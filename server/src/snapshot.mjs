// Learner memory that survives a redeploy: the instance's SQLite file, copied whole to the media store on a timer
// and once more at SIGTERM, and put back at boot when the store's copy is newer than the local file. Everything in
// the file comes along (learners, attempts, picks, drafted lessons, the learner graph and briefs, the credits
// ledger, the Qloo cache, call rows). One instance is assumed (max-instances 1): two instances would each restore
// the same file and then diverge. The loss window is one timer interval when the instance dies without SIGTERM.
//
// The copy is SQLite's online backup (node:sqlite `backup`), consistent under WAL while the app keeps writing. The
// object is `db/gloo.sqlite` under the store's prefix with a sidecar `db/gloo.sqlite.json` (taken_at, sha256, size,
// revision, row counts) so boot can decide without downloading the body; a dated copy once a day is kept 7 days.
// boot.mjs runs restoreIfNewer() before db.mjs opens the file; index.mjs starts the timer and the SIGTERM path.
import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The database file (db.mjs opens the same path): DB_PATH, or server/data/gloo.db.
export const DB_PATH = process.env.DB_PATH ?? resolve(here, "../data/gloo.db");
export const KEY = process.env.SNAPSHOT_KEY ?? "db/gloo.sqlite";
export const SIDECAR = `${KEY}.json`;
export const EVERY_MS = Number(process.env.SNAPSHOT_EVERY_MS ?? 5 * 60e3);
export const SHUTDOWN_BUDGET_MS = Number(process.env.SNAPSHOT_SHUTDOWN_MS ?? 7000); // of Cloud Run's 10 s grace
export const RECHECK_MS = Number(process.env.SNAPSHOT_RECHECK_MS ?? 90e3); // after boot: a newer snapshot from the revision being replaced
const DAILY_MS = 24 * 3600e3, KEEP_DAILY_MS = 7 * DAILY_MS;
const COUNTED = ["learners", "attempts", "learner_cues", "provisional_terms", "learner_nodes", "learner_briefs", "credit_events", "qloo_cache", "provider_calls"];

export const enabled = (path = DB_PATH) => process.env.SNAPSHOT !== "0" && path !== ":memory:";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const mtimeOf = async (p) => { try { return (await stat(p)).mtimeMs; } catch { return 0; } };
const rm = (p) => unlink(p).catch(() => {});

let restored = null; // what boot restored: { taken_at, revision, sha256, size } or null
export const restoredFrom = () => restored;

