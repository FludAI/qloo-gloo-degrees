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
const { entityFor } = await import("../src/taste.mjs");

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
