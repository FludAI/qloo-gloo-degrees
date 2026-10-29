// Degrees of Qloo (level.mjs): a level is drawn once per learner, forcing it sticks, and level 0 suppresses
// ranking with a reason that says so, before any Qloo call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-level-"));
const { q } = await import("../src/db.mjs");
delete process.env.ANTHROPIC_API_KEY; delete process.env.META_API_KEY; delete process.env.MODEL_ARMS;
const { assignLevel, forceLevel, levelFor, levelInfo, parseLevel, LEVELS, POOL, DEGREES, armPool, assignArm, forceArm, armFor, parseArm } = await import("../src/level.mjs");
const { tailorRole, tailorTerm } = await import("../src/taste.mjs");

const learner = () => { const sid = randomBytes(16).toString("hex"); q.ensureLearner.run(sid, Date.now()); return sid; };

test("assignment: a new learner draws one of the four levels, uniformly, and keeps it", () => {
  assert.deepEqual(LEVELS, [0, 1, 2, 3]);
  assert.deepEqual(POOL, LEVELS);
  assert.equal(levelFor("no-such-sid"), null);
  const seen = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < 400; i++) seen[levelFor(learner())]++;
  assert.ok(Object.values(seen).every((n) => n > 50), `every level drawn: ${JSON.stringify(seen)}`);
  // The draw is a function of the random source, so a fixed one is deterministic.
  const a = learner();
  assert.equal(assignLevel(a, { random: () => 0.99 }), 3);
  assert.equal(assignLevel(learner(), { random: () => 0 }), 0);
  assert.equal(assignLevel(learner(), { random: () => 0.5, levels: [1, 3] }), 3);
  const info = levelInfo(a);
  assert.equal(info.level, 3); assert.equal(info.degree, "agent doorway"); assert.equal(info.forced, false); assert.ok(info.assigned_at > 0);
  assert.deepEqual(info.degrees, DEGREES);
});

test("stickiness: the level is read back unchanged; forcing it overrides and stays forced; bad values are ignored", () => {
  const a = learner();
  const first = levelFor(a);
  for (let i = 0; i < 20; i++) assert.equal(levelFor(a), first);
  assert.equal(forceLevel(a, "2"), 2);
  assert.equal(levelFor(a), 2);
  assert.equal(levelInfo(a).forced, true);
  assert.equal(forceLevel(a, "7"), null); assert.equal(forceLevel(a, "x"), null); assert.equal(forceLevel(a, ""), null);
  assert.equal(levelFor(a), 2);
  assert.deepEqual(["0", "3", 1, "4", "-1", "1.5", null, undefined, ""].map(parseLevel), [0, 3, 1, null, null, null, null, null, null]);
});

test("model arm: drawn from the keyed providers (anthropic alone without keys), forced with ?model=, sticky, and read with the level", () => {
  assert.deepEqual(armPool(), ["anthropic"], "no key anywhere: every session is on the default arm");
  const a = learner();
  assert.equal(armFor(a), "anthropic");
  process.env.META_API_KEY = "test-not-a-key";
  assert.deepEqual(armPool(), ["meta"], "only the keyed provider is drawn");
  process.env.ANTHROPIC_API_KEY = "test-not-a-key";
  assert.deepEqual(armPool(), ["anthropic", "meta"]);
  const seen = { anthropic: 0, meta: 0 };
  for (let i = 0; i < 200; i++) seen[armFor(learner())]++;
  assert.ok(seen.anthropic > 50 && seen.meta > 50, JSON.stringify(seen));
  process.env.MODEL_ARMS = "meta";
  assert.deepEqual(armPool(), ["meta"], "MODEL_ARMS overrides the keys");
  assert.equal(assignArm(learner(), { random: () => 0.9, arms: ["anthropic", "meta"] }), "meta");
  const b = learner();
  const first = armFor(b);
  for (let i = 0; i < 10; i++) assert.equal(armFor(b), first);
  assert.equal(forceArm(b, "meta"), "meta"); assert.equal(armFor(b), "meta");
  assert.equal(forceArm(b, "openai"), null); assert.equal(armFor(b), "meta");
  const info = levelInfo(b);
  assert.deepEqual(info.model, { arm: "meta", forced: true, arms: ["anthropic", "meta"], available: { anthropic: true, meta: true } });
  assert.deepEqual(["meta", "anthropic", "", null, "x"].map(parseArm), ["meta", "anthropic", null, null, null]);
  delete process.env.MODEL_ARMS; delete process.env.META_API_KEY; delete process.env.ANTHROPIC_API_KEY;
});

test("suppression: level 0 leaves every card editorial with reason 'level 0' and makes no call; level 1 ranks", async () => {
  const role = { id: "chole", part: "chole", sound_like: "cola", pick: { question: "Say your favorite cola.", options: [
    { name: "Coca-Cola", wiki: "Coca-Cola", say: ["coke"], qloo: { entity: "Coca-Cola", type: "brand" }, connection: "c" },
    { name: "Pepsi-Cola", wiki: "Pepsi", say: ["pepsi"], qloo: { entity: "Pepsi", type: "brand" }, connection: "p" } ] } };
  const signals = ["mock-a", "mock-b"];
  let calls = 0;
  const call = async () => { calls++; return { status: "ok", results: [{ entity_id: "id-pepsi", name: "Pepsi", affinity: 0.9 }, { entity_id: "id-coke", name: "Coca-Cola", affinity: 0.5 }] }; };
  const zero = await tailorRole(role, signals, call, { budget: () => 150, level: 0 });
  assert.equal(calls, 0);
  assert.deepEqual(zero.pick.tailoring, { source: "editorial", reason: "level 0" });
  assert.deepEqual(zero.pick.options.map((o) => o.name), ["Coca-Cola", "Pepsi-Cola"]);
  const one = await tailorRole(role, signals, call, { budget: () => 150, level: 1 });
  assert.equal(calls, 1);
  assert.equal(one.pick.tailoring.source, "taste");
  assert.deepEqual(one.pick.options.map((o) => o.name), ["Pepsi-Cola", "Coca-Cola"]);
  // Through the term: the offer is recorded as untailored, with the picture source and build time of each card.
  const sid = learner();
  const term = { id: "cck", roles: [role, { id: "meaning", label: "no pick" }] };
  const t = await tailorTerm(term, sid, call, { signals, budget: () => 150, level: 0 });
  assert.equal(t.roles[0].pick.tailoring.reason, "level 0");
  const offer = q.getOffer.get(sid, "cck", "chole");
  assert.equal(offer.tailored, 0);
  assert.deepEqual(JSON.parse(offer.options).map((o) => o.pic), ["wiki", "wiki"]);
  assert.equal(typeof q.db?.prepare, "undefined"); // q is the statement map, not the handle
});
