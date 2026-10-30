// Recall by hook source and review stage (recall.mjs, degrees.mjs): one session with a taste pick and an editorial
// pick, answers at the now review and, by backdating the earlier ones in the database, at the 1-day review; the
// grid cells, the totals, the level and arm splits and the text tables; then a prompt on the whole word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-recall-"));
process.env.QLOO_MOCK = "1";
const { db, q } = await import("../src/db.mjs");
const { getTerm } = await import("../src/content/index.mjs");
const { hookSourceFor } = await import("../src/taste.mjs");
const { degreesReport, degreesText } = await import("../src/degrees.mjs");
const { answersOf, roleOfPrompt, STAGES, SOURCES } = await import("../src/recall.mjs");

const MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR;
const cck = getTerm("cholecystokinin");
const learner = (level, arm) => { const sid = randomBytes(16).toString("hex"); q.ensureLearner.run(sid, Date.now()); q.setLevel.run(level, 1, Date.now(), sid); q.setArm.run(arm, 1, sid); return sid; };
// A pick on a card: the hook source is what the app would record for it (taste.mjs hookSourceFor).
const pick = (sid, role, label) => {
  const { option, hook_source, shown_rank } = hookSourceFor(sid, cck, role, label);
  q.addCue.run(sid, cck.id, role, label, option?.connection ?? "mine", "pick", null, option?.qloo?.type ?? null, 1, Date.now(), option?.qloo?.entity ?? null, hook_source, shown_rank);
  return hook_source;
};
let n = 0;
const answer = (sid, promptId, outcome, { hinted = false } = {}) => {
  const prompt = cck.prompts.find((p) => p.id === promptId);
  const independent = outcome === "correct" && !hinted;
  q.insertAttempt.run(sid, cck.id, promptId, prompt.skill, "", outcome, hinted ? 1 : 0, independent ? 1 : 0, "1", "reviewed", `key-${++n}`, Date.now());
  return db.prepare("SELECT last_insert_rowid() AS id").get().id;
};
const backdate = (id, at) => db.prepare("UPDATE attempts SET created_at = ? WHERE id = ?").run(at, id);
const cells = (r) => Object.fromEntries(Object.entries(r.stages).map(([k, c]) => [k, `${c.independent}/${c.answers}`]));

test("prompt roles: the lesson names the part a prompt tests, the seeds' ids carry it too, a whole-word prompt has none", () => {
  assert.equal(roleOfPrompt(cck, "cck-chole"), "chole");
  assert.equal(roleOfPrompt(cck, "cck-cysto"), "cysto");
  assert.equal(roleOfPrompt(cck, "cck-function"), null, "a prompt on what CCK does is about the whole word");
  assert.equal(roleOfPrompt(cck, "cck-ectomy"), null);
  assert.equal(roleOfPrompt({ roles: [{ id: "peri" }], prompts: [{ id: "p-1-q1" }, { id: "p-1-q2", role: "peri" }] }, "p-1-q2"), "peri", "an explicit role wins");
  assert.equal(roleOfPrompt({ roles: [{ id: "peri" }], prompts: [{ id: "p-1-q1" }] }, "p-1-q1"), null, "a drafted prompt without a role is on the whole word");
  assert.equal(roleOfPrompt(cck, "no-such-prompt"), null);
  assert.equal(roleOfPrompt(getTerm("brier-score"), "brier-direction"), null);
});

