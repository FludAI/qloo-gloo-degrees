// QLOO_MOCK=1: labeled fixture envelopes so the UI can be built before the
// event key arrives. Nothing here is real Qloo data. Shapes follow the
// documented envelope; verify item fields against live results once keyed.
const exec = (op) => ({ transport: "mock", transport_name: "fixture", correlation_id: `mock-${op}`, duration_ms: 0 });
const prov = { source: "MOCK FIXTURE — not Qloo data", endpoint: "none", documentation: "server/src/mock.mjs" };

const base = (operation, results, summary) => ({
  schema_version: "1.0-preview.1", operation, status: results.length ? "ok" : "empty",
  summary, results, result_count: results.length, warnings: ["Mock mode: fixture data"],
  execution: exec(operation), provenance: prov,
});

export function mockQloo(op, args) {
  if (op === "find_tags") {
    const q = String(args.query ?? "concept");
    const title = q.replace(/\b\w/g, (c) => c.toUpperCase());
    return base("find_tags", [
      { urn: `urn:tag:genre:music:${q}`, name: title, subtype: "genre/music" },
      { urn: `urn:tag:genre:media:${q}`, name: title, subtype: "genre/media" },
      { urn: `urn:tag:keyword:media:${q}`, name: title, subtype: "keyword/media" },
      { urn: `urn:tag:style:place:${q}`, name: `${title} bar`, subtype: "style/place" },
    ].slice(0, args.limit ?? 5), `Mock: candidate tags for "${q}"`);
  }
  if (op === "describe") {
    const name = String(args.entity ?? "");
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    // A name containing "obscure" is unknown to the fixture (empty); the rest get a popularity from their length, no picture.
    if (/obscure/i.test(name)) return base("describe", [], `Mock: nothing for "${name}"`);
    return base("describe", [{ entity_id: `mock-${slug}`, name, type: `urn:entity:${args.type ?? "brand"}`,
      popularity: Number((0.2 + (slug.length % 8) / 10).toFixed(2)), properties: { description: "Fixture record. Not Qloo data." } }], `Mock: resolved "${name}"`);
  }
  if (op === "recommend") {
    const t = args.target_type ?? "movie";
    const names = {
      movie: ["Whiplash", "La La Land", "Round Midnight", "Bird", "Soul"],
      book: ["Coltrane: The Story of a Sound", "Kind of Blue (33 1/3)", "The Jazz Standards", "Really the Blues", "Blues People"],
      artist: ["Miles Davis", "Nina Simone", "Thelonious Monk", "Kamasi Washington", "Esperanza Spalding"],
      brand: ["Ben & Jerry's", "Häagen-Dazs", "Coca-Cola", "LinkedIn", "Netflix"],
      podcast: ["Jazz Night in America", "The Jazz Session", "Song Exploder", "Switched On Pop", "Strong Songs"],
    }[t] ?? ["Example A", "Example B", "Example C"];
    return base("recommend", names.slice(0, args.limit ?? 5).map((name, i) => ({
      entity_id: `mock-rec-${t}-${i}`, name, type: `urn:entity:${t}`,
      affinity: Number((0.92 - i * 0.07).toFixed(2)),
      explanation: "Fixture: shares signal tags with the confirmed taste profile.",
    })), `Mock: ${t} recommendations for the confirmed tags`);
  }
  if (op === "rank") {
    // Deterministic and visible: the supplied options come back in reverse alphabetical order, so a tailored
    // pick card is easy to tell from the editorial one in tests. Each result names the option it scores.
    const t = args.option_type ?? "brand";
    const options = [...new Set((args.options ?? []).map(String))].sort((a, b) => b.localeCompare(a));
    const title = (s) => s.replace(/^mock-/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return base("rank", options.map((option, i) => ({
      entity_id: option.startsWith("mock-") ? option : `mock-${option.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: option.startsWith("mock-") ? title(option) : option, option, type: `urn:entity:${t}`,
      affinity: Number((0.95 - i * 0.1).toFixed(2)), explanation: "Fixture: ranked against the signals.",
    })), `Mock: ${options.length} ${t} options ranked for ${(args.signals ?? []).length} signals`);
  }
  return base(op, [], `Mock: no fixture for ${op}`);
}
