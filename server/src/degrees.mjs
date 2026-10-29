// The degrees report: every session since a point in time, split by its degree of Qloo (level.mjs), with the
// outcomes that say whether taste made the hooks stick. Built from rows the app already keeps: pick cards as
// offered (pick_offers), picks (learner_cues), practice (attempts), provider calls. Sessions are cookies, not people.
const LEVELS = [0, 1, 2, 3];
const NAMES = { 0: "editorial", 1: "rerank", 2: "qloo cards", 3: "agent doorway" };

const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };
const rate = (n, d) => (d ? Number((n / d).toFixed(3)) : null);
const safeJson = (s) => { try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

export function degreesReport(db, { since = Date.now() - 48 * 3600e3 } = {}) {
  const learners = db.prepare("SELECT sid, qloo_level, qloo_forced, created_at FROM learners WHERE created_at >= ? ORDER BY created_at").all(since);
  const offers = db.prepare("SELECT term_id, role, tailored, options, at, build_ms FROM pick_offers WHERE sid = ?");
  const picks = db.prepare("SELECT term_id, role, label, hook_source, shown_rank, created_at FROM learner_cues WHERE sid = ? AND removed_at IS NULL AND source = 'pick'");
  const attempts = db.prepare("SELECT outcome, independent FROM attempts WHERE sid = ?");
  const calls = db.prepare("SELECT provider, op, status, cache FROM provider_calls WHERE sid = ?");
  const drafts = db.prepare("SELECT COUNT(*) AS n FROM provisional_terms WHERE sid = ?");
  const hasArt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'art'").get();
  const artOk = hasArt ? db.prepare("SELECT mime FROM art WHERE title = ?") : null;
  // A wiki tile has a picture when its article's lead image was fetched and kept; a Qloo tile carries its own URL.
  const pictured = (o) => o.pic === "qloo" || (o.pic === "wiki" && Boolean(artOk?.get(String(o.wiki ?? "").trim().slice(0, 120))?.mime));

  const blank = (level) => ({ level, degree: level == null ? "unassigned" : NAMES[level], sessions: 0, forced: 0,
    cards: 0, tailored_cards: 0, tiles: 0, pictured_tiles: 0, picks: 0, first_tile_picks: 0, taste_picks: 0, own_picks: 0, agent_picks: 0, skipped_cards: 0,
    answers: 0, correct: 0, independent: 0, recall_sessions: 0, drafted_words: 0,
    qloo_calls: 0, qloo_cache_hits: 0, agent_calls: 0, build_ms: [], pick_ms: [] });
  const by = new Map(LEVELS.map((l) => [l, blank(l)]));
  for (const { sid, qloo_level, qloo_forced, created_at } of learners) {
    const level = LEVELS.includes(qloo_level) ? qloo_level : null;
    if (!by.has(level)) by.set(level, blank(level));
    const g = by.get(level);
    g.sessions++; if (qloo_forced) g.forced++;
    const o = offers.all(sid), p = picks.all(sid), a = attempts.all(sid), c = calls.all(sid);
    const pickAt = new Map(p.map((x) => [`${x.term_id}|${x.role}`, x]));
    for (const card of o) {
      g.cards++; if (card.tailored) g.tailored_cards++;
      const tiles = safeJson(card.options).slice(0, 4);
      g.tiles += tiles.length; g.pictured_tiles += tiles.filter(pictured).length;
      if (Number.isFinite(card.build_ms)) g.build_ms.push(card.build_ms);
      const pick = pickAt.get(`${card.term_id}|${card.role}`);
      if (!pick) g.skipped_cards++;
      else if (pick.created_at >= card.at) g.pick_ms.push(pick.created_at - card.at);
    }
    for (const x of p) { g.picks++; if (x.shown_rank === 0) g.first_tile_picks++; if (x.hook_source === "taste") g.taste_picks++; if (x.hook_source === "own") g.own_picks++; if (x.hook_source === "agent") g.agent_picks++; }
    let recall = false;
    for (const x of a) { g.answers++; if (x.outcome === "correct") { g.correct++; if (x.independent) { g.independent++; recall = true; } } }
    if (recall) g.recall_sessions++;
    g.drafted_words += drafts.get(sid)?.n ?? 0;
    for (const x of c) {
      if (x.provider === "qloo" || x.provider === "qloo-mock") { if (x.cache === "hit") g.qloo_cache_hits++; else g.qloo_calls++; }
      if (x.provider === "anthropic" && x.op === "cue_agent") g.agent_calls++;
    }
  }
  const levels = [...by.values()].sort((x, y) => (x.level ?? 9) - (y.level ?? 9)).map(({ build_ms, pick_ms, ...g }) => ({
    ...g,
    rates: { first_tile: rate(g.first_tile_picks, g.picks), picture: rate(g.pictured_tiles, g.tiles), skip: rate(g.skipped_cards, g.cards),
      practice_correct: rate(g.correct, g.answers), independent: rate(g.independent, g.answers), recall_sessions: rate(g.recall_sessions, g.sessions),
      taste_picks: rate(g.taste_picks, g.picks) },
    median_build_ms: median(build_ms), median_pick_ms: median(pick_ms),
  }));
  return { since, sessions: learners.length, levels };
}

// A plain-text table for a terminal: one row per level.
export function degreesText(report) {
  const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);
  const ms = (x) => (x == null ? "-" : `${x}ms`);
  const head = ["level", "degree", "sessions", "cards", "tailored", "1st-tile", "pictures", "skip", "practice", "recall", "own", "qloo", "hits", "agent", "agent-picks", "drafts", "build", "to-pick"];
  const rows = report.levels.map((g) => [g.level ?? "?", g.degree, `${g.sessions}${g.forced ? ` (${g.forced} forced)` : ""}`, String(g.cards), String(g.tailored_cards),
    pct(g.rates.first_tile), pct(g.rates.picture), pct(g.rates.skip), `${g.correct}/${g.answers}`, `${g.independent} (${g.recall_sessions} sess)`, String(g.own_picks),
    String(g.qloo_calls), String(g.qloo_cache_hits), String(g.agent_calls), String(g.agent_picks), String(g.drafted_words), ms(g.median_build_ms), ms(g.median_pick_ms)]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  return [`sessions since ${new Date(report.since).toISOString()}: ${report.sessions}`, "",
    fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt),
    "", "1st-tile: picks of the first tile over all picks; pictures: tiles with an image; skip: cards offered that got no pick; practice: correct/answers; recall: independent correct answers (sessions with one); build: median ms to build a card; to-pick: median ms from card to pick"].join("\n") + "\n";
}
