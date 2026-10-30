import express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callQloo, readiness, OPERATIONS } from "./qloo.mjs";
import { findPersonalData } from "./guard.mjs";
import { cached, remember } from "./cache.mjs";
import { toItems } from "./normalize.mjs";
import { mockQloo } from "./mock.mjs";
import { take } from "./limits.mjs";
import { db, q, writes, exportLearner, deleteLearner } from "./db.mjs";
import { refreshBrief, briefRow, briefForPrompt, readsOn as briefReadsOn } from "./brief.mjs";
import { createSnapshotter, restoredFrom, enabled as snapshotsEnabled, DB_PATH, EVERY_MS as SNAPSHOT_EVERY_MS } from "./snapshot.mjs";
import { testersReport, testersText } from "./testers.mjs";
import { degreesReport, degreesText } from "./degrees.mjs";
import { assess, promptHints, bestHeard } from "./assess.mjs";
import { deriveSkill, POLICY } from "./scheduler.mjs";
import { listTerms, getTerm, findPrompt, publicTerm, publicPrompt, addTerms, reload as reloadContent, store as lessons } from "./content/index.mjs";
import { ID as LESSON_ID, readField } from "./lessons.mjs";
import { runCueAgent, runSyntheticAgent, agentMode, MODEL } from "./agent.mjs";
import { setVocabulary, resolveLocal, pickFromOcr, normalize } from "./resolve/index.mjs";
import { resolveWithLlm, draftLesson, syntheticLesson, compilePacket, suggestField } from "./drafter.mjs";
import { reviewLesson } from "./reviewer.mjs";
import { sttMode, transcribe, splitWake } from "./speech.mjs";
import { readWord } from "./reader.mjs";
import { art } from "./art.mjs";
import { ttsMode, speaker, VOICE } from "./tts.mjs";
import { media } from "./media.mjs";
import { scorePieces, termPieces } from "./resolve/pieces.mjs";
import { DOMAIN_TERMS } from "./resolve/domain-terms.mjs";
import { loadEntities, knownEntities, resolveEntity, tailorTerm, hookSourceFor, hooksSummary, signalsFor, familiarFor, MIN_PICKS, RESERVE as TASTE_RESERVE } from "./taste.mjs";
import { record as recordNode, learnerGraph } from "./graph.mjs";
import * as credits from "./credits.mjs";
import { levelFor, forceLevel, levelInfo, parseLevel, armFor, forceArm, parseArm } from "./level.mjs";
import { availability as modelAvailability, MODELS } from "./providers.mjs";
import { qlooCards, cardsRecord, CANDIDATES } from "./cards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const MOCK = process.env.QLOO_MOCK === "1" || process.argv.includes("--mock");
const PORT = Number(process.env.PORT ?? 8787);
let snapshots = null; // the snapshot timer (snapshot.mjs), once the server listens
// Hosted demo gate: camera, voice, the agent and lesson drafting spend money; reviewed lessons stay open.
const PASSCODE = String(process.env.DEMO_PASSCODE ?? "").trim();
// Owner token for the lesson API and the /edit console. Separate from the passcode; unset = owner API off.
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN ?? "").trim();

// Optional extra terms from a module outside this repo (GLOO_ENGINE_MODULE). Absent = bundled samples only.
let ENGINE = "gloo-open";
if (process.env.GLOO_ENGINE_MODULE) {
  const mod = await import(pathToFileURL(resolve(repoRoot, process.env.GLOO_ENGINE_MODULE)).href);
  addTerms(mod.terms ?? []);
  ENGINE = mod.ENGINE_NAME ?? "gloo-external";
}

// Lessons come from the store (bucket + SQLite), seeded from content/*.mjs on the first boot. After any owner
// edit the map, the resolver's vocabulary and the speech hints are rebuilt, so the learner app sees the new version.
// Recognition hints for spoken capture: every lesson title and alias, the domain list, and the wake phrase.
let SPEECH_HINTS = [];
async function refreshContent() {
  await reloadContent();
  setVocabulary(listTerms());
  SPEECH_HINTS = [...new Set(["gloo it", ...listTerms().flatMap((t) => [t.title.replace(/\s*\(.*?\)\s*/g, " ").trim(), ...(t.aliases ?? [])]), ...DOMAIN_TERMS])];
}
await refreshContent();
await loadEntities(); // Qloo IDs the packets' entities resolved to, from the media store

// A term is either a reviewed packet or this learner's own provisional draft.
function termFor(sid, id) {
  const t = getTerm(id);
  if (t) return t;
  const row = typeof id === "string" && id.startsWith("p-") ? q.provisionalById.get(id, sid) : null;
  return row ? compilePacket(JSON.parse(row.packet)) : null;
}
function promptFor(sid, promptId) {
  const found = findPrompt(promptId);
  if (found) return found;
  const m = /^(p-[a-f0-9]{10})-q\d+$/.exec(String(promptId ?? ""));
  const term = m && termFor(sid, m[1]);
  const prompt = term?.prompts.find((p) => p.id === promptId);
  return prompt ? { term, prompt } : null;
}

const app = express();
app.disable("x-powered-by");
// Media routes carry a camera crop or a few seconds of PCM; everything else stays small.
const smallJson = express.json({ limit: "32kb" });
const mediaJson = express.json({ limit: "3mb" });
app.use((req, res, next) => (["/api/glue", "/api/transcribe"].includes(req.path) ? mediaJson : smallJson)(req, res, next));

// Server-issued anonymous session. A browser-supplied learner ID is never authorization.
app.use((req, res, next) => {
  const m = /(?:^|;\s*)gloo_sid=([a-f0-9]{32})/.exec(req.headers.cookie ?? "");
  let sid = m?.[1];
  if (!sid) {
    sid = randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `gloo_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  }
  // First contact: the welcome Gloo (once per session for ever; the ledger survives "delete my data").
  if (q.ensureLearner.run(sid, Date.now()).changes === 1) credits.welcome(sid);
  req.sid = sid;
  // The degree of Qloo for this session (level.mjs): drawn at random on first contact, or forced by ?qloo=N on any
  // request (the page's own URL included), after which it sticks.
  const forced = parseLevel(Array.isArray(req.query.qloo) ? req.query.qloo[0] : req.query.qloo);
  req.level = forced != null ? forceLevel(sid, forced) : levelFor(sid);
  // The model arm the same way: ?model=meta|anthropic forces it (providers.mjs), else drawn once.
  const arm = parseArm(Array.isArray(req.query.model) ? req.query.model[0] : req.query.model);
  req.arm = arm != null ? forceArm(sid, arm) : armFor(sid);
  next();
});
// Behind Cloud Run's proxy the client address is the first forwarded hop. Only ever hashed with a secret, for the referral soft signal.
const clientIp = (req) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket?.remoteAddress || null;
const originOf = (req) => process.env.PUBLIC_URL?.replace(/\/$/, "") || `${req.headers["x-forwarded-proto"] ?? req.protocol ?? "http"}://${req.headers.host}`;

const unlocked = (sid) => !PASSCODE || Boolean(q.isUnlocked.get(sid)?.unlocked);
const locked = (res) => res.status(401).json({ error: "This demo needs a passcode for camera, voice and the agent.", code: "PASSCODE_REQUIRED" });
// The owner's token opens the gated routes too (the /edit console uses voice without a passcode).
const isOwner = (req) => { const given = String(req.headers["x-gloo-admin"] ?? "").trim(); const sha = (s) => createHash("sha256").update(s).digest(); return Boolean(ADMIN_TOKEN && given) && timingSafeEqual(sha(given), sha(ADMIN_TOKEN)); };
const gate = (req, res, next) => (unlocked(req.sid) || isOwner(req) ? next() : locked(res));

// Owner gate: x-gloo-admin must equal ADMIN_TOKEN. 401 without a header, 403 on a mismatch, 503 when the server has no token.
const admin = (req, res, next) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "The owner API isn't configured on this server (ADMIN_TOKEN).", code: "ADMIN_UNAVAILABLE" });
  const given = String(req.headers["x-gloo-admin"] ?? "").trim();
  if (!given) return res.status(401).json({ error: "Owner token required.", code: "ADMIN_TOKEN_REQUIRED" });
  const h = (s) => createHash("sha256").update(s).digest();
  if (!timingSafeEqual(h(given), h(ADMIN_TOKEN))) return res.status(403).json({ error: "That token didn't match.", code: "ADMIN_TOKEN_WRONG" });
  req.editor = String(req.headers["x-gloo-editor"] ?? "owner").trim().slice(0, 60) || "owner";
  next();
};

