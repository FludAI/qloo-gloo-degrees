// The learner brief: one short standing paragraph per learner, computed from the learner graph's node log
// (graph.mjs: words met, picks, hook kinds, practice outcomes) and the taste bag over it. It is what the cue agent
// and the drafter read about the learner, so hooks for a new word are sought in the domains this learner already
// likes. Built from lesson ids and titles, public entity names, hook kinds, outcomes and Qloo tag names only:
// nothing the learner typed or said reaches it. `briefOf` is pure (arrays in, text out) so the store can change
// under it; the two store-touching functions at the end read the nodes and keep one row per learner.
import { nodesFor, bagOf, tagsFor } from "./graph.mjs";
import { deriveSkill, POLICY } from "./scheduler.mjs";
import { findPersonalData } from "./guard.mjs";
import { db } from "./db.mjs";

export const MAX_CHARS = Number(process.env.BRIEF_MAX_CHARS ?? 700);
export const LIMITS = { words: 8, hooks: 6, tags: 8, results: 5 };
// The review stage a practice answer fell in, named by the schedule's gap before it (scheduler.mjs POLICY).
export const STAGES = ["now", "30m", "4h", "1d", "3d", "7d"];
export const readsOn = () => process.env.BRIEF !== "0"; // BRIEF=0: briefs are still kept, no prompt reads them

const title = (s) => String(s ?? "").trim().slice(0, 60);
const tagLeaf = (urn) => String(urn).split(":").pop().replace(/_/g, " ");

// The brief of one learner from their nodes. Returns null when there is nothing to say.
export function briefOf(nodes, { tagsOf = tagsFor, max = MAX_CHARS, limits = LIMITS } = {}) {
  const list = (nodes ?? []).filter((n) => n && n.kind && n.key).map((n) => ({ ...n, data: n.data && typeof n.data === "object" ? n.data : {} }));
  if (!list.length) return null;

  // Words met, with their practice outcomes.
  const words = new Map();
  for (const n of list) {
    if (n.kind === "word") words.set(n.key, { id: n.key, title: title(n.label) || n.key, at: n.created_at, provisional: Boolean(n.data.provisional), skipped: Boolean(n.data.skipped), outcomes: [] });
  }
  const outcomes = list.filter((n) => n.kind === "outcome" && n.data.outcome).map((n) => ({
    term_id: n.key, title: title(n.label) || n.key, skill: String(n.data.skill ?? "practice"), outcome: String(n.data.outcome),
    hinted: Boolean(n.data.hinted), independent: Boolean(n.data.independent), at: n.created_at }));
  for (const o of outcomes) {
    if (!words.has(o.term_id)) words.set(o.term_id, { id: o.term_id, title: o.title, at: o.at, provisional: false, skipped: false, outcomes: [] });
    words.get(o.term_id).outcomes.push(o);
  }
  // Each answer's review stage: the schedule the term and skill were in before it (deriveSkill over the earlier answers).
  const stageOf = new Map();
  for (const [, w] of words) {
    const bySkill = new Map();
    for (const o of [...w.outcomes].sort((a, b) => a.at - b.at)) {
      const prior = bySkill.get(o.skill) ?? [];
      const stage = prior.length ? deriveSkill(prior.map((p) => ({ skill: p.skill, outcome: p.outcome, independent: p.independent, created_at: p.at })), o.at, POLICY).stage : 0;
      stageOf.set(o, STAGES[Math.min(stage, STAGES.length - 1)]);
      prior.push(o); bySkill.set(o.skill, prior);
    }
  }
  const wordLine = (w) => {
    const n = w.outcomes.length, right = w.outcomes.filter((o) => o.outcome === "correct").length, unaided = w.outcomes.some((o) => o.outcome === "correct" && o.independent);
    const how = n ? `practiced, ${right} of ${n} right${unaided ? ", recalled unaided" : ""}` : w.skipped ? "first attempt skipped" : "started";
    return `${w.title} (${w.provisional ? "drafted; " : ""}${how})`;
  };

  // Hooks: the kind of hook each pick made, and whether the term's later answers went right.
  const picks = list.filter((n) => n.kind === "pick");
  const hooks = list.filter((n) => n.kind === "hook").map((h) => {
    const pick = picks.find((p) => p.data.term_id === h.data.term_id && p.data.role === h.data.role);
    const later = outcomes.filter((o) => o.term_id === h.data.term_id && o.at > h.created_at);
    const right = later.filter((o) => o.outcome === "correct" && !o.hinted).length;
    const status = !later.length ? "untested" : right * 2 >= later.length ? "stuck" : "failed";
    return { kind: h.key, part: String(h.data.part ?? h.label ?? ""), cue: title(pick?.label) || null, term_id: h.data.term_id, status, at: h.created_at };
  });
  const hookLine = (h) => `${h.part || "?"}→${h.cue ?? "a pick"}`;

  // Taste: the top tags of the bag over the picks, by name; the pick types seen.
  const names = new Map();
  for (const p of picks) for (const t of (p.data.entity_id && tagsOf?.(String(p.data.entity_id))) || []) if (t?.urn && t.name) names.set(t.urn, String(t.name));
  const vector = bagOf(list, tagsOf);
  const tags = Object.entries(vector).filter(([k]) => k.startsWith("urn:tag:")).sort((a, b) => b[1] - a[1]).map(([k, w]) => ({ urn: k, name: names.get(k) ?? tagLeaf(k), weight: Number(w.toFixed(3)) }));
  const types = [...new Set(picks.map((p) => p.data.type).filter(Boolean))];

  const results = [...outcomes].sort((a, b) => b.at - a.at).map((o) => ({ ...o, stage: stageOf.get(o) ?? "now" }));
  const resultLine = (o) => `${o.title}: ${o.skill} ${o.outcome}${o.outcome === "correct" ? (o.hinted ? " with a hint" : " unaided") : ""} at the ${o.stage} review`;

  // The paragraph, newest first, trimmed to the cap: oldest words first, then results, then hooks, then tags.
  const kept = { words: [...words.values()].sort((a, b) => b.at - a.at).slice(0, limits.words), hooks: hooks.sort((a, b) => b.at - a.at).slice(0, limits.hooks), tags: tags.slice(0, limits.tags), results: results.slice(0, limits.results) };
  const render = () => {
    const lines = [];
    if (kept.words.length) lines.push(`Met ${words.size} word${words.size === 1 ? "" : "s"}: ${kept.words.map(wordLine).join("; ")}.`);
    const stuck = kept.hooks.filter((h) => h.status === "stuck"), failed = kept.hooks.filter((h) => h.status === "failed"), untested = kept.hooks.filter((h) => h.status === "untested");
    const byKind = (hs, verb) => ["sound", "meaning"].filter((k) => hs.some((h) => h.kind === k)).map((k) => `${k} hook${hs.filter((h) => h.kind === k).length === 1 ? "" : "s"} ${verb}: ${hs.filter((h) => h.kind === k).map(hookLine).join(", ")}`);
    const hookParts = [...byKind(stuck, "stuck"), ...byKind(failed, "failed"), ...(untested.length ? [`untested: ${untested.map(hookLine).join(", ")}`] : [])];
    if (hookParts.length) lines.push(`Hooks: ${hookParts.join("; ")}.`);
    if (kept.tags.length) lines.push(`Likes: ${kept.tags.map((t) => t.name).join(", ")}${types.length ? ` (${types.join(", ")})` : ""}.`);
    else if (picks.length) lines.push(`Picks so far: ${[...new Set(picks.map((p) => title(p.label)).filter(Boolean))].slice(0, 6).join(", ")}${types.length ? ` (${types.join(", ")})` : ""}; taste tags not computed yet.`);
    if (kept.results.length) lines.push(`Last answers: ${kept.results.map(resultLine).join("; ")}.`);
    return lines.join(" ");
  };
  let text = render();
  const order = [() => kept.words.length > 1 && kept.words.pop(), () => kept.results.length > 1 && kept.results.pop(), () => kept.hooks.length > 1 && kept.hooks.pop(), () => kept.tags.length > 3 && kept.tags.pop()];
  for (let guard = 0; text.length > max && guard < 60; guard++) {
    if (!order.some((drop) => drop())) break;
    text = render();
  }
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return { text, chars: text.length, nodes: list.length,
    facts: { words: kept.words.map((w) => ({ id: w.id, title: w.title, provisional: w.provisional, skipped: w.skipped, answers: w.outcomes.length, right: w.outcomes.filter((o) => o.outcome === "correct").length })),
      hooks: kept.hooks.map(({ at, ...h }) => h), tags: kept.tags, types, results: kept.results.map((o) => ({ term_id: o.term_id, skill: o.skill, outcome: o.outcome, hinted: o.hinted, independent: o.independent, stage: o.stage, at: o.at })) } };
}

