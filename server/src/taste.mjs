// The taste loop: a learner's favorite picks are Qloo signals, and the next pick cards are ranked for them.
// A pick card still shows the reviewer's editorial options (every one carries the piece's sound and has a
// picture and a connection line); Qloo's `rank` only decides their order, so the first pictures the learner
// sees are the ones people with their taste tend to like. Nothing personal reaches Qloo: a signal is a public
// entity they picked (Pepsi, Twisted Sister), as a Qloo ID once known, else as the packet's name.
// Credits are scarce, so: no call under two picks, one rank call per piece and entity type (two types at
// most), answers cached for days (cache.mjs), and no call at all when the day's budget is nearly spent.
import { media } from "./media.mjs";
import { q } from "./db.mjs";
import { soundScore, SOUND } from "./reviewer.mjs";
import { remaining } from "./limits.mjs";

export const MIN_PICKS = Number(process.env.TASTE_MIN_PICKS ?? 2);
export const RESERVE = Number(process.env.TASTE_QLOO_RESERVE ?? 30); // ranking stops when fewer calls than this remain today
const MAX_GROUPS = 2;
const MAX_SIGNALS = 10;
export const TYPES = new Set(["artist", "book", "brand", "movie", "person", "place", "podcast", "tv_show", "videogame"]);
const KEY = "qloo/entities.json";

export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const ek = (name, type) => `${type}|${norm(name)}`;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

// ---- Resolved Qloo IDs for the packets' named entities: learned once (from describe, or free from a rank
// answer) and kept in the media store, so a redeploy never spends them again. A name Qloo could not match
// exactly (RC Cola is not in its brand graph) is remembered too, for a month, so it is never sent again. ----
const UNRESOLVED_MS = 30 * 24 * 3600e3;
let entities = null; // Map "type|name" -> { id, name, type, at, popularity?, image? } or { id: null, name, type, unresolved: at }
let saving = null;

export async function loadEntities() {
  if (entities) return entities;
  entities = new Map();
  try { for (const [k, v] of Object.entries((await media.getJson(KEY)) ?? {})) if (v?.id || v?.unresolved) entities.set(k, v); } catch { /* start empty */ }
  return entities;
}
export const entityIdFor = (name, type) => entities?.get(ek(name, type))?.id ?? null;
export const entityFor = (name, type) => { const e = entities?.get(ek(name, type)); return e?.id ? e : null; };
export const isUnresolved = (name, type) => { const u = entities?.get(ek(name, type))?.unresolved; return Boolean(u && Date.now() - u < UNRESOLVED_MS); };
export const knownEntities = () => (entities ? [...entities.values()].filter((v) => v.id).length : 0);

const save = () => {
  saving ??= Promise.resolve().then(async () => {
    saving = null;
    try { await media.putJson(KEY, Object.fromEntries(entities)); } catch (e) { console.warn(`taste: entities not saved (${e.message})`); }
  });
  return saving;
};
// `extra` carries what a describe record also said (popularity, image), kept so a Qloo-built card never asks twice.
export async function learnEntity(name, type, id, extra = {}) {
  if (!name || !type || !id) return;
  await loadEntities();
  const k = ek(name, type);
  const prev = entities.get(k);
  const more = Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null));
  if (prev?.id === String(id) && Object.keys(more).every((x) => prev[x] === more[x])) return;
  entities.set(k, { ...(prev?.id === String(id) ? prev : {}), id: String(id), name: String(name), type, at: Date.now(), ...more });
  await save();
}
export async function markUnresolved(name, type) {
  await loadEntities();
  const k = ek(name, type);
  if (entities.get(k)?.id) return;
  entities.set(k, { id: null, name: String(name), type, unresolved: Date.now() });
  await save();
}

// A needs_input answer lists the inputs Qloo could not match exactly, each with candidates. A candidate with the
// same name is the match (its ID is learned); anything else is marked unresolved. Returns the inputs to drop.
async function settleIssues(env, type) {
  const drop = new Set();
  for (const issue of env?.resolution?.issues ?? []) {
    if (issue?.field !== "options" || !issue.input) continue;
    const same = (issue.candidates ?? []).find((c) => c?.id && norm(c.name) === norm(issue.input));
    if (same) { await learnEntity(issue.input, type, same.id); continue; }
    await markUnresolved(issue.input, type);
    drop.add(norm(issue.input));
  }
  return drop;
}

