// The learner graph over time: a time-ordered set of nodes per learner (words met, with their outcomes; picks, as
// public entities; the kind of hook each pick made) and a deterministic embedding of that set, so a learner's
// trajectory can be compared with itself over time and with taste domains later. No model is involved: the
// embedding is a bag of Qloo tags (entity_tags, one call per entity, ever, kept in the media store) over the
// learner's pick entities, plus the words and hook kinds as tags of Gloo's own, L2-normalized. Storage is the
// point today; the analysis comes later.
import { db, q } from "./db.mjs";
import { media } from "./media.mjs";
import { remaining } from "./limits.mjs";
import { RESERVE } from "./taste.mjs";

const ins = db.prepare("INSERT INTO learner_nodes (sid, kind, key, label, data, created_at) VALUES (?, ?, ?, ?, ?, ?)");
const nodesOf = db.prepare("SELECT id, kind, key, label, data, created_at FROM learner_nodes WHERE sid = ? ORDER BY created_at, id");
const lastEmbedding = db.prepare("SELECT id, nodes, dims, vector, created_at FROM learner_embeddings WHERE sid = ? ORDER BY created_at DESC, id DESC LIMIT 1");
const embeddingsOf = db.prepare("SELECT id, nodes, dims, vector, created_at FROM learner_embeddings WHERE sid = ? ORDER BY created_at, id");
const putEmbedding = db.prepare("INSERT INTO learner_embeddings (sid, nodes, dims, vector, created_at) VALUES (?, ?, ?, ?, ?)");

export const KINDS = ["word", "pick", "hook", "outcome"];
// One node. Kinds: word (key: term id; a word met, with how it was captured), pick (key: Qloo entity ID when known,
// else the packet's entity name; a favorite), hook (key: sound | meaning; what kind of hook the pick made),
// outcome (key: term id; one practice answer). Nothing personal: labels are public names and lesson ids.
export function record(sid, kind, key, label, data = {}) {
  if (!sid || !KINDS.includes(kind) || !key) return null;
  return ins.run(sid, kind, String(key).slice(0, 120), label == null ? null : String(label).slice(0, 120), JSON.stringify(data).slice(0, 2000), Date.now()).lastInsertRowid;
}
export const nodesFor = (sid) => nodesOf.all(sid).map((r) => ({ ...r, data: safe(r.data) }));
const safe = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

// ---- Qloo tags per entity: learned once, kept in the media store next to the entity IDs. ----
const KEY = "qloo/tags.json";
const TAG_LIMIT = 10;
let tags = null;
let saving = null;
export async function loadTags() {
  if (tags) return tags;
  tags = new Map();
  try { for (const [k, v] of Object.entries((await media.getJson(KEY)) ?? {})) if (Array.isArray(v?.tags)) tags.set(k, v); } catch { /* start empty */ }
  return tags;
}
const save = () => (saving ??= Promise.resolve().then(async () => { saving = null; try { await media.putJson(KEY, Object.fromEntries(tags)); } catch (e) { console.warn(`graph: tags not saved (${e.message})`); } }));
export const tagsFor = (id) => tags?.get(id)?.tags ?? null;
const urnOf = (r) => { const u = r?.id ?? r?.urn ?? r?.tag_id; return typeof u === "string" && u.startsWith("urn:tag:") ? u : null; };
// The tags of one entity: known, or one entity_tags call within the caller's cap, or null (unknown for now).
async function learnTags(call, id, state, { cap, budget }) {
  await loadTags();
  const known = tagsFor(id);
  if (known) return known;
  if (state.calls >= cap || budget("qloo") < RESERVE) { state.skipped++; return null; }
  state.calls++;
  let env;
  try { env = await call("entity_tags", { entities: [id], limit: TAG_LIMIT }); } catch { return null; }
  if (!["ok", "partial", "empty"].includes(env?.status)) return null;
  const list = (env.results ?? []).map((r) => ({ urn: urnOf(r), name: r?.name ?? null, affinity: typeof r?.affinity === "number" ? r.affinity : null })).filter((t) => t.urn);
  tags.set(id, { tags: list, at: Date.now() });
  await save();
  return list;
}

