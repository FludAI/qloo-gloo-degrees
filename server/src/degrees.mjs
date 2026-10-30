// The degrees report: every session since a point in time, split by its degree of Qloo (level.mjs) and by its
// model arm (providers.mjs), with the outcomes that say whether taste made the hooks stick and whether the
// model changed anything. Built from rows the app already keeps: pick cards as offered (pick_offers), picks
// (learner_cues), practice (attempts), provider calls. Sessions are cookies, not people.
const LEVELS = [0, 1, 2, 3];
const NAMES = { 0: "editorial", 1: "rerank", 2: "qloo cards", 3: "agent doorway" };
const ARMS = ["anthropic", "muse"];
const MODEL_OPS = ["read_word", "resolve_term", "draft_lesson", "cue_agent"];

const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return Math.round(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2); };
const rate = (n, d) => (d ? Number((n / d).toFixed(3)) : null);
const safeJson = (s) => { try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

export function degreesReport(db, { since = Date.now() - 48 * 3600e3 } = {}) {
  const learners = db.prepare("SELECT sid, qloo_level, qloo_forced, model_arm, model_forced, created_at FROM learners WHERE created_at >= ? ORDER BY created_at").all(since);
  const offers = db.prepare("SELECT term_id, role, tailored, options, at, build_ms FROM pick_offers WHERE sid = ?");
  const picks = db.prepare("SELECT term_id, role, label, hook_source, shown_rank, created_at FROM learner_cues WHERE sid = ? AND removed_at IS NULL AND source = 'pick'");
  const attempts = db.prepare("SELECT outcome, independent FROM attempts WHERE sid = ?");
  const calls = db.prepare("SELECT provider, op, status, cache, duration_ms, model, tokens_in, tokens_out, fallback_from, stop, note FROM provider_calls WHERE sid = ?");
  const drafts = db.prepare("SELECT id, created_at FROM provisional_terms WHERE sid = ? ORDER BY created_at, rowid");
  const draftRows = db.prepare("SELECT brief, created_at FROM provider_calls WHERE sid = ? AND op = 'draft_lesson' AND status = 'ok' AND (note IS NULL OR (note NOT LIKE '%no_tool%' AND note NOT LIKE '%no_cards%')) ORDER BY created_at, id");
  const hasArt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'art'").get();
  const artOk = hasArt ? db.prepare("SELECT mime FROM art WHERE title = ?") : null;
  // A wiki tile has a picture when its article's lead image was fetched and kept; a Qloo tile carries its own URL.
  const pictured = (o) => o.pic === "qloo" || (o.pic === "wiki" && Boolean(artOk?.get(String(o.wiki ?? "").trim().slice(0, 120))?.mime));

  // ---- One learner's numbers, computed once, then added to each grouping it belongs to. ----
  const statsOf = (sid) => {
    const s = { cards: 0, tailored_cards: 0, tiles: 0, pictured_tiles: 0, picks: 0, first_tile_picks: 0, taste_picks: 0, own_picks: 0, agent_picks: 0, skipped_cards: 0,
      answers: 0, correct: 0, independent: 0, recall: 0, drafted_words: 0, accepted_drafts: 0, reads_tried: 0, reads_ok: 0, drafts_tried: 0, drafts_ok: 0,
      qloo_calls: 0, qloo_cache_hits: 0, agent_calls: 0, model_calls: 0, model_errors: 0, fallbacks: 0, model_cut: 0, text_tools: 0, no_cards: 0, drafted_briefed: 0, accepted_briefed: 0, drafted_plain: 0, accepted_plain: 0, tokens_in: 0, tokens_out: 0,
      build_ms: [], pick_ms: [], ms: Object.fromEntries(MODEL_OPS.map((op) => [op, []])) };
    const o = offers.all(sid), p = picks.all(sid), a = attempts.all(sid), c = calls.all(sid), d = drafts.all(sid);
    const pickAt = new Map(p.map((x) => [`${x.term_id}|${x.role}`, x]));
    for (const card of o) {
      s.cards++; if (card.tailored) s.tailored_cards++;
      const tiles = safeJson(card.options).slice(0, 4);
      s.tiles += tiles.length; s.pictured_tiles += tiles.filter(pictured).length;
      if (Number.isFinite(card.build_ms)) s.build_ms.push(card.build_ms);
      const pick = pickAt.get(`${card.term_id}|${card.role}`);
      if (!pick) s.skipped_cards++;
      else if (pick.created_at >= card.at) s.pick_ms.push(pick.created_at - card.at);
    }
    for (const x of p) { s.picks++; if (x.shown_rank === 0) s.first_tile_picks++; if (x.hook_source === "taste") s.taste_picks++; if (x.hook_source === "own") s.own_picks++; if (x.hook_source === "agent") s.agent_picks++; }
    for (const x of a) { s.answers++; if (x.outcome === "correct") { s.correct++; if (x.independent) { s.independent++; s.recall = 1; } } }
    const pickedTerms = new Set(p.map((x) => x.term_id));
    s.drafted_words = d.length; s.accepted_drafts = d.filter((x) => pickedTerms.has(x.id)).length; // a draft the learner went on to pick a hook in
    // Which drafts carried a learner brief: the n-th stored draft is the n-th draft call that produced one (same order, same session).
    const rows = draftRows.all(sid);
    d.forEach((x, i) => { const briefed = (rows[i]?.brief ?? 0) > 0; if (briefed) { s.drafted_briefed++; if (pickedTerms.has(x.id)) s.accepted_briefed++; } else { s.drafted_plain++; if (pickedTerms.has(x.id)) s.accepted_plain++; } });
    for (const x of c) {
      if (x.provider === "qloo" || x.provider === "qloo-mock") { if (x.cache === "hit") s.qloo_cache_hits++; else s.qloo_calls++; continue; }
      if (!ARMS.includes(x.provider)) continue;
      if (x.op === "cue_agent") s.agent_calls++;
      if (x.op === "read_word") { s.reads_tried++; if (x.status === "ok") s.reads_ok++; }
      if (x.op === "draft_lesson") { s.drafts_tried++; if (x.status === "ok") s.drafts_ok++; }
      if (x.op === "cue_agent_step") continue; // steps roll up into the run's row
      s.model_calls++; if (x.status === "error") s.model_errors++; if (x.fallback_from) s.fallbacks++;
      if (x.stop === "max_tokens") s.model_cut++; if (String(x.note ?? "").includes("tool_from_text")) s.text_tools++; if (String(x.note ?? "").includes("no_cards")) s.no_cards++;
      s.tokens_in += x.tokens_in ?? 0; s.tokens_out += x.tokens_out ?? 0;
      if (s.ms[x.op] && Number.isFinite(x.duration_ms)) s.ms[x.op].push(x.duration_ms);
    }
    return s;
  };
  const blank = (extra) => ({ ...extra, sessions: 0, forced: 0, cards: 0, tailored_cards: 0, tiles: 0, pictured_tiles: 0, picks: 0, first_tile_picks: 0, taste_picks: 0, own_picks: 0, agent_picks: 0, skipped_cards: 0,
    answers: 0, correct: 0, independent: 0, recall_sessions: 0, drafted_words: 0, accepted_drafts: 0, reads_tried: 0, reads_ok: 0, drafts_tried: 0, drafts_ok: 0,
    qloo_calls: 0, qloo_cache_hits: 0, agent_calls: 0, model_calls: 0, model_errors: 0, fallbacks: 0, model_cut: 0, text_tools: 0, no_cards: 0, drafted_briefed: 0, accepted_briefed: 0, drafted_plain: 0, accepted_plain: 0, tokens_in: 0, tokens_out: 0,
    build_ms: [], pick_ms: [], ms: Object.fromEntries(MODEL_OPS.map((op) => [op, []])) });
  const add = (g, s, forced) => {
    g.sessions++; if (forced) g.forced++;
    for (const k of Object.keys(s)) {
      if (k === "recall") g.recall_sessions += s.recall;
      else if (k === "ms") for (const op of MODEL_OPS) g.ms[op].push(...s.ms[op]);
      else if (Array.isArray(s[k])) g[k].push(...s[k]);
      else g[k] += s[k];
    }
  };
  const finish = ({ build_ms, pick_ms, ms, ...g }) => ({
    ...g,
    rates: { first_tile: rate(g.first_tile_picks, g.picks), picture: rate(g.pictured_tiles, g.tiles), skip: rate(g.skipped_cards, g.cards),
      practice_correct: rate(g.correct, g.answers), independent: rate(g.independent, g.answers), recall_sessions: rate(g.recall_sessions, g.sessions),
      taste_picks: rate(g.taste_picks, g.picks), read_ok: rate(g.reads_ok, g.reads_tried), draft_ok: rate(g.drafts_ok, g.drafts_tried), draft_accepted: rate(g.accepted_drafts, g.drafted_words),
      draft_accepted_briefed: rate(g.accepted_briefed, g.drafted_briefed), draft_accepted_plain: rate(g.accepted_plain, g.drafted_plain) },
    median_build_ms: median(build_ms), median_pick_ms: median(pick_ms),
    median_ms: Object.fromEntries(MODEL_OPS.map((op) => [op, median(ms[op])])),
  });

  const byLevel = new Map(LEVELS.map((l) => [l, blank({ level: l, degree: NAMES[l] })]));
  const byArm = new Map(ARMS.map((a) => [a, blank({ arm: a })]));
  const cells = new Map();
  for (const { sid, qloo_level, qloo_forced, model_arm, model_forced } of learners) {
    const level = LEVELS.includes(qloo_level) ? qloo_level : null;
    const arm = ARMS.includes(model_arm) ? model_arm : null;
    if (!byLevel.has(level)) byLevel.set(level, blank({ level, degree: "unassigned" }));
    if (!byArm.has(arm)) byArm.set(arm, blank({ arm: arm ?? "unassigned" }));
    const key = `${level ?? "?"}|${arm ?? "?"}`;
    if (!cells.has(key)) cells.set(key, blank({ level, arm: arm ?? "unassigned" }));
    const s = statsOf(sid);
    add(byLevel.get(level), s, qloo_forced);
    add(byArm.get(arm), s, model_forced);
    add(cells.get(key), s, qloo_forced || model_forced);
  }
  const order = (x, y) => (x.level ?? 9) - (y.level ?? 9) || String(x.arm ?? "").localeCompare(String(y.arm ?? ""));
  return { since, sessions: learners.length,
    levels: [...byLevel.values()].sort(order).map(finish),
    models: [...byArm.values()].sort((x, y) => ARMS.indexOf(x.arm) - ARMS.indexOf(y.arm)).map(finish),
    cells: [...cells.values()].sort(order).map(finish) };
}

// Plain-text tables for a terminal: one row per level, one per model arm, one per level and arm.
export function degreesText(report) {
  const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
  const ms = (x) => (x == null ? "-" : `${x}ms`);
  const table = (head, rows) => {
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const fmt = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
    return [fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)];
  };
  const sessions = (g) => `${g.sessions}${g.forced ? ` (${g.forced} forced)` : ""}`;
  const levelRows = report.levels.map((g) => [g.level ?? "?", g.degree, sessions(g), String(g.cards), String(g.tailored_cards),
    pct(g.rates.first_tile), pct(g.rates.picture), pct(g.rates.skip), `${g.correct}/${g.answers}`, `${g.independent} (${g.recall_sessions} sess)`, String(g.own_picks),
    String(g.qloo_calls), String(g.qloo_cache_hits), String(g.agent_calls), String(g.agent_picks), String(g.drafted_words), ms(g.median_build_ms), ms(g.median_pick_ms)]);
  const modelRows = report.models.map((g) => [g.arm, sessions(g), `${g.reads_ok}/${g.reads_tried}`, `${g.drafts_ok}/${g.drafts_tried}`, pct(g.rates.draft_accepted), `${g.drafted_briefed}: ${pct(g.rates.draft_accepted_briefed)}/${pct(g.rates.draft_accepted_plain)}`,
    pct(g.rates.picture), pct(g.rates.first_tile), `${g.correct}/${g.answers}`, String(g.independent), String(g.model_calls), String(g.model_errors), String(g.fallbacks), `${g.model_cut}/${g.text_tools}/${g.no_cards}`,
    `${g.tokens_in}/${g.tokens_out}`, ms(g.median_ms.read_word), ms(g.median_ms.draft_lesson), ms(g.median_ms.cue_agent)]);
  const cellRows = report.cells.map((g) => [g.level ?? "?", g.arm, sessions(g), String(g.cards), pct(g.rates.first_tile), pct(g.rates.picture), `${g.correct}/${g.answers}`, String(g.independent), String(g.drafted_words), String(g.agent_picks)]);
  return [`sessions since ${new Date(report.since).toISOString()}: ${report.sessions}`, "", "by degree of Qloo",
    ...table(["level", "degree", "sessions", "cards", "tailored", "1st-tile", "pictures", "skip", "practice", "recall", "own", "qloo", "hits", "agent", "agent-picks", "drafts", "build", "to-pick"], levelRows),
    "", "by model arm",
    ...table(["arm", "sessions", "reads", "drafts", "accepted", "briefed: acc b/p", "pictures", "1st-tile", "practice", "recall", "calls", "errors", "fallbacks", "cut/text/no-cards", "tokens in/out", "read ms", "draft ms", "agent ms"], modelRows),
    "", "by degree and arm",
    ...table(["level", "arm", "sessions", "cards", "1st-tile", "pictures", "practice", "recall", "drafts", "agent-picks"], cellRows),
    "", "1st-tile: picks of the first tile over all picks; pictures: tiles with an image; skip: cards offered that got no pick; practice: correct/answers; recall: independent correct answers (sessions with one); briefed: drafts whose prompt carried the learner brief, then acceptance with a brief / without; cut/text/no-cards: model answers cut at the output cap / tool calls the model wrote as JSON text / drafts that came back without a pick card (redrafted at four options, never shipped); build: median ms to build a card; to-pick: median ms from card to pick; reads/drafts: ok/tried; accepted: drafted words the learner went on to pick a hook in; tokens: a cost proxy, summed; ms: median model latency per task"].join("\n") + "\n";
}