const blocked = (summary, code, recovery) =>
  ({ status: "error", summary, results: [], result_count: 0, error: { code, retryable: false, recovery } });

async function runQloo(sid, op, args) {
  const pii = findPersonalData(args);
  if (pii) return blocked(`Blocked: input looks like it contains a ${pii}.`, "PERSONAL_DATA_BLOCKED", "Use public cultural names and concepts only.");
  const hit = !MOCK && cached(op, args);
  if (hit) { q.logCall.run(sid, "qloo", op, hit.status, "hit", 0, Date.now()); return { ...hit, cache: "hit" }; }
  const lim = take("qloo", sid);
  if (!lim.ok) return blocked(lim.reason, "DEMO_RATE_LIMIT", "Wait, or continue with editorial cues.");
  const t0 = performance.now();
  const envelope = MOCK ? mockQloo(op, args) : await callQloo(op, args);
  q.logCall.run(sid, MOCK ? "qloo-mock" : "qloo", op, envelope.status, "miss", performance.now() - t0, Date.now());
  if (!MOCK) remember(op, args, envelope);
  return envelope;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

app.get("/api/health", wrap(async (req, res) => {
  let qloo = { mode: MOCK ? "mock" : "live", ready: false };
  if (!MOCK) {
    try { qloo.ready = (await readiness()).ready; } catch (e) { qloo = { mode: "live", ready: false, error: e.message }; }
  }
  const agent = agentMode() === "live" ? { mode: "live", model: MODEL, models: MODELS, available: modelAvailability() } : MOCK ? { mode: "synthetic" } : { mode: "unavailable" };
  const stt = MOCK ? "mock" : await sttMode();
  const [tts, mediaMode] = await Promise.all([ttsMode(), media.mode()]);
  res.json({ qloo, agent, stt, tts, voice: tts === "google" ? VOICE : null, media: mediaMode, camera: agentMode() === "live" ? "live" : MOCK ? "mock" : "unavailable",
    taste: { signals: signalsFor(req.sid).length, min_picks: MIN_PICKS, reserve: TASTE_RESERVE, entities: knownEntities() },
    gated: Boolean(PASSCODE), unlocked: unlocked(req.sid), admin: Boolean(ADMIN_TOKEN), lessons: listTerms().length, engine: ENGINE, schedule_policy: POLICY.version,
    credits: { rules: credits.RULES, welcome: credits.CONFIG.welcome, word: credits.CONFIG.word, referral: credits.CONFIG.referral },
    memory: { snapshots: snapshotsEnabled() ? "on" : "off", every_ms: SNAPSHOT_EVERY_MS, instances_assumed: 1, restored_from: restoredFrom(), last_snapshot: snapshots?.last() ?? null, brief_reads: briefReadsOn() ? "on" : "off" },
    unavailable: ["pronunciation scoring", "glasses input", "mastery bonus", "encounter detection"] });
}));

// ---- Gloo credits: balance, the ledger's recent rows and this learner's referral link ----
app.get("/api/credits", (req, res) => {
  credits.welcome(req.sid); // sessions that predate the ledger get their welcome here
  credits.sawCode(req.sid, clientIp(req));
  res.json(credits.summary(req.sid, { origin: originOf(req) }));
});
// A visitor who arrived with ?ref=<code>: record the attribution. The reward waits for their first completed word.
app.post("/api/referrals/claim", (req, res) => {
  const code = String(req.body?.code ?? "").trim().slice(0, 32);
  if (!code) return res.status(400).json({ error: "code is required" });
  res.json(credits.claim({ code, sid: req.sid, ip: clientIp(req) }));
});

// This session's degree of Qloo. The only place the learner app can read it (the info sheet shows "degree N").
app.get("/api/level", (req, res) => res.json(levelInfo(req.sid)));

app.post("/api/unlock", (req, res) => {
  if (!PASSCODE) return res.json({ unlocked: true });
  const given = String(req.body?.code ?? "").trim();
  const h = (s) => createHash("sha256").update(s.toLowerCase()).digest();
  if (!given || !timingSafeEqual(h(given), h(PASSCODE))) return res.status(403).json({ error: "That passcode didn't match.", unlocked: false });
  q.unlock.run(req.sid);
  res.json({ unlocked: true });
});

// ---- Terms (no answers ever leave the server) ----
app.get("/api/terms", (req, res) => res.json([
  ...listTerms().map((t) => ({ id: t.id, title: t.title, summary: t.summary, provisional: Boolean(t.provisional), version: t.version, review_status: t.review.status })),
  ...q.provisionalFor.all(req.sid).map((r) => { const p = JSON.parse(r.packet); return { id: r.id, title: p.title, summary: p.summary, provisional: true, origin: r.origin }; }),
]));

// The words sheet: reviewed lessons, this learner's recent words (their own drafts included), and the words
// everyone looked up most in the last seven days (shared lessons only; a learner's private draft stays theirs).
const recentWords = db.prepare("SELECT term_id, MAX(created_at) AS at FROM resolutions WHERE sid = ? AND term_id IS NOT NULL GROUP BY term_id ORDER BY at DESC LIMIT 8");
const popularWords = db.prepare("SELECT term_id, COUNT(DISTINCT sid) AS count FROM resolutions WHERE term_id IS NOT NULL AND created_at >= ? GROUP BY term_id ORDER BY count DESC, MAX(created_at) DESC LIMIT 12");
app.get("/api/words", (req, res) => {
  const brief = (t) => t && { id: t.id, title: t.title, provisional: Boolean(t.provisional) };
  const reviewed = listTerms().map(brief);
  const recent = recentWords.all(req.sid).map((r) => brief(termFor(req.sid, r.term_id))).filter(Boolean);
  const shared = new Set(listTerms().map((t) => t.id));
  const popular = popularWords.all(Date.now() - 7 * 86400e3).filter((r) => shared.has(r.term_id)).slice(0, 8).map((r) => ({ ...brief(getTerm(r.term_id)), count: r.count }));
  res.json({ reviewed, recent, popular });
});

app.get("/api/terms/:id", wrap(async (req, res) => {
  const t = termFor(req.sid, req.params.id);
  if (!t) return res.status(404).json({ error: "unknown term" });
  const first = q.getFirst.get(req.sid, t.id);
  // The lesson unlocks only after the first attempt is saved or explicitly skipped.
  if (!first) return res.json({ id: t.id, title: t.title, first_attempt: t.first_attempt, locked: true, pronunciation: t.pronunciation,
    pieces: (t.roles ?? []).filter((r) => r.part).map((r) => ({ part: r.part, say: r.say ?? null, ipa_syllables: r.ipa_syllables ?? null })) });
  // The pick cards are ranked for this learner's taste (taste.mjs): same options, the likeliest favorites first.
  // Qloo spends credit, so like the other metered paths it waits for the passcode; a locked session sees the editorial order.
  const shown = unlocked(req.sid) || isOwner(req) ? await tailorTerm(t, req.sid, (op, args) => runQloo(req.sid, op, args), { level: req.level }) : t;
  res.json({ ...publicTerm(shown), locked: false, first_attempt_record: { ...first, pieces: first.pieces ? JSON.parse(first.pieces) : null } });
}));

app.post("/api/terms/:id/first-attempt", (req, res) => {
  const t = termFor(req.sid, req.params.id);
  if (!t) return res.status(404).json({ error: "unknown term" });
  const skipped = req.body?.skipped === true;
  const response = skipped ? null : String(req.body?.response ?? "").slice(0, 400);
  if (!skipped && !response.trim()) return res.status(400).json({ error: "response or skipped is required" });
  // Background signal: which sound pieces the attempt carried. Stored, not shown yet.
  const pieces = skipped ? null : scorePieces(termPieces(t), response);
  if (q.putFirst.run(req.sid, t.id, response, skipped ? 1 : 0, String(t.version), Date.now(), pieces ? JSON.stringify(pieces) : null).changes) {
    recordNode(req.sid, "word", t.id, t.title, { provisional: Boolean(t.provisional), skipped, said: pieces?.said_count ?? null, pieces: pieces?.pieces?.length ?? null });
    refreshBrief(req.sid);
  }
  credits.activate(req.sid); // a referred learner's first word experience may be complete now
  res.json({ saved: true, pieces });
});

// ---- Gate beacons: what the client saw at the camera gate (live, denied, unavailable, slow), for the testers report ----
const BEACON_FIELDS = ["state", "source", "error", "reason", "in_app", "platform", "slow"];
app.post("/api/beacon", (req, res) => {
  const event = String(req.body?.event ?? "").slice(0, 24);
  if (!/^[a-z_]+$/.test(event)) return res.status(400).json({ error: "event is required" });
  const data = {};
  for (const k of BEACON_FIELDS) if (req.body?.[k] != null) data[k] = typeof req.body[k] === "boolean" ? req.body[k] : String(req.body[k]).slice(0, 80);
  q.addBeacon.run(req.sid, event, JSON.stringify(data), Date.now());
  res.json({ ok: true });
});

// ---- Spoken input anywhere (first attempt, practice answers): PCM in, transcript out ----
app.post("/api/transcribe", gate, wrap(async (req, res) => {
  const pcm16 = String(req.body?.pcm16 ?? "");
  if (pcm16.length < 2000) return res.status(400).json({ error: "Too short. Hold the mic and say it." });
  if (MOCK) {
    // The mock hears "bayou" first and the prompt's answer second, so the pick among readings is testable.
    const found = req.body?.prompt_id ? promptFor(req.sid, String(req.body.prompt_id)) : null;
    const alts = found ? ["bayou", String(found.prompt.answer ?? "").replace(/\.$/, "").toLowerCase()] : ["gloo it"];
    return res.json({ transcript: found ? bestHeard(found.prompt, alts[0], alts.slice(1), found.term) : alts[0], alternatives: alts.slice(1), provider: "mock", expected: found ? promptHints(found.prompt, found.term) : [] });
  }
  if ((await sttMode()) !== "google") return res.status(503).json({ error: "Server speech isn't configured.", code: "STT_UNAVAILABLE" });
  const lim = take("stt", req.sid);
  if (!lim.ok) return res.status(429).json({ error: lim.reason });
  const t0 = performance.now();
  try {
    // A practice answer names its prompt: the recognizer is told what the prompt expects, and among its
    // readings the first the prompt accepts is the one heard. The learner never sees the hints.
    const found = req.body?.prompt_id ? promptFor(req.sid, String(req.body.prompt_id)) : null;
    const expected = found ? promptHints(found.prompt, found.term) : [];
    const out = await transcribe({ pcm16, hints: SPEECH_HINTS, expected });
    if (found) out.transcript = bestHeard(found.prompt, out.transcript, out.alternatives, found.term);
    q.logCall.run(req.sid, "google-stt", "recognize", out.transcript ? "ok" : "empty", null, performance.now() - t0, Date.now());
    res.json({ ...out, provider: "google" });
  } catch (e) {
    q.logCall.run(req.sid, "google-stt", "recognize", "error", null, performance.now() - t0, Date.now());
    console.error("stt:", e.message);
    res.status(502).json({ error: "Couldn't transcribe that. Try again or type it.", code: "STT_FAILED" });
  }
}));

// ---- Qloo cue discovery ----
app.post("/api/cues/resolve", gate, wrap(async (req, res) => {
  const entity = String(req.body?.entity ?? "").trim().slice(0, 80);
  if (!entity) return res.status(400).json({ error: "entity is required" });
  const args = { entity, ...(req.body?.type ? { type: String(req.body.type) } : {}) };
  const envelope = await runQloo(req.sid, "describe", args);
  res.json({ request: { operation: "describe", args }, envelope, items: toItems(envelope) });
}));

app.post("/api/cues/agent", gate, wrap(async (req, res) => {
  const t = termFor(req.sid, req.body?.term_id);
  if (!t) return res.status(404).json({ error: "unknown term" });
  if (!q.getFirst.get(req.sid, t.id)) return res.status(409).json({ error: "save the first attempt first" });
  // No typing anywhere: when the request names nothing, the learner's own picks are what they know (names, newest first).
  const familiar = ((req.body?.familiar ?? []).map((f) => String(f).trim().slice(0, 60)).filter(Boolean).slice(0, 6));
  if (!familiar.length) familiar.push(...familiarFor(req.sid));
  if (!familiar.length) return res.status(400).json({ status: "unavailable", reason: "Pick a favorite on one card first; the agent starts from your picks.", cues: [], trace: [], calls: [] });
  const pii = findPersonalData(familiar);
  if (pii) return res.status(400).json({ error: `That looks like a ${pii}. Name public things you know, like brands, films or books.` });
  // The agent is degree 3 of Qloo (level.mjs); below it the doorway stays shut, so the degrees compare cleanly.
  if (req.level != null && req.level < 3 && !isOwner(req)) return res.status(403).json({ status: "unavailable", reason: "The agent opens at degree 3 of Qloo; this session is at a lower degree.", cues: [], trace: [], calls: [] });
  const focus = t.roles.some((r) => r.id === req.body?.role) ? String(req.body.role) : null;
  const log = [];
  const run = async (op, args) => {
    const envelope = await runQloo(req.sid, op, args);
    log.push({ request: { operation: op, args }, envelope });
    return envelope;
  };
  let result;
  if (agentMode() === "live") {
    const lim = take("agent", req.sid);
    if (!lim.ok) return res.status(429).json({ status: "limited", reason: lim.reason, cues: [], trace: [], calls: [] });
    const t0 = performance.now();
    try {
      const brief = briefForPrompt(req.sid); // the learner brief (brief.mjs) rides beside the familiar list
      result = await runCueAgent({ term: t, familiar, run, focus, provider: req.arm, sid: req.sid, brief: brief.text, briefDropped: brief.dropped });
      q.logModel.run(req.sid, result.provider ?? req.arm, "cue_agent", result.status, null, performance.now() - t0, Date.now(), result.model ?? null, result.usage?.input_tokens ?? null, result.usage?.output_tokens ?? null, result.fallback_from ?? null, null, brief.dropped ? "brief_dropped" : null, brief.chars);
    } catch (e) {
      q.logModel.run(req.sid, e.provider ?? req.arm, "cue_agent", "error", null, performance.now() - t0, Date.now(), null, null, null, null, null, null, 0);
      result = { status: "error", reason: e.status ? `Model provider error (${e.status}).` : "Model provider error.", cues: [], trace: [] };
    }
  } else if (MOCK) {
    result = await runSyntheticAgent({ term: t, familiar, run });
  } else {
    result = { status: "unavailable", reason: "The agent isn't configured on this server. Use the reviewed cues below.", cues: [], trace: [] };
  }
  // What the agent proposed is remembered for this session, so a pick of one of its cards carries the verified ID
  // (the browser's copy is not trusted) and is counted as an agent hook.
  for (const c of result.cues ?? []) proposals.set(`${req.sid}|${t.id}|${c.role}|${c.label.toLowerCase()}`, { qloo_entity_id: c.qloo_entity_id, qloo_entity_type: c.qloo_entity_type, source: c.source, connection: c.connection });
  if (proposals.size > 5000) proposals.delete(proposals.keys().next().value);
  res.json({ ...result, familiar, calls: log });
}));
const proposals = new Map();

// ---- Learner cue choices (explicit recognition required) ----
app.get("/api/learner/cues/:termId", (req, res) => res.json(q.cuesFor.all(req.sid, req.params.termId)));

// ---- Gloo it: capture -> resolve (libraries first, LLM for close calls/misses) -> lesson ----
// Modes: typed {text} · voice {text} or {pcm16, image?} · camera {image} · ocr {words} (legacy on-device OCR).
// A held mic says either the word ("cholecystokinin") or the wake phrase ("gloo it") over a framed word.
app.post("/api/glue", wrap(async (req, res) => {
  const mode = ["typed", "voice", "ocr", "camera"].includes(req.body?.mode) ? req.body.mode : "typed";
  let text = String(req.body?.text ?? "").slice(0, 120);
  let alternatives = [];
  let transcript = null;
  let captured = mode;
  const image = typeof req.body?.image === "string" && req.body.image.length > 100 ? req.body.image.slice(0, 2_000_000) : null;
  const mime = ["image/jpeg", "image/png", "image/webp"].includes(req.body?.mime) ? req.body.mime : "image/jpeg";

  if (mode === "voice" && typeof req.body?.pcm16 === "string") {
    if (!unlocked(req.sid)) return locked(res);
    if (MOCK) transcript = "gloo it";
    else {
      if ((await sttMode()) !== "google") return res.status(503).json({ error: "Server speech isn't configured.", code: "STT_UNAVAILABLE" });
      const lim = take("stt", req.sid);
      if (!lim.ok) return res.status(429).json({ error: lim.reason });
      const t0 = performance.now();
      try {
        transcript = (await transcribe({ pcm16: req.body.pcm16, hints: SPEECH_HINTS })).transcript;
        q.logCall.run(req.sid, "google-stt", "recognize", transcript ? "ok" : "empty", null, performance.now() - t0, Date.now());
      } catch (e) {
        q.logCall.run(req.sid, "google-stt", "recognize", "error", null, performance.now() - t0, Date.now());
        console.error("stt:", e.message);
        return res.status(502).json({ error: "Couldn't hear that. Try again, or tap Gloo it to read the word.", code: "STT_FAILED" });
      }
    }
  }
  if (mode === "voice") {
    const { wake, rest } = splitWake(transcript ?? text);
    if (rest) text = rest;
    else if (image) captured = "camera"; // "gloo it" over a framed word: read the frame
    else return res.status(422).json({ error: wake ? "Heard “gloo it”, but no word. Say the word, or frame it and tap Gloo it." : "Didn't catch a word. Try again or type it.", transcript });
  }

  if (captured === "camera") {
    if (!image) return res.status(400).json({ error: "image is required" });
    if (!unlocked(req.sid)) return locked(res);
    let read;
    // Mock Qloo without a model key: a fixed read. With a model key the frame goes to the session's model arm, mock Qloo or not.
    if (MOCK && agentMode() !== "live") read = { word: "cholecystokinin", alternatives: ["gallbladder"], confidence: "high" };
    else if (agentMode() !== "live") return res.status(503).json({ error: "Camera reading needs the lesson agent, which isn't configured here." });
    else {
      const lim = take("camera", req.sid);
      if (!lim.ok) return res.status(429).json({ error: lim.reason });
      const t0 = performance.now();
      try { read = await readWord({ image, mime, provider: req.arm, sid: req.sid }); }
      catch (e) { q.logModel.run(req.sid, e.provider ?? req.arm, "read_word", "error", null, performance.now() - t0, Date.now(), null, null, null, null, null, null, 0); console.error("read_word:", e.message);
        return res.status(502).json({ error: "Couldn't read the frame right now. Try again, say it, or type it." }); }
    }
    if (!read.word) return res.status(422).json({ error: "No word in the frame. Get closer and hold steady, or say it." });
    text = read.word;
    alternatives = read.alternatives;
  } else if (mode === "ocr") {
    const words = (Array.isArray(req.body?.words) ? req.body.words : String(text).split(/\s+/)).slice(0, 400).map((w) => String(w).slice(0, 60));
    const picked = pickFromOcr(words);
    if (!picked.pick) return res.status(422).json({ error: "No word found in the photo. Try again closer, or type it." });
    text = picked.pick;
    alternatives = picked.alternatives;
  }
  const pii = findPersonalData(text);
  if (pii) return res.status(400).json({ error: `That looks like a ${pii}. Gloo a word or term instead.` });

  const local = resolveLocal(text, captured === "camera" ? "typed" : mode);
  let best = local.decision === "resolved" ? local.best : null;
  if (!best && local.decision !== "resolved" && local.normalized) {
    if (agentMode() === "live" && unlocked(req.sid)) {
      const lim = take("agent", req.sid);
      if (lim.ok) {
        try { best = await resolveWithLlm(local, { provider: req.arm, sid: req.sid }); }
        catch (e) { console.error("resolve_term:", e.message); }
      }
    }
    // Without the LLM, a reasonable best guess beats a dead end; it is labeled as such.
    if (!best && local.best && local.decision === "ambiguous") best = { ...local.best, method: `${local.best.method} (best guess)` };
    if (!best && local.normalized) best = { word: local.normalized, term_id: null, score: null, method: "as captured" };
  }
  if (!best) return res.status(422).json({ error: "Nothing to gloo. Try a word or short term." });
  const method = captured === "camera" ? `camera · ${best.method}` : best.method;
  q.logResolution.run(req.sid, captured, text, best.word, best.term_id, method, best.score, local.decision, Date.now());

  // Re-check: an LLM answer may name a reviewed lesson.
  const recheck = best.term_id ? null : resolveLocal(best.word).best;
  const reviewed = getTerm(best.term_id ?? (recheck?.method === "exact" ? recheck.term_id : null));
  let termId = reviewed?.id ?? q.provisionalByWord.get(req.sid, best.word)?.id ?? null;
  let created = false, spent = null;
  if (!termId) {
    if (!unlocked(req.sid)) return locked(res);
    if (agentMode() !== "live" && !MOCK) return res.status(503).json({ error: "New words need the lesson agent, which isn't configured here. Try a reviewed lesson." });
    const lim = take("agent", req.sid);
    if (!lim.ok) return res.status(429).json({ error: lim.reason });
    // A drafted word is the one thing that costs Gloo: one per word, charged before the draft and refunded if it fails.
    // Reviewed lessons and this learner's own earlier drafts never reach here, so repeat scans are free.
    spent = credits.chargeWord(req.sid, best.word);
    if (!spent.ok) return res.status(402).json({ error: spent.message, code: "GLOO_EMPTY", balance: spent.balance, word: best.word });
    const id = `p-${randomBytes(5).toString("hex")}`;
    let packet;
    // Degree 2: the drafter names more candidates per piece and Qloo keeps the ones it knows, pictures included (cards.mjs).
    const built = req.level >= 2;
    if (agentMode() === "live") {
      const brief = briefForPrompt(req.sid); // the learner brief (brief.mjs): pick names from the domains this learner likes, first
      try { packet = await draftLesson(id, best.word, { candidates: built ? CANDIDATES : 4, provider: req.arm, sid: req.sid, brief: brief.text, briefDropped: brief.dropped }); }
      catch (e) { console.error("draft_lesson:", e.message);
        const back = credits.refundWord(req.sid, best.word);
        return res.status(502).json({ error: "Couldn't draft a lesson for that word right now. Your Gloo is back. Try again, or a reviewed lesson.", balance: back.balance }); }
    } else {
      packet = syntheticLesson(id, best.word);
    }
    if (built) packet = await qlooCards(packet, (op, args) => runQloo(req.sid, op, args), { sid: req.sid });
    q.addProvisional.run(id, req.sid, best.word, packet.origin, JSON.stringify(packet), Date.now(), built ? JSON.stringify(cardsRecord(packet)) : null);
    termId = id;
    created = true;
    refreshBrief(req.sid);
  }
  // Spoken capture of a word doubles as the first attempt, saved before anything is shown.
  if (mode === "voice" && captured === "voice" && !q.getFirst.get(req.sid, termId)) {
    const t = termFor(req.sid, termId);
    q.putFirst.run(req.sid, termId, `voice capture: "${text}" (speech-to-text transcript, not a pronunciation score)`, 0, String(t.version), Date.now(),
      JSON.stringify(scorePieces(termPieces(t), text)));
  }
  res.json({ term_id: termId, created, transcript, ...(spent && { credits: { charged: spent.charged, balance: spent.balance } }),
    resolution: { input: text, mode: captured, word: best.word, method, score: best.score, decision: local.decision }, alternatives });
}));

app.post("/api/learner/cues", wrap(async (req, res) => {
  const t = termFor(req.sid, req.body?.term_id);
  if (!t) return res.status(404).json({ error: "unknown term" });
  const b = req.body;
  if (!t.roles.some((r) => r.id === b.role)) return res.status(400).json({ error: "unknown role" });
  if (b.recognized !== true) return res.status(400).json({ error: "A cue is used only after you confirm you recognize it." });
  const label = String(b.label ?? "").trim().slice(0, 80);
  const connection = String(b.connection ?? "").trim().slice(0, 240);
  if (!label || !connection) return res.status(400).json({ error: "label and connection are required" });
  const pii = findPersonalData([label, connection]);
  if (pii) return res.status(400).json({ error: `That looks like a ${pii}.` });
  const source = ["editorial", "qloo-grounded", "agent (no verified Qloo ID)", "learner", "synthetic", "pick"].includes(b.source) ? b.source : "learner";
  let entityId = b.qloo_entity_id ?? null, entityType = b.qloo_entity_type ?? null, entityName = null, hook = null, rank = null;
  const proposed = source === "pick" && b.via === "agent" ? proposals.get(`${req.sid}|${t.id}|${b.role}|${label.toLowerCase()}`) : null;
  if (proposed) {
    // A card the agent proposed on this session: its verified Qloo ID (or none), counted as an agent hook.
    hook = "agent"; rank = null; entityId = proposed.qloo_entity_id; entityType = proposed.qloo_entity_type; entityName = proposed.qloo_entity_id ? label : null;
  } else if (source === "pick") {
    // A favorite pick is a taste signal: the packet says which public entity it stands for (the browser's word is not
    // trusted), its Qloo ID is resolved once, and the card it was picked from says whether the hook came from taste.
    const { option, hook_source, shown_rank } = hookSourceFor(req.sid, t, b.role, label);
    hook = hook_source; rank = shown_rank;
    entityName = option?.qloo?.entity ?? null; entityType = option?.qloo?.type ?? null;
    // Resolving spends a credit, so a locked session, or one at degree 0 (no describe), only gets an ID the server already knows.
    const live = (unlocked(req.sid) || isOwner(req)) && req.level !== 0;
    entityId = entityName ? await resolveEntity((op, args) => runQloo(req.sid, op, args), entityName, entityType, live ? {} : { budget: () => 0 }) : null;
  }
  q.addCue.run(req.sid, t.id, b.role, label, connection, source, entityId, entityType, 1, Date.now(), entityName, hook, rank);
  if (source === "pick") {
    credits.activate(req.sid);
    // The learner graph (graph.mjs): the pick as a public entity, and the kind of hook it made.
    const role = t.roles.find((r) => r.id === b.role);
    recordNode(req.sid, "pick", entityId ?? entityName ?? label, label, { term_id: t.id, role: b.role, type: entityType, entity_id: entityId, hook_source: hook, shown_rank: rank });
    recordNode(req.sid, "hook", role?.sound_like ? "sound" : "meaning", role?.part ?? role?.label ?? b.role, { term_id: t.id, role: b.role, part: role?.part ?? null, sound_like: role?.sound_like ?? null });
    refreshBrief(req.sid);
  }
  res.json(q.cuesFor.all(req.sid, t.id));
}));

app.patch("/api/learner/cues/:id", (req, res) => {
  const connection = String(req.body?.connection ?? "").trim().slice(0, 240);
  if (!connection) return res.status(400).json({ error: "connection is required" });
  const r = q.editCue.run(connection, Number(req.params.id), req.sid);
  res.status(r.changes ? 200 : 404).json({ updated: r.changes });
});

app.delete("/api/learner/cues/:id", (req, res) => {
  const r = q.removeCue.run(Date.now(), Number(req.params.id), req.sid);
  res.status(r.changes ? 200 : 404).json({ removed: r.changes });
});

// ---- Practice: one prompt at a time, answers held server-side ----
app.get("/api/practice/:termId/next", (req, res) => {
  const t = termFor(req.sid, req.params.termId);
  if (!t) return res.status(404).json({ error: "unknown term" });
  const attempts = q.attemptsFor.all(req.sid, t.id);
  const doneIndependent = new Set(attempts.filter((a) => a.outcome === "correct" && a.independent).map((a) => a.prompt_id));
  const after = req.query.after ? t.prompts.findIndex((p) => p.id === req.query.after) : -1;
  const order = [...t.prompts.slice(after + 1), ...t.prompts.slice(0, after + 1)];
  const next = order.find((p) => !doneIndependent.has(p.id)) ?? order[0];
  res.json({ prompt: publicPrompt(next), remaining: t.prompts.filter((p) => !doneIndependent.has(p.id)).length, total: t.prompts.length });
});

app.post("/api/practice/hint", (req, res) => {
  const found = promptFor(req.sid, req.body?.prompt_id);
  if (!found?.prompt.hint) return res.status(404).json({ error: "no hint" });
  if (!q.openHint.get(req.sid, found.prompt.id)) q.addHint.run(req.sid, found.prompt.id, Date.now());
  res.json({ hint: found.prompt.hint });
});

app.post("/api/attempts", (req, res) => {
  const found = promptFor(req.sid, req.body?.prompt_id);
  if (!found) return res.status(404).json({ error: "unknown prompt" });
  const idem = String(req.body?.idempotency_key ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idem)) return res.status(400).json({ error: "idempotency_key is required" });
  const prior = q.attemptByKey.get(req.sid, idem);
  if (prior) return res.json({ duplicate: true, outcome: prior.outcome, hinted: Boolean(prior.hinted) });

  const { term, prompt } = found;
  const response = String(req.body?.response ?? "").slice(0, 400);
  const result = assess(prompt, response);
  const hinted = Boolean(q.openHint.get(req.sid, prompt.id));
  const independent = result.outcome === "correct" && !hinted;
  try {
    db.exec("BEGIN IMMEDIATE");
    q.insertAttempt.run(req.sid, term.id, prompt.id, prompt.skill, response, result.outcome, hinted ? 1 : 0, independent ? 1 : 0, String(term.version), term.review.status, idem, Date.now());
    q.consumeHints.run(req.sid, prompt.id);
    recordNode(req.sid, "outcome", term.id, term.title, { prompt_id: prompt.id, skill: prompt.skill, outcome: result.outcome, hinted, independent });
    db.exec("COMMIT");
    refreshBrief(req.sid);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    if (String(e.message).includes("UNIQUE")) {
      const p = q.attemptByKey.get(req.sid, idem);
      return res.json({ duplicate: true, outcome: p.outcome, hinted: Boolean(p.hinted) });
    }
    throw e;
  }
  res.json({ ...result, hinted, independent, skill: prompt.skill, provisional: Boolean(term.provisional),
    note: hinted && result.outcome === "correct" ? "Correct with a hint: practice, but not independent recall." : null });
});

