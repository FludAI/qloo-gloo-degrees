// The lesson store. Every lesson is one JSON packet: the shape content/*.mjs exports, with rubrics kept as
// accept lists (accept_all / accept_any / misconceptions keywords) instead of compiled regexes, plus
// { version (integer), review_status, edited_by, edited_at, reviewed_at, history (last 20 versions) }.
//
// Persistence: the media bucket (media.mjs) under lessons/<id>.json with lessons/index.json naming every id,
// so edits survive a redeploy; SQLite is the hot cache on the instance; a Map is the working copy.
// Code seeds a lesson only when the store has no copy of that id. Code never overwrites a stored lesson.
import { DatabaseSync } from "node:sqlite";
import { consistent, hyphenated, respellingCount, syllablesOf } from "./syllables.mjs";

export const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;
export const HISTORY = 20;
const INDEX_KEY = "lessons/index.json";
const key = (id) => `lessons/${id}.json`;

// ---- Rubric compilation (shared with the drafter: provisional packets use the same accept lists) ----
// A keyword is matched literally, lowercased. A "/.../" entry is a regex source, kept as written, so reviewed
// rubrics like /\bbile\b/ round-trip through JSON and the console.
const esc = (s) => String(s).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REGEX_ENTRY = /^\/(.+)\/$/s;
const pattern = (w) => { const m = REGEX_ENTRY.exec(String(w)); return m ? m[1] : esc(w); };
const anyOf = (words) => new RegExp(words.filter(Boolean).map(pattern).join("|"));
// The model occasionally returns an array field as a JSON string; read it either way.
export const arr = (x) => {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") { try { const v = JSON.parse(x); return Array.isArray(v) ? v : []; } catch { return []; } }
  return [];
};

// Turn a JSON packet into a runtime packet with compiled rubrics (stored as JSON, compiled on load).
export function compilePacket(json) {
  const prompts = arr(json.prompts).map((p) => ({
    ...p,
    rubric: p.type === "text" ? {
      all: arr(p.accept_all).map(arr).filter((g) => g.length).map(anyOf),
      any: arr(p.accept_any).length ? [anyOf(arr(p.accept_any))] : [],
    } : undefined,
    misconceptions: arr(p.misconceptions).map((m) => [anyOf(arr(m.keywords)), m.feedback]),
    bonus: arr(p.bonus?.keywords).length ? [anyOf(arr(p.bonus.keywords)), p.bonus.feedback] : undefined,
  }));
  return { ...json, prompts };
}

// ---- Code packet -> JSON packet (seeding) ----
const src = (re) => `/${re.source}/`;
function jsonPrompt(p) {
  const { rubric, misconceptions, bonus, ...rest } = p;
  const out = { ...rest };
  if (rubric) { out.accept_all = (rubric.all ?? []).map((re) => [src(re)]); out.accept_any = (rubric.any ?? []).map(src); }
  if (misconceptions) out.misconceptions = misconceptions.map(([re, feedback]) => ({ keywords: [src(re)], feedback }));
  if (bonus) out.bonus = { keywords: [src(bonus[0])], feedback: bonus[1] };
  return out;
}
export function fromCode(term) {
  const { review, version, prompts, ...rest } = term;
  const packet = JSON.parse(JSON.stringify({ ...rest, prompts: (prompts ?? []).map(jsonPrompt) }));
  return { ...packet, version: 1, review_status: review?.status === "reviewed" ? "reviewed" : "provisional",
    reviewed_at: review?.reviewed_at ?? null, edited_by: "code", edited_at: new Date().toISOString(), history: [] };
}

// ---- Validation ----
const IPA = /^[\p{L}\p{M}ˈˌːˑ.‿ ]+$/u;
const SKILLS = ["meaning", "operation", "transfer"];
const TYPES = ["text", "number", "choice"];
const ROLE_ID = /^[a-z0-9_-]{1,24}$/;
const isStr = (v, max = 400) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const optStr = (v, max = 400) => v == null || (typeof v === "string" && v.length <= max);
const strList = (v, max = 120) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length <= max);
const MAX_SYLLABLES = 16;

