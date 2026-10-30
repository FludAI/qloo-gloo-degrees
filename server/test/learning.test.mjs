// The learning record (learning.mjs): the shape of a line and its joins over rows written straight into the
// database, the guard keeping a line out, the day's file written whole and rewritten to the same bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
const DIR = mkdtempSync(join(tmpdir(), "gloo-learning-"));
process.env.MEDIA_DIR = DIR;
const { db, q } = await import("../src/db.mjs");
const { learningRecords, toLines, exportDay, dayKey, dayStart, startLearningExport } = await import("../src/learning.mjs");
const { createStore } = await import("../src/media.mjs");
const { getTerm } = await import("../src/content/index.mjs");

const media = createStore({ dir: DIR, forceLocal: true, prefix: "t/" });
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0); // 2026-10-30 noon UTC
const sid = "c".repeat(32), other = "d".repeat(32);
const draft = { id: "p-abc1234567", title: "Peristalsis", provisional: true, roles: [{ id: "peri", part: "peri", sound_like: "perry", ipa: "pɛri", meaning: "around",
  pick: { question: "Say your favorite peri.", options: [{ name: "Perrier", wiki: "Perrier", qloo: { entity: "Perrier", type: "brand", entity_id: "mock-perrier", popularity: 0.8 }, connection: "c" }, { name: "Katy Perry", wiki: "Katy Perry", qloo: { entity: "Katy Perry", type: "artist" }, connection: "c" }],
    built: { source: "qloo", candidates: 9, resolved: 1, kept: 2, rankable: ["brand"] } } }] };
// A draft whose title carries an address: the guard keeps its card out of the record.
const bad = { ...draft, id: "p-bad0000000", title: "Write to someone@example.com" };
const termOf = (s, id) => (id === draft.id && s === sid ? draft : id === bad.id ? bad : getTerm(id));

test("one line per card shown, joined: the word and part, the degree and arm and persona, the candidates, Qloo's order, the pick, the judges, the drafter's prompt version", () => {
  db.prepare("INSERT INTO learners (sid, created_at, qloo_level, model_arm, synthetic) VALUES (?, ?, 2, 'muse', 'sheldon-cooper')").run(sid, T0);
  q.addProvisional.run(draft.id, sid, "peristalsis", "ai-draft", JSON.stringify(draft), T0 + 1000);
  q.logModel.run(sid, "muse", "draft_lesson", "ok", null, 900, T0 + 900, "muse-spark-1.3", 10, 20, null, "tool_use", null, 0, "ab12cd34");
  q.putOffer.run(sid, draft.id, "peri", 1, JSON.stringify([{ name: "Perrier", taste: 0.9, pic: "qloo", wiki: "Perrier" }, { name: "Katy Perry", taste: 0.4, pic: "wiki", wiki: "Katy Perry" }]), JSON.stringify(["mock-pepsi"]), T0 + 2000, 12, null);
  q.addCue.run(sid, draft.id, "peri", "Perrier", "Perrier ≈ peri", "pick", "mock-perrier", "brand", 1, T0 + 5500, "Perrier", "taste", 0);
  q.judgeCue.run(2, "anthropic", "claude-sonnet-5-5", "perry in Perrier", 1, sid);
  q.putFit.run(sid, draft.id, "peri", "Perrier", "Perrier", 1, 1, JSON.stringify([{ name: "Perrier", fit: 3 }, { name: "Katy Perry", fit: 1 }]), "anthropic", "claude-sonnet-5-5", T0 + 6000);
  // A reviewed lesson's card on another, real session, with an off-list pick: the learner's own word never appears.
  db.prepare("INSERT INTO learners (sid, created_at, qloo_level, model_arm) VALUES (?, ?, 1, 'anthropic')").run(other, T0);
  q.putOffer.run(other, "cholecystokinin", "chole", 0, JSON.stringify([{ name: "Coca-Cola", taste: null, pic: "wiki", wiki: "Coca-Cola" }]), "[]", T0 + 3000, 1, "fewer than two picks");
  q.addCue.run(other, "cholecystokinin", "chole", "my private soda xyzzy", "because", "pick", null, null, 1, T0 + 4000, null, "own", null);
  const { records, dropped } = learningRecords(db, { since: T0, until: T0 + 10000, termOf });
  assert.equal(dropped, 0); assert.equal(records.length, 2);
  const [r, o] = records;
  assert.deepEqual([r.at, r.level, r.arm, r.persona, r.term_id, r.word, r.provisional, r.role, r.part, r.sound_like, r.ipa, r.meaning],
    ["2026-10-30T12:00:02.000Z", 2, "muse", "sheldon-cooper", draft.id, "Peristalsis", true, "peri", "peri", "perry", "pɛri", "around"]);
  assert.match(r.session, /^[a-f0-9]{12}$/); assert.ok(!JSON.stringify(records).includes(sid), "the session is an opaque hash");
  assert.deepEqual(r.candidates, [{ name: "Perrier", type: "brand", entity_id: "mock-perrier", popularity: 0.8, picture: "wiki" }, { name: "Katy Perry", type: "artist", entity_id: null, popularity: null, picture: "wiki" }]);
  assert.deepEqual(r.built, { source: "qloo", candidates: 9, resolved: 1, kept: 2, rankable: ["brand"], dropped: null });
  assert.deepEqual(r.offered, { tailored: true, reason: null, build_ms: 12, signals: 1, order: [{ name: "Perrier", affinity: 0.9, picture: "qloo" }, { name: "Katy Perry", affinity: 0.4, picture: "wiki" }] });
  assert.deepEqual(r.pick, { name: "Perrier", hook_source: "taste", shown_rank: 0, entity: "Perrier", entity_id: "mock-perrier", type: "brand", at: "2026-10-30T12:00:05.500Z", seconds_to_pick: 3.5 });
  assert.deepEqual(r.judge, { score: 2, reason: "perry in Perrier", provider: "anthropic", model: "claude-sonnet-5-5" });
  assert.deepEqual(r.fit, { qloo_top: "Perrier", judge_top: ["Perrier"], top_hit: 1, rho: 1, fits: [{ name: "Perrier", fit: 3 }, { name: "Katy Perry", fit: 1 }], provider: "anthropic", model: "claude-sonnet-5-5", at: "2026-10-30T12:00:06.000Z" });
  assert.deepEqual(r.prompt, { version: "ab12cd34", provider: "muse", model: "muse-spark-1.3", note: null });
  assert.equal(r.drafted_at, "2026-10-30T12:00:01.000Z");
  assert.deepEqual([o.word, o.persona, o.provisional, o.part, o.sound_like, o.offered.tailored, o.offered.reason, o.prompt, o.judge, o.fit], ["Cholecystokinin (CCK)", null, false, "chole", "cola", false, "fewer than two picks", null, null, null]);
  assert.deepEqual(o.pick, { name: "[own]", hook_source: "own", shown_rank: null, entity: null, entity_id: null, type: null, at: "2026-10-30T12:00:04.000Z", seconds_to_pick: 1 });
  assert.ok(!JSON.stringify(records).includes("xyzzy"), "nothing a learner typed");
  assert.equal(toLines(records).split("\n").length, 3); assert.equal(toLines([]), "");
  // The guard keeps a line out: a card whose draft title carries an address.
  q.addProvisional.run(bad.id, sid, "bad", "ai-draft", JSON.stringify(bad), T0 + 7000);
  q.putOffer.run(sid, bad.id, "peri", 0, "[]", "[]", T0 + 7500, 1, null);
  const again = learningRecords(db, { since: T0, until: T0 + 10000, termOf });
  assert.equal(again.dropped, 1); assert.equal(again.records.length, 2);
});