app.get("/api/progress/:termId", (req, res) => {
  const t = termFor(req.sid, req.params.termId);
  if (!t) return res.status(404).json({ error: "unknown term" });
  const attempts = q.attemptsFor.all(req.sid, t.id);
  const skills = {};
  for (const skill of [...new Set(t.prompts.map((p) => p.skill))]) {
    skills[skill] = deriveSkill(attempts.filter((a) => a.skill === skill), Date.now());
  }
  skills.pronunciation = { state: "not assessed", note: "Speech scoring is not configured in this build." };
  res.json({ term_id: t.id, provisional: Boolean(t.provisional), skills, first_attempt: q.getFirst.get(req.sid, t.id) ?? null, hooks: hooksSummary(req.sid, t.id) });
});

// ---- The app's voice: plain text in, MP3 out. The server wraps the term's pieces in IPA; a clip is
// synthesized once ever and served from the media store after that (hits are free and unmetered). ----
const SAY_MAX = 400;
app.post("/api/say", gate, wrap(async (req, res) => {
  const text = String(req.body?.text ?? "").replace(/\s+/g, " ").trim().slice(0, SAY_MAX);
  if (!text) return res.status(400).json({ error: "text is required" });
  const term = req.body?.term_id ? termFor(req.sid, req.body.term_id) : null;
  if (req.body?.term_id && !term) return res.status(404).json({ error: "unknown term" });
  if ((await ttsMode()) !== "google") return res.status(503).json({ error: "Server voice isn't configured.", code: "TTS_UNAVAILABLE" });
  const t0 = performance.now();
  let out;
  try {
    out = await speaker.say(text, term, { beforeSynth: () => take("tts", req.sid).ok });
  } catch (e) {
    q.logCall.run(req.sid, "google-tts", "synthesize", "error", null, performance.now() - t0, Date.now());
    console.error("tts:", e.message);
    return res.status(502).json({ error: "Couldn't make the audio.", code: "TTS_FAILED" });
  }
  if (out.denied) return res.status(429).json({ error: "Hourly voice limit reached for this session. The browser voice takes over." });
  q.logCall.run(req.sid, "google-tts", "synthesize", "ok", out.cached ? "hit" : "miss", performance.now() - t0, Date.now());
  res.setHeader("content-type", "audio/mpeg");
  res.setHeader("cache-control", "private, max-age=86400");
  res.setHeader("x-gloo-clip", out.clip);
  res.setHeader("x-gloo-cache", out.verified ? "verified" : out.cached ? "hit" : "miss");
  // The syllable marks of the word and pieces in this line, for the paw: base64 JSON (IPA can't ride in a header as is).
  if (out.marks?.length) res.setHeader("x-gloo-marks", Buffer.from(JSON.stringify(out.marks), "utf8").toString("base64"));
  res.end(out.bytes);
}));

