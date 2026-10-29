// Model providers: the one place the server talks to a language model. Two backends, switchable per task
// and per session (the learner's "model arm", level.mjs), so the degrees site can vary the model as well as
// the degree of Qloo:
//   anthropic  Claude through the Anthropic API (the default; today's code)
//   meta       Meta Model API (Muse Spark) through its Anthropic-Messages-compatible protocol at
//              https://api.meta.ai: the same request and response shapes, tools, images and effort included,
//              with a bearer token instead of an API key. Named tool choice is not accepted there; every
//              call here already uses "auto" and checks for the tool it asked for.
// A backend without a key reports unavailable; a task asked for it falls back to the other backend and the
// fallback is recorded on the call's row. Nothing personal goes to either: the camera crop and the learner's
// words go as they did before, and no identifier of the learner travels with them.
import Anthropic from "@anthropic-ai/sdk";
import { q } from "./db.mjs";

export const PROVIDERS = ["anthropic", "meta"];
export const MODELS = {
  anthropic: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  meta: process.env.META_MODEL ?? "muse-spark-1.3",
};
export const META_BASE_URL = process.env.META_BASE_URL ?? "https://api.meta.ai";

export const available = (p) => (p === "anthropic" ? Boolean(process.env.ANTHROPIC_API_KEY) : p === "meta" ? Boolean(process.env.META_API_KEY) : false);
export const availability = () => Object.fromEntries(PROVIDERS.map((p) => [p, available(p)]));
export const anyAvailable = () => PROVIDERS.some(available);

// The backend a call will use for the provider it asked for: itself when keyed, else the other, else null.
export function pick(provider) {
  const wanted = PROVIDERS.includes(provider) ? provider : "anthropic";
  if (available(wanted)) return { provider: wanted, fallback_from: null };
  const other = PROVIDERS.find((p) => p !== wanted && available(p));
  return other ? { provider: other, fallback_from: wanted } : null;
}

const clients = {};
function client(p) {
  if (!clients[p]) {
    clients[p] = p === "meta"
      ? new Anthropic({ apiKey: null, authToken: process.env.META_API_KEY, baseURL: META_BASE_URL })
      : new Anthropic();
  }
  return clients[p];
}

// One model call. `provider` is the arm asked for, `task` names the call on its provider_calls row (sid may be
// null for owner tools). The rest is an Anthropic messages.create body without `model`. Returns the response
// plus what was used: { res, provider, model, fallback_from, usage: { input, output }, ms }. Throws on a
// provider error after logging it; throws MODEL_UNAVAILABLE when no backend has a key.
export async function complete({ provider = "anthropic", task = "model", sid = null, log = true, ...body }) {
  const use = pick(provider);
  if (!use) throw Object.assign(new Error(`No model provider is configured for ${task}.`), { code: "MODEL_UNAVAILABLE" });
  const model = MODELS[use.provider];
  const t0 = performance.now();
  try {
    const res = await client(use.provider).messages.create({ model, ...body });
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
