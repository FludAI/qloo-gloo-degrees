// The degrees report over rows written straight into the database (degrees.mjs): seeds are not picks, a card a
// Qloo cap left editorial is counted, the fidelity of judged cards is a rate and a mean rho, and the canon-fit
// agreement itself (judge.mjs) is right on small cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-degrees-"));
const { db, q } = await import("../src/db.mjs");
const { degreesReport, degreesText } = await import("../src/degrees.mjs");
const { agreement } = await import("../src/judge.mjs");

test("agreement: Qloo's top against the judge's fits, and Spearman's rho with ties", () => {
  assert.deepEqual(agreement(["Penguin", "Aspirin"], [{ name: "Penguin", fit: 3 }, { name: "Aspirin", fit: 1 }]), { top_hit: 1, rho: 1, judge_top: ["Penguin"] });
  assert.deepEqual(agreement(["Penguin", "Aspirin"], [{ name: "Penguin", fit: 0 }, { name: "Aspirin", fit: 2 }]), { top_hit: 0, rho: -1, judge_top: ["Aspirin"] });
  assert.deepEqual(agreement(["A", "B", "C"], [{ name: "A", fit: 2 }, { name: "B", fit: 2 }, { name: "C", fit: 1 }]), { top_hit: 1, rho: 0.866, judge_top: ["A", "B"] });
  assert.deepEqual(agreement(["A", "B"], [{ name: "A", fit: 1 }, { name: "B", fit: 1 }]), { top_hit: 1, rho: 0, judge_top: ["A", "B"] }, "all equal: no order to agree with");
  assert.deepEqual(agreement(["A", "B"], [{ name: "A", fit: null }, { name: "B", fit: 2 }]), { top_hit: 0, rho: null, judge_top: ["B"] }, "one name unscored: nothing to correlate");
  assert.deepEqual(agreement(["A"], []), { top_hit: 0, rho: null, judge_top: [] });
});

test("the report: seeds apart from picks, limited cards counted, fidelity rolled up per persona and cell", () => {
  const now = Date.now();
  const sid = "a".repeat(32), real = "b".repeat(32);
  db.prepare("INSERT INTO learners (sid, created_at, qloo_level, model_arm, synthetic) VALUES (?, ?, 2, 'anthropic', 'sheldon-cooper')").run(sid, now);
  db.prepare("INSERT INTO learners (sid, created_at, qloo_level, model_arm) VALUES (?, ?, 2, 'anthropic')").run(real, now);
  for (const [name, type] of [["Star Trek", "tv_show"], ["Halo", "videogame"]]) q.addCue.run(sid, "seed", type, name, "seeded", "pick", `id-${name}`, type, 1, now, name, "seed", null);
  q.addCue.run(sid, "cholecystokinin", "chole", "Pepsi-Cola", "cola", "pick", "mock-pepsi", "brand", 1, now + 1, "Pepsi", "taste", 0);
  q.putOffer.run(sid, "cholecystokinin", "chole", 1, JSON.stringify([{ name: "Pepsi-Cola", taste: 0.9 }, { name: "Coca-Cola", taste: 0.5 }]), "[]", now, 3, null);
  q.putOffer.run(sid, "cholecystokinin", "cysto", 0, JSON.stringify([{ name: "Sister Act", taste: null }]), "[]", now, 2, "DEMO_RATE_LIMIT");
  q.putOffer.run(sid, "cholecystokinin", "in", 0, JSON.stringify([{ name: "LinkedIn", taste: null }]), "[]", now, 2, "one entity");
  q.putFit.run(sid, "cholecystokinin", "chole", "Pepsi-Cola", "Pepsi-Cola", 1, 1, "[]", "anthropic", "m", now);
  q.putFit.run(sid, "brier-score", "sound", "Breyers", "Moneyball", 0, -1, "[]", "anthropic", "m", now);
  const r = degreesReport(db, { since: now - 1000 });
  const p = r.synthetic.personas.find((x) => x.persona === "sheldon-cooper");
  assert.deepEqual([p.seeds, p.picks, p.cards, p.tailored_cards, p.limited_cards, p.unrankable_cards], [2, 1, 3, 1, 1, 1]);
  assert.deepEqual([p.fit_cards, p.fit_hits, p.fidelity, p.fidelity_rho], [2, 1, 0.5, 0]);
  const cell = r.synthetic.cells.find((c) => c.level === 2 && c.arm === "anthropic");
  assert.equal(cell.fidelity, 0.5); assert.equal(cell.seeds, 2);
  assert.equal(r.cells.find((c) => c.level === 2 && c.arm === "anthropic").fit_cards, 0, "the real cell has no judged card");
  const text = degreesText(r);
  assert.match(text, /\nsheldon-cooper +2 +anthropic +1 +2 +3 +1 +1 /); // persona, level, arm, sessions, seeds, cards, tailored, limited
  assert.match(text, /50% rho 0 \(2\)/); assert.match(text, /fidelity by degree and arm \(judged by a model/); assert.match(text, /\n2 +anthropic +1 +2 +50% +0 */);
  assert.match(text, /\blimited\b/); assert.match(text, /\bseeds\b/);
});