// The ID behind a packet entity: known, or one `describe` (when the budget allows), or null (the name still works as a signal).
export async function resolveEntity(call, name, type, { budget = remaining } = {}) {
  await loadEntities();
  if (!name) return null;
  const known = entityIdFor(name, type);
  if (known) return known;
  if (!TYPES.has(type) || budget("qloo") < RESERVE) return null;
  let env;
  try { env = await call("describe", { entity: name, type }); } catch { return null; }
  if (!["ok", "partial"].includes(env?.status)) return null;
  const hit = (env.results ?? []).find((r) => r && (r.entity_id || r.id));
  const id = hit ? String(hit.entity_id ?? hit.id) : null;
  if (id) await learnEntity(name, type, id, { popularity: num(hit.popularity), image: typeof hit.properties?.image?.url === "string" ? hit.properties.image.url.slice(0, 300) : null });
  return id;
}

// ---- The learner's taste: distinct entities from their picks, newest first. ----
export function signalsFor(sid) {
  const out = [];
  for (const r of q.pickSignals.all(sid)) {
    const s = r.qloo_entity_id ?? r.qloo_entity ?? null;
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_SIGNALS) break;
  }
  return out;
}

// ---- Tailoring ----
// One role's pick card, with its options reordered for the signals. `call(op, args)` is the guarded, cached,
// metered Qloo call (index.mjs runQloo bound to the session). Never throws: any trouble leaves the editorial order.
// `level` is the session's degree of Qloo (level.mjs): under 1, ranking is suppressed and the reason says so.
export async function tailorRole(role, signals, call, { budget = remaining, groups = MAX_GROUPS, level = null } = {}) {
  const options = role.pick?.options ?? [];
  const editorial = (reason) => ({ ...role, pick: { ...role.pick, options: options.map((o) => ({ ...o })), tailoring: { source: "editorial", reason } } });
  if (level != null && level < 1) return editorial("level 0");
  if (signals.length < MIN_PICKS) return editorial("fewer than two picks");
  if (options.length < 2) return editorial("one option");
  await loadEntities();

  // Qloo ranks one entity type at a time, so options are grouped by type; a group needs two distinct entities to be worth a call.
  // An option that doesn't carry the piece's sound (the reviewer's bar) is never promoted, whatever Qloo says.
  // An option goes to Qloo as its ID once known (exact), else as the packet's name (Qloo matches exact names within the type).
  const sigs = new Set(signals.map((x) => norm(x)));
  const byType = new Map();
  const scores = new Map(); // option index -> { group, score }
  options.forEach((o, i) => {
    const type = o.qloo?.type, name = o.qloo?.entity;
    if (!name || !TYPES.has(type)) return;
    if (role.sound_like && soundScore(role, o) < SOUND) return;
    if (isUnresolved(name, type)) return;
    const id = entityIdFor(name, type);
    // The learner's own earlier pick is on this card: that is their taste itself, first on the card, no call needed.
    if ((id && sigs.has(norm(id))) || sigs.has(norm(name))) { scores.set(i, { group: -1, score: 1 }); return; }
    const g = byType.get(type) ?? { type, members: [], keys: new Set() };
    g.members.push({ i, name, id });
    g.keys.add(id ?? norm(name));
    byType.set(type, g);
  });
  const ranked = [...byType.values()].filter((g) => g.keys.size >= 2)
    .sort((a, b) => b.members.length - a.members.length || a.members[0].i - b.members[0].i).slice(0, groups);
  if (!ranked.length && !scores.size) return editorial("one entity");
  if (ranked.length && budget("qloo") < RESERVE) return editorial("budget");

  let answered = 0, reason = null;
  for (const [gi, g] of ranked.entries()) {
    const toSend = (members) => [...new Set(members.map((m) => entityIdFor(m.name, g.type) ?? m.name))].slice(0, 10);
    const sent = toSend(g.members);
    let env;
    try {
      env = await call("rank", { options: sent, option_type: g.type, signals });
      if (env?.status === "needs_input") {
        // A name with several matches is sent again as the ID of the one with that exact name; a name with no match
        // is dropped and remembered. One more call ranks what is left, if the set changed and two entities remain.
        const drop = await settleIssues(env, g.type);
        const again = toSend(g.members.filter((m) => !drop.has(norm(m.name))));
        if (again.join("\n") !== sent.join("\n") && again.length >= 2) env = await call("rank", { options: again, option_type: g.type, signals });
      }
    } catch (e) { reason = e.message; continue; }
    if (!["ok", "partial"].includes(env?.status)) { reason = env?.error?.code ?? env?.status ?? "no answer"; continue; }
    answered++;
    for (const r of env.results ?? []) {
      if (!r) continue;
      const id = r.entity_id ?? r.id ?? null;
      const rname = r.name ?? r.title ?? "";
      const score = num(r.affinity ?? r.score ?? r.rank_score ?? r.query_affinity);
      if (score == null) continue;
      for (const m of g.members) {
        const mid = entityIdFor(m.name, g.type);
        const hit = (id && mid && String(id) === mid) || (r.option && [m.name, mid].includes(String(r.option))) || (r.query && [m.name, mid].includes(String(r.query))) || (rname && norm(rname) === norm(m.name));
        if (!hit) continue;
        if (id && !mid) await learnEntity(m.name, g.type, id); // a rank answer teaches the ID for free
        const prev = scores.get(m.i);
        if (!prev || prev.score < score) scores.set(m.i, { group: gi, score });
      }
    }
  }
  if (!scores.size) return editorial(answered ? "no match" : reason ?? "unavailable");

  // Scores from different calls are not comparable, so the groups keep their order; within a group, by affinity.
  const rows = options.map((o, i) => ({ o, i, s: scores.get(i) ?? null }));
  const top = rows.filter((x) => x.s).sort((a, b) => a.s.group - b.s.group || b.s.score - a.s.score || a.i - b.i);
  const rest = rows.filter((x) => !x.s);
  const out = [...top, ...rest].map((x) => (x.s ? { ...x.o, taste: Number(x.s.score.toFixed(3)) } : { ...x.o }));
  return { ...role, pick: { ...role.pick, options: out, tailoring: { source: "taste", signals: signals.length, ranked: top.map((x) => x.o.name), types: ranked.map((g) => g.type) } } };
}