// The same marks as JSON, for a clip that already exists: GET /api/say/timing?text=…&term_id=… -> { clip, verified, marks }.
app.get("/api/say/timing", gate, wrap(async (req, res) => {
  const text = String(req.query.text ?? "").replace(/\s+/g, " ").trim().slice(0, SAY_MAX);
  if (!text) return res.status(400).json({ error: "text is required" });
  const term = req.query.term_id ? termFor(req.sid, String(req.query.term_id)) : null;
  if (req.query.term_id && !term) return res.status(404).json({ error: "unknown term" });
  const r = await speaker.timing(text, term);
  if (!r) return res.status(404).json({ error: "No clip for that text yet. Play it first." });
  res.json(r);
}));

// Owner's ear: "sounds right" pins the clip forever; "sounds wrong" unpins it.
app.post("/api/say/verify", gate, wrap(async (req, res) => {
  const text = String(req.body?.text ?? "").replace(/\s+/g, " ").trim().slice(0, SAY_MAX);
  if (!text || typeof req.body?.verified !== "boolean") return res.status(400).json({ error: "text and verified (true|false) are required" });
  const term = req.body?.term_id ? termFor(req.sid, req.body.term_id) : null;
  if (req.body?.term_id && !term) return res.status(404).json({ error: "unknown term" });
  const r = await speaker.verify(text, term, req.body.verified);
  if (!r) return res.status(404).json({ error: "No clip for that text yet. Play it first." });
  res.json(r);
}));

