// Qloo-built pick cards (degree 2): for a new word the drafter names eight to twelve candidates per piece instead
// of four; each is resolved with `describe`; those Qloo knows and rates popular enough stay, with Qloo's own
// picture (images.qloo.com) and the Wikipedia article as the fallback; the card then shows the most popular four
// (ranked for the learner's picks later, by taste.mjs, like any other card). Nothing personal is sent: a candidate
// is a public name and a type. Every resolved entity is kept in the shared cache, so a word costs its describes once.
import { loadEntities, entityFor, learnEntity, isUnresolved, markUnresolved, norm, TYPES } from "./taste.mjs";
import { remaining } from "./limits.mjs";
import { RESERVE } from "./taste.mjs";

export const POP_FLOOR = Number(process.env.QLOO_POP_FLOOR ?? 0.3); // a candidate below this popularity is dropped
export const DESCRIBE_CAP = Number(process.env.QLOO_DESCRIBE_PER_WORD ?? 40); // describe calls per drafted word, at most
export const KEEP = Number(process.env.QLOO_CARD_KEEP ?? 8); // options kept per card (the client shows four; rank reorders up to ten)
export const CANDIDATES = Number(process.env.QLOO_CARD_CANDIDATES ?? 12); // what the drafter is asked for, per piece

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const imageOf = (r) => { const u = r?.properties?.image?.url ?? r?.image?.url ?? (typeof r?.image === "string" ? r.image : null); return typeof u === "string" && /^https:\/\//.test(u) ? u.slice(0, 300) : null; };

// A needs_input answer: Qloo could not match the name exactly and lists candidates. The one with the same name is
// the match, learned with what the answer says of it; otherwise the name is remembered as unresolved. Either way the
// name is never asked again for a later word (a describe is a credit; the first live lessons spent most of theirs here).
async function settled(env, name, type) {
  const cands = (env?.resolution?.issues ?? []).flatMap((i) => i?.candidates ?? []);
  const same = cands.find((c) => (c?.id || c?.entity_id) && norm(c.name) === norm(name));
  if (!same) { await markUnresolved(name, type); return null; }
  await learnEntity(name, type, String(same.id ?? same.entity_id), { popularity: num(same.popularity), image: imageOf(same) });
  return entityFor(name, type);
}

// One candidate's Qloo record: from the cache when known (free), else one describe within the cap. Null when Qloo
// does not know the name. `state.calls` counts the describes spent on this word.
async function recordFor(call, name, type, state, { floor, cap, budget }) {
  const known = entityFor(name, type);
  if (known?.id && known.popularity != null) return known;
  if (isUnresolved(name, type)) return null;
  if (state.calls >= cap || budget("qloo") < RESERVE) { state.skipped++; return known?.id ? known : null; }
  state.calls++;
  let env;
  try { env = await call("describe", { entity: name, type }); } catch { return known?.id ? known : null; }
  if (env?.status === "needs_input") return (await settled(env, name, type)) ?? (known?.id ? known : null);
  if (!["ok", "partial"].includes(env?.status)) { if (env?.status === "empty") await markUnresolved(name, type); return known?.id ? known : null; }
  const hit = (env.results ?? []).find((r) => r && (r.entity_id || r.id));
  if (!hit) { await markUnresolved(name, type); return null; }
  const id = String(hit.entity_id ?? hit.id);
  await learnEntity(name, type, id, { popularity: num(hit.popularity), image: imageOf(hit) });
  return entityFor(name, type) ?? { id, name, type, popularity: num(hit.popularity), image: imageOf(hit) };
}

// The packet with its pick cards rebuilt from Qloo. Never throws; a card Qloo cannot fill keeps the drafter's first four.
export async function qlooCards(packet, call, { floor = POP_FLOOR, cap = DESCRIBE_CAP, keep = KEEP, budget = remaining } = {}) {
  await loadEntities();
  const state = { calls: 0, skipped: 0, unasked: 0 };
  const roles = [];
  for (const role of packet.roles ?? []) {
    const options = role.pick?.options ?? [];
    if (!options.length) { roles.push(role); continue; }
    const resolved = [], rest = [];
    const enough = Math.max(4, keep); // popular names a card can use; past that a describe would be a credit for nothing
    for (const o of options) {
      const name = o.qloo?.entity ?? o.name, type = o.qloo?.type;
      if (resolved.length >= enough) { if (name && TYPES.has(type) && !entityFor(name, type)?.id) state.unasked++; rest.push(o); continue; }
      const rec = name && TYPES.has(type) ? await recordFor(call, name, type, state, { floor, cap, budget }) : null;
      if (rec?.id && rec.popularity != null && rec.popularity >= floor) {
        resolved.push({ ...o, image: rec.image ?? null, qloo: { entity: name, type, entity_id: rec.id, popularity: Number(rec.popularity.toFixed(3)), image: rec.image ?? null } });
      } else {
        rest.push({ ...o, qloo: rec?.id ? { entity: name, type, entity_id: rec.id, popularity: rec.popularity ?? null, image: rec.image ?? null } : o.qloo ?? null });
      }
    }
    resolved.sort((a, b) => b.qloo.popularity - a.qloo.popularity);
    // Fewer than four popular names: the drafter's others fill the card, in its order, without a Qloo picture.
    const kept = [...resolved, ...rest].slice(0, Math.max(4, Math.min(keep, resolved.length)));
    roles.push({ ...role, pick: { ...role.pick, options: kept, built: { source: "qloo", candidates: options.length, resolved: resolved.length, kept: kept.length, floor } } });
  }
  return { ...packet, roles, cards: { source: "qloo", describes: state.calls, skipped: state.skipped, unasked: state.unasked, cap, floor } };
}
