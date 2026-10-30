// Qloo-built pick cards (degree 2): for a new word the drafter names eight to twelve candidates per piece instead
// of four; each is resolved with `describe`; those Qloo knows and rates popular enough stay, with Qloo's own
// picture (images.qloo.com) and the Wikipedia article as the fallback; the card then shows the most popular four
// (ranked for the learner's picks later, by taste.mjs, like any other card). Nothing personal is sent: a candidate
// is a public name and a type. Every resolved entity is kept in the shared cache, so a word costs its describes once.
//
// The sound bar: a candidate is scored against the piece's sound first (soundScore, the one scorer the reviewer and
// the ranking path use) and only a name above the bar is described and kept; the rest are recorded as dropped. A
// live "spic" card once offered Britney Spears, Spotify, The Simpsons, Snapchat and SpongeBob: names that share a
// first letter with the piece, not its sound. The ranking path never promotes a name under the bar; this builder
// insists on a name above it, because it has eight to twelve candidates to choose from. Kept names are ordered by
// sound first and popularity second. When fewer than three clear, the card falls back to the drafter's first four
// and the record says why. Behind SOUND_JUDGE a model scores the cleared names 0 to 3 (one call per card, op
// "sound_judge", through providers.mjs); a 0 drops the name; any failure leaves the deterministic result and is noted.
import { loadEntities, entityFor, learnEntity, isUnresolved, markUnresolved, norm, TYPES } from "./taste.mjs";
import { soundScore, SOUND } from "./reviewer.mjs";
import { complete, toolCall, PROVIDERS } from "./providers.mjs";
import { remaining } from "./limits.mjs";
import { RESERVE } from "./taste.mjs";

export const POP_FLOOR = Number(process.env.QLOO_POP_FLOOR ?? 0.3); // a candidate below this popularity is dropped
export const DESCRIBE_CAP = Number(process.env.QLOO_DESCRIBE_PER_WORD ?? 40); // describe calls per drafted word, at most
export const KEEP = Number(process.env.QLOO_CARD_KEEP ?? 8); // options kept per card (the client shows four; rank reorders up to ten)
export const CANDIDATES = Number(process.env.QLOO_CARD_CANDIDATES ?? 12); // what the drafter is asked for, per piece
export const MIN_CLEARED = 3; // fewer names above the bar than this: the card keeps the drafter's first four
export const JUDGE = PROVIDERS.includes(process.env.SOUND_JUDGE) ? process.env.SOUND_JUDGE : "off"; // SOUND_JUDGE=anthropic|muse|off
export { SOUND };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const imageOf = (r) => { const u = r?.properties?.image?.url ?? r?.image?.url ?? (typeof r?.image === "string" ? r.image : null); return typeof u === "string" && /^https:\/\//.test(u) ? u.slice(0, 300) : null; };

// ---- The sound bar ----
// A role has a sound to carry when it names one (sound_like); a meaning role's options are judged by meaning, not here.
const hasSound = (role) => Boolean(role.sound_like);
// The option's sound score, 0 to 1, from the one scorer (reviewer.mjs): its name and any spoken forms against the piece.
export const soundOf = (role, option) => Number(soundScore(role, typeof option === "string" ? { name: option } : option).toFixed(2));
// Above the bar, not at it: a name at the bar itself (Snapchat is 0.75 against "spic") carries at most a syllable's edge.
export const clears = (score) => score > SOUND;

// ---- The model judge ----
const JUDGE_TOOL = {
  name: "sound_judge",
  description: "Your score for each name: does it carry the sound of the word part?",
  input_schema: { type: "object", properties: { scores: { type: "array", items: { type: "object", properties: {
    name: { type: "string", description: "The name exactly as given" },
    score: { type: "integer", minimum: 0, maximum: 3, description: "0 the sound is not there (a shared first letter is not the sound); 1 faint; 2 clearly there; 3 the part is heard whole" } },
    required: ["name", "score"] } } }, required: ["scores"] },
};
const JUDGE_SYSTEM = `You judge whether a public name carries the sound of a word part, for a learner who remembers the part by the name. Say the part and each name aloud in your head. Score each name 0 to 3: 0 the sound is not in the name (sharing a first letter or two is not the sound); 1 faint, a stretch; 2 the sound is clearly there; 3 the part is heard whole in the name. Score every name given, once, by its exact text. Respond only by calling the ${JUDGE_TOOL.name} tool.`;
// One call per card: the piece's sound and the cleared names; returns Map name -> 0..3. Throws on any trouble (the
// caller keeps the deterministic result and notes it). Nothing personal travels: a word part and public names.
export async function judgeSounds(role, names, { provider, sid = null, ask = complete } = {}) {
  const sound = [`Part: "${role.part}"`, role.sound_like ? `sounds like "${role.sound_like}"` : null, role.say ? `said "${role.say}"` : null, role.ipa ? `IPA ${role.ipa}` : null].filter(Boolean).join(", ");
  const { res } = await ask({ provider, task: "sound_judge", sid, max_tokens: 400, system: JUDGE_SYSTEM, tools: [JUDGE_TOOL], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: `${sound}.\nNames:\n${names.map((n) => `- ${n}`).join("\n")}` }] });
  const call = toolCall(res, JUDGE_TOOL.name);
  if (!call) throw new Error(`no ${JUDGE_TOOL.name} call (stop ${res.stop_reason ?? "?"})`);
  const out = new Map();
  for (const s of Array.isArray(call.input?.scores) ? call.input.scores : []) {
    const score = Number(s?.score);
    const name = names.find((n) => norm(n) === norm(s?.name));
    if (name && Number.isInteger(score) && score >= 0 && score <= 3) out.set(name, score);
  }
  if (!out.size) throw new Error(`${JUDGE_TOOL.name} scored none of the names`);
  return out;
}

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

