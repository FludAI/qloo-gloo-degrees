// Qloo-built cards (cards.mjs) with a mocked Qloo runner: the sound bar (a name that only shares a first letter with
// the piece is dropped before any describe), sound-first ordering, the fallback to the drafter's four, the popularity
// floor, the per-word describe cap, the cache (a known entity costs nothing), Qloo's picture with Wikipedia as the
// fallback, and the model judge behind SOUND_JUDGE through a fake Anthropic backend (no real model is ever called).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-cards-"));
delete process.env.SOUND_JUDGE; delete process.env.ANTHROPIC_API_KEY; delete process.env.META_API_KEY;
const { qlooCards, cardsRecord, soundOf, clears, POP_FLOOR, DESCRIBE_CAP, KEEP, CANDIDATES, JUDGE, MIN_CLEARED, SOUND } = await import("../src/cards.mjs");
const { entityFor, isUnresolved } = await import("../src/taste.mjs");
const { db } = await import("../src/db.mjs");

// A fixture graph: popularity by name; "Nobody" is unknown; only some have pictures.
const GRAPH = { "Pepsi-Cola": 0.99, "Coca-Cola": 0.98, "RC Cola": 0.25, "Inca Kola": 0.4, Fanta: 0.7, Sprite: 0.8, Nobody: null, "Sister Act": 0.6, Sisters: 0.35, "Twisted Sister": 0.75,
  "Britney Spears": 0.95, Spotify: 0.9, "The Simpsons": 0.93, Snapchat: 0.88, SpongeBob: 0.9, "Spic and Span": 0.5, Spicy: 0.45, "Spice Girls": 0.8, "Spin City": 0.9 };
const PICS = new Set(["Pepsi-Cola", "Coca-Cola", "Sprite", "Sister Act"]);
const runner = () => {
  const seen = [];
  const call = async (op, args) => {
    seen.push([op, args.entity]);
    assert.equal(op, "describe");
    const pop = GRAPH[args.entity];
    if (pop == null) return { status: "empty", results: [] };
    const id = `id-${args.entity.toLowerCase().replace(/[^a-z]+/g, "-")}`;
    return { status: "ok", results: [{ entity_id: id, name: args.entity, popularity: pop, properties: PICS.has(args.entity) ? { image: { url: `https://images.qloo.com/i/${id}.jpg` } } : {} }] };
  };
  return { call, seen };
};
const opt = (name, type = "brand") => ({ name, wiki: name, say: [], qloo: { entity: name, type }, connection: `${name} sounds like it.` });
const packet = () => ({ id: "p-1", roles: [
  { id: "chole", part: "chole", sound_like: "cola", pick: { question: "Say your favorite cola.", options: ["Pepsi-Cola", "RC Cola", "Nobody", "Coca-Cola", "Inca Kola", "Fanta", "Sprite"].map((n) => opt(n)) } },
  { id: "cysto", part: "cysto", sound_like: "sister", pick: { question: "Say your favorite Sister.", options: [opt("Sister Act", "movie"), opt("Sisters", "movie"), opt("Twisted Sister", "artist"), { name: "Typed", wiki: null, say: [], qloo: null, connection: "no type" }] } },
  { id: "meaning", part: "kin", meaning: "movement" },
] });
// The live "spic" card as it was offered: five names that share a first letter with the piece, and three that carry its sound.
const SPIC = [["Britney Spears", "person"], ["Spotify", "brand"], ["The Simpsons", "tv_show"], ["Snapchat", "brand"], ["SpongeBob", "tv_show"], ["Spic and Span", "brand"], ["Spicy", "movie"], ["Spice Girls", "artist"]];
const spic = (names = SPIC) => ({ id: "p-spic", roles: [{ id: "spic", part: "spic", sound_like: "spick", say: "spik", pick: { question: "Say your favorite spick.", options: names.map(([n, t]) => opt(n, t)) } }] });
const plenty = () => 150;
const noJudge = { source: "qloo", judge: "off", judged: 0, judge_zero: 0, judge_failed: 0, bar: 0.75 };

test("defaults are env-tunable with sane values; the judge is off unless SOUND_JUDGE names an arm", () => {
  assert.equal(POP_FLOOR, 0.3); assert.equal(DESCRIBE_CAP, 40); assert.equal(KEEP, 8); assert.equal(CANDIDATES, 12); assert.equal(JUDGE, "off"); assert.equal(MIN_CLEARED, 3); assert.equal(SOUND, 0.75);
});

