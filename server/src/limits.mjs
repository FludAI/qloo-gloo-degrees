// Bounded usage for a public demo that spends the event quota and model budget.
const WINDOW_MS = 60 * 60e3;
const LIMITS = {
  qloo: Number(process.env.LIMIT_QLOO_PER_SESSION_HOUR ?? 60),
  qloo_synthetic: Number(process.env.LIMIT_QLOO_PER_SESSION_HOUR_SYNTHETIC ?? 200), // a simulated learner plays several words in minutes (scripts/simulate-learner.mjs)
  agent: Number(process.env.LIMIT_AGENT_PER_SESSION_HOUR ?? 8),
  agent_global: Number(process.env.LIMIT_AGENT_GLOBAL_DAY ?? 300),
  qloo_global: Number(process.env.LIMIT_QLOO_GLOBAL_DAY ?? 150),
  stt: Number(process.env.LIMIT_STT_PER_SESSION_HOUR ?? 40),
  camera: Number(process.env.LIMIT_CAMERA_PER_SESSION_HOUR ?? 40),
  tts: Number(process.env.LIMIT_TTS_PER_SESSION_HOUR ?? 60),
};
const buckets = new Map();
let globalAgent = { day: new Date().toDateString(), n: 0 };
let globalQloo = { day: new Date().toDateString(), n: 0 };

// How many calls the day's global budget still allows (qloo only; other kinds are per session).
export function remaining(kind) {
  if (kind !== "qloo") return Infinity;
  const today = new Date().toDateString();
  if (globalQloo.day !== today) globalQloo = { day: today, n: 0 };
  return Math.max(0, LIMITS.qloo_global - globalQloo.n);
}

export const caps = () => ({ ...LIMITS });
// `synthetic`: the session is a simulated learner, whose hourly Qloo cap is its own; the daily cap is shared.
export function take(kind, sid, { synthetic = false } = {}) {
  if (kind === "qloo") {
    // Event credits are finite: a hard daily cap across all visitors (cache hits never reach here).
    const today = new Date().toDateString();
    if (globalQloo.day !== today) globalQloo = { day: today, n: 0 };
    if (globalQloo.n >= LIMITS.qloo_global) return { ok: false, reason: "The demo's daily Qloo budget is used up. Reviewed hooks and practice still work." };
  }
  if (kind === "agent") {
    const today = new Date().toDateString();
    if (globalAgent.day !== today) globalAgent = { day: today, n: 0 };
    if (globalAgent.n >= LIMITS.agent_global) return { ok: false, reason: "The demo's daily agent budget is used up. The rest of the lesson still works." };
  }
  const key = `${kind}:${sid}`;
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  const cap = kind === "qloo" && synthetic ? LIMITS.qloo_synthetic : LIMITS[kind];
  if (hits.length >= cap) return { ok: false, reason: `Hourly ${kind} limit reached for this session. Try again later; learning still works.` };
  hits.push(now);
  buckets.set(key, hits);
  if (kind === "agent") globalAgent.n++;
  if (kind === "qloo") globalQloo.n++;
  return { ok: true };
}