// ---- Pictures for the picks (Wikipedia lead images, cached server-side) ----
app.get("/api/art", wrap(async (req, res) => {
  const title = String(req.query.t ?? "").slice(0, 120);
  if (!title) return res.status(400).end();
  const a = await art(title);
  if (!a) return res.status(404).end();
  res.setHeader("content-type", a.mime);
  res.setHeader("cache-control", "public, max-age=86400");
  res.end(Buffer.from(a.bytes));
}));

// ---- Owner API: the lesson store behind ADMIN_TOKEN. The AI drafts and suggests; a person decides. ----
// The stored history keeps full snapshots; the API returns the version list without them.
const adminView = (doc) => ({ ...doc, history: (doc.history ?? []).map(({ packet, ...h }) => h) });
const lessonErrors = (e, res) => {
  if (e?.code === "NOT_FOUND") return res.status(404).json({ error: "unknown lesson" });
  if (e?.code === "EXISTS") return res.status(409).json({ error: e.message });
  if (e?.code === "INVALID") return res.status(400).json({ error: e.message, problems: e.problems ?? [] });
  throw e;
};

app.get("/api/admin/lessons", admin, (req, res) => res.json(lessons.summaries()));

// The testers report: every session since ?hours (default 48), where it stopped, what went wrong. ?format=text for a terminal.
app.get("/api/admin/testers", admin, (req, res) => {
  const hours = Math.min(24 * 30, Math.max(0.1, Number(req.query.hours ?? 48) || 48));
  const report = testersReport(db, { since: Date.now() - hours * 3600e3 });
  if (req.query.format === "text") return res.type("text/plain").send(restoredLine() + testersText(report));
  res.json({ ...report, restored_from: restoredFrom() });
});