test("the sound bar: a name scores 0 to 1 against the piece's sound, and only a name above the bar clears it", () => {
  const role = { part: "spic", sound_like: "spick" };
  assert.deepEqual(SPIC.map(([n]) => [n, soundOf(role, n)]), [["Britney Spears", 0.67], ["Spotify", 0.67], ["The Simpsons", 0.5], ["Snapchat", 0.75], ["SpongeBob", 0.75], ["Spic and Span", 1], ["Spicy", 1], ["Spice Girls", 1]]);
  assert.equal(clears(0.75), false, "at the bar is not above it"); assert.equal(clears(0.76), true); assert.equal(clears(1), true);
  assert.equal(soundOf(role, { name: "X", say: ["spick"] }), 1, "a spoken form counts, as the one scorer has always read it");
});

test("a built card drops the names that only share a first letter with the piece, never describes them, and records the drops", async () => {
  const { call, seen } = runner();
  const out = await qlooCards(spic(), call, { budget: plenty });
  const card = out.roles[0].pick;
  assert.deepEqual(card.options.map((o) => o.name), ["Spice Girls", "Spic and Span", "Spicy"], "the true matches, by sound then popularity");
  assert.deepEqual(card.options.map((o) => o.sound), [1, 1, 1]);
  assert.ok(card.options.every((o) => o.qloo.entity_id && o.sound_judged === undefined));
  assert.deepEqual(seen.map((s) => s[1]), ["Spic and Span", "Spicy", "Spice Girls"], "a dropped name costs no describe");
  assert.deepEqual(card.built, { source: "qloo", candidates: 8, cleared: 3, kept: 3, resolved: 3, fallback: null, bar: 0.75, floor: 0.3,
    dropped: [{ name: "Britney Spears", sound: 0.67 }, { name: "Spotify", sound: 0.67 }, { name: "The Simpsons", sound: 0.5 }, { name: "Snapchat", sound: 0.75 }, { name: "SpongeBob", sound: 0.75 }] });
  assert.deepEqual(out.cards, { ...noJudge, describes: 3, skipped: 0, unasked: 0, cap: 40, floor: 0.3, dropped: 5, fallbacks: 0 });
  assert.deepEqual(cardsRecord(out).roles, [{ role: "spic", candidates: 8, cleared: 3, kept: 3, dropped: 5, fallback: null, bar: 0.75, judged: null, judge_zero: 0, judge_failed: null }]);
  assert.equal(cardsRecord({ id: "x", roles: [] }), null, "a packet whose cards were not built has no record");
});

test("kept names are ordered by sound first and popularity second", async () => {
  const { call } = runner();
  const out = await qlooCards(spic([...SPIC, ["Spin City", "tv_show"]]), call, { budget: plenty });
  const card = out.roles[0].pick;
  assert.deepEqual(card.options.map((o) => [o.name, o.sound, o.qloo.popularity]), [["Spice Girls", 1, 0.8], ["Spic and Span", 1, 0.5], ["Spicy", 1, 0.45], ["Spin City", 0.8, 0.9]], "Spin City is the most popular and clears the bar, but its sound is fainter, so it comes last");
  assert.equal(card.built.cleared, 4);
});

test("fewer than three names above the bar: the card keeps the drafter's first four and the record says why", async () => {
  const { call, seen } = runner();
  const out = await qlooCards(spic(SPIC.slice(0, 7)), call, { budget: plenty }); // Spic and Span and Spicy are the only true matches
  const card = out.roles[0].pick;
  assert.deepEqual(card.options.map((o) => o.name), ["Britney Spears", "Spotify", "The Simpsons", "Snapchat"]);
  assert.deepEqual(card.options.map((o) => o.sound), [0.67, 0.67, 0.5, 0.75]);
  assert.equal(seen.length, 0, "a card that falls back spends no describe");
  assert.equal(card.built.fallback, "fewer than three names cleared the sound bar");
  assert.equal(card.built.cleared, 2); assert.equal(card.built.kept, 4); assert.equal(card.built.resolved, 0); assert.equal(card.built.dropped.length, 5);
  assert.equal(out.cards.fallbacks, 1); assert.equal(out.cards.dropped, 5);
  assert.equal(cardsRecord(out).roles[0].fallback, "fewer than three names cleared the sound bar");
});

