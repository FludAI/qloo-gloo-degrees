// The taste loop's guards, with a fake Qloo: no call under two picks or near the budget, the editorial order
// on any trouble, and an option without the piece's sound never promoted whatever Qloo scores it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MEDIA_LOCAL = "1"; // never the real bucket
process.env.DB_PATH ??= ":memory:"; // offers are written through db.mjs; never the dev database
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-taste-"));
const { tailorRole, tailorTerm, resolveEntity, entityIdFor, RESERVE, MIN_PICKS, norm } = await import("../src/taste.mjs");

const role = { id: "chole", part: "chole", sound_like: "cola", pick: { question: "Say your favorite cola.", options: [
  { name: "Coca-Cola", wiki: "Coca-Cola", say: ["coke"], qloo: { entity: "Coca-Cola", type: "brand" }, connection: "c" },
  { name: "Zebra", wiki: "Zebra", say: ["zebra"], qloo: { entity: "Zebra", type: "brand" }, connection: "z" }, // carries no "cola" sound
  { name: "Pepsi-Cola", wiki: "Pepsi", say: ["pepsi"], qloo: { entity: "Pepsi", type: "brand" }, connection: "p" },
  { name: "Brie", wiki: "Brie", say: ["brie"], qloo: null, connection: "no entity" },
] } };
const signals = ["mock-a", "mock-b"];
const plenty = () => 150;
const answer = (results) => async () => ({ status: "ok", results });

test("no call under two picks, and none when the day's budget is nearly spent", async () => {
  let calls = 0;
  const call = async () => { calls++; return { status: "ok", results: [] }; };
  const one = await tailorRole(role, ["mock-a"], call, { budget: plenty });
  assert.equal(one.pick.tailoring.source, "editorial"); assert.equal(one.pick.tailoring.reason, "fewer than two picks");
  const broke = await tailorRole(role, signals, call, { budget: () => RESERVE - 1 });
  assert.equal(broke.pick.tailoring.reason, "budget");
  assert.equal(calls, 0);
  assert.equal(MIN_PICKS, 2);
});

test("a ranked card keeps every option; the one without the sound is never promoted", async () => {
  const seen = [];
  const call = async (op, args) => { seen.push([op, args]); return { status: "ok", results: [
    { entity_id: "id-zebra", name: "Zebra", affinity: 0.99 }, // Qloo loves it, but it is not a cola
    { entity_id: "id-pepsi", name: "Pepsi", affinity: 0.8 },
    { entity_id: "id-coke", name: "Coca-Cola", affinity: 0.5 },
  ] }; };
  const t = await tailorRole(role, signals, call, { budget: plenty });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "rank");
  assert.deepEqual(seen[0][1], { options: ["Coca-Cola", "Pepsi"], option_type: "brand", signals }); // Zebra and Brie were never sent
  assert.equal(t.pick.tailoring.source, "taste");
  assert.deepEqual(t.pick.options.map((o) => o.name), ["Pepsi-Cola", "Coca-Cola", "Zebra", "Brie"]);
  assert.deepEqual(t.pick.tailoring.ranked, ["Pepsi-Cola", "Coca-Cola"]);
  assert.equal(t.pick.options[0].taste, 0.8);
  assert.equal(t.pick.options[2].taste, undefined);
  assert.ok(t.pick.options.every((o) => o.wiki && o.connection));
  // The answer taught the IDs (for free), so from now on the options go as IDs (exact; one new cache key, once).
  assert.equal(entityIdFor("Pepsi", "brand"), "id-pepsi");
  assert.equal(entityIdFor("coca cola", "brand"), "id-coke");
  seen.length = 0;
  await tailorRole(role, signals, call, { budget: plenty });
  assert.deepEqual(seen[0][1].options, ["id-coke", "id-pepsi"]);
  // The learner's own earlier pick leads its card, ahead of what Qloo scores, and is not sent (Qloo leaves signals out anyway).
  seen.length = 0;
  const mine = await tailorRole(role, ["id-coke", "mock-b"], call, { budget: plenty });
  assert.equal(seen.length, 0, "one other entity left: nothing to rank");
  assert.deepEqual(mine.pick.options.map((o) => o.name), ["Coca-Cola", "Zebra", "Pepsi-Cola", "Brie"]);
  assert.equal(mine.pick.options[0].taste, 1);
});