// The degrees report: the same window, split by degree of Qloo: cards, picks, pictures, practice, recall, calls, latency.
app.get("/api/admin/degrees", admin, (req, res) => {
  const hours = Math.min(24 * 30, Math.max(0.1, Number(req.query.hours ?? 48) || 48));
  const report = degreesReport(db, { since: Date.now() - hours * 3600e3 });
  if (req.query.format === "text") return res.type("text/plain").send(restoredLine() + degreesText(report));
  res.json({ ...report, restored_from: restoredFrom() });
});
// The line a report opens with after a restore: the memory the rows come from spans a redeploy.
const restoredLine = () => { const r = restoredFrom(); return r ? `restored from the snapshot taken ${new Date(r.taken_at).toISOString()}${r.revision ? ` by ${r.revision}` : ""}${r.late ? " (late, before any write here)" : ""}\n\n` : ""; };

// One learner's brief: the paragraph the agent and the drafter read about them, with its facts.
app.get("/api/admin/learners/:sid/brief", admin, (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.sid)) return res.status(400).json({ error: "sid is 32 hex characters" });
  if (!q.getLevel.get(req.params.sid)) return res.status(404).json({ error: "unknown learner" });
  res.json({ sid: req.params.sid, brief: briefRow(req.params.sid), reads: briefReadsOn() ? "on" : "off", max_chars: Number(process.env.BRIEF_MAX_CHARS ?? 700) });
});