test("a meaning role has no sound to carry: no bar, no scores, every candidate is a candidate", async () => {
  const graph = { Hop: 0.9, Skip: 0.5, Jump: 0.95 };
  const call = async (op, args) => ({ status: "ok", results: [{ entity_id: `id-${args.entity.toLowerCase()}`, name: args.entity, popularity: graph[args.entity] }] });
  const out = await qlooCards({ id: "p-m", roles: [{ id: "kin", part: "kin", meaning: "movement", pick: { question: "q", options: ["Hop", "Skip", "Jump"].map((n) => opt(n)) } }] }, call, { budget: plenty });
  const card = out.roles[0].pick;
  assert.deepEqual(card.options.map((o) => o.name), ["Jump", "Hop", "Skip"]);
  assert.ok(card.options.every((o) => o.sound === undefined));
  assert.equal(card.built.bar, null); assert.deepEqual(card.built.dropped, []); assert.equal(card.built.fallback, null);
});

test("candidates are described once each, kept above the floor, sorted by popularity, with Qloo's picture and the wiki fallback", async () => {
  const { call, seen } = runner();
  const out = await qlooCards(packet(), call, { budget: plenty });
  assert.equal(out.cards.source, "qloo"); assert.equal(out.cards.describes, 7); assert.equal(out.cards.skipped, 0); assert.equal(out.cards.dropped, 4);
  const chole = out.roles[0].pick;
  assert.deepEqual(chole.options.map((o) => o.name), ["Pepsi-Cola", "Coca-Cola", "Inca Kola", "RC Cola"]); // Nobody, Fanta and Sprite under the bar; RC Cola under the floor fills the fourth tile
  assert.deepEqual(chole.built, { source: "qloo", candidates: 7, cleared: 4, kept: 4, resolved: 3, fallback: null, bar: 0.75, floor: 0.3, dropped: [{ name: "Nobody", sound: 0.25 }, { name: "Fanta", sound: 0.25 }, { name: "Sprite", sound: 0.25 }] });
  assert.equal(chole.options[0].image, "https://images.qloo.com/i/id-pepsi-cola.jpg");
  assert.deepEqual(chole.options[0].qloo, { entity: "Pepsi-Cola", type: "brand", entity_id: "id-pepsi-cola", popularity: 0.99, image: "https://images.qloo.com/i/id-pepsi-cola.jpg" });
  assert.equal(chole.options[2].image, null, "Inca Kola has no Qloo picture: the wiki title stays for the fallback");
  assert.equal(chole.options[2].wiki, "Inca Kola");
  assert.equal(chole.question, "Say your favorite cola.");
  const cysto = out.roles[1].pick;
  assert.deepEqual(cysto.options.map((o) => o.name), ["Twisted Sister", "Sister Act", "Sisters"]); // three resolved; the untyped "Typed" is under the bar
  assert.deepEqual(cysto.built.dropped, [{ name: "Typed", sound: 0.33 }]);
  assert.deepEqual(out.roles[2], packet().roles[2], "a role without a pick is untouched");
  // The cache learned every record, so the same word again costs nothing.
  assert.equal(entityFor("Pepsi-Cola", "brand").popularity, 0.99);
  assert.equal(entityFor("Inca Kola", "brand").image, undefined);
  seen.length = 0;
  const again = await qlooCards(packet(), call, { budget: plenty });
  assert.deepEqual(seen.map((s) => s[1]), [], "every name is known, so nothing is asked again");
  assert.deepEqual(again.roles[0].pick.options.map((o) => o.name), ["Pepsi-Cola", "Coca-Cola", "Inca Kola", "RC Cola"]);
});

