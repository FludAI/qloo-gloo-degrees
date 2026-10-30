// Degrees of Qloo: how much Qloo shapes a learner's lesson, one level per session, so the gain in learning
// adhesion from taste can be measured level against level (degrees.mjs) instead of assumed.
//   0  editorial only: no describe, no rank; the packet's order
//   1  rerank: the pick cards reordered from the learner's picks (production's behavior)
//   2  Qloo-built cards: a new word's pick options come from Qloo's graph, pictures included
//   3  the agent doorway: "None of these" asks the cue agent for more
// A new learner draws a level at random from QLOO_LEVELS (default all four); ?qloo=N forces one and it sticks.
import { q } from "./db.mjs";
import { PROVIDERS, availability } from "./providers.mjs";

export const LEVELS = [0, 1, 2, 3];
export const DEGREES = { 0: "editorial", 1: "rerank", 2: "qloo cards", 3: "agent doorway" };
export const parseLevel = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isInteger(n) && LEVELS.includes(n) ? n : null; };
const pool = (s) => { const out = [...new Set(String(s ?? "").split(",").map(parseLevel).filter((n) => n != null))]; return out.length ? out : LEVELS; };
export const POOL = pool(process.env.QLOO_LEVELS ?? "0,1,2,3");

export function assignLevel(sid, { random = Math.random, levels = POOL } = {}) {
  const level = levels[Math.min(levels.length - 1, Math.floor(random() * levels.length))];
  q.setLevel.run(level, 0, Date.now(), sid);
  return level;
}
export function forceLevel(sid, level) {
  const n = parseLevel(level);
  if (n == null) return null;
  q.setLevel.run(n, 1, Date.now(), sid);
  return n;
}
// The learner's level, drawn now if the row predates the switch. Null for an unknown sid.
export function levelFor(sid, opts) {
  const row = q.getLevel.get(sid);
  if (!row) return null;
  return row.qloo_level ?? assignLevel(sid, opts);
}
// ---- The model arm: which model provider answers this session's tasks (providers.mjs). Drawn once from
// MODEL_ARMS, or from the providers that have a key; ?model=muse|anthropic forces it and it sticks. ----
export const ARMS = PROVIDERS;
export const parseArm = (v) => (ARMS.includes(String(v ?? "")) ? String(v) : null);
export function armPool() {
  const given = String(process.env.MODEL_ARMS ?? "").split(",").map(parseArm).filter(Boolean);
  if (given.length) return [...new Set(given)];
  const keyed = ARMS.filter((p) => availability()[p]);
  return keyed.length ? keyed : ["anthropic"];
}
export function assignArm(sid, { random = Math.random, arms = armPool() } = {}) {
  const arm = arms[Math.min(arms.length - 1, Math.floor(random() * arms.length))];
  q.setArm.run(arm, 0, sid);
  return arm;
}
export function forceArm(sid, arm) {
  const a = parseArm(arm);
  if (a == null) return null;
  q.setArm.run(a, 1, sid);
  return a;
}
export function armFor(sid, opts) {
  const row = q.getLevel.get(sid);
  if (!row) return null;
  return parseArm(row.model_arm) ?? assignArm(sid, opts);
}

export function levelInfo(sid) {
  const level = levelFor(sid);
  const arm = armFor(sid);
  const row = q.getLevel.get(sid) ?? {};
  return { level, degree: level == null ? null : DEGREES[level], forced: Boolean(row.qloo_forced), assigned_at: row.qloo_level_at ?? null, degrees: DEGREES,
    model: { arm, forced: Boolean(row.model_forced), arms: ARMS, available: availability() }, synthetic: row.synthetic ?? null };
}