// One learner's graph over time: nodes in order, the tag-bag embedding, and the trajectory between snapshots.
// Tags are learned through the admin's own metered Qloo runner, a few per look, and kept for ever.
app.get("/api/admin/learners/:sid/graph", admin, wrap(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.sid)) return res.status(400).json({ error: "sid is 32 hex characters" });
  if (!q.getLevel.get(req.params.sid)) return res.status(404).json({ error: "unknown learner" });
  res.json({ ...(await learnerGraph(req.params.sid, (op, args) => runQloo(req.sid, op, args))), brief: briefRow(req.params.sid) });
}));

app.get("/api/admin/lessons/:id", admin, (req, res) => {
  const doc = lessons.get(req.params.id);
  if (!doc) return res.status(404).json({ error: "unknown lesson" });
  res.json(adminView(doc));
});

// JSON merge patch: top-level fields, and roles / prompts / pick options addressed by id or index. One version per call.
app.patch("/api/admin/lessons/:id", admin, wrap(async (req, res) => {
  let doc;
  try { doc = await lessons.patch(req.params.id, req.body ?? {}, { editor: req.editor }); } catch (e) { return lessonErrors(e, res); }
  await refreshContent();
  res.json(adminView(doc));
}));

app.post("/api/admin/lessons/:id/publish", admin, wrap(async (req, res) => {
  let doc;
  try { doc = await lessons.publish(req.params.id, { editor: req.editor }); } catch (e) { return lessonErrors(e, res); }
  await refreshContent();
  res.json(adminView(doc));
}));

// A learner's provisional draft (p-...) becomes a shared lesson, labeled provisional for everyone until published.
app.post("/api/admin/lessons/:id/promote", admin, wrap(async (req, res) => {
  const row = q.provisionalAnyById.get(req.params.id);
  if (!row) return res.status(404).json({ error: "unknown provisional lesson" });
  const packet = JSON.parse(row.packet);
  const id = String(req.body?.id ?? normalize(row.word).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 60);
  if (!LESSON_ID.test(id)) return res.status(400).json({ error: "id: lowercase letters, digits and dashes", problems: [`id: must match ${LESSON_ID}`] });
  let doc;
  try { doc = await lessons.promote(packet, { id, editor: req.editor, origin: row.origin, from: row.id }); } catch (e) { return lessonErrors(e, res); }
  await refreshContent();
  res.status(201).json(adminView(doc));
}));

