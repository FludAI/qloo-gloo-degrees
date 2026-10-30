// The learner brief (brief.mjs): the paragraph from a known node log, the review stage of each answer, the caps,
// the fallbacks, what never reaches it, and the store side (one row per learner, reads off with BRIEF=0, the guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-brief-"));
const { briefOf, refreshBrief, briefRow, briefForPrompt, STAGES, MAX_CHARS } = await import("../src/brief.mjs");
const { record } = await import("../src/graph.mjs");
const { db } = await import("../src/db.mjs");

const MIN = 60e3;
const t0 = 1_700_000_000_000;
const node = (kind, key, label, data, at) => ({ id: at, kind, key, label, data, created_at: at });
const TAGS = {
  "mock-pepsi": [{ urn: "urn:tag:genre:soft_drink", name: "Soft drinks", affinity: 0.9 }],
  "id-perrier": [{ urn: "urn:tag:genre:mineral_water", name: "Mineral water", affinity: 0.8 }, { urn: "urn:tag:genre:soft_drink", name: "Soft drinks", affinity: 0.5 }],
};
const tagsOf = (id) => TAGS[id] ?? null;
const log = () => [
  node("word", "cholecystokinin", "Cholecystokinin", { provisional: false, skipped: false, said: 3, pieces: 5 }, t0),
  node("pick", "mock-pepsi", "Pepsi-Cola", { term_id: "cholecystokinin", role: "chole", type: "brand", entity_id: "mock-pepsi", hook_source: "own", shown_rank: 0 }, t0 + 1),
  node("hook", "sound", "chole", { term_id: "cholecystokinin", role: "chole", part: "chole", sound_like: "cola" }, t0 + 2),
  node("outcome", "cholecystokinin", "Cholecystokinin", { prompt_id: "cck-chole", skill: "meaning", outcome: "correct", hinted: false, independent: true }, t0 + 3),
  node("outcome", "cholecystokinin", "Cholecystokinin", { prompt_id: "cck-chole", skill: "meaning", outcome: "correct", hinted: false, independent: true }, t0 + 31 * MIN),
  node("word", "p-1", "Peristalsis", { provisional: true, skipped: true, said: null, pieces: null }, t0 + 40 * MIN),
  node("pick", "id-perrier", "Perrier", { term_id: "p-1", role: "peri", type: "brand", entity_id: "id-perrier", hook_source: "taste", shown_rank: 1 }, t0 + 41 * MIN),
  node("hook", "meaning", "peri", { term_id: "p-1", role: "peri", part: "peri", sound_like: null }, t0 + 41 * MIN + 1),
  node("outcome", "p-1", "Peristalsis", { prompt_id: "p-1-q3", skill: "transfer", outcome: "incorrect", hinted: false, independent: false }, t0 + 42 * MIN),
];

test("the brief of a known node log: words with outcomes newest first, hooks that stuck and failed, taste tags by name, the last answers with their review stage", () => {
  const b = briefOf(log(), { tagsOf });
  assert.equal(b.text,
    "Met 2 words: Peristalsis (drafted; practiced, 0 of 1 right); Cholecystokinin (practiced, 2 of 2 right, recalled unaided). " +
    "Hooks: sound hook stuck: chole→Pepsi-Cola; meaning hook failed: peri→Perrier. " +
    "Likes: Soft drinks, Mineral water (brand). " +
    "Last answers: Peristalsis: transfer incorrect at the now review; Cholecystokinin: meaning correct unaided at the 30m review; Cholecystokinin: meaning correct unaided at the now review.");
  assert.equal(b.chars, b.text.length); assert.equal(b.nodes, 9); assert.ok(b.chars <= MAX_CHARS);
  assert.deepEqual(b.facts.words.map((w) => [w.id, w.answers, w.right, w.provisional]), [["p-1", 1, 0, true], ["cholecystokinin", 2, 2, false]]);
  assert.deepEqual(b.facts.hooks.map((h) => [h.kind, h.part, h.cue, h.status]), [["meaning", "peri", "Perrier", "failed"], ["sound", "chole", "Pepsi-Cola", "stuck"]]);
  assert.deepEqual(b.facts.tags.map((t) => t.name), ["Soft drinks", "Mineral water"]); assert.deepEqual(b.facts.types, ["brand"]);
  assert.deepEqual(b.facts.results.map((r) => [r.skill, r.outcome, r.stage]), [["transfer", "incorrect", "now"], ["meaning", "correct", "30m"], ["meaning", "correct", "now"]]);
  assert.deepEqual(STAGES, ["now", "30m", "4h", "1d", "3d", "7d"]);
});

