// A simulated learner: a film or TV character persona played through the degrees API as a learner would be, one
// fresh session per run at a chosen degree of Qloo and model arm, so the degrees report fills with rows that can
// be compared across degrees and arms. The session is marked synthetic on the server (header x-gloo-synthetic with
// the sim token), so its rows never enter the real funnel.
//
//   SIM_TOKEN=... node scripts/simulate-learner.mjs --persona sim/personas/marty-mcfly.json --level 2 --model anthropic --words 3
//   node scripts/simulate-learner.mjs --base http://localhost:8787 --persona fixture:marty-mcfly --level 1 --dry-run
//
// Flags: --base (default https://qloo.gloo.news) · --persona <file.json> | fixture:<slug> · --level 0..3 · --model anthropic|muse
//        --words N (default: all the persona's words) · --arm-judge on|off (default off) · --judge-provider anthropic|muse
//        --first say|skip (the first attempt: say the word as spelled, or skip it; default say) · --out <dir> (default ~/gloo-notes/sim-runs)
//        --dry-run (rows to stdout, no file unless --out is given, the judge off) · --quiet
// Environment: SIM_TOKEN (required: the server accepts the synthetic mark only with it; never a flag), SIM_PASSCODE (a gated demo).
//
// What the persona does per word: types the word (POST /api/glue); says the word as its first attempt (or skips);
// opens the lesson; on every pick card picks the option whose name or packet entity matches one of the persona's
// likes, else the first tile; at degree 3 with no match, asks the agent ("None of these") and picks a proposal
// that matches a like, else the first tile; practices with a taste-blind rule: every prompt is answered once with
// the lesson's own definition sentence, so synthetic practice rows measure the rubric, never retention, and no
// outcome can depend on the hook picked. The run's rows go to one JSON lines file: a run line, a line per word, a
// summary line.
import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Two inline fixture personas (the persona library in sim/ is another session's): likes chosen to land on the
// reviewed lessons' cards, so the choose rule and its fallback can both be exercised against the mock server.
export const FIXTURES = {
  "marty-mcfly": { slug: "marty-mcfly", name: "Marty McFly", work: { title: "Back to the Future", kind: "film", year: 1985 }, manner: "quick, casual, says the first thing that comes to mind",
    likes: [{ name: "Pepsi", type: "brand", why: "orders a Pepsi Free at Lou's diner" }, { name: "Huey Lewis and the News", type: "artist", why: "the band on his Walkman" }, { name: "Toyota", type: "brand", why: "the black 4x4 he wants" }],
    words: [{ word: "cholecystokinin", where: { scene: "fixture" } }, { word: "peristalsis", where: { scene: "fixture" } }, { word: "brier score", where: { scene: "fixture" } }], words_source: "curated" },
  "ferris-bueller": { slug: "ferris-bueller", name: "Ferris Bueller", work: { title: "Ferris Bueller's Day Off", kind: "film", year: 1986 }, manner: "confident, talks to the audience",
    likes: [{ name: "The Beatles", type: "artist", why: "sings Twist and Shout on the parade float" }, { name: "Ferrari", type: "brand", why: "Cameron's father's 250 GT" }, { name: "Chicago", type: "place", why: "the whole day off" }],
    words: [{ word: "brier score", where: { scene: "fixture" } }, { word: "cholecystokinin", where: { scene: "fixture" } }], words_source: "curated" },
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const nowS = (t0) => Number(((performance.now() - t0) / 1000).toFixed(2));

export function parseArgs(argv) {
  const o = { base: "https://qloo.gloo.news", persona: null, level: null, model: null, words: null, armJudge: false, judgeProvider: null, first: "say", out: null, dryRun: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--base") { o.base = v; i++; } else if (a === "--persona") { o.persona = v; i++; }
    else if (a === "--level") { o.level = Number(v); i++; } else if (a === "--model") { o.model = v; i++; }
    else if (a === "--words") { o.words = Number(v); i++; } else if (a === "--arm-judge") { o.armJudge = v === "on"; i++; }
    else if (a === "--judge-provider") { o.judgeProvider = v; i++; } else if (a === "--first") { o.first = v === "skip" ? "skip" : "say"; i++; }
    else if (a === "--out") { o.out = v; i++; } else if (a === "--dry-run") o.dryRun = true; else if (a === "--quiet") o.quiet = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!o.persona) throw new Error("--persona <file.json> or fixture:<slug> is required");
  if (o.level != null && ![0, 1, 2, 3].includes(o.level)) throw new Error("--level is 0, 1, 2 or 3");
  if (o.model != null && !["anthropic", "muse"].includes(o.model)) throw new Error("--model is anthropic or muse");
  return o;
}

export function loadPersona(ref) {
  const p = ref.startsWith("fixture:") ? FIXTURES[ref.slice(8)] : JSON.parse(readFileSync(ref, "utf8"));
  if (!p) throw new Error(`no persona ${ref}`);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(p.slug ?? "")) throw new Error("persona.slug must be lowercase letters, digits and dashes");
  if (!Array.isArray(p.words) || !p.words.length) throw new Error("persona.words is empty");
  return { ...p, likes: Array.isArray(p.likes) ? p.likes : [] };
}

// One session's client: a cookie jar, the two headers on every request, JSON in and out, the status kept.
function client(base, { slug, token, headers = {} }) {
  const jar = new Map();
  return async (method, path, body) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(base.replace(/\/$/, "") + path, {
      method, headers: { "x-gloo-synthetic": slug, ...(token ? { "x-gloo-sim-token": token } : {}), ...headers, ...(cookie && { cookie }), ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    for (const set of res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean)) {
      const [k, v] = set.split(";")[0].split("=");
      if (k) jar.set(k.trim(), v ?? "");
    }
    let json = null; try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
  };
}

// The option on a card that matches a persona like, by the card's name or the packet's entity name.
export function favoriteOn(options, likes) {
  const wants = likes.map((l) => norm(l.name)).filter(Boolean);
  const matches = (o) => { const names = [norm(o.name), norm(o.qloo?.entity)].filter(Boolean); return wants.some((w) => names.some((n) => n === w || n.includes(w) || w.includes(n))); };
  const at = options.findIndex(matches);
  return { rank: at >= 0 ? at : null, option: at >= 0 ? options[at] : null };
}

// Model rows and Qloo rows this session logged since a moment, from its own export (works for a synthetic session like any other).
function spend(rows, since) {
  const out = { qloo_calls: 0, qloo_hits: 0, model_calls: 0, tokens_in: 0, tokens_out: 0, model_ms: 0, model_errors: 0, fallbacks: 0, notes: [] };
  for (const r of rows) {
    if (r.created_at < since) continue;
    if (String(r.provider).startsWith("qloo")) { if (r.cache === "hit") out.qloo_hits++; else out.qloo_calls++; continue; }
    if (!["anthropic", "muse"].includes(r.provider)) continue;
    if (r.op === "cue_agent_step") continue;
    out.model_calls++; out.tokens_in += r.tokens_in ?? 0; out.tokens_out += r.tokens_out ?? 0; out.model_ms += Math.round(r.duration_ms ?? 0);
    if (r.status === "error") out.model_errors++; if (r.fallback_from) out.fallbacks++; if (r.note) out.notes.push(`${r.op}:${r.note}`);
  }
  return out;
}

export async function simulate(opts, { log = console.error } = {}) {
  const persona = loadPersona(opts.persona);
  const token = process.env.SIM_TOKEN ?? "";
  const say = opts.quiet ? () => {} : log;
  const call = client(opts.base, { slug: persona.slug, token });
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${persona.slug}-L${opts.level ?? "x"}-${opts.model ?? "x"}-${Math.random().toString(36).slice(2, 6)}`;
  const outDir = opts.out ?? (opts.dryRun ? null : join(homedir(), "gloo-notes", "sim-runs"));
  const file = outDir ? join(outDir, `${runId}.jsonl`) : null;
  if (outDir) mkdirSync(outDir, { recursive: true });
  const lines = [];
  const emit = (row) => { lines.push(row); const s = JSON.stringify(row); if (file) appendFileSync(file, s + "\n"); if (opts.dryRun) console.log(s); };

  // The session: level and arm forced on the first request; the mark must come back or the run stops here.
  const qs = [opts.level != null ? `qloo=${opts.level}` : null, opts.model ? `model=${opts.model}` : null].filter(Boolean).join("&");
  const level = await call("GET", `/api/level${qs ? `?${qs}` : ""}`);
  if (level.status !== 200) throw new Error(`GET /api/level: ${level.status}`);
  if (level.body.synthetic !== persona.slug) throw new Error("the server did not accept the synthetic mark (SIM_TOKEN missing here or not set on the server); nothing was played");
  const arm = level.body.model?.arm ?? null, lvl = level.body.level;
  const health = (await call("GET", "/api/health")).body ?? {};
  if (health.gated && !health.unlocked) {
    if (!process.env.SIM_PASSCODE) throw new Error("the demo is passcode-gated; set SIM_PASSCODE");
    const u = await call("POST", "/api/unlock", { code: process.env.SIM_PASSCODE });
    if (!u.body?.unlocked) throw new Error("the passcode did not unlock the session");
  }
  const judge = opts.armJudge && !opts.dryRun;
  emit({ kind: "run", run: runId, at: new Date().toISOString(), base: opts.base, persona: persona.slug, name: persona.name, work: persona.work, words_source: persona.words_source ?? null,
    level: lvl, degree: level.body.degree, arm, level_forced: level.body.forced, arm_forced: level.body.model?.forced ?? null, synthetic: level.body.synthetic,
    judge: judge ? (opts.judgeProvider ?? "server default") : "off", first_attempt: opts.first, practice_rule: "taste-blind: every prompt answered once with the lesson's definition; no memory model",
    dry_run: opts.dryRun, server: { qloo: health.qloo?.mode ?? null, agent: health.agent?.mode ?? null, model: health.agent?.model ?? null } });
  say(`run ${runId}: ${persona.name} at degree ${lvl} (${level.body.degree}), arm ${arm}${judge ? ", judged" : ""}`);

  const words = persona.words.slice(0, opts.words ?? persona.words.length);
  const totals = { words: 0, drafted: 0, cards: 0, ranked_cards: 0, favorite_hits: 0, picks: 0, agent_asks: 0, answers: 0, correct: 0, judged: 0, sound_sum: 0, qloo_calls: 0, tokens: 0, errors: 0 };
  for (const w of words) {
    const t0 = performance.now(), since = Date.now();
    const row = { kind: "word", run: runId, persona: persona.slug, level: lvl, arm, word: w.word, where: w.where ?? null, term_id: null, created: null, resolution: null, first_attempt: opts.first,
      cards: [], agent: null, practice: [], seconds: { lesson: null, done: null }, spend: null, errors: [] };
    try {
      const g = await call("POST", "/api/glue", { text: w.word, mode: "typed" });
      if (g.status !== 200) { row.errors.push(`glue ${g.status}: ${g.body?.error ?? "?"}`); throw new Error("stop"); }
      row.term_id = g.body.term_id; row.created = g.body.created; row.resolution = { word: g.body.resolution?.word, method: g.body.resolution?.method }; row.credits = g.body.credits ?? null;
      if (g.body.created) totals.drafted++;
      const fa = opts.first === "skip" ? { skipped: true } : { response: w.word };
      const f = await call("POST", `/api/terms/${row.term_id}/first-attempt`, fa);
      if (f.status !== 200 && f.status !== 409) row.errors.push(`first-attempt ${f.status}`);
      let term = (await call("GET", `/api/terms/${row.term_id}`)).body;
      row.seconds.lesson = nowS(t0);
      row.title = term?.title ?? null; row.roles = (term?.roles ?? []).length; row.built = term?.cards ?? null; row.draft = term?.draft ?? null;
      for (const roleId of (term?.roles ?? []).map((r) => r.id)) {
        const role = (term?.roles ?? []).find((r) => r.id === roleId); // from the latest load: ranked with the picks so far
        if (!role?.pick?.options?.length) continue;
        const tCard = nowS(t0);
        const options = role.pick.options;
        const fav = favoriteOn(options, persona.likes);
        const card = { role: role.id, part: role.part ?? null, sound_like: role.sound_like ?? null, ranked: role.pick.tailoring?.source === "taste", tailoring: role.pick.tailoring?.source ?? null, reason: role.pick.tailoring?.reason ?? null,
          built: role.pick.built?.source ?? null, options: options.length, pictured: options.filter((o) => o.image || o.wiki).length, names: options.slice(0, 8).map((o) => o.name),
          favorite_rank: fav.rank, chosen: null, chosen_rank: null, via: null, hook_source: null, entity_id: null, judge: null, seconds: { card: tCard, pick: null } };
        let choice = fav.option, via = fav.option ? "like" : "first";
        if (!choice && lvl >= 3) {
          // "None of these": the agent proposes; a proposal matching a like is picked through the agent.
          const a = await call("POST", "/api/cues/agent", { term_id: row.term_id, role: role.id });
          totals.agent_asks++;
          card.agent = { status: a.body?.status ?? `http ${a.status}`, proposals: (a.body?.cues ?? []).map((c) => c.label), calls: (a.body?.calls ?? []).length, reason: a.body?.reason ?? null };
          const p = favoriteOn((a.body?.cues ?? []).map((c) => ({ name: c.label, qloo: { entity: c.label } })), persona.likes);
          if (p.option) { const cue = a.body.cues[p.rank]; choice = { name: cue.label, connection: cue.connection, qloo: { type: cue.qloo_entity_type }, via: "agent" }; via = "agent"; }
        }
        if (!choice) choice = options[0];
        const picked = await call("POST", "/api/learner/cues", { term_id: row.term_id, role: role.id, label: choice.name, connection: choice.connection, source: "pick", recognized: true, qloo_entity_id: null, qloo_entity_type: choice.qloo?.type ?? null, ...(choice.via ? { via: choice.via } : {}) });
        card.seconds.pick = nowS(t0);
        if (picked.status !== 200) { card.error = `pick ${picked.status}: ${picked.body?.error ?? "?"}`; row.cards.push(card); continue; }
        const cue = (picked.body ?? []).find((c) => c.role === role.id && c.source === "pick");
        card.chosen = choice.name; card.chosen_rank = options.findIndex((o) => o.name === choice.name); if (card.chosen_rank < 0) card.chosen_rank = null;
        card.via = via; card.hook_source = cue?.hook_source ?? null; card.entity_id = cue?.qloo_entity_id ?? null; card.shown_rank = cue?.shown_rank ?? null;
        totals.cards++; if (card.ranked) totals.ranked_cards++; if (fav.rank != null) totals.favorite_hits++; totals.picks++;
        if (judge) {
          const j = await call("POST", "/api/sim/judge", { term_id: row.term_id, role: role.id, label: choice.name, ...(opts.judgeProvider ? { provider: opts.judgeProvider } : {}) });
          card.judge = j.status === 200 ? { score: j.body.score, reason: j.body.reason, provider: j.body.provider, model: j.body.model } : { error: `${j.status} ${j.body?.error ?? j.body?.status ?? ""}`.trim() };
          if (j.status === 200) { totals.judged++; totals.sound_sum += j.body.score; }
        }
        row.cards.push(card);
        // The lesson reloads after a pick, as the client does: the cards still ahead come back ranked with it.
        term = (await call("GET", `/api/terms/${row.term_id}`)).body;
      }
      // Practice, taste-blind: each prompt once, the definition as the answer, whatever the hooks were.
      const answer = String(term?.definition ?? term?.summary ?? w.word).slice(0, 300);
      const total = term?.prompt_count ?? 0;
      let after = null;
      for (let i = 0; i < total; i++) {
        const nx = await call("GET", `/api/practice/${row.term_id}/next${after ? `?after=${encodeURIComponent(after)}` : ""}`);
        const prompt = nx.body?.prompt; if (!prompt) break;
        const at = await call("POST", "/api/attempts", { prompt_id: prompt.id, response: answer, idempotency_key: `sim-${runId}-${row.term_id}-${i}`.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) });
        row.practice.push({ prompt: prompt.id, skill: prompt.skill, outcome: at.body?.outcome ?? `http ${at.status}`, independent: Boolean(at.body?.independent), seconds: nowS(t0) });
        totals.answers++; if (at.body?.outcome === "correct") totals.correct++;
        after = prompt.id;
      }
      row.progress = (await call("GET", `/api/progress/${row.term_id}`)).body?.hooks?.line ?? null;
    } catch (e) { if (e.message !== "stop") row.errors.push(e.message); }
    row.seconds.done = nowS(t0);
    const ex = (await call("GET", "/api/export")).body;
    row.spend = spend(ex?.provider_calls ?? [], since);
    totals.words++; totals.qloo_calls += row.spend.qloo_calls; totals.tokens += row.spend.tokens_in + row.spend.tokens_out; totals.errors += row.errors.length;
    emit(row);
    say(`  ${w.word}: ${row.term_id ?? "-"}${row.created ? " (drafted)" : ""} · ${row.cards.length} cards (${row.cards.filter((c) => c.ranked).length} ranked, ${row.cards.filter((c) => c.favorite_rank != null).length} with a like) · practice ${row.practice.filter((p) => p.outcome === "correct").length}/${row.practice.length} · qloo ${row.spend.qloo_calls} · tokens ${row.spend.tokens_in}/${row.spend.tokens_out} · ${row.seconds.done}s${row.errors.length ? ` · errors: ${row.errors.join("; ")}` : ""}`);
  }
  const summary = { kind: "summary", run: runId, persona: persona.slug, level: lvl, arm, ...totals, sound_match: totals.judged ? Number((totals.sound_sum / totals.judged).toFixed(2)) : null, file };
  emit(summary);
  say(`done: ${totals.words} words, ${totals.cards} cards (${totals.ranked_cards} ranked, ${totals.favorite_hits} with a like), practice ${totals.correct}/${totals.answers} (scripted), qloo ${totals.qloo_calls}, tokens ${totals.tokens}${totals.judged ? `, sound match ${summary.sound_match} over ${totals.judged} judged` : ""}${file ? `\n${file}` : ""}`);
  return { run: runId, file, lines, summary };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  simulate(parseArgs(process.argv.slice(2))).catch((e) => { console.error(`simulate-learner: ${e.message}`); process.exitCode = 1; });
}
