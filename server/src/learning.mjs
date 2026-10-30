// The learning record: one line per pick card shown, joined from what the tables already hold, so what the
// experiment learned survives as training-grade data. Each line carries the word and the part with its target
// sound, the degree and the arm (and the persona when the session was simulated), the candidates the card
// offered with their Qloo records, Qloo's order with affinities, the pick with how it was made, the judges' scores
// when judged, the prompt version the lesson was drafted with, and timestamps. Public names and lesson ids only:
// a session is an opaque hash, a learner's own words never appear (an off-list pick is "[own]"), and the guard runs
// over every line. The day's lines go to the media store under learning/YYYY-MM-DD.jsonl, rewritten whole, so a
// rerun writes the same bytes.
import { createHash } from "node:crypto";
import { findPersonalData } from "./guard.mjs";

export const EVERY_MS = Number(process.env.LEARNING_EVERY_MS ?? 60 * 60e3);
const DAY = 86400e3;
const session = (sid) => createHash("sha256").update(String(sid)).digest("hex").slice(0, 12);
const safeJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export const dayKey = (at) => `learning/${new Date(at).toISOString().slice(0, 10)}.jsonl`;
export const dayStart = (at) => Math.floor(at / DAY) * DAY;

// Every card shown in [since, until), as records. `termOf(sid, term_id)` is the packet as the learner saw it (the
// reviewed lesson or their own draft), or null when it no longer exists. Returns { records, dropped } where
// dropped counts lines the guard kept out.
export function learningRecords(db, { since = 0, until = Infinity, termOf } = {}) {
  const offers = db.prepare(`SELECT o.sid, o.term_id, o.role, o.tailored, o.options, o.signals, o.at, o.build_ms, o.reason, l.qloo_level, l.model_arm, l.synthetic
    FROM pick_offers o JOIN learners l ON l.sid = o.sid WHERE o.at >= ? AND o.at < ? ORDER BY o.at, o.term_id, o.role`).all(since, until === Infinity ? Number.MAX_SAFE_INTEGER : until);
  const pickFor = db.prepare("SELECT label, hook_source, shown_rank, qloo_entity, qloo_entity_id, qloo_type, created_at, judge_score, judge_reason, judge_provider, judge_model FROM learner_cues WHERE sid = ? AND term_id = ? AND role = ? AND source = 'pick' AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1");
  const fitFor = db.prepare("SELECT qloo_top, judge_top, top_hit, rho, fits, provider, model, created_at FROM card_fits WHERE sid = ? AND term_id = ? AND role = ?");
  const draftFor = db.prepare("SELECT prompt, provider, model, note, created_at FROM provider_calls WHERE sid = ? AND op = 'draft_lesson' AND status = 'ok' AND created_at <= ? ORDER BY created_at DESC LIMIT 1");
  const provisional = db.prepare("SELECT created_at FROM provisional_terms WHERE id = ? AND sid = ?");
  const records = [];
  let dropped = 0;
  for (const o of offers) {
    const term = termOf?.(o.sid, o.term_id) ?? null;
    const role = term?.roles?.find((r) => r.id === o.role) ?? null;
    const p = pickFor.get(o.sid, o.term_id, o.role);
    const f = fitFor.get(o.sid, o.term_id, o.role);
    const created = o.term_id.startsWith("p-") ? provisional.get(o.term_id, o.sid)?.created_at ?? null : null;
    const d = created != null ? draftFor.get(o.sid, created + 1000) : null;
    const built = role?.pick?.built ?? null;
    const rec = {
      at: iso(o.at), session: session(o.sid), level: o.qloo_level ?? null, arm: o.model_arm ?? null, persona: o.synthetic ?? null,
      term_id: o.term_id, word: term?.title ?? null, provisional: term ? Boolean(term.provisional) : o.term_id.startsWith("p-"), drafted_at: iso(created),
      role: o.role, part: role?.part ?? null, sound_like: role?.sound_like ?? null, ipa: role?.ipa ?? null, meaning: role?.meaning ?? null, question: role?.pick?.question ?? null,
      candidates: (role?.pick?.options ?? []).map((x) => ({ name: x.name, type: x.qloo?.type ?? null, entity_id: x.qloo?.entity_id ?? null, popularity: x.qloo?.popularity ?? null, picture: x.image ? "qloo" : x.wiki ? "wiki" : null })),
      built: built ? { source: built.source, candidates: built.candidates ?? null, resolved: built.resolved ?? null, kept: built.kept ?? null, rankable: built.rankable ?? null, dropped: built.dropped ?? null } : null,
      offered: { tailored: Boolean(o.tailored), reason: o.reason ?? null, build_ms: o.build_ms ?? null, signals: safeJson(o.signals, []).length,
        order: safeJson(o.options, []).map((x) => ({ name: x.name, affinity: x.taste ?? null, picture: x.pic ?? null })) },
      pick: p ? { name: p.hook_source === "own" ? "[own]" : p.label, hook_source: p.hook_source ?? null, shown_rank: p.shown_rank ?? null, entity: p.hook_source === "own" ? null : p.qloo_entity ?? null, entity_id: p.qloo_entity_id ?? null, type: p.qloo_type ?? null, at: iso(p.created_at), seconds_to_pick: p.created_at >= o.at ? Number(((p.created_at - o.at) / 1000).toFixed(1)) : null } : null,
      judge: p && Number.isInteger(p.judge_score) ? { score: p.judge_score, reason: p.judge_reason ?? null, provider: p.judge_provider ?? null, model: p.judge_model ?? null } : null,
      fit: f ? { qloo_top: f.qloo_top, judge_top: String(f.judge_top ?? "").split("|").filter(Boolean), top_hit: f.top_hit, rho: f.rho, fits: safeJson(f.fits, []), provider: f.provider, model: f.model, at: iso(f.created_at) } : null,
      prompt: d ? { version: d.prompt ?? null, provider: d.provider, model: d.model, note: d.note ?? null } : null,
    };
    if (findPersonalData(JSON.stringify(rec))) { dropped++; continue; }
    records.push(rec);
  }
  return { records, dropped };
}

export const toLines = (records) => (records.length ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");

// One day's file in the store, rewritten whole from the database; the same day twice writes the same bytes and
// says it changed nothing. `day` is any instant of the day (UTC).
export async function exportDay({ db, media, termOf, day = Date.now(), log = console } = {}) {
  const start = dayStart(day), key = dayKey(start);
  const { records, dropped } = learningRecords(db, { since: start, until: start + DAY, termOf });
  const text = toLines(records);
  media.forget?.(key);
  const before = await media.get(key);
  const same = before ? before.toString("utf8") === text : text === "";
  if (!same) await media.put(key, Buffer.from(text), "application/x-ndjson");
  const out = { key, day: new Date(start).toISOString().slice(0, 10), lines: records.length, dropped, bytes: Buffer.byteLength(text), written: !same };
  if (!same) log.log?.(`learning: ${out.key} ${out.lines} lines${dropped ? ` (${dropped} kept out by the guard)` : ""}`);
  return out;
}

// Today and yesterday (a card shown late in the day lands on the first run after midnight), on a timer.
export function startLearningExport({ db, media, termOf, every = EVERY_MS, now = Date.now, log = console } = {}) {
  const run = async () => { const t = now(); const out = []; for (const d of [t - DAY, t]) out.push(await exportDay({ db, media, termOf, day: d, log })); return out; };
  const timer = setInterval(() => run().catch((e) => log.warn?.(`learning: ${e.message.split("\n")[0]}`)), every);
  timer.unref?.();
  return { run, stop: () => clearInterval(timer) };
}
