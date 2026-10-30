// The database snapshot (snapshot.mjs) through a local media store: the round trip, the sidecar, an unchanged
// snapshot skipped, a newer local file left alone, a corrupt body refused, the late re-check after boot, the
// shutdown path within its budget, the timer, and the boot entry restoring before the server opens the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-snap-media-"));
const { createStore } = await import("../src/media.mjs");
const { createSnapshotter, restoreIfNewer, KEY, SIDECAR, enabled } = await import("../src/snapshot.mjs");

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "gloo-snap-"));
const store = () => createStore({ dir: mkdtempSync(join(dir, "store-")), forceLocal: true, prefix: "degrees/" });
const quiet = { log: () => {}, warn: () => {} };
const seed = (path, rows) => {
  const d = new DatabaseSync(path);
  d.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS learners (sid TEXT PRIMARY KEY, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS qloo_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)");
  const ins = d.prepare("INSERT OR REPLACE INTO learners (sid, created_at) VALUES (?, ?)");
  for (const [sid, at] of rows) ins.run(sid, at);
  return d;
};
const sids = (d) => d.prepare("SELECT sid FROM learners ORDER BY sid").all().map((r) => r.sid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("enabled: off for an in-memory database or SNAPSHOT=0", () => {
  assert.equal(enabled(":memory:"), false); assert.equal(enabled("/tmp/x.db"), true);
  process.env.SNAPSHOT = "0"; assert.equal(enabled("/tmp/x.db"), false); delete process.env.SNAPSHOT;
});

test("round trip: a snapshot lands with its sidecar, an unchanged one is skipped, and a fresh path restores it row for row", async () => {
  const media = store();
  const a = seed(join(dir, "a.db"), [["a".repeat(32), 1], ["b".repeat(32), 2]]);
  a.prepare("INSERT INTO qloo_cache (key, value, at) VALUES (?, ?, ?)").run("describe:x", "{}", 3);
  const snap = createSnapshotter({ db: a, path: join(dir, "a.db"), media, writes: { n: 2 }, tmp: dir, now: () => 1000, revision: "rev-1", log: quiet });
  const first = await snap.take("test");
  assert.equal(first.skipped, false); assert.ok(first.size > 0); assert.equal(first.taken_at, 1000);
  const side = await media.getJson(SIDECAR);
  assert.equal(side.sha256, first.sha256); assert.equal(side.revision, "rev-1"); assert.equal(side.writes, 2); assert.equal(side.reason, "test");
  assert.deepEqual(side.tables, { learners: 2, qloo_cache: 1 });
  assert.equal(side.dailies.length, 1); assert.match(side.dailies[0].key, /^db\/daily\/gloo-\d{8}-\d{4}\.sqlite$/);
  assert.ok(await media.get(side.dailies[0].key), "the dated copy exists");
  assert.deepEqual(await snap.take("again"), { skipped: true, reason: "unchanged", sha256: first.sha256, size: first.size });
  a.prepare("INSERT INTO learners (sid, created_at) VALUES (?, ?)").run("c".repeat(32), 3);
  const second = await snap.take("timer");
  assert.equal(second.skipped, false); assert.notEqual(second.sha256, first.sha256);
  assert.equal((await media.getJson(SIDECAR)).dailies.length, 1, "no second dated copy the same day");
  // A fresh path (a new revision): the copy is put in place, checked, and reads back.
  const target = join(dir, "fresh", "gloo.db");
  const r = await restoreIfNewer({ path: target, media, log: quiet });
  assert.equal(r.restored, true); assert.equal(r.sha256, second.sha256); assert.equal(r.revision, "rev-1");
  assert.ok(existsSync(target) && !existsSync(`${target}-wal`));
  assert.deepEqual(sids(new DatabaseSync(target)), ["a".repeat(32), "b".repeat(32), "c".repeat(32)]);
  a.close();
});

test("restore leaves a newer local file alone, refuses a body whose sha differs from the sidecar, and refuses a body that is not a database", async () => {
  const media = store();
  const src = seed(join(dir, "s.db"), [["d".repeat(32), 1]]);
  const snap = createSnapshotter({ db: src, path: join(dir, "s.db"), media, tmp: dir, now: () => 5000, log: quiet });
  await snap.take();
  // Newer local file: the sidecar says 5000 ms since the epoch; a file touched now is newer.
  const local = join(dir, "local.db"); seed(local, [["e".repeat(32), 9]]).close();
  const kept = await restoreIfNewer({ path: local, media, log: quiet });
  assert.deepEqual(kept, { restored: false, reason: "local file is newer", taken_at: 5000 });
  assert.deepEqual(sids(new DatabaseSync(local)), ["e".repeat(32)]);
  // Corrupt body: the sidecar's sha does not match.
  await media.put(KEY, Buffer.from("not a database"), "application/vnd.sqlite3");
  const old = join(dir, "old.db"); seed(old, [["f".repeat(32), 1]]).close(); utimesSync(old, new Date(1), new Date(1));
  const bad = await restoreIfNewer({ path: old, media, log: quiet });
  assert.equal(bad.restored, false); assert.equal(bad.reason, "sha mismatch");
  assert.deepEqual(sids(new DatabaseSync(old)), ["f".repeat(32)], "the local file is untouched");
  // A body that matches its sidecar but is not a database: the integrity step refuses it and the local file stays.
  const side = await media.getJson(SIDECAR);
  const { createHash } = await import("node:crypto");
  await media.putJson(SIDECAR, { ...side, sha256: createHash("sha256").update("not a database").digest("hex") });
  const worse = await restoreIfNewer({ path: old, media, log: quiet });
  assert.equal(worse.restored, false); assert.match(worse.reason, /not a database|integrity|file/i);
  assert.deepEqual(sids(new DatabaseSync(old)), ["f".repeat(32)]);
  assert.ok(!existsSync(`${old}.restore`), "no leftover");
  // No snapshot at all.
  assert.deepEqual(await restoreIfNewer({ path: join(dir, "none.db"), media: store(), log: quiet }), { restored: false, reason: "no snapshot" });
  src.close();
});

test("after boot: a newer snapshot from the revision being replaced is copied in while nothing was written here, and left alone after a write", async () => {
  const media = store();
  const older = seed(join(dir, "older.db"), [["g".repeat(32), 1]]);
  await createSnapshotter({ db: older, path: join(dir, "older.db"), media, tmp: dir, now: () => 10_000, log: quiet }).take();
  older.close();
  const mine = join(dir, "mine", "gloo.db");
  assert.equal((await restoreIfNewer({ path: mine, media, log: quiet })).restored, true);
  const db = new DatabaseSync(mine);
  const writes = { n: 0 };
  const snap = createSnapshotter({ db, path: mine, media, writes, tmp: dir, now: () => 10_500, log: quiet });
  assert.deepEqual(await snap.recheckOnce(), { applied: false, reason: "nothing newer" });
  // The old revision's SIGTERM snapshot lands after this one restored.
  const newer = seed(join(dir, "newer.db"), [["g".repeat(32), 1], ["h".repeat(32), 2]]);
  await createSnapshotter({ db: newer, path: join(dir, "newer.db"), media, tmp: dir, now: () => 11_000, revision: "rev-old", log: quiet }).take("sigterm");
  newer.close();
  const r = await snap.recheckOnce();
  assert.deepEqual(r, { applied: true, taken_at: 11_000 });
  assert.deepEqual(sids(db), ["g".repeat(32), "h".repeat(32)], "copied in through the open connection");
  assert.equal(snap.last().taken_at, 11_000);
  // Written here since: a yet newer snapshot is not applied.
  const newest = seed(join(dir, "newest.db"), [["i".repeat(32), 1]]);
  await createSnapshotter({ db: newest, path: join(dir, "newest.db"), media, tmp: dir, now: () => 12_000, log: quiet }).take();
  newest.close();
  writes.n = 1;
  assert.deepEqual(await snap.recheckOnce(), { applied: false, reason: "local writes", taken_at: 12_000 });
  assert.deepEqual(sids(db), ["g".repeat(32), "h".repeat(32)]);
  db.close();
});

test("shutdown takes a last snapshot and exits; a stalled store cannot hold it past the budget; the timer snapshots on its own", async () => {
  const media = store();
  const d = seed(join(dir, "t.db"), [["j".repeat(32), 1]]);
  let exited = null;
  const snap = createSnapshotter({ db: d, path: join(dir, "t.db"), media, tmp: dir, log: quiet });
  const closed = { n: 0 };
  const r = await snap.shutdown({ server: { close: () => closed.n++ }, exit: (c) => { exited = c; } });
  assert.equal(exited, 0); assert.equal(closed.n, 1); assert.equal(r.skipped, false); assert.ok(await media.get(KEY));
  // A store whose upload never finishes: the budget ends it, the process still exits.
  const stalled = { ...media, put: () => new Promise(() => {}) };
  d.prepare("INSERT INTO learners (sid, created_at) VALUES (?, ?)").run("k".repeat(32), 2);
  exited = null;
  const s2 = await createSnapshotter({ db: d, path: join(dir, "t.db"), media: stalled, tmp: dir, log: quiet }).shutdown({ budgetMs: 150, exit: (c) => { exited = c; } });
  assert.equal(exited, 0); assert.match(s2.error, /no snapshot within 150 ms/);
  // The timer: a write, then a snapshot within a few ticks.
  const media3 = store();
  const s3 = createSnapshotter({ db: d, path: join(dir, "t.db"), media: media3, tmp: dir, log: quiet }).start({ every: 40, signals: false });
  const before = s3.last()?.sha256 ?? null; // what boot restored, until the timer looks at this database
  for (let i = 0; i < 50 && (s3.last()?.sha256 ?? null) === before; i++) await sleep(40);
  s3.stop();
  assert.notEqual(s3.last()?.sha256 ?? null, before, "the timer took a snapshot");
  assert.ok(await media3.getJson(SIDECAR));
  d.close();
});

test("boot: the entry restores the store's snapshot before the server opens the database, health says so, and the timer keeps the store current", async () => {
  const mediaDir = mkdtempSync(join(dir, "boot-media-"));
  const media = createStore({ dir: mediaDir, forceLocal: true, prefix: "degrees/" });
  const sid = "5".repeat(32);
  const src = seed(join(dir, "boot-src.db"), [[sid, Date.now()]]);
  const taken = await createSnapshotter({ db: src, path: join(dir, "boot-src.db"), media, tmp: dir, revision: "rev-seed", log: quiet }).take("seed");
  src.close();
  const dbPath = join(dir, "boot", "gloo.db");
  const PORT = 8797;
  const proc = spawn(process.execPath, [resolve(here, "../src/boot.mjs"), "--mock"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, MEDIA_LOCAL: "1", MEDIA_DIR: mediaDir, MEDIA_PREFIX: "degrees/", SNAPSHOT_EVERY_MS: "300", SNAPSHOT_RECHECK_MS: "0", ADMIN_TOKEN: "test-owner-token" },
    stdio: "ignore",
  });
  try {
    let health = null;
    for (let i = 0; i < 150 && !health; i++) {
      try { health = await (await fetch(`http://localhost:${PORT}/api/health`)).json(); } catch { await sleep(200); }
    }
    assert.ok(health, "the server came up");
    assert.equal(health.memory.snapshots, "on"); assert.equal(health.memory.every_ms, 300); assert.equal(health.memory.instances_assumed, 1);
    assert.equal(health.memory.restored_from.sha256, taken.sha256); assert.equal(health.memory.restored_from.revision, "rev-seed");
    // The seeded learner exists after the restore and the migrations.
    const b = await fetch(`http://localhost:${PORT}/api/admin/learners/${sid}/brief`, { headers: { "x-gloo-admin": "test-owner-token" } });
    assert.equal(b.status, 200); assert.equal((await b.json()).brief, null);
    const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
    assert.match(text, /^restored from the snapshot taken \d{4}-\d{2}-\d{2}T.* by rev-seed\n/);
    // A write (a new session), then the timer puts a newer snapshot in the store.
    await fetch(`http://localhost:${PORT}/api/level`);
    let side = null;
    for (let i = 0; i < 40; i++) { media.forget(SIDECAR); side = await media.getJson(SIDECAR); if (side?.taken_at > taken.taken_at) break; await sleep(150); }
    assert.ok(side?.taken_at > taken.taken_at, "a newer snapshot after the write");
    assert.ok(side.writes >= 1, `writes counted: ${side.writes}`); assert.ok(side.tables.learners >= 2, JSON.stringify(side.tables));
    const h2 = await (await fetch(`http://localhost:${PORT}/api/health`)).json();
    assert.equal(h2.memory.last_snapshot.sha256, side.sha256);
  } finally { proc.kill(); }
});
