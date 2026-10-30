// Qloo-built cards (cards.mjs) with a mocked Qloo runner: the popularity floor, the per-word describe cap, the
// cache (a known entity costs nothing), Qloo's picture with Wikipedia as the fallback, and a card Qloo cannot fill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";
process.env.MEDIA_LOCAL = "1";
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-cards-"));
const { qlooCards, POP_FLOOR, DESCRIBE_CAP, KEEP, CANDIDATES } = await import("../src/cards.mjs");
const { entityFor, isUnresolved } = await import("../src/taste.mjs");

// A fixture graph: popularity by name; "Nobody" is unknown; only some have pictures.
const GRAPH = { Pepsi: 0.99, "Coca-Cola": 0.98, "RC Cola": 0.25, "Inca Kola": 0.4, Fanta: 0.7, Sprite: 0.8, Nobody: null, "Sister Act": 0.6, Sisters: 0.35, "Twisted Sister": 0.75 };
const PICS = new Set(["Pepsi", "Coca-Cola", "Sprite", "Sister Act"]);
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
  { id: "chole", part: "chole", sound_like: "cola", pick: { question: "Say your favorite cola.", options: ["Pepsi", "RC Cola", "Nobody", "Coca-Cola", "Inca Kola", "Fanta", "Sprite"].map((n) => opt(n)) } },
  { id: "cysto", part: "cysto", sound_like: "sister", pick: { question: "Say your favorite Sister.", options: [opt("Sister Act", "movie"), opt("Sisters", "movie"), opt("Twisted Sister", "artist"), { name: "Typed", wiki: null, say: [], qloo: null, connection: "no type" }] } },
  { id: "meaning", part: "kin", meaning: "movement" },
] });
const plenty = () => 150;

test("defaults are env-tunable with sane values", () => {
  assert.equal(POP_FLOOR, 0.3); assert.equal(DESCRIBE_CAP, 40); assert.equal(KEEP, 8); assert.equal(CANDIDATES, 12);
});

test("candidates are described once each, kept above the floor, sorted by popularity, with Qloo's picture and the wiki fallback", async () => {
  const { call, seen } = runner();
  const out = await qlooCards(packet(), call, { budget: plenty });
  assert.equal(out.cards.source, "qloo"); assert.equal(out.cards.describes, 10); assert.equal(out.cards.skipped, 0);
  const chole = out.roles[0].pick;
  assert.deepEqual(chole.options.map((o) => o.name), ["Pepsi", "Coca-Cola", "Sprite", "Fanta", "Inca Kola"]); // RC Cola under the floor, Nobody unknown
  assert.deepEqual(chole.built, { source: "qloo", candidates: 7, resolved: 5, kept: 5, floor: 0.3 });
  assert.equal(chole.options[0].image, "https://images.qloo.com/i/id-pepsi.jpg");
  assert.deepEqual(chole.options[0].qloo, { entity: "Pepsi", type: "brand", entity_id: "id-pepsi", popularity: 0.99, image: "https://images.qloo.com/i/id-pepsi.jpg" });
  assert.equal(chole.options[3].image, null, "Fanta has no Qloo picture: the wiki title stays for the fallback");
  assert.equal(chole.options[3].wiki, "Fanta");
  assert.equal(chole.question, "Say your favorite cola.");
  const cysto = out.roles[1].pick;
  assert.deepEqual(cysto.options.map((o) => o.name), ["Twisted Sister", "Sister Act", "Sisters", "Typed"]); // three resolved, padded to four with the untyped one
  assert.equal(cysto.options[3].qloo, null);
  assert.deepEqual(out.roles[2], packet().roles[2], "a role without a pick is untouched");
  // The cache learned every record, so the same word again costs nothing.
  assert.equal(entityFor("Pepsi", "brand").popularity, 0.99);
  assert.equal(entityFor("Fanta", "brand").image, undefined);
  seen.length = 0;
  const again = await qlooCards(packet(), call, { budget: plenty });
  assert.deepEqual(seen.map((s) => s[1]), [], "the unknown name is remembered as unresolved, so nothing is asked again");
  assert.deepEqual(again.roles[0].pick.options.map((o) => o.name), ["Pepsi", "Coca-Cola", "Sprite", "Fanta", "Inca Kola"]);
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
  assert.equal(broke.roles[0].pick.options.length, 5, "known entities from the cache still resolve; the card is padded to four at least");
  assert.ok(broke.roles[0].pick.options.slice(0, 3).every((o) => o.qloo.entity_id));
});

test("a higher floor and a smaller keep narrow the card; the floor is reported on it", async () => {
  const { call } = runner();
  const out = await qlooCards(packet(), call, { floor: 0.9, keep: 4, budget: plenty });
  assert.deepEqual(out.roles[0].pick.options.map((o) => o.name), ["Pepsi", "Coca-Cola", "RC Cola", "Nobody"]); // two above 0.9, padded to four in the drafter's order
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
  const out = await qlooCards({ id: "p-3", roles: [{ id: "chole", part: "chole", pick: { question: "Which cola?", options: many } }] }, call, { budget: plenty });
  assert.equal(seen.length, KEEP, "one describe per kept option, none past that"); assert.equal(out.cards.describes, KEEP); assert.equal(out.cards.unasked, 12 - KEEP);
  assert.equal(out.roles[0].pick.options.length, KEEP); assert.ok(out.roles[0].pick.options.every((o) => o.qloo.entity_id));
  const four = await qlooCards({ id: "p-4", roles: [{ id: "chole", part: "chole", pick: { question: "Which cola?", options: Array.from({ length: 6 }, (_, i) => opt(`Soda ${i + 1}`)) } }] }, call, { keep: 2, budget: plenty });
  assert.equal(four.roles[0].pick.options.length, 4, "never fewer than the four a card shows");
});