test("the day's file is written whole to the store and a rerun writes the same bytes; a new card changes it; the timer covers today and yesterday", async () => {
  const day = T0;
  const first = await exportDay({ db, media, termOf, day, log: { log() {} } });
  assert.deepEqual([first.key, first.day, first.lines, first.dropped, first.written], ["learning/2026-10-30.jsonl", "2026-10-30", 2, 1, true]);
  assert.equal(dayKey(day), first.key); assert.equal(dayStart(day), Date.UTC(2026, 9, 30));
  const path = join(DIR, "t", "learning", "2026-10-30.jsonl");
  assert.ok(existsSync(path));
  const bytes = readFileSync(path, "utf8");
  assert.equal(bytes.split("\n").length, 3);
  const second = await exportDay({ db, media, termOf, day: day + 3600e3, log: { log() {} } });
  assert.equal(second.written, false, "same day, same bytes, nothing rewritten"); assert.equal(readFileSync(path, "utf8"), bytes);
  q.putOffer.run(other, "cholecystokinin", "cysto", 0, JSON.stringify([{ name: "Sister Act", taste: null }]), "[]", T0 + 8000, 1, "fewer than two picks");
  const third = await exportDay({ db, media, termOf, day, log: { log() {} } });
  assert.equal(third.written, true); assert.equal(third.lines, 3);
  const empty = await exportDay({ db, media, termOf, day: T0 - 86400e3, log: { log() {} } });
  assert.deepEqual([empty.lines, empty.written, empty.bytes], [0, false, 0], "a day without cards writes nothing");
  const timer = startLearningExport({ db, media, termOf, every: 3600e3, now: () => T0 + 86400e3 + 60e3, log: { log() {}, warn() {} } });
  const runs = await timer.run();
  timer.stop();
  assert.deepEqual(runs.map((r) => [r.day, r.lines]), [["2026-10-30", 3], ["2026-10-31", 0]]);
});