test("needs_input: names Qloo cannot match exactly are dropped, remembered, and the rest ranked in one more call", async () => {
  const colas = { id: "chole", part: "chole", sound_like: "cola", pick: { options: [
    { name: "Coca-Cola", wiki: "Coca-Cola", say: ["coke"], qloo: { entity: "Coca-Cola", type: "brand" }, connection: "c" },
    { name: "Pepsi-Cola", wiki: "Pepsi", say: ["pepsi"], qloo: { entity: "Pepsi", type: "brand" }, connection: "p" },
    { name: "RC Cola", wiki: "RC Cola", say: ["rc"], qloo: { entity: "RC Cola", type: "brand" }, connection: "r" },
    { name: "Inca Kola", wiki: "Inca Kola", say: ["inca"], qloo: { entity: "Inca Kola", type: "brand" }, connection: "i" },
  ] } };
  const seen = [];
  const call = async (op, args) => {
    seen.push(args.options);
    if (args.options.includes("RC Cola")) return { status: "needs_input", summary: "Choose or correct the unresolved ranking inputs.", resolution: { issues: [
      { input: "RC Cola", kind: "ambiguous", field: "options", candidates: [{ id: "x1", name: "Royal Challengers Bangalore" }] },
      { input: "Inca Kola", kind: "ambiguous", field: "options", candidates: [{ id: "x2", name: "Fritz-kola" }] },
      { input: "Coca-Cola", kind: "ambiguous", field: "options", candidates: [{ id: "id-coke-2", name: "Coca-Cola" }, { id: "x3", name: "Coca-Cola Zero" }] }, // several: the one with that exact name
    ] } };
    return { status: "ok", results: [{ entity_id: "id-pepsi", name: "Pepsi", affinity: 0.9 }, { entity_id: "id-coke-2", name: "Coca-Cola", affinity: 0.7 }] };
  };
  const t = await tailorRole(colas, signals, call, { budget: plenty });
  // Coca-Cola's ID was known from the earlier test (id-coke), so the first call sends it; the fake's issue names the exact-name
  // candidate id-coke-2, which replaces it for the retry (in reality an ID is never reported as ambiguous).
  assert.deepEqual(seen, [["id-coke", "id-pepsi", "RC Cola", "Inca Kola"], ["id-coke-2", "id-pepsi"]]);
  assert.deepEqual(t.pick.options.map((o) => o.name), ["Pepsi-Cola", "Coca-Cola", "RC Cola", "Inca Kola"]);
  assert.equal(t.pick.tailoring.source, "taste");
  assert.equal(t.pick.options[1].taste, 0.7, "matched by name when the IDs differ");
  // Next time the unmatched names are not sent at all: one call.
  seen.length = 0;
  await tailorRole(colas, signals, call, { budget: plenty });
  assert.deepEqual(seen, [["id-coke-2", "id-pepsi"]]);
  // A name with several matches, none known yet: the exact-name candidate's ID is learned and sent in the retry.
  const films = { id: "cysto", part: "cysto", sound_like: "sister", pick: { options: [
    { name: "Sister Act", wiki: "Sister Act", say: ["sister act"], qloo: { entity: "Sister Act", type: "movie" }, connection: "a" },
    { name: "Sisters (2015)", wiki: "Sisters (2015 film)", say: ["sisters"], qloo: { entity: "Sisters", type: "movie" }, connection: "b" },
  ] } };
  seen.length = 0;
  const call2 = async (op, args) => {
    seen.push(args.options);
    if (args.options.includes("Sisters")) return { status: "needs_input", resolution: { issues: [{ input: "Sisters", field: "options", candidates: [{ id: "m-1973", name: "Sisters" }, { id: "m-2015", name: "Sisters (2015 film)" }] }] } };
    return { status: "ok", results: [{ entity_id: "m-1973", name: "Sisters", affinity: 0.8 }, { entity_id: "m-act", name: "Sister Act", affinity: 0.6 }] };
  };
  const f = await tailorRole(films, signals, call2, { budget: plenty });
  assert.deepEqual(seen, [["Sister Act", "Sisters"], ["Sister Act", "m-1973"]]); // only Sisters was ambiguous
  assert.deepEqual(f.pick.options.map((o) => o.name), ["Sisters (2015)", "Sister Act"]);
  // The original role is untouched.
  assert.equal(role.pick.options[0].name, "Coca-Cola"); assert.equal(role.pick.options[0].taste, undefined);
});