// Ask the AI for one field. Returns a proposal only; the owner accepts it into a PATCH or discards it.
app.post("/api/admin/lessons/:id/suggest", admin, wrap(async (req, res) => {
  const doc = lessons.get(req.params.id);
  if (!doc) return res.status(404).json({ error: "unknown lesson" });
  const field = String(req.body?.field ?? "").trim().slice(0, 120);
  const current = readField(doc, field);
  if (!field || typeof current !== "string") return res.status(400).json({ error: "field must name a text field of the lesson, e.g. summary or roles.chole.meaning", field });
  const instruction = String(req.body?.instruction ?? "").trim().slice(0, 600) || null;
  if (agentMode() !== "live") return res.status(503).json({ error: "The lesson agent isn't configured on this server.", code: "AGENT_UNAVAILABLE" });
  try {
    const out = await suggestField({ packet: adminView({ ...doc, history: [] }), field, current, instruction, sid: req.sid });
    res.json({ field, current, suggestion: out.value, reason: out.reason, saved: false });
  } catch (e) {
    console.error("suggest_field:", e.message);
    res.status(502).json({ error: "The model didn't answer. Try again.", code: "SUGGEST_FAILED" });
  }
}));

// Review the whole lesson. Deterministic checks always run; the model is asked once when configured. The result is
// stored on the lesson as `pending` proposals (no version change) until the owner accepts some or discards them.
app.post("/api/admin/lessons/:id/review", admin, wrap(async (req, res) => {
  const doc = lessons.get(req.params.id);
  if (!doc) return res.status(404).json({ error: "unknown lesson" });
  const instruction = String(req.body?.instruction ?? "").trim().slice(0, 600) || null;
  const { proposals, notes } = await reviewLesson(doc, { instruction });
  const saved = await lessons.setPending(doc.id, { created_at: new Date().toISOString(), by: req.editor, instruction, proposals, notes });
  res.json(adminView(saved));
}));

// Accept the chosen proposals as one new version (editor "reviewer via <who>"), clearing every proposal
// unless { keep_rest: true }, which leaves the others pending.
app.post("/api/admin/lessons/:id/proposals/accept", admin, wrap(async (req, res) => {
  let doc;
  try { doc = await lessons.acceptProposals(req.params.id, req.body?.paths, { editor: `reviewer via ${req.editor}`, keepRest: req.body?.keep_rest === true }); } catch (e) { return lessonErrors(e, res); }
  await refreshContent();
  res.json(adminView(doc));
}));

app.post("/api/admin/lessons/:id/proposals/discard", admin, wrap(async (req, res) => {
  let doc;
  try { doc = await lessons.discardProposals(req.params.id); } catch (e) { return lessonErrors(e, res); }
  res.json(adminView(doc));
}));

// Draft a new shared lesson for a word (the same drafter learners get) and store it as provisional. Body { word, id? }.
app.post("/api/admin/lessons/draft", admin, wrap(async (req, res) => {
  const word = String(req.body?.word ?? "").trim().slice(0, 60);
  if (!word) return res.status(400).json({ error: "word: the term to draft a lesson for" });
  const pii = findPersonalData(word);
  if (pii) return res.status(400).json({ error: `That looks like a ${pii}. Draft a word or term instead.` });
  const id = String(req.body?.id ?? normalize(word).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 60);
  if (!LESSON_ID.test(id)) return res.status(400).json({ error: "id: lowercase letters, digits and dashes", problems: [`id: must match ${LESSON_ID}`] });
  if (lessons.get(id)) return res.status(409).json({ error: `lesson ${id} already exists` });
  let packet;
  if (agentMode() === "live") {
    try { packet = await draftLesson(id, word, { sid: req.sid }); }
    catch (e) { console.error("draft_lesson:", e.message);
      return res.status(502).json({ error: "Couldn't draft a lesson for that word right now.", code: "DRAFT_FAILED" }); }
  } else if (MOCK) {
    packet = syntheticLesson(id, word);
  } else {
    return res.status(503).json({ error: "The lesson agent isn't configured on this server.", code: "AGENT_UNAVAILABLE" });
  }
  let doc;
  try { doc = await lessons.promote(packet, { id, editor: req.editor, origin: packet.origin, from: null }); } catch (e) { return lessonErrors(e, res); }
  await refreshContent();
  res.status(201).json(adminView(doc));
}));

// ---- Owner: the credit ledger of one session, and adjustments (refunds, reversals after confirmed abuse, top-ups) ----
app.get("/api/admin/credits/:sid", admin, (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.sid)) return res.status(400).json({ error: "sid is 32 hex characters" });
  res.json(credits.adminView(req.params.sid));
});
app.post("/api/admin/credits/:sid/adjust", admin, (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.sid)) return res.status(400).json({ error: "sid is 32 hex characters" });
  const b = req.body ?? {};
  const out = credits.adjust({ sid: req.params.sid, delta: b.delta, reason: b.reason, by: req.editor, referral_id: b.referral_id ?? null, idempotency_key: b.idempotency_key ?? null });
  if (out.error) return res.status(400).json({ error: out.error });
  res.status(out.written ? 201 : 200).json(out);
});

// ---- Learner data controls ----
app.get("/api/diagnostics", (req, res) => res.json({ calls: q.callCounts.all(req.sid) }));
app.get("/api/export", (req, res) => res.json({ ...exportLearner(req.sid), ...credits.exportCredits(req.sid) }));
app.delete("/api/learner", (req, res) => { deleteLearner(req.sid); res.json({ deleted: true }); });

// Allow-listed passthrough to any Qloo workflow (schemas validated by qloo mcp).
app.post("/api/qloo/:op", gate, wrap(async (req, res) => {
  if (!OPERATIONS.includes(req.params.op)) return res.status(404).json({ error: "unknown operation" });
  const envelope = await runQloo(req.sid, req.params.op, req.body ?? {});
  res.json({ request: { operation: req.params.op, args: req.body ?? {} }, envelope, items: toItems(envelope) });
}));

// Production: serve the built web app from the same origin.
const dist = resolve(repoRoot, "web/dist");
if (existsSync(dist)) {
  // Hashed assets can be cached for a year; the page itself never, so a deploy reaches every phone on the next open.
  app.use(express.static(dist, { index: false, maxAge: "365d", immutable: true, setHeaders: (res, path) => { if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-store"); } }));
  app.get(/^\/(?!api\/).*/, (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(resolve(dist, "index.html")); });
}

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "That capture is too large. Try again." });
  console.error(err.message); // never log request bodies or headers
  res.status(500).json({ error: "Server error." });
});

media.mode().then((m) => console.log(`media: ${m}`)); // choose the store now, not on the first request
const server = app.listen(PORT, () => console.log(`qloo-gloo on :${PORT} · Qloo ${MOCK ? "MOCK" : "live"} · agent ${agentMode()} · engine ${ENGINE}${PASSCODE ? " · passcode gate on" : ""}`));
// Learner memory across redeploys (snapshot.mjs): the database to the store on a timer and at SIGTERM; boot.mjs restored it.
if (snapshotsEnabled()) snapshots = createSnapshotter({ db, path: DB_PATH, media, writes }).start({ server });