test("the per-word cap and the day's reserve stop describes; what resolved still leads, the rest fill in the drafter's order", async () => {
  const { call, seen } = runner();
  const fresh = { id: "p-2", roles: [{ id: "x", part: "x", pick: { question: "q", options: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((n) => opt(n)) } }] };
  const graph = { Alpha: 0.9, Beta: 0.5, Gamma: 0.95, Delta: 0.6, Epsilon: 0.7 };
  const capped = async (op, args) => ({ status: "ok", results: [{ entity_id: `id-${args.entity.toLowerCase()}`, name: args.entity, popularity: graph[args.entity] }] });
  const out = await qlooCards(fresh, capped, { cap: 2, budget: plenty });
  assert.equal(out.cards.describes, 2); assert.equal(out.cards.skipped, 3);
  assert.deepEqual(out.roles[0].pick.options.map((o) => o.name), ["Alpha", "Beta", "Gamma", "Delta"]); // Alpha (0.9) and Beta (0.5) resolved and ordered; Gamma.. unresolved in order
  assert.equal(out.roles[0].pick.options[2].qloo.entity_id, undefined);
  const broke = await qlooCards(packet(), call, { budget: () => 0 });
  assert.equal(seen.length, 0, "no budget: no describe at all");
  assert.equal(broke.roles[0].pick.options.length, 4, "known entities from the cache still resolve; the card is padded to four at least");
  assert.ok(broke.roles[0].pick.options.slice(0, 3).every((o) => o.qloo.entity_id));
});

test("a higher floor and a smaller keep narrow the card; the floor is reported on it", async () => {
  const { call } = runner();
  const out = await qlooCards(packet(), call, { floor: 0.9, keep: 4, budget: plenty });
  assert.deepEqual(out.roles[0].pick.options.map((o) => o.name), ["Pepsi-Cola", "Coca-Cola", "RC Cola", "Inca Kola"]); // two above 0.9, padded to four with the cleared names in the drafter's order
  assert.equal(out.roles[0].pick.built.floor, 0.9);
  assert.equal(out.roles[0].pick.options[2].qloo.popularity, 0.25, "a resolved name under the floor still carries what Qloo said");
});

test("a needs_input answer is settled once: the same-named candidate is learned, any other name is remembered as unresolved, and neither is asked again", async () => {
  const seen = [];
  const call = async (op, args) => {
    seen.push(args.entity);
    if (args.entity === "Perry Mason") return { status: "needs_input", results: [], resolution: { issues: [{ field: "entity", input: "Perry Mason", candidates: [
      { id: "id-perry-mason-1957", name: "Perry Mason", type: "urn:entity:tv_show", popularity: 0.81, properties: { image: { url: "https://images.qloo.com/i/pm.jpg" } } },
      { id: "id-perry-mason-2020", name: "Perry Mason (2020)", type: "urn:entity:tv_show", popularity: 0.6 } ] }] } };
    if (args.entity === "Perry's Diner") return { status: "needs_input", results: [], resolution: { issues: [{ field: "entity", input: "Perry's Diner", candidates: [{ id: "id-x", name: "Perry Street", popularity: 0.2 }] }] } };
    return { status: "ok", results: [{ entity_id: `id-${args.entity.toLowerCase()}`, name: args.entity, popularity: 0.9 }] };
  };
  const pk = () => ({ id: "p-2", roles: [{ id: "peri", part: "peri", pick: { question: "Say your favorite Perry.", options: [opt("Perry Mason", "tv_show"), opt("Perry's Diner", "place"), opt("Perrier", "brand")] } }] });
  const out = await qlooCards(pk(), call, { budget: plenty });
  const names = out.roles[0].pick.options.map((o) => o.name);
  assert.deepEqual(names, ["Perrier", "Perry Mason", "Perry's Diner"], "the matched candidate is kept and ranked; the unmatched name fills the card unresolved");
  assert.deepEqual(out.roles[0].pick.options[1].qloo, { entity: "Perry Mason", type: "tv_show", entity_id: "id-perry-mason-1957", popularity: 0.81, image: "https://images.qloo.com/i/pm.jpg" });
  assert.equal(out.roles[0].pick.options[2].qloo.entity_id, undefined);
  assert.equal(out.cards.describes, 3);
  assert.equal(entityFor("Perry Mason", "tv_show").id, "id-perry-mason-1957"); assert.equal(entityFor("Perry's Diner", "place"), null); assert.equal(isUnresolved("Perry's Diner", "place"), true);
  const again = await qlooCards(pk(), call, { budget: plenty });
  assert.equal(again.cards.describes, 0, "a settled name costs nothing the next time");
  assert.deepEqual(seen, ["Perry Mason", "Perry's Diner", "Perrier"]);
});

