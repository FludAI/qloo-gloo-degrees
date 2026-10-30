// Model providers: the one place the server talks to a language model. Two backends, switchable per task
// and per session (the learner's "model arm", level.mjs), so the degrees site can vary the model as well as
// the degree of Qloo:
//   anthropic  Claude through the Anthropic API (the default; today's code)
//   muse       Muse Spark through the hosted Meta Model API (https://api.meta.ai, bearer key META_API_KEY),
//              on its chat-completions surface, POST /v1/chat/completions. Every call here is written in the
//              Anthropic messages shape (system, content blocks, tools, tool_use and tool_result); the muse
//              backend converts the request and converts the answer back, so a task reads the same on either
//              arm. The API accepts tool_choice "auto" only; every call here uses auto and checks for its tool.
//              An answer that writes the call as JSON text instead of calling the tool still counts (the row notes
//              it). Muse Spark always reasons and its reasoning tokens count against the output cap, so the muse
//              request adds headroom to the cap and sets a modest reasoning effort (see below).
// A backend without a key reports unavailable; a task asked for it falls back to the other backend and the
// fallback is recorded on the call's row. Nothing personal goes to either: the camera crop and the learner's
// words go as they did before, and no identifier of the learner travels with them.
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { q } from "./db.mjs";

export const PROVIDERS = ["anthropic", "muse"];
// A prompt's version: a short hash of its template text, so any change to the words a model is given shows as a
// new version on the rows it answers (provider_calls.prompt) and as a split in the degrees report.
export const promptVersion = (...texts) => createHash("sha256").update(texts.map(String).join("\n--\n")).digest("hex").slice(0, 8);
export const MODELS = {
  anthropic: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  muse: process.env.META_MODEL ?? "muse-spark-1.3",
};
export const META_BASE_URL = (process.env.META_BASE_URL ?? "https://api.meta.ai").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.META_TIMEOUT_MS ?? 90e3);
// The Anthropic-shaped max_tokens of a call means visible output. Muse spends reasoning tokens from the same cap
// (max_completion_tokens) and picks its own depth when none is asked, so a 2,500-token draft could spend the whole
// cap thinking and come back cut, with no tool call: the first live draft did. Headroom and a default effort fix that.
const REASONING_EFFORT = process.env.META_REASONING_EFFORT ?? "low"; // minimal | low | medium | high | xhigh ("none" is refused)
const REASONING_HEADROOM = Number(process.env.META_REASONING_HEADROOM ?? 6000);

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
  const body = { model, messages: toChatMessages({ system, messages }), max_completion_tokens: (max_tokens ?? 1024) + REASONING_HEADROOM };
  if (tools?.length) { body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", properties: {} } } })); body.tool_choice = "auto"; }
  const effort = output_config?.effort ?? REASONING_EFFORT;
  body.reasoning_effort = effort === "none" ? "minimal" : effort;
  if (typeof temperature === "number") body.temperature = temperature;
  return body;
}
// The text of an answer: a string, or an array of content parts.
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => typeof p?.text === "string").map((p) => p.text).join("") : "");
// A JSON object inside text: a fenced block first, else the outermost braces. Null when there is none.
export function jsonIn(text) {
  const s = String(text ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  for (const cand of [fenced?.[1], s]) {
    if (!cand) continue;
    const a = cand.indexOf("{"), b = cand.lastIndexOf("}");
    if (a < 0 || b <= a) continue;
    try { const v = JSON.parse(cand.slice(a, b + 1)); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* not JSON */ }
  }
  return null;
}
let seq = 0;
// `tools` names the tools the request offered: when none was called but the text holds a JSON object that fits one,
// that object stands in for the call and `note` says so ("tool_from_text").
export function fromChatResponse(json, { tools = [] } = {}) {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  const text = textOf(msg.content);
  if (text.trim()) content.push({ type: "text", text });
  for (const c of msg.tool_calls ?? []) {
    let input = {};
    try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { _raw: String(c.function?.arguments ?? "") }; }
    content.push({ type: "tool_use", id: c.id ?? `call_${++seq}`, name: c.function?.name ?? "", input });
  }
  let note = null;
  if (tools.length && !content.some((b) => b.type === "tool_use") && text) {
    const obj = jsonIn(text);
    if (obj) {
      // Either the arguments themselves (one tool offered), or a wrapper naming the tool: { name, arguments | input }.
      const wrapped = typeof obj.name === "string" && tools.includes(obj.name) ? obj.arguments ?? obj.input ?? obj.parameters ?? null : null;
      const name = wrapped != null ? obj.name : tools.length === 1 ? tools[0] : null;
      const input = wrapped != null ? (typeof wrapped === "string" ? jsonIn(wrapped) : wrapped) : obj;
      if (name && input && typeof input === "object") { content.push({ type: "tool_use", id: `call_${++seq}`, name, input }); note = "tool_from_text"; }
    }
  }
  const reason = choice.finish_reason;
  const reasoning = json?.usage?.completion_tokens_details?.reasoning_tokens;
  return { id: json?.id ?? null, type: "message", role: "assistant", model: json?.model ?? null, content, note,
    stop_reason: reason === "tool_calls" ? "tool_use" : reason === "length" ? "max_tokens" : "end_turn",
    usage: { input_tokens: json?.usage?.prompt_tokens ?? null, output_tokens: json?.usage?.completion_tokens ?? null, ...(Number.isFinite(reasoning) ? { reasoning_tokens: reasoning } : {}) } };
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
  return fromChatResponse(await res.json(), { tools: (body.tools ?? []).map((t) => t.name) });
}

