// The testers report: every session since a point in time, how far it got, and what went wrong.
// Built from rows the app already keeps (learners, provider calls, first attempts, cues, attempts, drafts)
// plus the gate beacons the client sends (camera live, denied, unavailable, slow). Sessions are cookies,
// not people: the report says where a session stopped, never who it was.
const STAGES = ["visited", "gate", "read", "lesson", "pick", "practice", "correct"];

export function testersReport(db, { since = Date.now() - 48 * 3600e3 } = {}) {
  const learners = db.prepare("SELECT sid, created_at, qloo_level, qloo_forced FROM learners WHERE created_at >= ? ORDER BY created_at").all(since);
  const beacons = db.prepare("SELECT event, data, created_at FROM beacons WHERE sid = ? ORDER BY created_at");
  const calls = db.prepare("SELECT provider, op, status, cache, created_at FROM provider_calls WHERE sid = ? ORDER BY created_at");
  const firsts = db.prepare("SELECT term_id, skipped, created_at FROM first_attempts WHERE sid = ?");
  const cues = db.prepare("SELECT term_id, role, label, source, hook_source, created_at FROM learner_cues WHERE sid = ? AND removed_at IS NULL");
  const attempts = db.prepare("SELECT term_id, outcome, independent, created_at FROM attempts WHERE sid = ?");
  const drafts = db.prepare("SELECT word, created_at FROM provisional_terms WHERE sid = ?");
  const resolutions = db.prepare("SELECT mode, decision, created_at FROM resolutions WHERE sid = ?");

  const sessions = learners.map(({ sid, created_at, qloo_level, qloo_forced }) => {
    const b = beacons.all(sid).map((r) => ({ event: r.event, at: r.created_at, ...safeJson(r.data) }));
    const c = calls.all(sid), f = firsts.all(sid), cu = cues.all(sid), a = attempts.all(sid), d = drafts.all(sid), r = resolutions.all(sid);
    const gates = b.filter((x) => x.event === "gate"), mics = b.filter((x) => x.event === "mic");
    const mic = mics[mics.length - 1] ?? null;
    const last = gates[gates.length - 1] ?? null;
    const live = gates.some((x) => x.state === "live");
    const reads = c.filter((x) => ["anthropic", "meta"].includes(x.provider) && x.op === "read_word");
    const readOk = reads.filter((x) => x.status === "ok").length;
    const captures = { camera: r.filter((x) => x.mode === "camera").length, voice: r.filter((x) => x.mode === "voice").length, typed: r.filter((x) => x.mode === "typed").length };
    const picks = cu.filter((x) => x.source === "pick");
    const correct = a.filter((x) => x.outcome === "correct").length, independent = a.filter((x) => x.outcome === "correct" && x.independent).length;
    const errors = c.filter((x) => x.status === "error").map((x) => `${x.provider}:${x.op}`);
    const stage = correct ? "correct" : a.length ? "practice" : picks.length ? "pick" : f.length ? "lesson" : readOk || r.some((x) => x.term_id || x.decision) ? "read" : live ? "gate" : "visited";
    const lastSeen = Math.max(created_at, ...b.map((x) => x.at), ...c.map((x) => x.created_at), ...f.map((x) => x.created_at), ...cu.map((x) => x.created_at), ...a.map((x) => x.created_at));
    return {
      sid: sid.slice(0, 8), started_at: created_at, last_seen: lastSeen, stage, level: qloo_level ?? null, level_forced: Boolean(qloo_forced),
      gate: last ? { state: last.state ?? null, source: last.source ?? null, error: last.error ?? null, in_app: last.in_app ?? null, platform: last.platform ?? null, slow: Boolean(last.slow) } : null,
      mic: mic ? { state: mic.state ?? null, error: mic.error ?? null } : null,
      reads: { tried: reads.length, ok: readOk }, captures,
      lessons: f.map((x) => x.term_id), picks: picks.length, taste_picks: picks.filter((x) => x.hook_source === "taste").length,
      voice_lines: c.filter((x) => x.provider === "google-tts").length, heard: c.filter((x) => x.provider === "google-stt").length,
      practice: { answers: a.length, correct, independent }, drafted: d.map((x) => x.word), errors,
    };
  });
  const funnel = Object.fromEntries(STAGES.map((s, i) => [s, sessions.filter((x) => STAGES.indexOf(x.stage) >= i).length]));
  return { since, sessions: sessions.length, funnel, rows: sessions };
}

function safeJson(s) { try { const v = JSON.parse(s ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } }

// A plain-text table for a terminal.
export function testersText(report) {
  const t = (ms) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
  const lines = [`sessions since ${new Date(report.since).toISOString()}: ${report.sessions}`,
    "funnel: " + STAGES.map((s) => `${s} ${report.funnel[s]}`).join(" > "), ""];
  const head = ["sid", "started", "lvl", "stage", "gate", "src", "where", "mic", "reads", "lessons", "picks", "voice", "practice", "drafted", "errors"];
  const rows = report.rows.map((r) => [r.sid, t(r.started_at), r.level == null ? "-" : `${r.level}${r.level_forced ? "!" : ""}`, r.stage,
    r.gate ? `${r.gate.state}${r.gate.slow ? "+slow" : ""}${r.gate.error ? ` ${r.gate.error}` : ""}` : "-", r.gate?.source ?? "-",
    r.gate ? `${r.gate.platform ?? "?"}${r.gate.in_app ? ` in ${r.gate.in_app}` : ""}` : "-",
    r.mic ? `${r.mic.state}${r.mic.error ? ` ${r.mic.error}` : ""}` : "-",
    `${r.reads.ok}/${r.reads.tried}`, r.lessons.join(",") || "-", `${r.picks}${r.taste_picks ? ` (${r.taste_picks} taste)` : ""}`, String(r.voice_lines),
    `${r.practice.correct}/${r.practice.answers}${r.practice.independent ? ` (${r.practice.independent} own)` : ""}`, r.drafted.join(",") || "-", [...new Set(r.errors)].join(",") || "-"]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  lines.push(fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt));
  return lines.join("\n") + "\n";
}