test("any trouble leaves the editorial order: an error envelope, a throw, an answer that names nothing", async () => {
  const names = (t) => t.pick.options.map((o) => o.name);
  const editorial = ["Coca-Cola", "Zebra", "Pepsi-Cola", "Brie"];
  const err = await tailorRole(role, signals, async () => ({ status: "error", results: [], error: { code: "DEMO_RATE_LIMIT" } }), { budget: plenty });
  assert.deepEqual(names(err), editorial); assert.equal(err.pick.tailoring.reason, "DEMO_RATE_LIMIT");
  const thrown = await tailorRole(role, signals, async () => { throw new Error("harness down"); }, { budget: plenty });
  assert.deepEqual(names(thrown), editorial); assert.equal(thrown.pick.tailoring.reason, "harness down");
  const nothing = await tailorRole(role, signals, answer([{ entity_id: "x", name: "Fanta", affinity: 0.9 }]), { budget: plenty });
  assert.deepEqual(names(nothing), editorial); assert.equal(nothing.pick.tailoring.reason, "no match");
  // A piece whose options are one entity said two ways (kin) is never sent.
  const kin = { id: "kin", part: "kin", sound_like: "KY-netic Sand", pick: { options: [
    { name: "KY-netic Sand", wiki: "Kinetic Sand", say: ["ky-netic"], qloo: { entity: "Kinetic Sand", type: "brand" }, connection: "a" },
    { name: "kih-NET-ic Sand", wiki: "Kinetic Sand", say: ["kinetic sand"], qloo: { entity: "Kinetic Sand", type: "brand" }, connection: "b" } ] } };
  let calls = 0;
  const same = await tailorRole(kin, signals, async () => { calls++; }, { budget: plenty });
  assert.equal(calls, 0); assert.equal(same.pick.tailoring.reason, "one entity");
});

test("resolveEntity: known IDs cost nothing; describe runs once and only with budget", async () => {
  let calls = 0;
  const call = async (op, args) => { calls++; assert.equal(op, "describe"); return { status: "ok", results: [{ entity_id: `id-${norm(args.entity)}`, name: args.entity }] }; };
  assert.equal(await resolveEntity(call, "Pepsi", "brand", { budget: plenty }), "id-pepsi"); // learned by the rank test above
  assert.equal(calls, 0);
  assert.equal(await resolveEntity(call, "Twisted Sister", "artist", { budget: () => 0 }), null); // no budget: the name stays the signal
  assert.equal(calls, 0);
  assert.equal(await resolveEntity(call, "Twisted Sister", "artist", { budget: plenty }), "id-twisted sister");
  assert.equal(await resolveEntity(call, "Twisted Sister", "artist", { budget: plenty }), "id-twisted sister");
  assert.equal(calls, 1);
  assert.equal(await resolveEntity(call, "Somewhere", "locality", { budget: plenty }), null); // not a rankable type
  assert.equal(calls, 1);
});

test("tailorTerm: a card already picked is kept as shown, with no call; the cards ahead are ranked with the fresh signals", async () => {
  const ahead = { ...role, id: "in", part: "in", sound_like: null, pick: { ...role.pick, options: role.pick.options.map((o) => ({ ...o })) } };
  const term = { id: "t-skip", roles: [{ ...role, id: "chole" }, ahead] };
  const sent = [];
  const call = async (op, args) => { sent.push({ op, option_type: args.option_type }); return { status: "ok", results: [
    { entity_id: "mock-pepsi", name: "Pepsi", affinity: 0.9 }, { entity_id: "mock-coke", name: "Coca-Cola", affinity: 0.4 }] }; };
  const out = await tailorTerm(term, "sid-skip", call, { signals, budget: plenty, skip: new Set(["chole"]) });
  const by = (id) => out.roles.find((r) => r.id === id).pick;
  assert.deepEqual(by("chole").tailoring, { source: "kept", reason: "already picked" });
  assert.deepEqual(by("chole").options.map((o) => o.name), role.pick.options.map((o) => o.name));
  assert.ok(by("chole").options.every((o) => o.taste === undefined));
  assert.equal(by("in").tailoring.source, "taste");
  assert.deepEqual(by("in").options.slice(0, 2).map((o) => o.name), ["Pepsi-Cola", "Coca-Cola"]);
  assert.deepEqual(sent, [{ op: "rank", option_type: "brand" }], "one call, for the card ahead only");
  // Nothing was skipped: both cards ranked, two calls.
  sent.length = 0;
  const all = await tailorTerm(term, "sid-skip", call, { signals, budget: plenty });
  assert.ok(all.roles.every((r) => r.pick.tailoring.source === "taste"));
  assert.equal(sent.length, 2);
});