test("review stages follow the schedule: each unaided correct answer moves the next one up a stage, a hinted one holds, an error holds", () => {
  const answers = [["correct", true], ["correct", true], ["correct", false], ["incorrect", false], ["correct", true]];
  const nodes = [node("word", "w", "Word", {}, t0), ...answers.map(([outcome, independent], i) => node("outcome", "w", "Word", { skill: "meaning", outcome, hinted: outcome === "correct" && !independent, independent }, t0 + (i + 1) * 10 * MIN))];
  const b = briefOf(nodes, { tagsOf });
  assert.deepEqual(b.facts.results.map((r) => r.stage).reverse(), ["now", "30m", "4h", "4h", "4h"]);
  assert.match(b.text, /Word \(practiced, 4 of 5 right, recalled unaided\)/);
  assert.match(b.text, /meaning correct with a hint at the 4h review/);
});

test("caps and fallbacks: a long log stays under the cap dropping the oldest words first; picks without tags are named; an empty log is nothing", () => {
  const nodes = [];
  for (let i = 0; i < 20; i++) {
    nodes.push(node("word", `w-${i}`, `Word Number ${i} With A Long Title`, { provisional: true, skipped: false }, t0 + i * MIN));
    for (let k = 0; k < 3; k++) nodes.push(node("outcome", `w-${i}`, `Word Number ${i} With A Long Title`, { skill: "meaning", outcome: k ? "correct" : "incorrect", hinted: false, independent: Boolean(k) }, t0 + i * MIN + k + 1));
  }
  const b = briefOf(nodes, { tagsOf });
  assert.ok(b.chars <= MAX_CHARS, `${b.chars} chars`);
  assert.match(b.text, /^Met 20 words: Word Number 19/); assert.ok(!b.text.includes("Word Number 0 "), "the oldest word was dropped first");
  assert.ok(b.facts.words.length < 8 && b.facts.results.length >= 1);
  const small = briefOf(nodes, { tagsOf, max: 120 });
  assert.ok(small.chars <= 120, `${small.chars}`); assert.match(small.text, /^Met 20 words: Word Number 19/);
  const untagged = briefOf([node("word", "x", "Xylem", {}, t0), node("pick", "Nile", "Nile", { term_id: "x", role: "r", type: "place", entity_id: null }, t0 + 1)], { tagsOf });
  assert.match(untagged.text, /Picks so far: Nile \(place\); taste tags not computed yet\./);
  assert.equal(briefOf([], { tagsOf }), null); assert.equal(briefOf(null), null);
});

test("nothing typed reaches the brief: a node whose data carries a learner's words is read for its named fields only", () => {
  const nodes = [
    node("word", "w", "Word", { provisional: false, skipped: false, response: "my spoken try xyzzy" }, t0),
    node("outcome", "w", "Word", { skill: "meaning", outcome: "incorrect", hinted: false, independent: false, response: "typed answer plugh" }, t0 + 1),
    node("pick", "Pepsi", "Pepsi", { term_id: "w", role: "r", type: "brand", connection: "because I said so quux" }, t0 + 2),
  ];
  const b = briefOf(nodes, { tagsOf });
  for (const s of ["xyzzy", "plugh", "quux"]) assert.ok(!b.text.includes(s) && !JSON.stringify(b.facts).includes(s), s);
});

test("the store side: one row per learner, replaced on refresh; reads off with BRIEF=0; the guard drops a brief with something personal in it", () => {
  const sid = "7".repeat(32);
  db.prepare("INSERT OR IGNORE INTO learners (sid, created_at) VALUES (?, ?)").run(sid, Date.now());
  assert.equal(refreshBrief(sid), null); assert.equal(briefRow(sid), null);
  record(sid, "word", "cholecystokinin", "Cholecystokinin", { provisional: false, skipped: true });
  const b = refreshBrief(sid);
  assert.match(b.text, /^Met 1 word: Cholecystokinin \(first attempt skipped\)\.$/);
  assert.deepEqual(briefRow(sid).text, b.text); assert.equal(briefRow(sid).nodes, 1);
  record(sid, "outcome", "cholecystokinin", "Cholecystokinin", { skill: "meaning", outcome: "correct", hinted: false, independent: true });
  assert.match(refreshBrief(sid).text, /practiced, 1 of 1 right, recalled unaided/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learner_briefs WHERE sid = ?").get(sid).n, 1);
  const p = briefForPrompt(sid);
  assert.equal(p.text, briefRow(sid).text); assert.equal(p.chars, p.text.length); assert.equal(p.dropped, false);
  process.env.BRIEF = "0";
  assert.deepEqual(briefForPrompt(sid), { text: null, chars: 0, dropped: false });
  delete process.env.BRIEF;
  db.prepare("UPDATE learner_briefs SET text = ? WHERE sid = ?").run("Met 1 word: someone@example.com (started).", sid);
  assert.deepEqual(briefForPrompt(sid), { text: null, chars: 0, dropped: true });
  assert.deepEqual(briefForPrompt(null), { text: null, chars: 0, dropped: false });
});