let anthropic = null;
const create = (p, body) => (p === "muse" ? museCreate(body) : (anthropic ??= new Anthropic()).messages.create(body));

// One model call. `provider` is the arm asked for, `task` names the call on its provider_calls row (sid may be
// null for owner tools). The rest is an Anthropic messages.create body without `model`. Returns the response
// in the Anthropic shape plus what was used: { res, provider, model, fallback_from, usage: { input, output }, ms, stop, note }.
// `stop` is the stop reason ("max_tokens" means the answer was cut at the cap); `note` is "tool_from_text" when the
// call was read out of the text, "no_tool" when tools were offered and none came back, else null. Both go on the row,
// with `brief`: how many characters of the learner brief the prompt carried (0 for none; brief.mjs), and the note
// says "brief_dropped" when the guard kept one out of this call.
// `row` is the id of the provider_calls row the call was logged on (null when `log` is off), so a caller that
// judges the answer afterwards can add to its note (q.noteCall).
// Throws on a provider error after logging it; throws MODEL_UNAVAILABLE when no backend has a key.
export async function complete({ provider = "anthropic", task = "model", sid = null, log = true, brief_chars = 0, brief_dropped = false, prompt_version = null, ...body }) {
  const use = pick(provider);
  if (!use) throw Object.assign(new Error(`No model provider is configured for ${task}.`), { code: "MODEL_UNAVAILABLE" });
  const model = MODELS[use.provider];
  const t0 = performance.now();
  try {
    const res = await create(use.provider, { model, ...body });
    const usage = { input: res.usage?.input_tokens ?? null, output: res.usage?.output_tokens ?? null, reasoning: res.usage?.reasoning_tokens ?? null };
    const ms = performance.now() - t0;
    const stop = res.stop_reason ?? null;
    const base = res.note ?? (body.tools?.length && !(res.content ?? []).some((b) => b.type === "tool_use") ? "no_tool" : null);
    const note = brief_dropped ? [base, "brief_dropped"].filter(Boolean).join(",") : base;
    const row = log ? Number(q.logModel.run(sid, use.provider, task, "ok", null, ms, Date.now(), model, usage.input, usage.output, use.fallback_from, stop, note, brief_chars, prompt_version).lastInsertRowid) : null;
    return { res, provider: use.provider, model, fallback_from: use.fallback_from, usage, ms, stop, note, brief_chars, prompt_version, row };
  } catch (e) {
    if (log) q.logModel.run(sid, use.provider, task, "error", null, performance.now() - t0, Date.now(), model, null, null, use.fallback_from, null, brief_dropped ? "brief_dropped" : null, brief_chars, prompt_version);
    e.provider = use.provider;
    throw e;
  }
}

// The tool call a structured answer was asked for, or null.
export const toolCall = (res, name) => res.content.find((b) => b.type === "tool_use" && b.name === name) ?? null;