test("a card stops asking once it has enough popular names: the rest of the drafter's candidates are not described", async () => {
  const seen = [];
  const call = async (op, args) => { seen.push(args.entity); return { status: "ok", results: [{ entity_id: `id-${seen.length}`, name: args.entity, popularity: 0.9 }] }; };
  const many = Array.from({ length: 12 }, (_, i) => opt(`Cola ${i + 1}`));
  const out = await qlooCards({ id: "p-3", roles: [{ id: "chole", part: "chole", sound_like: "cola", pick: { question: "Which cola?", options: many } }] }, call, { budget: plenty });
  assert.equal(seen.length, KEEP, "one describe per kept option, none past that"); assert.equal(out.cards.describes, KEEP); assert.equal(out.cards.unasked, 12 - KEEP);
  assert.equal(out.roles[0].pick.options.length, KEEP); assert.ok(out.roles[0].pick.options.every((o) => o.qloo.entity_id && o.sound === 1));
  const four = await qlooCards({ id: "p-4", roles: [{ id: "chole", part: "chole", pick: { question: "Which cola?", options: Array.from({ length: 6 }, (_, i) => opt(`Soda ${i + 1}`)) } }] }, call, { keep: 2, budget: plenty });
  assert.equal(four.roles[0].pick.options.length, 4, "never fewer than the four a card shows");
});

// ---- The model judge, through providers.mjs against a fake Anthropic backend: scores come back as the sound_judge tool call. ----
let fake, mode = "scores", requests = [];
const judgeScores = { "Spice Girls": 3, "Spic and Span": 3, Spicy: 0, "Spin City": 1 };
const reply = (content, extra = {}) => ({ id: "msg", type: "message", role: "assistant", model: "fake", stop_reason: "tool_use", content, usage: { input_tokens: 12, output_tokens: 6 }, ...extra });
const judge = () => new Promise((resolve) => {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.setHeader("content-type", "application/json");
      if (mode === "down") { res.statusCode = 400; return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "the fake is down" } })); }
      if (mode === "text") return res.end(JSON.stringify(reply([{ type: "text", text: "I would rather not score these." }], { stop_reason: "end_turn" })));
      const names = String(parsed.messages[0].content).split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
      const scores = names.map((name) => ({ name, score: judgeScores[name] ?? 2 }));
      res.end(JSON.stringify(reply([{ type: "tool_use", id: "j1", name: "sound_judge", input: { scores } }])));
    });
  }).listen(0, () => resolve(fake.address().port));
});
after(() => fake?.close());
const judgeRows = () => db.prepare("SELECT sid, provider, op, status, model, tokens_in, tokens_out, stop, note FROM provider_calls WHERE op = 'sound_judge' ORDER BY id").all().map((r) => ({ ...r }));

test("the judge: one model call per built card scores the cleared names 0 to 3; a 0 drops a name the bar let through; the row and the record say so", async () => {
  const port = await judge();
  process.env.ANTHROPIC_API_KEY = "test-not-a-key"; process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
  const { call, seen } = runner();
  const out = await qlooCards(spic([...SPIC, ["Spin City", "tv_show"]]), call, { budget: plenty, judge: "anthropic", sid: "sid-judge" });
  const card = out.roles[0].pick;
  assert.deepEqual(card.options.map((o) => [o.name, o.sound, o.sound_judged]), [["Spice Girls", 1, 3], ["Spic and Span", 1, 3], ["Spin City", 0.8, 1]], "Spicy cleared the bar and the judge scored it 0");
  assert.ok(!seen.some((s) => s[1] === "Spicy"), "the judge runs before any describe, so a name it drops costs none");
  assert.deepEqual(card.built.judge, { provider: "anthropic", scores: [3, 0, 3, 1], median: 2, zeros: 1, failed: null }, "scores in the order the names were sent");
  assert.deepEqual(card.built.dropped.slice(5), [{ name: "Spicy", sound: 1, sound_judged: 0 }]);
  assert.equal(card.built.cleared, 3); assert.equal(card.built.kept, 3);
  assert.deepEqual(out.cards, { source: "qloo", describes: 0, skipped: 0, unasked: 0, cap: 40, floor: 0.3, bar: 0.75, dropped: 5, fallbacks: 0, judge: "anthropic", judged: 4, judge_zero: 1, judge_failed: 0 }, "every name is in the cache from the cards above; dropped counts the bar's drops, the judge's zero apart");
  assert.deepEqual(cardsRecord(out).roles[0], { role: "spic", candidates: 9, cleared: 3, kept: 3, dropped: 5, fallback: null, bar: 0.75, judged: [3, 0, 3, 1], judge_zero: 1, judge_failed: null });
  // One request, the part's sound and the four cleared names, through the fake; nothing else about the session travels.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools[0].name, "sound_judge");
  assert.match(String(requests[0].messages[0].content), /^Part: "spic", sounds like "spick", said "spik"\.\nNames:\n- Spic and Span\n- Spicy\n- Spice Girls\n- Spin City$/);
  assert.ok(!JSON.stringify(requests[0]).includes("sid-judge"));
  assert.deepEqual(judgeRows(), [{ sid: "sid-judge", provider: "anthropic", op: "sound_judge", status: "ok", model: "claude-sonnet-5-5", tokens_in: 12, tokens_out: 6, stop: "tool_use", note: null }]);
  // Off (the default), nothing is asked.
  requests = [];
  const off = await qlooCards(spic(), call, { budget: plenty, sid: "sid-off" });
  assert.equal(requests.length, 0); assert.equal(off.roles[0].pick.built.judge, undefined); assert.ok(off.roles[0].pick.options.every((o) => o.sound_judged === undefined));
});