const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// The packet with its pick cards rebuilt from Qloo. Never throws; a card Qloo cannot fill keeps the drafter's first four.
// `judge` is the model arm that scores cleared names ("off" for none); `sid` is the session the judge's rows are logged on.
export async function qlooCards(packet, call, { floor = POP_FLOOR, cap = DESCRIBE_CAP, keep = KEEP, budget = remaining, judge = JUDGE, sid = null, ask = complete } = {}) {
  await loadEntities();
  const state = { calls: 0, skipped: 0, unasked: 0, dropped: 0, fallbacks: 0, judged: 0, judge_zero: 0, judge_failed: 0 };
  const roles = [];
  for (const role of packet.roles ?? []) {
    const options = role.pick?.options ?? [];
    if (!options.length) { roles.push(role); continue; }
    const sounded = hasSound(role);
    // The bar first: a name under it is never described, so it costs no credit. Each option carries its score.
    const scored = options.map((o) => (sounded ? { ...o, sound: soundOf(role, o) } : { ...o }));
    let cleared = sounded ? scored.filter((o) => clears(o.sound)) : scored;
    const dropped = sounded ? scored.filter((o) => !clears(o.sound)).map((o) => ({ name: o.name, sound: o.sound })) : [];
    state.dropped += dropped.length;
    // The judge, when on and there is something to judge: a 0 drops a name the bar let through.
    let judged = null;
    if (sounded && judge !== "off" && cleared.length) {
      try {
        const scores = await judgeSounds(role, cleared.map((o) => o.name), { provider: judge, sid, ask });
        cleared = cleared.map((o) => (scores.has(o.name) ? { ...o, sound_judged: scores.get(o.name) } : o));
        const zeros = cleared.filter((o) => o.sound_judged === 0);
        for (const o of zeros) dropped.push({ name: o.name, sound: o.sound, sound_judged: 0 });
        cleared = cleared.filter((o) => o.sound_judged !== 0);
        const all = [...scores.values()];
        judged = { provider: judge, scores: all, median: median(all), zeros: zeros.length, failed: null };
        state.judged += all.length; state.judge_zero += zeros.length;
      } catch (e) {
        judged = { provider: judge, scores: [], median: null, zeros: 0, failed: String(e.message ?? e).slice(0, 160) };
        state.judge_failed++;
      }
    }
    const built = { source: "qloo", candidates: options.length, cleared: cleared.length, dropped, kept: 0, resolved: 0, fallback: null, bar: sounded ? SOUND : null, floor, ...(judged ? { judge: judged } : {}) };
    // Fewer than three names above the bar: the drafter's first four stand, as the lesson's own editorial card.
    if (sounded && cleared.length < MIN_CLEARED) {
      const kept = scored.slice(0, 4);
      state.fallbacks++;
      built.kept = kept.length; built.fallback = judged && judged.zeros && cleared.length + judged.zeros >= MIN_CLEARED ? "fewer than three names after the judge" : "fewer than three names cleared the sound bar";
      roles.push({ ...role, pick: { ...role.pick, options: kept, built } });
      continue;
    }
    const resolved = [], rest = [];
    const enough = Math.max(4, keep); // popular names a card can use; past that a describe would be a credit for nothing
    for (const o of cleared) {
      const name = o.qloo?.entity ?? o.name, type = o.qloo?.type;
      if (resolved.length >= enough) { if (name && TYPES.has(type) && !entityFor(name, type)?.id) state.unasked++; rest.push(o); continue; }
      const rec = name && TYPES.has(type) ? await recordFor(call, name, type, state, { floor, cap, budget }) : null;
      if (rec?.id && rec.popularity != null && rec.popularity >= floor) {
        resolved.push({ ...o, image: rec.image ?? null, qloo: { entity: name, type, entity_id: rec.id, popularity: Number(rec.popularity.toFixed(3)), image: rec.image ?? null } });
      } else {
        rest.push({ ...o, qloo: rec?.id ? { entity: name, type, entity_id: rec.id, popularity: rec.popularity ?? null, image: rec.image ?? null } : o.qloo ?? null });
      }
    }
    // Sound first, popularity second; the unresolved rest by sound, then the drafter's order.
    resolved.sort((a, b) => (b.sound ?? 0) - (a.sound ?? 0) || b.qloo.popularity - a.qloo.popularity);
    rest.sort((a, b) => (b.sound ?? 0) - (a.sound ?? 0));
    // Fewer than four popular names: the drafter's others fill the card, without a Qloo picture.
    const kept = [...resolved, ...rest].slice(0, Math.max(4, Math.min(keep, resolved.length)));
    built.kept = kept.length; built.resolved = resolved.length;
    roles.push({ ...role, pick: { ...role.pick, options: kept, built } });
  }
  return { ...packet, roles, cards: { source: "qloo", describes: state.calls, skipped: state.skipped, unasked: state.unasked, cap, floor, bar: SOUND, dropped: state.dropped, fallbacks: state.fallbacks,
    judge, judged: state.judged, judge_zero: state.judge_zero, judge_failed: state.judge_failed } };
}

// What the provisional_terms row keeps of a built packet (its `cards` column): the word's totals and one small record
// per built card, for the degrees report. `dropped` counts the bar's drops; the judge's zeros are counted apart.
// Null for a packet whose cards were not built.
export function cardsRecord(packet) {
  if (packet?.cards?.source !== "qloo") return null;
  const roles = (packet.roles ?? []).filter((r) => r.pick?.built).map((r) => { const b = r.pick.built; return {
    role: r.id, candidates: b.candidates, cleared: b.cleared, kept: b.kept, dropped: b.dropped.filter((d) => d.sound_judged === undefined).length, fallback: b.fallback, bar: b.bar,
    judged: b.judge ? b.judge.scores : null, judge_zero: b.judge?.zeros ?? 0, judge_failed: b.judge?.failed ?? null }; });
  return { ...packet.cards, roles };
}