// ---- The store side: one row per learner, replaced on each recompute (after a draft, a first attempt, a pick, an answer). ----
db.exec("CREATE TABLE IF NOT EXISTS learner_briefs (sid TEXT PRIMARY KEY, text TEXT NOT NULL, facts TEXT NOT NULL, nodes INTEGER NOT NULL, chars INTEGER NOT NULL, at INTEGER NOT NULL)");
const put = db.prepare("INSERT OR REPLACE INTO learner_briefs (sid, text, facts, nodes, chars, at) VALUES (?, ?, ?, ?, ?, ?)");
const get = db.prepare("SELECT text, facts, nodes, chars, at FROM learner_briefs WHERE sid = ?");
const drop = db.prepare("DELETE FROM learner_briefs WHERE sid = ?");

export function refreshBrief(sid) {
  if (!sid) return null;
  const b = briefOf(nodesFor(sid));
  if (!b) { drop.run(sid); return null; }
  put.run(sid, b.text, JSON.stringify(b.facts).slice(0, 4096), b.nodes, b.chars, Date.now());
  return b;
}
export function briefRow(sid) {
  const r = sid ? get.get(sid) : null;
  if (!r) return null;
  let facts = null; try { facts = JSON.parse(r.facts); } catch { /* keep null */ }
  return { text: r.text, facts, nodes: r.nodes, chars: r.chars, at: r.at };
}
// What a prompt may carry: the stored text, unless reads are off or the guard sees something personal in it
// (built from public names, it should never; a hit drops the brief for that call and the row notes it).
export function briefForPrompt(sid) {
  if (!readsOn()) return { text: null, chars: 0, dropped: false };
  const r = briefRow(sid);
  if (!r?.text) return { text: null, chars: 0, dropped: false };
  if (findPersonalData(r.text)) return { text: null, chars: 0, dropped: true };
  return { text: r.text, chars: r.chars, dropped: false };
}
