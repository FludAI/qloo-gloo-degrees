// The degrees report's built cards (degrees.mjs): per level and arm, cards built from Qloo, the median names kept,
// the share of candidates the sound bar dropped, fallbacks, and the judge's median score and share of zeros, read
// from the small record each drafted word keeps (provisional_terms.cards), in JSON and in the text table.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const { db, q } = await import("../src/db.mjs");
const { degreesReport, degreesText } = await import("../src/degrees.mjs");

const now = Date.now();
const learner = (sid, level, arm) => { q.ensureLearner.run(sid, now - 1000); q.setLevel.run(level, 0, now, sid); q.setArm.run(arm, 0, sid); };
const card = (role, extra) => ({ role, candidates: 8, cleared: 3, kept: 3, dropped: 5, fallback: null, bar: 0.75, judged: null, judge_zero: 0, judge_failed: null, ...extra });
const word = (id, sid, cards) => q.addProvisional.run(id, sid, `word-${id}`, "agent", JSON.stringify({ id, roles: [] }), now, cards ? JSON.stringify({ source: "qloo", roles: cards }) : null);

test("built cards per level and arm: counts, median kept, the bar's drop share, fallbacks, the judge's median and zero share", () => {
  learner("s-a", 2, "anthropic"); learner("s-b", 2, "anthropic"); learner("s-m", 2, "muse"); learner("s-one", 1, "anthropic");
  // Session a: two words. The first has two cards, one of them a fallback; the second was judged (one zero, four names).
  word("w1", "s-a", [card("spic"), card("per", { candidates: 10, cleared: 2, kept: 4, dropped: 8, fallback: "fewer than three names cleared the sound bar" })]);
  word("w2", "s-a", [card("chole", { candidates: 6, cleared: 4, kept: 4, dropped: 2, judged: [3, 3, 0, 2], judge_zero: 1 })]);
  // Session b: one card whose judge call failed; the bar alone stood.
  word("w3", "s-b", [card("cysto", { candidates: 4, cleared: 3, kept: 3, dropped: 1, judged: [], judge_failed: "the model was down" })]);
  // The muse arm: one card, judged clean. Degree 1 drafts have no built cards.
  word("w4", "s-m", [card("kin", { candidates: 5, cleared: 5, kept: 5, dropped: 0, judged: [2, 3, 3, 1, 2] })]);
  word("w5", "s-one", null);
  const r = degreesReport(db, { since: now - 60e3 });
  const two = r.cells.find((c) => c.level === 2 && c.arm === "anthropic");
  assert.deepEqual(two.built, { cards: 4, median_kept: 4, dropped_rate: 0.571, fallbacks: 1, judged_names: 4, median_judged: 3, judge_zero_rate: 0.25, judge_failed: 1 }); // 16 of 28 candidates dropped; kept 3,4,4,3
  const muse = r.cells.find((c) => c.level === 2 && c.arm === "muse");
  assert.deepEqual(muse.built, { cards: 1, median_kept: 5, dropped_rate: 0, fallbacks: 0, judged_names: 5, median_judged: 2, judge_zero_rate: 0, judge_failed: 0 });
  const level2 = r.levels.find((l) => l.level === 2);
  assert.deepEqual(level2.built, { cards: 5, median_kept: 4, dropped_rate: 0.485, fallbacks: 1, judged_names: 9, median_judged: 2, judge_zero_rate: 0.111, judge_failed: 1 }); // 16 of 33
  assert.deepEqual(r.levels.find((l) => l.level === 1).built, { cards: 0, median_kept: null, dropped_rate: null, fallbacks: 0, judged_names: 0, median_judged: null, judge_zero_rate: null, judge_failed: 0 });
  assert.equal(r.models.find((m) => m.arm === "anthropic").built.cards, 4);
  for (const k of ["built_cards", "kept_per_card", "judged", "judge_zero"]) assert.equal(k in two, false, `${k} is folded into built`);
  const text = degreesText(r);
  assert.match(text, /\nbuilt cards\nlevel +arm +built +kept +dropped +fallbacks +judged \(names\) +judge-0 +judge-failed\n[- ]+\n2 +anthropic +4 +4 +57% +1 +3 \(4\) +25% +1 *\n2 +muse +1 +5 +0% +0 +2 \(5\) +0% +0 *\n/);
  assert.match(text, /built cards: pick cards built from Qloo at degree 2; kept: median names kept per card; dropped: share of candidates the sound bar dropped/);
});

test("no built cards in the window: the table says none", () => {
  const text = degreesText(degreesReport(db, { since: now + 60e3 }));
  assert.match(text, /\nbuilt cards\nnone\n/);
});
