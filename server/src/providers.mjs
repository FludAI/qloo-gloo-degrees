// Model providers: the one place the server talks to a language model. Two backends, switchable per task
// and per session (the learner's "model arm", level.mjs), so the degrees site can vary the model as well as
// the degree of Qloo:
//   anthropic  Claude through the Anthropic API (the default; today's code)
//   muse       Muse Spark through the hosted Meta Model API (https://api.meta.ai, bearer key META_API_KEY),
//              on its chat-completions surface, POST /v1/chat/completions. Every call here is written in the
//              Anthropic messages shape (system, content blocks, tools, tool_use and tool_result); the muse
//              backend converts the request and converts the answer back, so a task reads the same on either
//              arm. The API accepts tool_choice "auto" only; every call here uses auto and checks for its tool.
// A backend without a key reports unavailable; a task asked for it falls back to the other backend and the
// fallback is recorded on the call's row. Nothing personal goes to either: the camera crop and the learner's
// words go as they did before, and no identifier of the learner travels with them.
import Anthropic from "@anthropic-ai/sdk";
import { q } from "./db.mjs";

export const PROVIDERS = ["anthropic", "muse"];
export const MODELS = {
  anthropic: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  muse: process.env.META_MODEL ?? "muse-spark-1.3",
};
export const META_BASE_URL = (process.env.META_BASE_URL ?? "https://api.meta.ai").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.META_TIMEOUT_MS ?? 90e3);

export const available = (p) => (p === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY) : p === "muse" ? Boolean(process.env.META_API_KEY) : false);
export const availability = () => Object.fromEntries(PROVIDERS.map((p) => [p, available(p)]));
export const anyAvailable = () => PROVIDERS.some(available);

// The backend a call will use for the provider it asked for: itself when keyed, else the other, else null.
export function pick(provider) {
  const wanted = PROVIDERS.includes(provider) ? provider : "anthropic";
  if (available(wanted)) return { provider: wanted, fallback_from: null };
  const other = PROVIDERS.find((p) => p !== wanted && available(p));
  return other ? { provider: other, fallback_from: wanted } : null;
}

// ---- The muse backend: Anthropic-shaped request -> chat completions, and the answer back. ----
const str = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : v == null ? "" : JSON.stringify(v));
function toChatMessages({ system, messages }) {
  const out = [];
  if (system) out.push({ role: "system", content: str(system) });
  for (const m of messages ?? []) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content ?? [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results each become a tool message (in order); text and images one user message.
    const results = blocks.filter((b) => b.type === "tool_result");
    for (const r of results) out.push({ role: "tool", tool_call_id: r.tool_use_id, content: str(r.content) });
    const rest = blocks.filter((b) => b.type !== "tool_result").map((b) =>
      b.type === "image" && b.source?.type === "base64" ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
      : b.type === "image" && b.source?.type === "url" ? { type: "image_url", image_url: { url: b.source.url } }
      : { type: "text", text: str(b.text ?? b) });
    if (rest.length) out.push({ role: "user", content: rest });
  }
  return out;
}
export function toChatRequest({ model, system, messages, tools, max_tokens, output_config, temperature }) {
  const body = { model, messages: toChatMessages({ system, messages }), max_tokens: max_tokens ?? 1024 };
  if (tools?.length) { body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", properties: {} } } })); body.tool_choice = "auto"; }
  if (output_config?.effort) body.reasoning_effort = output_config.effort;
  if (typeof temperature === "number") body.temperature = temperature;
  return body;
}
let seq = 0;
export function fromChatResponse(json) {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (typeof msg.content === "string" && msg.content.trim()) content.push({ type: "text", text: msg.content });
  for (const c of msg.tool_calls ?? []) {
    let input = {};
    try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { _raw: String(c.function?.arguments ?? "") }; }
    content.push({ type: "tool_use", id: c.id ?? `call_${++seq}`, name: c.function?.name ?? "", input });
  }
  const reason = choice.finish_reason;
  return { id: json?.id ?? null, type: "message", role: "assistant", model: json?.model ?? null, content,
    stop_reason: reason === "tool_calls" ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn",
    usage: { input_tokens: json?.usage?.prompt_tokens ?? null, output_tokens: json?.usage?.completion_tokens ?? null } };
}
async function museCreate(body) {
  const res = await fetch(`${META_BASE_URL}/v1/chat/completions`, {
    method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${process.env.META_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(toChatRequest(body)),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = str((await res.json())?.error?.message ?? "").slice(0, 200); } catch { /* no body */ }
    throw Object.assign(new Error(`Meta Model API ${res.status}${detail ? `: ${detail}` : ""}`), { status: res.status });
  }
  return fromChatResponse(await res.json());
}

let anthropic = null;
const create = (p, body) => (p === "muse" ? museCreate(body) : (anthropic ??= new Anthropic()).messages.create(body));

// One model call. `provider` is the arm asked for, `task` names the call on its provider_calls row (sid may be
// null for owner tools). The rest is an Anthropic messages.create body without `model`. Returns the response
// in the Anthropic shape plus what was used: { res, provider, model, fallback_from, usage: { input, output }, ms }.
// Throws on a provider error after logging it; throws MODEL_UNAVAILABLE when no backend has a key.
export async function complete({ provider = "anthropic", task = "model", sid = null, log = true, ...body }) {
  const use = pick(provider);
  if (!use) throw Object.assign(new Error(`No model provider is configured for ${task}.`), { code: "MODEL_UNAVAILABLE" });
  const model = MODELS[use.provider];
  const t0 = performance.now();
  try {
    const res = await create(use.provider, { model, ...body });
    const usage = { input: res.usage?.input_tokens ?? null, output: res.usage?.output_tokens ?? null };
    const ms = performance.now() - t0;
    if (log) q.logModel.run(sid, use.provider, task, "ok", null, ms, Date.now(), model, usage.input, usage.output, use.fallback_from);
    return { res, provider: use.provider, model, fallback_from: use.fallback_from, usage, ms };
  } catch (e) {
    if (log) q.logModel.run(sid, use.provider, task, "error", null, performance.now() - t0, Date.now(), model, null, null, use.fallback_from);
    e.provider = use.provider;
    throw e;
  }
}

// The tool call a structured answer was asked for, or null.
export const toolCall = (res, name) => res.content.find((b) => b.type === "tool_use" && b.name === name) ?? null;