test("recall by hook source and stage: a taste pick and an editorial pick, answers at the now and the 1-day review, the totals, the splits and the text", () => {
  const sid = learner(1, "anthropic");
  // The chole card was ranked for this learner and Qloo scored Pepsi: the pick is a taste hook. The cysto card was not ranked: editorial.
  q.putOffer.run(sid, cck.id, "chole", 1, JSON.stringify([{ name: "Pepsi-Cola", taste: 0.9 }, { name: "Coca-Cola", taste: 0.5 }]), "[]", Date.now(), 12);
  assert.equal(pick(sid, "chole", "Pepsi-Cola"), "taste");
  assert.equal(pick(sid, "cysto", cck.roles.find((r) => r.id === "cysto").pick.options[0].name), "editorial");
  // Three independent correct answers on the meaning skill, two days ago, move the schedule to the 1-day interval; today's answers fall at that review.
  const t0 = Date.now() - 2 * DAY;
  backdate(answer(sid, "cck-chole", "correct"), t0);                 // taste, now review
  backdate(answer(sid, "cck-cysto", "correct"), t0 + 40 * MIN);      // editorial, 30m review
  backdate(answer(sid, "cck-chole", "correct"), t0 + 5 * HOUR);      // taste, 4h review
  answer(sid, "cck-chole", "correct", { hinted: true });             // taste, 1d review, with a hint: correct but not independent
  answer(sid, "cck-cysto", "incorrect");                             // editorial, 1d review (a hinted answer leaves the stage), wrong
  const got = answersOf(db, sid);
  assert.deepEqual(got.map((a) => [a.prompt_id, a.role, a.source, a.stage, a.outcome, a.independent]), [
    ["cck-chole", "chole", "taste", "now", "correct", true], ["cck-cysto", "cysto", "editorial", "30m", "correct", true], ["cck-chole", "chole", "taste", "4h", "correct", true],
    ["cck-chole", "chole", "taste", "1d", "correct", false], ["cck-cysto", "cysto", "editorial", "1d", "incorrect", false]]);

  const report = degreesReport(db, { since: Date.now() - HOUR });
  const { recall } = report;
  assert.deepEqual(recall.stages, STAGES); assert.deepEqual(STAGES, ["now", "30m", "4h", "1d", "3d", "7d"]);
  assert.deepEqual(recall.sources.map((r) => r.source), SOURCES, "the four rows are always there, in order");
  const taste = recall.sources.find((r) => r.source === "taste"), editorial = recall.sources.find((r) => r.source === "editorial");
  assert.deepEqual(taste.stages.now, { correct: 1, independent: 1, answers: 1 });
  assert.deepEqual(taste.stages["1d"], { correct: 1, independent: 0, answers: 1 });
  assert.deepEqual(cells(taste), { now: "1/1", "30m": "0/0", "4h": "1/1", "1d": "0/1", "3d": "0/0", "7d": "0/0" });
  assert.deepEqual(taste.total, { correct: 3, independent: 2, answers: 3 });
  assert.deepEqual(cells(editorial), { now: "0/0", "30m": "1/1", "4h": "0/0", "1d": "0/1", "3d": "0/0", "7d": "0/0" });
  assert.deepEqual(editorial.total, { correct: 1, independent: 1, answers: 2 });
  for (const s of ["own", "whole word"]) assert.deepEqual(recall.sources.find((r) => r.source === s).total, { correct: 0, independent: 0, answers: 0 });
  // By level and by arm: only the combinations with answers, labelled.
  assert.deepEqual(recall.by_level.map((r) => [r.level, r.degree, r.source, r.total.independent, r.total.answers]), [[1, "rerank", "taste", 2, 3], [1, "rerank", "editorial", 1, 2]]);
  assert.deepEqual(recall.by_arm.map((r) => [r.arm, r.source, r.total.independent, r.total.answers]), [["anthropic", "taste", 2, 3], ["anthropic", "editorial", 1, 2]]);
  assert.match(recall.note, /taste: the card was ranked for this learner and Qloo scored the picked option/);
  assert.match(recall.note, /stage: the review the answer fell in/);
  // The earlier sections are untouched by the new one.
  assert.equal(report.levels.find((l) => l.level === 1).answers, 5);
  assert.deepEqual(Object.keys(report), ["since", "sessions", "levels", "models", "cells", "recall"]);

  const text = degreesText(report);
  const after = text.slice(text.indexOf("by degree and arm"));
  assert.ok(after.indexOf("recall by hook source\n") > 0, "the new sections come after the cells");
  const section = (title) => after.slice(after.indexOf(`${title}\n`)).split("\n\n")[0].split("\n");
  const main = section("recall by hook source");
  assert.match(main[1], /^hook +now +30m +4h +1d +3d +7d +total\s*$/);
  assert.match(main[3], /^taste +1\/1 +- +1\/1 +0\/1 +- +- +2\/3\s*$/);
  assert.match(main[4], /^editorial +- +1\/1 +- +0\/1 +- +- +1\/2\s*$/);
  assert.match(main[5], /^own +- +- +- +- +- +- +-\s*$/);
  assert.match(main[6], /^whole word +- +- +- +- +- +- +-\s*$/);
  const byLevel = section("recall by hook source and degree");
  assert.match(byLevel[1], /^level +hook +now /); assert.match(byLevel[3], /^1 +taste +1\/1 +- +1\/1 +0\/1 +- +- +2\/3\s*$/); assert.equal(byLevel.length, 5);
  const byArm = section("recall by hook source and arm");
  assert.match(byArm[3], /^anthropic +taste +1\/1 /); assert.match(byArm[4], /^anthropic +editorial +- +1\/1 /);
  assert.match(text, /\ncells: independent correct answers \/ answers at that review stage, "-" where none was answered; stage: .*; taste: the card was ranked for this learner and Qloo scored the picked option; /);
  assert.ok(text.indexOf("1st-tile: picks of the first tile") > text.indexOf("recall by hook source and arm"), "the old footnote still closes the report");
});