// Before the database opens: put the store's copy in place when it is newer than the local file. Never throws;
// a bad or unreadable copy means the server starts with what it has (an empty file on a fresh revision).
export async function restoreIfNewer({ path = DB_PATH, media, log = console } = {}) {
  if (!enabled(path)) return { restored: false, reason: "off" };
  try {
    const side = await media.getJson(SIDECAR);
    if (!side?.taken_at || !side.sha256) return { restored: false, reason: "no snapshot" };
    const local = await mtimeOf(path);
    if (local && side.taken_at <= local) return { restored: false, reason: "local file is newer", taken_at: side.taken_at };
    const bytes = await media.get(KEY);
    if (!bytes) return { restored: false, reason: "snapshot body missing", taken_at: side.taken_at };
    if (sha256(bytes) !== side.sha256) return { restored: false, reason: "sha mismatch", taken_at: side.taken_at };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.restore`;
    await writeFile(tmp, bytes);
    let ok = false;
    try { const check = new DatabaseSync(tmp); try { ok = check.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok"; } finally { check.close(); } }
    catch (e) { await rm(tmp); return { restored: false, reason: `integrity check failed: ${e.message.split("\n")[0]}`, taken_at: side.taken_at }; }
    if (!ok) { await rm(tmp); return { restored: false, reason: "integrity check failed", taken_at: side.taken_at }; }
    await Promise.all([rm(`${path}-wal`), rm(`${path}-shm`)]);
    await rename(tmp, path);
    restored = { taken_at: side.taken_at, revision: side.revision ?? null, sha256: side.sha256, size: bytes.length, tables: side.tables ?? null };
    log.log(`snapshot: restored the database taken ${new Date(side.taken_at).toISOString()}${side.revision ? ` by ${side.revision}` : ""} (${bytes.length} bytes)`);
    return { restored: true, ...restored };
  } catch (e) {
    log.warn(`snapshot: restore skipped (${e.message.split("\n")[0]})`);
    return { restored: false, reason: e.message };
  }
}

// Row counts for the sidecar (tables that do not exist yet are skipped).
const countRows = (db) => Object.fromEntries(COUNTED.flatMap((t) => { try { return [[t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]]; } catch { return []; } }));
const dailyKey = (at) => { const d = new Date(at).toISOString().replace(/[-:]/g, "").slice(0, 13).toLowerCase(); return `db/daily/gloo-${d.slice(0, 8)}-${d.slice(9, 13)}.sqlite`; };

// The running side: `db` is the open database, `writes` the counter db.mjs keeps ({ n }), `media` the store.
export function createSnapshotter({ db, path = DB_PATH, media, writes = { n: 0 }, tmp = tmpdir(), now = Date.now, revision = process.env.K_REVISION ?? null, log = console }) {
  let last = restored ? { sha256: restored.sha256, taken_at: restored.taken_at, size: restored.size } : null;
  let side = null; // the sidecar as last written by this process
  let timer = null, recheck = null, taking = null;
  const tmpFile = join(tmp, `gloo-snapshot-${process.pid}.sqlite`);

  // One snapshot: back up, hash, upload when changed, write the sidecar; a daily copy when a day has passed.
  async function take(reason = "timer") {
    if (taking) return taking;
    taking = (async () => {
      const t0 = performance.now();
      await rm(tmpFile);
      await backup(db, tmpFile);
      const bytes = await readFile(tmpFile);
      await rm(tmpFile);
      const sha = sha256(bytes);
      if (last?.sha256 === sha) return { skipped: true, reason: "unchanged", sha256: sha, size: bytes.length };
      const at = now();
      const prev = side ?? (await media.getJson(SIDECAR).catch(() => null)) ?? {};
      const dailies = Array.isArray(prev.dailies) ? prev.dailies.filter((d) => d?.key && d.at) : [];
      await media.put(KEY, bytes, "application/vnd.sqlite3");
      // A dated copy once a day, kept seven days (deleted by key: the sidecar remembers what was written).
      if (!dailies.length || at - Math.max(...dailies.map((d) => d.at)) >= DAILY_MS) {
        const key = dailyKey(at);
        await media.put(key, bytes, "application/vnd.sqlite3");
        dailies.push({ key, at });
        for (const d of dailies.filter((d) => at - d.at > KEEP_DAILY_MS)) { await media.del(d.key).catch(() => {}); dailies.splice(dailies.indexOf(d), 1); }
      }
      side = { taken_at: at, size: bytes.length, sha256: sha, revision, reason, writes: writes.n, tables: countRows(db), dailies };
      await media.putJson(SIDECAR, side);
      last = { sha256: sha, taken_at: at, size: bytes.length };
      return { skipped: false, sha256: sha, size: bytes.length, taken_at: at, ms: Math.round(performance.now() - t0), reason };
    })().finally(() => { taking = null; });
    return taking;
  }

  // Right after boot, for RECHECK_MS: the revision being replaced may still write its SIGTERM snapshot after this one
  // restored. While nothing has been written here, a newer snapshot is copied in table by table (the open
  // connection stays); once this instance has written, the newer copy is left and the conflict logged.
  async function recheckOnce() {
    media.forget?.(SIDECAR); media.forget?.(KEY); // another process may have rewritten both since this one read them
    const s = await media.getJson(SIDECAR).catch(() => null);
    if (!s?.taken_at || !s.sha256 || s.taken_at <= (last?.taken_at ?? 0)) return { applied: false, reason: "nothing newer" };
    if (writes.n > 0) { log.warn(`snapshot: a newer snapshot (${new Date(s.taken_at).toISOString()}) appeared after this instance wrote ${writes.n} rows; kept the local database`); return { applied: false, reason: "local writes", taken_at: s.taken_at }; }
    const bytes = await media.get(KEY);
    if (!bytes || sha256(bytes) !== s.sha256) return { applied: false, reason: "sha mismatch", taken_at: s.taken_at };
    const src = `${path}.newer`;
    await writeFile(src, bytes);
    try {
      const check = new DatabaseSync(src);
      try { if (check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") return { applied: false, reason: "integrity check failed" }; } finally { check.close(); }
      db.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS newer`);
      try {
        const tables = db.prepare("SELECT name FROM newer.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
        const mine = new Set(db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const t of tables.filter((t) => mine.has(t))) { db.exec(`DELETE FROM main."${t}"`); db.exec(`INSERT INTO main."${t}" SELECT * FROM newer."${t}"`); }
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      } finally { db.exec("DETACH DATABASE newer"); }
    } finally { await rm(src); }
    last = { sha256: s.sha256, taken_at: s.taken_at, size: bytes.length };
    restored = { taken_at: s.taken_at, revision: s.revision ?? null, sha256: s.sha256, size: bytes.length, tables: s.tables ?? null, late: true };
    log.log(`snapshot: a newer snapshot (${new Date(s.taken_at).toISOString()}) replaced the restored database before any write here`);
    return { applied: true, taken_at: s.taken_at };
  }

  // SIGTERM: stop taking connections, one last snapshot within the budget, then exit whatever happened.
  async function shutdown({ server = null, budgetMs = SHUTDOWN_BUDGET_MS, exit = (code) => process.exit(code) } = {}) {
    if (timer) clearInterval(timer); if (recheck) clearInterval(recheck);
    try { server?.close(); } catch { /* already closed */ }
    let timeout;
    const result = await Promise.race([
      take("sigterm").catch((e) => ({ error: e.message })),
      new Promise((r) => { timeout = setTimeout(() => r({ error: `no snapshot within ${budgetMs} ms` }), budgetMs); }),
    ]);
    clearTimeout(timeout);
    if (result?.error) log.warn(`snapshot: at shutdown, ${result.error}`); else log.log(`snapshot: at shutdown, ${result.skipped ? "unchanged" : `${result.size} bytes saved`}`);
    exit(0);
    return result;
  }

  function start({ server = null, every = EVERY_MS, recheckFor = RECHECK_MS, signals = true } = {}) {
    timer = setInterval(() => take("timer").catch((e) => log.warn(`snapshot: ${e.message.split("\n")[0]}`)), every);
    timer.unref();
    if (restored && recheckFor > 0) {
      const until = now() + recheckFor;
      recheck = setInterval(async () => {
        try { const r = await recheckOnce(); if (r.applied || writes.n > 0 || now() >= until) { clearInterval(recheck); recheck = null; } }
        catch (e) { log.warn(`snapshot: recheck ${e.message.split("\n")[0]}`); }
      }, 10e3);
      recheck.unref();
    }
    if (signals) process.once("SIGTERM", () => { shutdown({ server }); });
    return api;
  }

  const api = { take, shutdown, start, recheckOnce, last: () => last, stop: () => { if (timer) clearInterval(timer); if (recheck) clearInterval(recheck); timer = recheck = null; } };
  return api;
}