// ipa_syllables: a list of IPA strings, one per syllable, or null. Where the respelling is hyphenated
// ("koh-lih-sis-tuh-KY-nin", "sis-toh") its token count must match; a hook word ("cola") is not a count.
function checkSyllables(at, x, say, bad) {
  const s = x?.ipa_syllables;
  if (s != null) {
    if (!Array.isArray(s) || !s.length || s.length > MAX_SYLLABLES || !s.every((v) => typeof v === "string" && v.trim() && v.length <= 20 && IPA.test(v))) return bad(`${at}.ipa_syllables: a list of IPA syllables (1 to ${MAX_SYLLABLES}), or null`);
    if (!consistent(x.ipa, s)) return bad(`${at}.ipa_syllables: joined, they must spell ${at}.ipa`);
  }
  const n = syllablesOf(x).length;
  if (n && hyphenated(say) && respellingCount(say) !== n) bad(`${at}: ${n} IPA syllable${n === 1 ? "" : "s"} but the respelling "${say}" has ${respellingCount(say)}`);
}

export function validatePacket(p) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!p || typeof p !== "object") return ["packet must be an object"];
  if (!isStr(p.title, 120)) bad("title: a short non-empty string");
  if (!isStr(p.summary, 600)) bad("summary: a non-empty string (≤ 600)");
  if (!isStr(p.definition, 600)) bad("definition: a non-empty string (≤ 600)");
  if (p.pronunciation == null || typeof p.pronunciation !== "object") bad("pronunciation: an object");
  else {
    if (!isStr(p.pronunciation.approx, 80)) bad("pronunciation.approx: a non-empty respelling");
    if (p.pronunciation.ipa != null && !(typeof p.pronunciation.ipa === "string" && p.pronunciation.ipa.length <= 80 && IPA.test(p.pronunciation.ipa))) bad("pronunciation.ipa: IPA letters and stress marks only, no slashes, or null");
    if (!optStr(p.pronunciation.note, 300)) bad("pronunciation.note: a string or null");
    checkSyllables("pronunciation", p.pronunciation, p.pronunciation.approx, bad);
  }
  if (p.aliases != null && !strList(p.aliases, 80)) bad("aliases: a list of strings");
  if (p.distinctions != null && !strList(p.distinctions, 300)) bad("distinctions: a list of strings");
  if (p.sources != null && !(Array.isArray(p.sources) && p.sources.every((s) => s && isStr(s.label, 120) && typeof s.url === "string" && /^https?:\/\//.test(s.url)))) bad("sources: a list of { label, url (http/https) }");
  if (p.components != null && !(Array.isArray(p.components) && p.components.every((c) => c && isStr(c.part, 40) && isStr(c.meaning, 120) && optStr(c.cue, 160)))) bad("components: a list of { part, meaning, cue? }");
  if (p.first_attempt != null && !(typeof p.first_attempt === "object" && isStr(p.first_attempt.question, 300))) bad("first_attempt.question: a non-empty string");

  const roleIds = new Set();
  if (!Array.isArray(p.roles) || !p.roles.length || p.roles.length > 6) bad("roles: 1 to 6 roles");
  else {
    const ids = roleIds;
    p.roles.forEach((r, i) => {
      const at = `roles[${i}]`;
      if (!r || typeof r !== "object") return bad(`${at}: an object`);
      if (typeof r.id !== "string" || !ROLE_ID.test(r.id)) bad(`${at}.id: a short slug`);
      else if (ids.has(r.id)) bad(`${at}.id: duplicate "${r.id}"`); else ids.add(r.id);
      if (!isStr(r.label, 80)) bad(`${at}.label: a non-empty string`);
      if (!isStr(r.part, 40)) bad(`${at}.part: the word part, non-empty`);
      if (!optStr(r.meaning, 120)) bad(`${at}.meaning: a string`);
      if (!optStr(r.say, 60)) bad(`${at}.say: a respelling or null`);
      if (r.ipa != null && !(typeof r.ipa === "string" && r.ipa.length <= 60 && IPA.test(r.ipa))) bad(`${at}.ipa: IPA letters and stress marks only, no slashes, or null`);
      checkSyllables(at, r, r.say, bad);
      if (!optStr(r.sound_like, 60)) bad(`${at}.sound_like: a string or null`);
      if (!optStr(r.target, 160)) bad(`${at}.target: a string`);
      if (!optStr(r.look_for, 200)) bad(`${at}.look_for: a string`);
      if (r.pick != null) {
        if (typeof r.pick !== "object" || !isStr(r.pick.question, 120)) bad(`${at}.pick.question: a short spoken question`);
        const opts = r.pick?.options;
        if (!Array.isArray(opts) || !opts.length || opts.length > 6) bad(`${at}.pick.options: 1 to 6 options`);
        else opts.forEach((o, j) => {
          const oat = `${at}.pick.options[${j}]`;
          if (!o || typeof o !== "object") return bad(`${oat}: an object`);
          if (!isStr(o.name, 60)) bad(`${oat}.name: a non-empty string`);
          if (!optStr(o.wiki, 120)) bad(`${oat}.wiki: a Wikipedia title or null`);
          if (o.say != null && !strList(o.say, 60)) bad(`${oat}.say: a list of spoken forms`);
          if (!optStr(o.connection, 240)) bad(`${oat}.connection: a string`);
          if (!optStr(o.ipa, 80)) bad(`${oat}.ipa: IPA for the voice to say the name, or null`);
          if (o.image != null && !/^https:\/\/[^\s"']{8,500}$/.test(String(o.image))) bad(`${oat}.image: an https picture URL (an affiliate program's own image link), or null`);
          if (o.link != null && !/^https:\/\/[^\s"']{8,500}$/.test(String(o.link))) bad(`${oat}.link: an https shop link, or null`);
          if (o.qloo != null && !(typeof o.qloo === "object" && isStr(o.qloo.entity, 80) && optStr(o.qloo.type, 40))) bad(`${oat}.qloo: { entity, type } or null`);
        });
      }
    });
  }

  if (!Array.isArray(p.prompts) || !p.prompts.length || p.prompts.length > 10) bad("prompts: 1 to 10 prompts");
  else {
    const ids = new Set();
    const rule = (at, w) => {
      if (typeof w !== "string" || !w.trim()) return bad(`${at}: keywords must be non-empty strings`);
      const m = REGEX_ENTRY.exec(w);
      if (m) { try { new RegExp(m[1]); } catch { bad(`${at}: bad regex ${w}`); } }
    };
    p.prompts.forEach((q, i) => {
      const at = `prompts[${i}]`;
      if (!q || typeof q !== "object") return bad(`${at}: an object`);
      if (!isStr(q.id, 60)) bad(`${at}.id: a non-empty string`);
      else if (ids.has(q.id)) bad(`${at}.id: duplicate "${q.id}"`); else ids.add(q.id);
      if (q.role != null && !(typeof q.role === "string" && roleIds.has(q.role))) bad(`${at}.role: the id of one of the roles (the word part the prompt tests), or null for a whole-word prompt`);
      if (!SKILLS.includes(q.skill)) bad(`${at}.skill: one of ${SKILLS.join(", ")}`);
      if (!TYPES.includes(q.type)) bad(`${at}.type: one of ${TYPES.join(", ")}`);
      if (!isStr(q.question, 300)) bad(`${at}.question: a non-empty string`);
      if (!optStr(q.hint, 200)) bad(`${at}.hint: a string or null`);
      if (!isStr(q.answer, 400)) bad(`${at}.answer: the reviewed answer, non-empty`);
      if (q.type === "text") {
        const all = q.accept_all ?? [], any = q.accept_any ?? [];
        if (!Array.isArray(all) || !all.every(Array.isArray)) bad(`${at}.accept_all: a list of keyword groups`);
        else all.forEach((g, gi) => g.forEach((w) => rule(`${at}.accept_all[${gi}]`, w)));
        if (!Array.isArray(any)) bad(`${at}.accept_any: a list of keywords`);
        else any.forEach((w) => rule(`${at}.accept_any`, w));
        if (!(Array.isArray(all) && all.some((g) => g.length)) && !(Array.isArray(any) && any.length)) bad(`${at}: a text prompt needs at least one accept rule`);
      } else if (q.type === "number") {
        if (!Number.isFinite(q.expected)) bad(`${at}.expected: a finite number`);
      } else if (q.type === "choice") {
        if (!strList(q.options, 120) || q.options.length < 2) bad(`${at}.options: at least two choices`);
        else if (!q.options.includes(q.expected)) bad(`${at}.expected: one of the options`);
      }
      if (q.misconceptions != null && !(Array.isArray(q.misconceptions) && q.misconceptions.every((m) => m && Array.isArray(m.keywords) && m.keywords.length && isStr(m.feedback, 300)))) bad(`${at}.misconceptions: a list of { keywords, feedback }`);
      else (q.misconceptions ?? []).forEach((m, mi) => m.keywords.forEach((w) => rule(`${at}.misconceptions[${mi}]`, w)));
      if (q.bonus != null && !(typeof q.bonus === "object" && Array.isArray(q.bonus.keywords) && q.bonus.keywords.length && isStr(q.bonus.feedback, 300))) bad(`${at}.bonus: { keywords, feedback } or null`);
    });
  }
  return problems;
}

// ---- Merge patch ----
// Top-level scalars and objects merge (null deletes an optional field); roles, prompts and pick options are
// addressed by id (or index) and merged item by item; other lists replace as a whole.
const TOP_SCALARS = ["title", "summary", "definition", "scene", "origin", "formula"];
const TOP_LISTS = ["aliases", "components", "family", "distinctions", "transfer", "sources", "rules", "examples", "editorial_cues"];
const TOP_OBJECTS = ["pronunciation", "first_attempt", "graph"];
const ROLE_FIELDS = ["label", "part", "say", "ipa", "ipa_syllables", "sound_like", "meaning", "target", "look_for"];
const OPTION_FIELDS = ["name", "wiki", "say", "connection", "qloo", "ipa", "image", "link"];
const PROMPT_FIELDS = ["role", "skill", "type", "question", "hint", "answer", "accept_all", "accept_any", "expected", "options", "misconceptions", "bonus"];
const META = new Set(["id", "version", "review_status", "reviewed_at", "edited_by", "edited_at", "history", "provisional", "promoted_from", "pending"]);

const mergeFields = (target, patch, fields, at, problems) => {
  for (const k of Object.keys(patch)) {
    if (!fields.includes(k)) { problems.push(`${at}.${k}: not an editable field`); continue; }
    if (patch[k] === null) delete target[k]; else target[k] = patch[k];
  }
};
const locate = (list, item, at, problems) => {
  if (!item || typeof item !== "object") { problems.push(`${at}: an object`); return -1; }
  const i = Number.isInteger(item.index) ? item.index : item.id != null ? list.findIndex((x) => x.id === item.id) : -1;
  if (i >= 0 && i < list.length) return i;
  problems.push(`${at}: no item with ${item.id != null ? `id "${item.id}"` : `index ${item.index}`}`);
  return -1;
};

export function applyPatch(doc, patch) {
  const problems = [];
  const { history, pending, ...packet } = structuredClone(doc);
  const changed = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { packet, changed, problems: ["patch must be a JSON object"] };
  for (const [k, v] of Object.entries(patch)) {
    if (META.has(k)) { problems.push(`${k}: managed by the store`); continue; }
    if (TOP_SCALARS.includes(k)) { if (v === null) delete packet[k]; else packet[k] = v; changed.push(k); continue; }
    if (TOP_LISTS.includes(k)) { if (v === null) delete packet[k]; else packet[k] = v; changed.push(k); continue; }
    if (TOP_OBJECTS.includes(k)) {
      if (v === null) { delete packet[k]; changed.push(k); continue; }
      if (typeof v !== "object" || Array.isArray(v)) { problems.push(`${k}: an object`); continue; }
      packet[k] = { ...(packet[k] ?? {}) };
      for (const [f, fv] of Object.entries(v)) { if (fv === null) delete packet[k][f]; else packet[k][f] = fv; }
      changed.push(k); continue;
    }
    if (k === "roles" || k === "prompts") {
      if (!Array.isArray(v)) { problems.push(`${k}: a list of items addressed by id or index`); continue; }
      const list = packet[k] ?? [];
      v.forEach((item, n) => {
        const i = locate(list, item, `${k}[${n}]`, problems);
        if (i < 0) return;
        const { id, index, pick, ...fields } = item;
        const at = `${k}.${list[i].id ?? i}`;
        changed.push(at);
        if (k === "prompts") return mergeFields(list[i], fields, PROMPT_FIELDS, at, problems);
        mergeFields(list[i], fields, ROLE_FIELDS, at, problems);
        if (pick === undefined) return;
        if (pick === null) { delete list[i].pick; return; }
        if (typeof pick !== "object") { problems.push(`${at}.pick: an object`); return; }
        list[i].pick = { ...(list[i].pick ?? { question: "", options: [] }) };
        if (pick.question !== undefined) list[i].pick.question = pick.question;
        if (pick.options === undefined) return;
        if (!Array.isArray(pick.options)) { problems.push(`${at}.pick.options: a list of options addressed by index or name`); return; }
        const opts = list[i].pick.options = list[i].pick.options.map((o) => ({ ...o }));
        pick.options.forEach((op, m) => {
          const oat = `${at}.pick.options[${m}]`;
          if (!op || typeof op !== "object") return problems.push(`${oat}: an object`);
          let j = Number.isInteger(op.index) ? op.index : opts.findIndex((o) => o.name === op.name);
          if (j === opts.length && Number.isInteger(op.index)) { opts.push({ name: "", wiki: null, say: [], qloo: null, connection: "" }); }
          if (j < 0 || j >= opts.length) return problems.push(`${oat}: no option ${op.index ?? op.name}`);
          const { index: _i, remove, ...of } = op;
          if (remove === true) { opts[j] = null; return; } // { index, remove: true } drops the option
          mergeFields(opts[j], of, OPTION_FIELDS, oat, problems);
        });
        list[i].pick.options = opts.filter(Boolean);
      });
      continue;
    }
    problems.push(`${k}: not an editable field`);
  }
  return { packet, changed: [...new Set(changed)], problems };
}

// Read one field by path: "summary", "pronunciation.ipa", "roles.chole.meaning", "roles.0.pick.options.1.wiki", "prompts.cck-chole.hint".
export function readField(doc, path) {
  let node = doc;
  for (const tok of String(path ?? "").split(".").filter(Boolean)) {
    if (node == null) return undefined;
    if (Array.isArray(node)) {
      const i = /^\d+$/.test(tok) ? Number(tok) : node.findIndex((x) => x && (x.id === tok || x.name === tok));
      node = node[i];
    } else if (Object.prototype.hasOwnProperty.call(node, tok)) node = node[tok];
    else return undefined;
  }
  return node;
}

// ---- Proposal paths ----
// The reviewer addresses one field by a path like "summary", "pronunciation.ipa", "roles[chole].say",
// "roles[chole].pick.options[2].wiki", "prompts[cck-chole].answer"; dotted keys ("roles.chole.say") read the same.
// A bracketed key is taken literally, so an option name with a dot in it still works.
export function parsePath(path) {
  const tokens = [];
  const re = /\[([^\]]*)\]|([^.[\]]+)/g;
  let m;
  for (const s = String(path ?? ""); (m = re.exec(s)); ) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens.map((t) => t.trim()).filter(Boolean);
}
// Tokens -> the canonical bracket form the reviewer reports.
const KEYED = new Set(["roles", "prompts", "options"]);
export const formatPath = (tokens) => tokens.map((t, i) => (i === 0 ? t : KEYED.has(tokens[i - 1]) ? `[${t}]` : `.${t}`)).join("");

// Read the value a path addresses (undefined when the path leads nowhere).
export function readPath(doc, path) {
  let node = doc;
  for (const tok of parsePath(path)) {
    if (node == null) return undefined;
    if (Array.isArray(node)) {
      const i = /^\d+$/.test(tok) ? Number(tok) : node.findIndex((x) => x && (x.id === tok || x.name === tok));
      node = node[i];
    } else if (Object.prototype.hasOwnProperty.call(node, tok)) node = node[tok];
    else return undefined;
  }
  return node;
}

// One path + value -> the merge patch the store applies. Throws LessonError(INVALID) on a path the grammar can't express.
const keyed = (tok) => (/^\d+$/.test(tok) ? { index: Number(tok) } : { id: tok });
export function pathToPatch(path, value) {
  const t = parsePath(path);
  const err = (why) => { throw new LessonError("INVALID", `${path}: ${why}`, [`${path}: ${why}`]); };
  if (!t.length) err("empty path");
  const [head, key, ...rest] = t;
  if (TOP_SCALARS.includes(head) || TOP_LISTS.includes(head)) { if (t.length !== 1) err("this field is patched whole"); return { [head]: value }; }
  if (TOP_OBJECTS.includes(head)) { if (t.length !== 2) err("needs one sub-field, e.g. pronunciation.ipa"); return { [head]: { [key]: value } }; }
  if (head === "prompts") {
    if (t.length !== 3 || !PROMPT_FIELDS.includes(rest[0])) err(`needs prompts[<id>].<${PROMPT_FIELDS.join("|")}>`);
    return { prompts: [{ ...keyed(key), [rest[0]]: value }] };
  }
  if (head === "roles") {
    if (!key) err("needs a role id or index");
    if (rest.length === 1 && ROLE_FIELDS.includes(rest[0])) return { roles: [{ ...keyed(key), [rest[0]]: value }] };
    if (rest[0] !== "pick") err(`needs roles[<id>].<${ROLE_FIELDS.join("|")}> or roles[<id>].pick…`);
    if (rest.length === 2 && rest[1] === "question") return { roles: [{ ...keyed(key), pick: { question: value } }] };
    if (rest.length === 4 && rest[1] === "options" && OPTION_FIELDS.includes(rest[3])) {
      const o = /^\d+$/.test(rest[2]) ? { index: Number(rest[2]) } : { name: rest[2] };
      return { roles: [{ ...keyed(key), pick: { options: [{ ...o, [rest[3]]: value }] } }] };
    }
    err("needs roles[<id>].pick.question or roles[<id>].pick.options[<n>].<name|wiki|say|connection|qloo|ipa|image|link>");
  }
  err("not an editable field");
}

// Several single-field patches -> one patch, merging roles, prompts and options addressed by the same key.
export function mergePatches(patches) {
  const out = {};
  const sameKey = (a, b) => (a.id != null && a.id === b.id) || (a.index != null && a.index === b.index) || (a.name != null && a.name === b.name);
  const mergeInto = (list, item) => {
    const hit = list.find((x) => sameKey(x, item));
    if (!hit) return list.push(structuredClone(item));
    for (const [k, v] of Object.entries(item)) {
      if (k === "pick" && hit.pick && v && typeof v === "object") {
        if (v.question !== undefined) hit.pick.question = v.question;
        if (v.options) { hit.pick.options = hit.pick.options ?? []; v.options.forEach((o) => mergeInto(hit.pick.options, o)); }
      } else hit[k] = structuredClone(v);
    }
  };
  for (const p of patches) for (const [k, v] of Object.entries(p)) {
    if (k === "roles" || k === "prompts") { out[k] = out[k] ?? []; v.forEach((item) => mergeInto(out[k], item)); }
    else if (TOP_OBJECTS.includes(k) && out[k] && v && typeof v === "object") out[k] = { ...out[k], ...v };
    else out[k] = structuredClone(v);
  }
  return out;
}

export class LessonError extends Error {
  constructor(code, message, problems) { super(message); this.code = code; this.problems = problems; }
}

// ---- The store ----
// opts: { media (media.mjs store), db (DatabaseSync; defaults to a private in-memory db), seeds (code packets) }
export function createLessonStore({ media, db = new DatabaseSync(":memory:"), seeds = [] }) {
  db.exec(`CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY, doc TEXT NOT NULL, version INTEGER NOT NULL, review_status TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  const sql = {
    upsert: db.prepare("INSERT OR REPLACE INTO lessons (id, doc, version, review_status, updated_at) VALUES (?, ?, ?, ?, ?)"),
    all: db.prepare("SELECT id, doc FROM lessons ORDER BY id"),
  };
  const docs = new Map();
  let loaded = false;

  const cache = (doc) => { docs.set(doc.id, doc); sql.upsert.run(doc.id, JSON.stringify(doc), doc.version, doc.review_status, Date.now()); };
  async function save(doc) {
    const isNew = !docs.has(doc.id);
    await media.putJson(key(doc.id), doc);
    if (isNew) {
      const ids = [...new Set([...docs.keys(), doc.id])].sort();
      await media.putJson(INDEX_KEY, { ids, updated_at: new Date().toISOString() });
    }
    cache(doc);
    return doc;
  }
  const snapshot = (doc) => { const { history, pending, ...packet } = doc; return packet; };
  // The version after a change: `packet` is the new content, `doc` the stored one, which becomes the history entry.
  const next = (doc, { editor, changed, packet = doc, review_status, reviewed_at }) => {
    const entry = { version: doc.version, edited_by: doc.edited_by, edited_at: doc.edited_at, review_status: doc.review_status, changed, packet: snapshot(doc) };
    const { pending, ...content } = packet;
    return { ...content, id: doc.id, version: doc.version + 1, edited_by: editor, edited_at: new Date().toISOString(),
      review_status: review_status ?? doc.review_status, reviewed_at: reviewed_at === undefined ? doc.reviewed_at : reviewed_at,
      ...(doc.pending && { pending: doc.pending }), // proposals outlive an ordinary edit; accept and discard clear them
      history: [entry, ...(doc.history ?? [])].slice(0, HISTORY) };
  };

  const store = {
    get loaded() { return loaded; },
    // Bucket first; rows already in SQLite fill any gap (same instance, bucket unreachable); then seed what is missing.
    async load() {
      let ids = [];
      try { ids = (await media.getJson(INDEX_KEY))?.ids ?? []; } catch (e) { console.warn(`lessons: index unavailable (${e.message})`); }
      for (const id of ids) {
        if (!ID.test(id)) continue;
        try { const doc = await media.getJson(key(id)); if (doc?.id === id) cache(doc); }
        catch (e) { console.warn(`lessons: ${id} unavailable (${e.message})`); }
      }
      for (const row of sql.all.all()) if (!docs.has(row.id)) docs.set(row.id, JSON.parse(row.doc));
      for (const seed of seeds) if (!docs.has(seed.id)) await save(fromCode(seed));
      loaded = true;
      return store;
    },
    list: () => [...docs.values()],
    get: (id) => docs.get(id) ?? null,
    summaries: () => [...docs.values()].map((d) => ({ id: d.id, title: d.title, review_status: d.review_status, version: d.version, edited_by: d.edited_by, edited_at: d.edited_at })),

    // JSON merge patch -> validate -> bump version -> persist. Throws LessonError(NOT_FOUND | INVALID).
    async patch(id, patch, { editor = "owner" } = {}) {
      const doc = docs.get(id);
      if (!doc) throw new LessonError("NOT_FOUND", `no lesson ${id}`);
      const { packet, changed, problems } = applyPatch(doc, patch);
      problems.push(...validatePacket(packet));
      if (problems.length) throw new LessonError("INVALID", "the lesson didn't validate", problems);
      if (!changed.length) return doc;
      return save(next(doc, { editor, changed, packet }));
    },
    async publish(id, { editor = "owner" } = {}) {
      const doc = docs.get(id);
      if (!doc) throw new LessonError("NOT_FOUND", `no lesson ${id}`);
      if (doc.review_status === "reviewed") return doc;
      const problems = validatePacket(doc);
      if (problems.length) throw new LessonError("INVALID", "fix the lesson before publishing", problems);
      return save(next(doc, { editor, changed: ["review_status"], review_status: "reviewed", reviewed_at: new Date().toISOString().slice(0, 10) }));
    },
    // ---- Pending proposals: the reviewer's whole-lesson patch, waiting for a person ----
    // pending { created_at, by, instruction, proposals [{ path, before, after, reason, severity }], notes }.
    // Storing or clearing proposals is not an edit: the version stays, nothing enters the history.
    async setPending(id, pending) {
      const doc = docs.get(id);
      if (!doc) throw new LessonError("NOT_FOUND", `no lesson ${id}`);
      const { pending: _old, ...rest } = doc;
      return save(pending ? { ...rest, pending } : rest);
    },
    // Apply the chosen proposals as one patch (one new version), then clear every proposal.
    // keepRest: the proposals not chosen stay pending (the ambient console accepts one at a time).
    async acceptProposals(id, paths, { editor = "reviewer", keepRest = false } = {}) {
      const doc = docs.get(id);
      if (!doc) throw new LessonError("NOT_FOUND", `no lesson ${id}`);
      const proposals = doc.pending?.proposals ?? [];
      if (!proposals.length) throw new LessonError("INVALID", "no proposals are pending", ["pending: nothing to accept"]);
      const chosen = [...new Set((Array.isArray(paths) ? paths : []).map(String))];
      const problems = [];
      if (!chosen.length) problems.push("paths: choose at least one proposal");
      const picked = chosen.map((p) => {
        const hit = proposals.find((x) => x.path === p);
        if (!hit) problems.push(`${p}: no such proposal`);
        else if (hit.after == null) problems.push(`${p}: this proposal has no replacement to apply`);
        return hit;
      }).filter((x) => x && x.after != null);
      if (problems.length) throw new LessonError("INVALID", "those proposals can't be applied", problems);
      const patch = mergePatches(picked.map((p) => pathToPatch(p.path, p.after)));
      const { packet, changed, problems: applyProblems } = applyPatch(doc, patch);
      applyProblems.push(...validatePacket(packet));
      if (applyProblems.length) throw new LessonError("INVALID", "the lesson didn't validate", applyProblems);
      const { pending, ...base } = doc;
      const rest = proposals.filter((p) => !chosen.includes(p.path));
      const kept = keepRest && rest.length ? { ...pending, proposals: rest } : null;
      return save(next(kept ? { ...base, pending: kept } : base, { editor, changed, packet }));
    },
    async discardProposals(id) { return store.setPending(id, null); },

    // A learner's provisional packet becomes a shared lesson, still labeled provisional until published.
    async promote(packet, { id, editor = "owner", origin = null, from = null } = {}) {
      if (!ID.test(String(id))) throw new LessonError("INVALID", "bad lesson id", [`id: must match ${ID}`]);
      if (docs.has(id)) throw new LessonError("EXISTS", `lesson ${id} already exists`);
      const { provisional, origin: _o, review, version: _v, ...rest } = packet;
      const prompts = arr(rest.prompts).map((p, i) => ({ ...p, id: `${id}-q${i + 1}` }));
      const doc = { ...rest, id, prompts, version: 1, review_status: "provisional", reviewed_at: null, edited_by: editor,
        edited_at: new Date().toISOString(), promoted_from: { provisional_id: from, origin }, history: [] };
      const problems = validatePacket(doc);
      if (problems.length) throw new LessonError("INVALID", "the draft didn't validate", problems);
      return save(doc);
    },
  };
  return store;
}