test("a whole-word prompt counts under 'whole word' whatever the picks; a part prompt before any pick counts under 'no pick'; the pick's own hook stays its own", () => {
  const sid = learner(2, "muse");
  assert.equal(pick(sid, "kin", "My own kinetic thing"), "own");
  answer(sid, "cck-function", "correct");            // the whole word, now review
  answer(sid, "cck-kin", "correct");                 // own, 30m review (one independent answer before it on the meaning skill)
  answer(sid, "cck-cystitis", "incorrect");          // transfer skill: its own schedule, so the now review; no single part
  answer(sid, "cck-cysto", "correct");               // a part with no pick yet
  const got = answersOf(db, sid);
  assert.deepEqual(got.map((a) => [a.prompt_id, a.source, a.stage, a.independent]), [["cck-function", "whole word", "now", true], ["cck-kin", "own", "30m", true], ["cck-cystitis", "whole word", "now", false], ["cck-cysto", "no pick", "4h", true]]);
  const { recall } = degreesReport(db, { since: Date.now() - HOUR });
  const whole = recall.sources.find((r) => r.source === "whole word");
  assert.deepEqual(cells(whole), { now: "1/2", "30m": "0/0", "4h": "0/0", "1d": "0/0", "3d": "0/0", "7d": "0/0" });
  assert.deepEqual(whole.total, { correct: 1, independent: 1, answers: 2 });
  assert.deepEqual(recall.sources.find((r) => r.source === "own").total, { correct: 1, independent: 1, answers: 1 });
  assert.deepEqual(recall.sources.map((r) => r.source), [...SOURCES, "no pick"], "a source outside the four follows them");
  assert.deepEqual(recall.by_level.filter((r) => r.level === 2).map((r) => [r.source, r.total.answers]), [["own", 1], ["whole word", 2], ["no pick", 1]]);
  assert.deepEqual(recall.by_arm.filter((r) => r.arm === "muse").map((r) => r.source), ["own", "whole word", "no pick"]);
  const text = degreesText(degreesReport(db, { since: Date.now() - HOUR }));
  assert.match(text, /\nwhole word +1\/2 +- +- +- +- +- +1\/2\s*\n/);
  assert.match(text, /\nno pick +- +- +1\/1 +- +- +- +1\/1\s*\n/);
  assert.match(text, /\n2 +whole word +1\/2 /); assert.match(text, /\nmuse +own +- +1\/1 /);
});