// The whole term as this learner should see it, and a record of what each card offered (so a later pick can say
// whether it came from a tailored card: index.mjs reads pick_offers when the cue is saved).
// Each offer also records where every tile's picture comes from (qloo, wiki, none) and the build time, for the degrees report.
export const picOf = (o) => (o.image ? "qloo" : o.wiki ? "wiki" : null);
export async function tailorTerm(term, sid, call, opts = {}) {
  const signals = opts.signals ?? signalsFor(sid);
  const roles = [];
  for (const role of term.roles ?? []) {
    if (!role.pick?.options?.length) { roles.push(role); continue; }
    const t0 = performance.now();
    const t = await tailorRole(role, signals, call, opts);
    roles.push(t);
    q.putOffer.run(sid, term.id, role.id, t.pick.tailoring.source === "taste" ? 1 : 0,
      JSON.stringify(t.pick.options.map((o) => ({ name: o.name, taste: o.taste ?? null, pic: picOf(o), wiki: o.wiki ?? null }))), JSON.stringify(signals), Date.now(),
      Math.round(performance.now() - t0));
  }
  return { ...term, roles };
}

// How a saved pick relates to the card it came from: taste (the card was ranked for this learner and Qloo scored
// this option), editorial (the packet's order, or an unscored option), own (an off-list favorite).
export function hookSourceFor(sid, term, roleId, label) {
  const role = (term.roles ?? []).find((r) => r.id === roleId);
  const option = role?.pick?.options?.find((o) => o.name === label) ?? null;
  const offer = q.getOffer.get(sid, term.id, roleId);
  const shown = offer ? JSON.parse(offer.options) : (role?.pick?.options ?? []).map((o) => ({ name: o.name, taste: null }));
  const at = shown.findIndex((s) => s.name === label);
  const shown_rank = at >= 0 ? at : null;
  if (!option) return { option: null, hook_source: "own", shown_rank };
  return { option, hook_source: offer?.tailored && shown[at]?.taste != null ? "taste" : "editorial", shown_rank };
}

// The progress line: "3 of your 4 hooks came from your taste."
export function hooksSummary(sid, termId) {
  const count = (rows) => {
    const c = { total: 0, taste: 0, editorial: 0, own: 0 };
    for (const r of rows) { c.total += r.n; if (r.hook_source in c) c[r.hook_source] += r.n; else c.editorial += r.n; }
    return c;
  };
  const term = count(q.hooksFor.all(sid, termId));
  const all = count(q.hooksAll.all(sid));
  const line = term.total ? `${term.taste} of your ${term.total} hook${term.total === 1 ? "" : "s"} came from your taste.` : null;
  return { term, all, signals: signalsFor(sid).length, min_picks: MIN_PICKS, line };
}
