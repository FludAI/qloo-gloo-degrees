// SQLite via Node's built-in node:sqlite (no native build step; works on Windows).
// Local: server/data/gloo.db. Cloud Run: set DB_PATH (see docs/DEPLOY.md for durability notes).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH as path } from "./snapshot.mjs";

if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
export const db = new DatabaseSync(path);
// How many writing statements ran on this connection (snapshot.mjs: a newer snapshot may replace the database
// only while this is 0). Every module prepares its statements through db.prepare, so the count is complete.
export const writes = { n: 0 };
{
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = prepare(sql);
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) { const run = st.run.bind(st); st.run = (...a) => { writes.n++; return run(...a); }; }
    return st;
  };
}

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS learners (sid TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS first_attempts (
  sid TEXT NOT NULL, term_id TEXT NOT NULL, response TEXT, skipped INTEGER NOT NULL, content_version TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (sid, term_id));
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, sid TEXT NOT NULL, term_id TEXT NOT NULL, prompt_id TEXT NOT NULL, skill TEXT NOT NULL,
  response TEXT, outcome TEXT NOT NULL, hinted INTEGER NOT NULL, independent INTEGER NOT NULL,
  content_version TEXT, review_status TEXT, idem_key TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (sid, idem_key));
CREATE TABLE IF NOT EXISTS hint_exposures (sid TEXT NOT NULL, prompt_id TEXT NOT NULL, created_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS learner_cues (
  id INTEGER PRIMARY KEY, sid TEXT NOT NULL, term_id TEXT NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL,
  connection TEXT NOT NULL, source TEXT NOT NULL, qloo_entity_id TEXT, qloo_type TEXT, recognized INTEGER NOT NULL,
  removed_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provisional_terms (
  id TEXT PRIMARY KEY, sid TEXT NOT NULL, word TEXT NOT NULL, origin TEXT NOT NULL, packet TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resolutions (
  id INTEGER PRIMARY KEY, sid TEXT NOT NULL, mode TEXT NOT NULL, input TEXT NOT NULL, resolved TEXT, term_id TEXT,
  method TEXT, score REAL, decision TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pick_offers (
  sid TEXT NOT NULL, term_id TEXT NOT NULL, role TEXT NOT NULL, tailored INTEGER NOT NULL, options TEXT NOT NULL, signals TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (sid, term_id, role));
CREATE TABLE IF NOT EXISTS beacons (id INTEGER PRIMARY KEY, sid TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learner_nodes (
  id INTEGER PRIMARY KEY, sid TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, label TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS learner_nodes_sid ON learner_nodes (sid, created_at);
CREATE TABLE IF NOT EXISTS learner_embeddings (
  id INTEGER PRIMARY KEY, sid TEXT NOT NULL, nodes INTEGER NOT NULL, dims INTEGER NOT NULL, vector TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learner_briefs (sid TEXT PRIMARY KEY, text TEXT NOT NULL, facts TEXT NOT NULL, nodes INTEGER NOT NULL, chars INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provider_calls (
  id INTEGER PRIMARY KEY, sid TEXT, provider TEXT NOT NULL, op TEXT NOT NULL, status TEXT NOT NULL, cache TEXT, duration_ms REAL, created_at INTEGER NOT NULL);
`);

// Demo passcode gate: one flag per server-issued session.
if (!db.prepare("PRAGMA table_info(learners)").all().some((c) => c.name === "unlocked")) {
  db.exec("ALTER TABLE learners ADD COLUMN unlocked INTEGER NOT NULL DEFAULT 0");
}

if (!db.prepare("PRAGMA table_info(first_attempts)").all().some((c) => c.name === "pieces")) {
  db.exec("ALTER TABLE first_attempts ADD COLUMN pieces TEXT");
}

// The taste loop (taste.mjs): which packet entity a pick stands for, whether the card it came from was ranked
// for this learner (hook_source: taste | editorial | own), and where on the card the pick sat.
{
  const cols = db.prepare("PRAGMA table_info(learner_cues)").all().map((c) => c.name);
  for (const [col, type] of [["qloo_entity", "TEXT"], ["hook_source", "TEXT"], ["shown_rank", "INTEGER"]]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE learner_cues ADD COLUMN ${col} ${type}`);
  }
}

// Degrees of Qloo (level.mjs): how much Qloo shapes this learner's lessons, drawn once per session or forced
// with ?qloo=N; and on each offered card, how long the server took to build it.
{
  const cols = db.prepare("PRAGMA table_info(learners)").all().map((c) => c.name);
  for (const [col, type] of [["qloo_level", "INTEGER"], ["qloo_forced", "INTEGER NOT NULL DEFAULT 0"], ["qloo_level_at", "INTEGER"], ["model_arm", "TEXT"], ["model_forced", "INTEGER NOT NULL DEFAULT 0"]]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE learners ADD COLUMN ${col} ${type}`);
  }
  if (!db.prepare("PRAGMA table_info(pick_offers)").all().some((c) => c.name === "build_ms")) db.exec("ALTER TABLE pick_offers ADD COLUMN build_ms REAL");
  // Model calls (providers.mjs): which model answered, what it cost in tokens, and whether the arm asked for fell back.
  const calls = db.prepare("PRAGMA table_info(provider_calls)").all().map((c) => c.name);
  for (const [col, type] of [["model", "TEXT"], ["tokens_in", "INTEGER"], ["tokens_out", "INTEGER"], ["fallback_from", "TEXT"], ["stop", "TEXT"], ["note", "TEXT"], ["brief", "INTEGER"]]) {
    if (!calls.includes(col)) db.exec(`ALTER TABLE provider_calls ADD COLUMN ${col} ${type}`);
  }
}

export const q = {
  addBeacon: db.prepare("INSERT INTO beacons (sid, event, data, created_at) VALUES (?, ?, ?, ?)"),
  ensureLearner: db.prepare("INSERT OR IGNORE INTO learners (sid, created_at) VALUES (?, ?)"),
  isUnlocked: db.prepare("SELECT unlocked FROM learners WHERE sid = ?"),
  unlock: db.prepare("UPDATE learners SET unlocked = 1 WHERE sid = ?"),
  getLevel: db.prepare("SELECT qloo_level, qloo_forced, qloo_level_at, model_arm, model_forced FROM learners WHERE sid = ?"),
  setLevel: db.prepare("UPDATE learners SET qloo_level = ?, qloo_forced = ?, qloo_level_at = ? WHERE sid = ?"),
  setArm: db.prepare("UPDATE learners SET model_arm = ?, model_forced = ? WHERE sid = ?"),
  getFirst: db.prepare("SELECT * FROM first_attempts WHERE sid = ? AND term_id = ?"),
  putFirst: db.prepare("INSERT OR IGNORE INTO first_attempts (sid, term_id, response, skipped, content_version, created_at, pieces) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  attemptByKey: db.prepare("SELECT * FROM attempts WHERE sid = ? AND idem_key = ?"),
  insertAttempt: db.prepare(`INSERT INTO attempts (sid, term_id, prompt_id, skill, response, outcome, hinted, independent, content_version, review_status, idem_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  provisionalById: db.prepare("SELECT * FROM provisional_terms WHERE id = ? AND sid = ?"),
  provisionalByWord: db.prepare("SELECT * FROM provisional_terms WHERE sid = ? AND word = ?"),
  provisionalAnyById: db.prepare("SELECT * FROM provisional_terms WHERE id = ?"), // owner promotion only; never a learner route

  provisionalFor: db.prepare("SELECT id, word, origin, packet FROM provisional_terms WHERE sid = ? ORDER BY created_at"),
  addProvisional: db.prepare("INSERT INTO provisional_terms (id, sid, word, origin, packet, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  logResolution: db.prepare(`INSERT INTO resolutions (sid, mode, input, resolved, term_id, method, score, decision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  attemptsFor: db.prepare("SELECT * FROM attempts WHERE sid = ? AND term_id = ? ORDER BY created_at, id"),
  openHint: db.prepare("SELECT rowid FROM hint_exposures WHERE sid = ? AND prompt_id = ? AND consumed = 0 LIMIT 1"),
  addHint: db.prepare("INSERT INTO hint_exposures (sid, prompt_id, created_at) VALUES (?, ?, ?)"),
  consumeHints: db.prepare("UPDATE hint_exposures SET consumed = 1 WHERE sid = ? AND prompt_id = ?"),
  cuesFor: db.prepare("SELECT id, term_id, role, label, connection, source, qloo_entity_id, qloo_type, hook_source, shown_rank, created_at FROM learner_cues WHERE sid = ? AND term_id = ? AND removed_at IS NULL ORDER BY created_at"),
  addCue: db.prepare(`INSERT INTO learner_cues (sid, term_id, role, label, connection, source, qloo_entity_id, qloo_type, recognized, created_at, qloo_entity, hook_source, shown_rank)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  // Taste signals: the distinct public entities behind this learner's favorite picks, newest first (ID when known, else the packet's name).
  // What the learner said they like, as names, newest first: the packet's entity when the pick was on the card, else their own word.
  pickNames: db.prepare("SELECT label, qloo_entity FROM learner_cues WHERE sid = ? AND removed_at IS NULL AND source = 'pick' ORDER BY created_at DESC LIMIT 20"),
  pickSignals: db.prepare(`SELECT qloo_entity_id, qloo_entity, qloo_type, MAX(created_at) AS at FROM learner_cues
    WHERE sid = ? AND removed_at IS NULL AND source = 'pick' AND (qloo_entity_id IS NOT NULL OR qloo_entity IS NOT NULL)
    GROUP BY COALESCE(qloo_entity_id, qloo_entity) ORDER BY at DESC LIMIT 10`),
  putOffer: db.prepare("INSERT OR REPLACE INTO pick_offers (sid, term_id, role, tailored, options, signals, at, build_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  getOffer: db.prepare("SELECT tailored, options, signals, at FROM pick_offers WHERE sid = ? AND term_id = ? AND role = ?"),
  hooksFor: db.prepare("SELECT hook_source, COUNT(*) AS n FROM learner_cues WHERE sid = ? AND term_id = ? AND removed_at IS NULL AND source = 'pick' GROUP BY hook_source"),
  hooksAll: db.prepare("SELECT hook_source, COUNT(*) AS n FROM learner_cues WHERE sid = ? AND removed_at IS NULL AND source = 'pick' GROUP BY hook_source"),
  editCue: db.prepare("UPDATE learner_cues SET connection = ? WHERE id = ? AND sid = ? AND removed_at IS NULL"),
  removeCue: db.prepare("UPDATE learner_cues SET removed_at = ? WHERE id = ? AND sid = ?"),
  logCall: db.prepare("INSERT INTO provider_calls (sid, provider, op, status, cache, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  logModel: db.prepare("INSERT INTO provider_calls (sid, provider, op, status, cache, duration_ms, created_at, model, tokens_in, tokens_out, fallback_from, stop, note, brief) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  callCounts: db.prepare("SELECT provider, status, COUNT(*) AS n FROM provider_calls WHERE sid = ? GROUP BY provider, status"),
};

export function exportLearner(sid) {
  const all = (t) => db.prepare(`SELECT * FROM ${t} WHERE sid = ?`).all(sid);
  return { first_attempts: all("first_attempts"), attempts: all("attempts"), learner_cues: all("learner_cues"),
    provisional_terms: all("provisional_terms"), resolutions: all("resolutions"), provider_calls: all("provider_calls"), pick_offers: all("pick_offers"),
    learner_nodes: all("learner_nodes"), learner_embeddings: all("learner_embeddings"), learner_briefs: all("learner_briefs") };
}

export function deleteLearner(sid) {
  db.exec("BEGIN");
  try {
    for (const t of ["first_attempts", "attempts", "hint_exposures", "learner_cues", "provisional_terms", "resolutions", "provider_calls", "pick_offers", "learner_nodes", "learner_embeddings", "learner_briefs", "learners"]) {
      db.prepare(`DELETE FROM ${t} WHERE sid = ?`).run(sid);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
