// The learner graph (graph.mjs) without HTTP: nodes in order, the tag bag as a deterministic unit vector, tags
// learned once per entity through a mocked Qloo runner, snapshots only when the set grows, and the drift between them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-graph-"));
const { q, exportLearner, deleteLearner } = await import("../src/db.mjs");
const { record, nodesFor, bagOf, cosine, tasteOnly, learnerGraph, tagsFor, KINDS } = await import("../src/graph.mjs");

const learner = () => { const sid = randomBytes(16).toString("hex"); q.ensureLearner.run(sid, Date.now()); return sid; };
const TAGS = { "id-pepsi": ["urn:tag:genre:media:fiction", "urn:tag:keyword:brand:soda"], "id-twisted-sister": ["urn:tag:genre:music:heavy_metal", "urn:tag:genre:media:fiction"] };
const runner = () => { const seen = []; return { seen, call: async (op, args) => { seen.push([op, args]); const id = args.entities[0]; const t = TAGS[id];
  return t ? { status: "ok", results: t.map((urn, i) => ({ id: urn, name: urn.split(":").pop(), type: urn.split(":").slice(0, 4).join(":"), affinity: 1 - i * 0.1 })) } : { status: "empty", results: [] }; } }; };

test("nodes are recorded in order with their data; bad kinds and empty keys are ignored", () => {
  const sid = learner();
  assert.deepEqual(KINDS, ["word", "pick", "hook", "outcome"]);
  assert.ok(record(sid, "word", "cholecystokinin", "Cholecystokinin", { provisional: false, skipped: true }));
  assert.ok(record(sid, "pick", "id-pepsi", "Pepsi-Cola", { term_id: "cholecystokinin", role: "chole", type: "brand", entity_id: "id-pepsi", hook_source: "editorial" }));
  assert.ok(record(sid, "hook", "sound", "chole", { term_id: "cholecystokinin", role: "chole", sound_like: "cola" }));
  assert.ok(record(sid, "outcome", "cholecystokinin", "Cholecystokinin", { outcome: "correct", independent: true, skill: "meaning" }));
  assert.equal(record(sid, "feeling", "x", "x"), null); assert.equal(record(sid, "word", "", "x"), null); assert.equal(record("", "word", "x", "x"), null);
  const nodes = nodesFor(sid);
  assert.deepEqual(nodes.map((n) => [n.kind, n.key]), [["word", "cholecystokinin"], ["pick", "id-pepsi"], ["hook", "sound"], ["outcome", "cholecystokinin"]]);
  assert.equal(nodes[1].data.type, "brand"); assert.equal(nodes[3].data.independent, true);
  assert.equal(exportLearner(sid).learner_nodes.length, 4);
  deleteLearner(sid);
  assert.equal(nodesFor(sid).length, 0);
});

test("the bag is a unit vector over Qloo tags and Gloo's own tags, deterministic, and taste-only drops Gloo's", () => {
  const nodes = [
    { kind: "word", key: "cck", data: {} }, { kind: "hook", key: "sound", data: {} },
    { kind: "pick", key: "id-pepsi", data: { type: "brand" } }, { kind: "pick", key: "id-twisted-sister", data: { type: "artist" } },
    { kind: "outcome", key: "cck", data: { outcome: "correct", independent: true } },
  ];
  const tagsOf = (id) => (TAGS[id] ?? []).map((urn, i) => ({ urn, affinity: 1 - i * 0.1 }));
  const v = bagOf(nodes, tagsOf);
  const sq = Object.values(v).reduce((s, w) => s + w * w, 0);
  assert.ok(Math.abs(sq - 1) < 0.01, `unit length (${sq})`);
  assert.equal(Object.keys(v)[0], "urn:tag:genre:media:fiction", "the shared tag weighs most");
  assert.deepEqual(v, bagOf(nodes, tagsOf), "deterministic");
  assert.ok(v["urn:gloo:word:cck"] && v["urn:gloo:hook:sound"] && v["urn:gloo:outcome:correct:independent"] && v["urn:gloo:pick_type:brand"]);
  assert.deepEqual(Object.keys(tasteOnly(v)).sort(), ["urn:tag:genre:media:fiction", "urn:tag:genre:music:heavy_metal", "urn:tag:keyword:brand:soda"]);
  assert.equal(cosine(v, v), 1);
  assert.equal(cosine(v, {}), 0);
  assert.equal(bagOf([], tagsOf) && Object.keys(bagOf([], tagsOf)).length, 0);
});

test("learnerGraph: tags are fetched once per entity under a cap, the embedding is stored when the set grows, and the trajectory reports drift", async () => {
  const sid = learner();
  const { call, seen } = runner();
  record(sid, "word", "cholecystokinin", "Cholecystokinin", {});
  record(sid, "pick", "id-pepsi", "Pepsi-Cola", { type: "brand", entity_id: "id-pepsi" });
  const g1 = await learnerGraph(sid, call, { budget: () => 150 });
  assert.equal(seen.length, 1); assert.deepEqual(seen[0], ["entity_tags", { entities: ["id-pepsi"], limit: 10 }]);
  assert.equal(g1.entities, 1); assert.equal(g1.untagged, 0); assert.equal(g1.embedding.nodes, 2);
  assert.ok(g1.embedding.vector["urn:tag:keyword:brand:soda"] > 0);
  assert.deepEqual(g1.trajectory.map((t) => t.drift), [0]);
  assert.deepEqual(tagsFor("id-pepsi").map((t) => t.urn), TAGS["id-pepsi"]);
  // Nothing changed: no call, no new snapshot.
  const same = await learnerGraph(sid, call, { budget: () => 150 });
  assert.equal(seen.length, 1); assert.equal(same.trajectory.length, 1);
  // A second pick: one more call, a second snapshot, drift between them; an unknown entity counts as untagged and is retried next look.
  record(sid, "pick", "id-twisted-sister", "Twisted Sister", { type: "artist", entity_id: "id-twisted-sister" });
  record(sid, "pick", "id-nobody", "Nobody", { type: "brand", entity_id: "id-nobody" });
  const g2 = await learnerGraph(sid, call, { budget: () => 150 });
  assert.equal(seen.length, 3); assert.equal(g2.untagged, 1); assert.equal(g2.trajectory.length, 2);
  assert.ok(g2.trajectory[1].drift > 0 && g2.trajectory[1].drift < 1, `drift ${g2.trajectory[1].drift}`);
  assert.ok(g2.trajectory[1].taste_drift > 0);
  assert.equal(g2.nodes.length, 4); assert.equal(g2.nodes[0].kind, "word");
  // The cap: a learner with many new entities costs at most `cap` calls per look, the rest are skipped and reported.
  const many = learner();
  for (let i = 0; i < 6; i++) record(many, "pick", `id-new-${i}`, `New ${i}`, { type: "brand", entity_id: `id-new-${i}` });
  seen.length = 0;
  const g3 = await learnerGraph(many, call, { cap: 2, budget: () => 150 });
  assert.equal(seen.length, 2); assert.deepEqual(g3.calls, { calls: 2, skipped: 4 });
  seen.length = 0;
  await learnerGraph(many, call, { cap: 2, budget: () => 0 });
  assert.equal(seen.length, 0, "no budget: no call");
});
