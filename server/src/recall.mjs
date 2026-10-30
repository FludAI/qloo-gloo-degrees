// Recall by hook source and review stage: the thesis metric of the degrees report. Every practice answer is
// placed on a grid: the source of the hook the learner picked for the word part the prompt tests (taste:
// the card was ranked for this learner and Qloo scored the picked option; editorial: a packet option from
// an unranked card; own: a name the learner brought; a prompt on the whole word has no part) against the
// review stage the answer fell in, derived exactly as the learner brief derives it (brief.mjs): the schedule
// the term and skill were in before the answer, from the earlier answers of the same term and skill
// (scheduler.mjs deriveSkill), named by the interval that led to it (now, 30m, 4h, 1d, 3d, 7d). The cell counts
// the answers, the correct ones, and the independent correct ones (not hinted). Sessions are cookies.
import { deriveSkill, POLICY } from "./scheduler.mjs";
import { STAGES } from "./brief.mjs";
import { getTerm } from "./content/index.mjs";
import { compilePacket } from "./lessons.mjs";

export { STAGES };
export const SOURCES = ["taste", "editorial", "own", "whole word"]; // always printed, in this order; other sources seen follow
export const WHOLE = "whole word";
export const NO_PICK = "no pick"; // a part prompt answered before any pick for that part

// The word part a prompt tests: the prompt's role when the lesson names one, else the role whose id ends the
// prompt id (cck-chole -> chole, the seeds' convention), else none: the prompt is about the whole word.
export function roleOfPrompt(term, promptId) {
  const roles = term?.roles ?? [];
  const prompt = (term?.prompts ?? []).find((p) => p.id === promptId);
  if (!prompt) return null;
  if (prompt.role && roles.some((r) => r.id === prompt.role)) return prompt.role;
  const hit = roles.find((r) => r.id && String(promptId).endsWith(`-${r.id}`));
  return hit?.id ?? null;
}

// The lesson an answer was on: a shared lesson, or this learner's own provisional draft.
const termFor = (db) => {
  const provisional = db.prepare("SELECT packet FROM provisional_terms WHERE id = ? AND sid = ?");
  const cache = new Map();
  return (sid, id) => {
    const key = `${sid}|${id}`;
    if (cache.has(key)) return cache.get(key);
    let t = getTerm(id) ?? null;
    if (!t && typeof id === "string" && id.startsWith("p-")) {
      const row = provisional.get(id, sid);
      if (row) { try { t = compilePacket(JSON.parse(row.packet)); } catch { t = null; } }
    }
    cache.set(key, t);
    return t;
  };
};

const cell = () => ({ correct: 0, independent: 0, answers: 0 });
const row = (extra) => ({ ...extra, stages: Object.fromEntries(STAGES.map((s) => [s, cell()])), total: cell() });
const count = (c, a) => { c.answers++; if (a.outcome === "correct") { c.correct++; if (a.independent) c.independent++; } };

// Every answer of one learner with its stage, hook source and the fields the grid needs.
export function answersOf(db, sid, { termOf = termFor(db) } = {}) {
  const attempts = db.prepare("SELECT term_id, prompt_id, skill, outcome, hinted, independent, created_at FROM attempts WHERE sid = ? ORDER BY created_at, id").all(sid);
  if (!attempts.length) return [];
  const picks = db.prepare("SELECT term_id, role, hook_source, created_at FROM learner_cues WHERE sid = ? AND removed_at IS NULL AND source = 'pick' ORDER BY created_at, id").all(sid);
  const prior = new Map(); // term|skill -> the earlier answers, oldest first
  return attempts.map((a) => {
    const key = `${a.term_id}|${a.skill}`;
    const before = prior.get(key) ?? [];
    const stage = before.length ? deriveSkill(before, a.created_at, POLICY).stage : 0;
    before.push({ skill: a.skill, outcome: a.outcome, independent: Boolean(a.independent), created_at: a.created_at });
    prior.set(key, before);
    const role = roleOfPrompt(termOf(sid, a.term_id), a.prompt_id);
    // The pick that stood for the part when the answer was given: the latest one made before it, else the latest at all.
    const forRole = role ? picks.filter((p) => p.term_id === a.term_id && p.role === role) : [];
    const pick = forRole.filter((p) => p.created_at <= a.created_at).pop() ?? forRole.pop() ?? null;
    const source = !role ? WHOLE : !pick ? NO_PICK : String(pick.hook_source || "editorial");
    return { term_id: a.term_id, prompt_id: a.prompt_id, skill: a.skill, role, source, stage: STAGES[Math.min(stage, STAGES.length - 1)],
      outcome: a.outcome, independent: Boolean(a.independent) && a.outcome === "correct", hinted: Boolean(a.hinted), at: a.created_at };
  });
}

// The grid over every learner given: by source; by level and source; by arm and source.
export function recallByHook(db, learners, { levelName = (l) => String(l ?? "unassigned"), termOf } = {}) {
  const bySource = new Map(SOURCES.map((s) => [s, row({ source: s })]));
  const byLevel = new Map(), byArm = new Map();
  const into = (map, key, make, a) => {
    if (!map.has(key)) map.set(key, make());
    const r = map.get(key); count(r.stages[a.stage], a); count(r.total, a);
  };
  const opts = termOf ? { termOf } : {};
  for (const { sid, level, arm } of learners) {
    for (const a of answersOf(db, sid, opts)) {
      into(bySource, a.source, () => row({ source: a.source }), a);
      into(byLevel, `${level ?? "?"}|${a.source}`, () => row({ level: level ?? null, degree: levelName(level), source: a.source }), a);
      into(byArm, `${arm ?? "unassigned"}|${a.source}`, () => row({ arm: arm ?? "unassigned", source: a.source }), a);
    }
  }
  const sourceOrder = (x, y) => (SOURCES.includes(x.source) ? SOURCES.indexOf(x.source) : 9) - (SOURCES.includes(y.source) ? SOURCES.indexOf(y.source) : 9) || x.source.localeCompare(y.source);
  return { stages: STAGES,
    sources: [...bySource.values()].sort(sourceOrder),
    by_level: [...byLevel.values()].sort((x, y) => (x.level ?? 9) - (y.level ?? 9) || sourceOrder(x, y)),
    by_arm: [...byArm.values()].sort((x, y) => String(x.arm).localeCompare(String(y.arm)) || sourceOrder(x, y)),
    note: "cells: independent correct answers / answers at that review stage, \"-\" where none was answered; stage: the review the answer fell in, derived from the earlier answers of the same word and skill as the learner brief derives it (each independent correct answer moves the schedule one interval on: now, 30m, 4h, 1d, 3d, 7d; a hinted or wrong answer leaves it); taste: the card was ranked for this learner and Qloo scored the picked option; editorial: a packet option from an unranked card; own: a name the learner brought; whole word: the prompt tests no single part; no pick: a part prompt answered with no pick for that part" };
}

// Text cells: "k/n" (independent correct over answers), "-" when nothing was answered there.
export const recallCell = (c) => (c.answers ? `${c.independent}/${c.answers}` : "-");