// ---- The embedding: a sparse unit vector over tag URNs. Deterministic for a given node set and tag cache. ----
export function bagOf(nodes, tagsOf = tagsFor) {
  const bag = new Map();
  const add = (k, w = 1) => bag.set(k, (bag.get(k) ?? 0) + w);
  for (const n of nodes) {
    if (n.kind === "word") add(`urn:gloo:word:${n.key}`);
    else if (n.kind === "hook") add(`urn:gloo:hook:${n.key}`);
    else if (n.kind === "outcome") add(`urn:gloo:outcome:${n.data.outcome ?? "unknown"}${n.data.independent ? ":independent" : ""}`);
    else if (n.kind === "pick") {
      add(`urn:gloo:pick_type:${n.data.type ?? "unknown"}`);
      for (const t of tagsOf(n.key) ?? []) add(t.urn, t.affinity ?? 1);
    }
  }
  const norm = Math.sqrt([...bag.values()].reduce((s, w) => s + w * w, 0)) || 1;
  return Object.fromEntries([...bag.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, w]) => [k, Number((w / norm).toFixed(4))]));
}
export const cosine = (a, b) => { let s = 0; for (const [k, w] of Object.entries(a)) if (b[k]) s += w * b[k]; return Number(s.toFixed(4)); };
// Only the Qloo part of two vectors (what the learner likes), leaving Gloo's own tags out.
export const tasteOnly = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith("urn:tag:")));

// Compute (and store, when the node set grew) this learner's embedding. `call` is the metered Qloo runner; at most
// `cap` entity_tags calls per request, so an admin look never spends much. Returns the graph as the admin sees it.
export async function learnerGraph(sid, call, { cap = Number(process.env.QLOO_TAGS_PER_REQUEST ?? 10), budget = remaining } = {}) {
  const nodes = nodesFor(sid);
  const state = { calls: 0, skipped: 0 };
  const ids = [...new Set(nodes.filter((n) => n.kind === "pick" && n.data.entity_id).map((n) => n.key))];
  let untagged = 0;
  for (const id of ids) if (!(await learnTags(call, id, state, { cap, budget }))?.length) untagged++; // unknown yet, or Qloo has no tags for it
  const vector = bagOf(nodes);
  const dims = Object.keys(vector).length;
  const prev = lastEmbedding.get(sid);
  let stored = prev;
  if (nodes.length && (!prev || prev.nodes !== nodes.length || prev.vector !== JSON.stringify(vector))) {
    putEmbedding.run(sid, nodes.length, dims, JSON.stringify(vector), Date.now());
    stored = lastEmbedding.get(sid);
  }
  const snapshots = embeddingsOf.all(sid).map((e) => ({ id: e.id, at: e.created_at, nodes: e.nodes, dims: e.dims, vector: safe(e.vector) }));
  const trajectory = snapshots.map((s, i) => ({ at: s.at, nodes: s.nodes, dims: s.dims,
    drift: i ? Number((1 - cosine(snapshots[i - 1].vector, s.vector)).toFixed(4)) : 0,
    taste_drift: i ? Number((1 - cosine(tasteOnly(snapshots[i - 1].vector), tasteOnly(s.vector))).toFixed(4)) : 0 }));
  return {
    sid, nodes: nodes.map((n) => ({ id: n.id, at: n.created_at, kind: n.kind, key: n.key, label: n.label, ...n.data })),
    entities: ids.length, untagged, calls: state, embedding: stored ? { at: stored.created_at, nodes: stored.nodes, dims, vector } : null,
    trajectory, learner: q.getLevel.get(sid) ?? null,
  };
}