test("the judge can empty a card: zeros that leave fewer than three names fall back to the drafter's four, with the reason", async () => {
  const { call } = runner();
  requests = [];
  const out = await qlooCards(spic(), call, { budget: plenty, judge: "anthropic", sid: "sid-judge-2" }); // three cleared; Spicy judged 0 leaves two
  const card = out.roles[0].pick;
  assert.deepEqual(card.options.map((o) => o.name), ["Britney Spears", "Spotify", "The Simpsons", "Snapchat"]);
  assert.equal(card.built.fallback, "fewer than three names after the judge");
  assert.equal(card.built.cleared, 2); assert.equal(card.built.judge.zeros, 1);
  assert.equal(out.cards.fallbacks, 1);
});

test("a judge failure leaves the deterministic result and notes it: a backend error, or an answer without the tool call", async () => {
  const { call } = runner();
  mode = "down"; requests = [];
  const down = await qlooCards(spic(), call, { budget: plenty, judge: "anthropic", sid: "sid-down" });
  let card = down.roles[0].pick;
  assert.deepEqual(card.options.map((o) => o.name), ["Spice Girls", "Spic and Span", "Spicy"], "the bar's result stands");
  assert.ok(card.options.every((o) => o.sound_judged === undefined));
  assert.equal(card.built.judge.provider, "anthropic"); assert.match(card.built.judge.failed, /the fake is down/); assert.deepEqual(card.built.judge.scores, []); assert.equal(card.built.judge.zeros, 0);
  assert.equal(down.cards.judge_failed, 1); assert.equal(down.cards.judged, 0);
  assert.equal(cardsRecord(down).roles[0].judge_failed, card.built.judge.failed);
  assert.equal(cardsRecord(down).roles[0].judged.length, 0);
  mode = "text";
  const text = await qlooCards(spic(), call, { budget: plenty, judge: "anthropic", sid: "sid-text" });
  card = text.roles[0].pick;
  assert.deepEqual(card.options.map((o) => o.name), ["Spice Girls", "Spic and Span", "Spicy"]);
  assert.match(card.built.judge.failed, /no sound_judge call \(stop end_turn\)/);
  const rows = judgeRows().slice(1);
  assert.deepEqual(rows.map((r) => [r.sid, r.status, r.note]), [["sid-judge-2", "ok", null], ["sid-down", "error", null], ["sid-text", "ok", "no_tool"]]);
  mode = "scores";
});

test("SOUND_JUDGE=muse without a Meta key falls back to the other arm and the row records it", async () => {
  const { call } = runner();
  requests = [];
  const out = await qlooCards(spic(), call, { budget: plenty, judge: "muse", sid: "sid-muse" });
  assert.equal(out.roles[0].pick.built.judge.provider, "muse", "the arm asked for");
  assert.equal(requests.length, 1);
  const row = db.prepare("SELECT provider, fallback_from FROM provider_calls WHERE sid = 'sid-muse' AND op = 'sound_judge'").get();
  assert.equal(row.provider, "anthropic"); assert.equal(row.fallback_from, "muse");
});
