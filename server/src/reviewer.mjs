// The lesson reviewer: one pass over a whole lesson that ends in proposals, never in a save.
// Deterministic checks run first (rubrics, sounds, say/ipa, length) and are reported even when the model
// is unavailable; the model is then asked once to fill in replacements for what was flagged and to add its
// own proposals under the product rules. A person accepts some, discards the rest (lessons.mjs: pending).
import { complete, toolCall } from "./providers.mjs";
import { doubleMetaphone } from "double-metaphone";
import { distance } from "fastest-levenshtein";
import { TRUTH_RULE } from "./drafter.mjs";
import { compilePacket, applyPatch, validatePacket, readPath, parsePath, pathToPatch, mergePatches, arr } from "./lessons.mjs";
import { assess, parseNumber, NUMERIC_TOLERANCE } from "./assess.mjs";
import { scorePieces } from "./resolve/pieces.mjs";

export const PRODUCT_RULES = `Product rules for a Gloo lesson (the app speaks every line; the screen shows almost no text):
1. ${TRUTH_RULE}
2. Every pick option must carry the role's sound (for a sound role: its name sounds like the piece) or the role's meaning (for a meaning role: the thing plainly is or does what the piece means). Name any option that doesn't and replace it with a well-known public name that does, with its exact English Wikipedia article title for the picture.
3. A piece's respelling (say) and its IPA must describe the same sound. Normally that is the piece as said inside the term. Exception, deliberate: when a piece's say equals its sound_like, the owner has pinned the piece to its hook word (chole is spoken "cola"), and that is correct; do not propose the dictionary sound for it. IPA is US English, no slashes or brackets.
4. Every practice answer must satisfy its own rubric: a text answer must match its accept rules, a number answer must state the expected value, a choice answer must name the expected option. Fix the answer or the rule, not the question.
5. Minimal, speakable text: the summary is one or two short spoken sentences; pick questions are short spoken questions ("Say your favorite cola."); no symbols a voice would read badly (≈ → + = /). Hints and questions stay short.
6. Be accurate; never invent etymology, sources or Wikipedia titles.`;

export const SOUND = 0.75; // the same bar pieces.mjs uses for "said"
const clip = (s, n) => String(s ?? "").slice(0, n);
const proposal = (path, before, reason, severity, after = null) => ({ path, before: before === undefined ? null : before, after, reason, severity });

// ---- Sound helpers ----
const DIGITS = { 0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };
const spoken = (s) => String(s ?? "").replace(/\d/g, (d) => ` ${DIGITS[d]} `);
// Does this option's name (or any of its spoken forms) carry the role's sound? 0..1, as the first-attempt scorer rates pieces.
export function soundScore(role, option) {
  const aliases = role.sound_like ? [spoken(role.sound_like)] : [];
  const piece = [{ part: spoken(role.part), aliases }];
  // Each spoken form on its own: an ending piece ("-in") has to close the form it is matched against.
  return Math.max(0, ...[option.name, ...arr(option.say)].filter(Boolean).map((t) => scorePieces(piece, spoken(t)).pieces[0]?.score ?? 0));
}

// IPA -> rough letters, so a respelling and an IPA string can be compared by sound.
const IPA_MAP = [["tʃ", "ch"], ["dʒ", "j"], ["oʊ", "o"], ["aɪ", "i"], ["eɪ", "a"], ["aʊ", "ow"], ["ɔɪ", "oy"], ["ɪ", "i"], ["ʊ", "u"], ["ə", "e"], ["ɚ", "er"], ["ɝ", "er"],
  ["ɛ", "e"], ["æ", "a"], ["ɑ", "a"], ["ɒ", "o"], ["ɔ", "o"], ["ʌ", "u"], ["ʃ", "sh"], ["ʒ", "zh"], ["θ", "th"], ["ð", "th"], ["ŋ", "ng"], ["j", "y"], ["ɹ", "r"], ["ɾ", "t"], ["ɡ", "g"]];
export function ipaLetters(ipa) {
  let s = String(ipa ?? "").toLowerCase();
  for (const [from, to] of IPA_MAP) s = s.split(from).join(to);
  return s.replace(/[^a-z ]+/g, "").trim();
}
const letters = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]+/g, "");
const ratio = (a, b) => (a.length || b.length ? 1 - distance(a, b) / Math.max(a.length, b.length) : 1);
const keys = (s) => doubleMetaphone(s).filter(Boolean);
// How far a respelling and an IPA string agree: the best of letter similarity and metaphone similarity, 0..1.
export function sayIpaAgreement(say, ipa) {
  const a = letters(say), b = letters(ipaLetters(ipa));
  if (!a || !b) return 1;
  let best = ratio(a, b);
  for (const x of keys(a)) for (const y of keys(b)) best = Math.max(best, ratio(x, y));
  return Number(best.toFixed(2));
}
const AGREE = 0.6;

// ---- Rubric check: does the stored answer pass the prompt's own rules? ----
export function answerPasses(compiledPrompt) {
  const p = compiledPrompt;
  if (p.type === "text") { const r = assess(p, p.answer); return { ok: r.outcome === "correct", why: r.outcome === "correct" ? "" : `scored "${r.outcome}" (${r.feedback})` }; }
  if (p.type === "number") {
    const nums = [...String(p.answer ?? "").matchAll(/-?\d+(?:\.\d+)?%?/g)].map((m) => parseNumber(m[0])).filter((n) => n !== null);
    const ok = nums.some((n) => Math.abs(n - p.expected) <= NUMERIC_TOLERANCE);
    return { ok, why: ok ? "" : `the answer never states the expected value ${p.expected}` };
  }
  if (p.type === "choice") {
    const a = String(p.answer ?? "").toLowerCase(), e = String(p.expected ?? "").toLowerCase();
    const label = e.split(/\s*\(/)[0].trim();
    const ok = a.includes(e) || (label && new RegExp(`(^|[^a-z0-9])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(a));
    return { ok, why: ok ? "" : `the answer doesn't name the expected choice "${p.expected}"` };
  }
  return { ok: true, why: "" };
}

const CLAIM = /already contains its meaning|contains its (own )?meaning|parts carry (its|the) meaning|the word (already )?tells you what it means/i;
const SYMBOLS = /[≈→←↔+=|/\\*#_{}<>^~]/;
const sentences = (s) => String(s ?? "").split(/[.!?](\s|$)/).filter((x) => x && x.trim().length > 1).length;

// Every deterministic check. Returns { proposals (after: null where only the model can supply the fix), notes, questions (for the model) }.
export function checkLesson(doc) {
  const proposals = [], notes = [], questions = [];
  const compiled = compilePacket(doc);

  // 1. The meaning claim needs real morphemes behind it.
  if (CLAIM.test(doc.summary ?? "")) {
    const morphemes = arr(doc.components).filter((c) => c && c.part && String(c.meaning ?? "").trim()).length;
    if (!morphemes) proposals.push(proposal("summary", doc.summary, `The summary claims the word contains its meaning, but the lesson lists no word parts with meanings. Lead with the sound hook and then state the meaning plainly, or add real components first.`, "fix"));
    else questions.push(`The summary claims the word contains its meaning; confirm the ${morphemes} listed components are real morphemes with those meanings, and fix the summary if not.`);
  }

  // 2. Each pick option carries the role's sound or meaning.
  for (const role of arr(doc.roles)) {
    const opts = arr(role.pick?.options);
    opts.forEach((o, j) => {
      const at = `roles[${role.id}].pick.options[${j}]`;
      if (!o.wiki) proposals.push(proposal(`${at}.wiki`, o.wiki ?? null, `"${o.name}" has no Wikipedia title, so it has no picture.`, "improve"));
      if (role.sound_like) {
        const score = soundScore(role, o);
        if (score < SOUND) proposals.push(proposal(`${at}.name`, o.name, `"${o.name}" doesn't carry the sound of "${role.part}" (like "${role.sound_like}"): sound match ${score}. Replace it with a well-known name that does, and set its Wikipedia title.`, "fix"));
      } else {
        const words = [letters(role.part), ...String(role.meaning ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4)];
        const text = String(o.connection ?? "").toLowerCase();
        if (!words.some((w) => w && text.includes(w))) proposals.push(proposal(`${at}.connection`, o.connection ?? null, `"${o.name}" is a meaning cue for "${role.part}" (${role.meaning}), but its connection line doesn't say how it carries that meaning.`, "improve"));
      }
    });
  }

  // 3. say and ipa agree, for each piece and for the whole word.
  const pairs = [["pronunciation.approx", doc.pronunciation?.approx, "pronunciation.ipa", doc.pronunciation?.ipa, doc.title],
    ...arr(doc.roles).map((r) => [`roles[${r.id}].say`, r.say, `roles[${r.id}].ipa`, r.ipa, r.part])];
  for (const [sayPath, say, ipaPath, ipa, piece] of pairs) {
    if (!say || !ipa || say === "—") continue;
    const a = sayIpaAgreement(say, ipa);
    if (a < AGREE) proposals.push(proposal(ipaPath, ipa, `For "${piece}", the respelling "${say}" and the IPA "${ipa}" describe different sounds (agreement ${a}). Make them agree with how the piece is said inside the term; also check ${sayPath}.`, "fix"));
  }

  // 4. Every answer passes its own rubric.
  for (const p of compiled.prompts) {
    const { ok, why } = answerPasses(p);
    if (!ok) proposals.push(proposal(`prompts[${p.id}].answer`, p.answer, `The stored answer fails its own rubric: ${why}. Rewrite the answer so it passes, or widen the accept rules (accept_all / accept_any).`, "fix"));
  }

  // 5. Short and speakable.
  if (doc.summary && (doc.summary.length > 240 || sentences(doc.summary) > 2 || SYMBOLS.test(doc.summary))) {
    proposals.push(proposal("summary", doc.summary, `The summary is spoken aloud: keep it to one or two short sentences with no symbols (${doc.summary.length} characters now${SYMBOLS.test(doc.summary) ? ", with symbols a voice reads badly" : ""}).`, "improve"));
  }
  for (const r of arr(doc.roles)) {
    const q = r.pick?.question;
    if (q && (q.length > 70 || SYMBOLS.test(q) || !/[.?!]["”]?$/.test(q.trim()))) proposals.push(proposal(`roles[${r.id}].pick.question`, q, `The pick question is spoken: a short spoken sentence ending in a period or question mark, no symbols.`, "improve"));
  }
  for (const p of arr(doc.prompts)) {
    if (String(p.question ?? "").length > 160) proposals.push(proposal(`prompts[${p.id}].question`, p.question, `The question is long for a spoken prompt (${p.question.length} characters). Shorten it without changing what it asks.`, "improve"));
  }

  // One entry per path: the first (most severe, since fixes come first within each check) wins.
  const seen = new Set();
  const unique = proposals.filter((p) => !seen.has(p.path) && seen.add(p.path));
  notes.push(`${unique.length} deterministic finding${unique.length === 1 ? "" : "s"}: ${unique.filter((p) => p.severity === "fix").length} to fix, ${unique.filter((p) => p.severity === "improve").length} to improve.`);
  return { proposals: unique, notes, questions };
}

// ---- The model pass ----
const REVIEW_TOOL = {
  name: "review_lesson",
  description: "Proposed changes to a lesson. Each proposal replaces one field, addressed by path. Nothing is saved; a person accepts or discards each one.",
  input_schema: { type: "object", properties: {
    proposals: { type: "array", maxItems: 40, items: { type: "object", properties: {
      path: { type: "string", description: 'One field: "summary", "definition", "pronunciation.approx", "pronunciation.ipa", "roles[<id>].say|ipa|sound_like|meaning|label|part|target|look_for", "roles[<id>].pick.question", "roles[<id>].pick.options[<n>].name|wiki|say|connection", "prompts[<id>].question|hint|answer|accept_all|accept_any|expected|misconceptions", or a whole list: "components", "distinctions", "sources"' },
      after: { type: ["string", "number", "array", "object", "null"], description: "The complete new value for that field, the same kind as the current one: text for text, a list for accept lists and option say lists, a number for expected" },
      reason: { type: "string", description: "One sentence: what was wrong and why this is better" },
      severity: { type: "string", enum: ["fix", "improve"], description: "fix: a rule is broken; improve: better, not required" } },
      required: ["path", "after", "reason", "severity"] } },
    notes: { type: "string", description: "One or two sentences on the lesson as a whole: what holds up, what you could not judge" } },
    required: ["proposals", "notes"] },
};

// The owner's reviewer stays on Claude whatever the owner session's arm; the call is logged without a session.
async function askModel({ system, user }) {
  const { res } = await complete({
    provider: "anthropic", task: "review_lesson", sid: null,
    max_tokens: 6000, system: `${system}\n\nRespond only by calling the ${REVIEW_TOOL.name} tool.`,
    tools: [REVIEW_TOOL], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }],
  });
  const call = toolCall(res, REVIEW_TOOL.name);
  if (!call) throw new Error("model returned no structured output");
  return call.input;
}

const groupKey = (path) => { const t = parsePath(path); return t[0] === "roles" || t[0] === "prompts" ? `${t[0]}[${t[1]}]` : t[0]; };
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Model output -> checked proposals: a path the store can patch, a real change, a lesson that still validates,
// and for a prompt, an answer that still passes its rubric. Anything else is dropped with a note.
export function shapeModelProposals(doc, raw, notes) {
  const out = [];
  const seen = new Set();
  for (const r of arr(raw?.proposals).slice(0, 40)) {
    const path = clip(r?.path, 160).trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    try { pathToPatch(path, r.after); } catch (e) { notes.push(`Dropped a proposal: ${e.message}.`); continue; }
    const before = readPath(doc, path);
    if (before === undefined && !/\.pick\.options\[\d+\]\./.test(path)) { notes.push(`Dropped a proposal for ${path}: no such field.`); continue; }
    if (sameValue(before, r.after)) continue;
    out.push({ path, before: before === undefined ? null : before, after: r.after, reason: clip(r.reason, 300) || "Proposed by the reviewer.", severity: r.severity === "fix" ? "fix" : "improve" });
  }
  // Validate group by group (one role, one prompt, one top-level field); a failing group falls back to one at a time.
  const groups = new Map();
  for (const p of out) { const k = groupKey(p.path); groups.set(k, [...(groups.get(k) ?? []), p]); }
  const kept = [];
  const tryApply = (list) => {
    const { packet, problems } = applyPatch(doc, mergePatches(list.map((p) => pathToPatch(p.path, p.after))));
    problems.push(...validatePacket(packet));
    if (problems.length) return { problems };
    const k = groupKey(list[0].path);
    if (k.startsWith("prompts[")) {
      const id = parsePath(list[0].path)[1];
      const prompt = compilePacket(packet).prompts.find((q, i) => q.id === id || String(i) === id);
      const { ok, why } = prompt ? answerPasses(prompt) : { ok: true };
      if (!ok) return { problems: [`the proposed answer still fails its rubric: ${why}`] };
    }
    return { problems: [] };
  };
  for (const list of groups.values()) {
    if (!tryApply(list).problems.length) { kept.push(...list); continue; }
    for (const p of list) {
      const { problems } = tryApply([p]);
      if (problems.length) notes.push(`Dropped the proposal for ${p.path}: ${problems.join("; ")}.`);
      else kept.push(p);
    }
  }
  return kept;
}

// Deterministic findings + the model's proposals -> one list. A deterministic finding without a replacement takes the model's.
function mergeProposals(deterministic, fromModel) {
  const out = deterministic.map((d) => ({ ...d }));
  for (const m of fromModel) {
    const hit = out.find((d) => d.path === m.path);
    if (!hit) { out.push(m); continue; }
    if (hit.after == null) { hit.after = m.after; hit.reason = `${hit.reason} ${m.reason}`; }
  }
  return out;
}

// reviewLesson(packet, { instruction?, ask? }) -> { proposals: [{ path, before, after, reason, severity }], notes: [string] }
export async function reviewLesson(packet, { instruction = null, ask = askModel } = {}) {
  const { history, pending, ...doc } = packet;
  const { proposals, notes, questions } = checkLesson(doc);
  if (!process.env.ANTHROPIC_API_KEY) { notes.push("The model wasn't asked: the lesson agent isn't configured on this server."); return { proposals, notes }; }
  const flagged = proposals.filter((p) => p.after == null).map((p) => `- ${p.path} (${p.severity}): ${p.reason}`);
  const user = `Lesson (JSON):\n${JSON.stringify(doc)}\n\n` +
    (flagged.length ? `Deterministic findings that need a replacement value. Propose one for each path (and for the sibling fields a fix needs, e.g. a replacement pick option needs name, wiki, say and connection):\n${flagged.join("\n")}\n\n` : "No deterministic findings.\n\n") +
    (questions.length ? `Questions to settle:\n${questions.map((q) => `- ${q}`).join("\n")}\n\n` : "") +
    (instruction ? `Owner's instruction for this review: ${instruction}\n\n` : "") +
    `Then review the whole lesson against the product rules and propose any other change you are confident improves it. Each proposal changes one field; before and after must differ. Do not propose changes to id, version or review fields.`;
  try {
    const raw = await ask({ system: `You review one lesson for Gloo, which teaches hard words to people who cannot yet say them: it speaks every line aloud, shows almost no text, and teaches the sound pieces before the meaning. You propose; a person decides.\n\n${PRODUCT_RULES}`, user });
    const shaped = shapeModelProposals(doc, raw, notes);
    if (raw?.notes) notes.push(clip(raw.notes, 600));
    return { proposals: mergeProposals(proposals, shaped), notes };
  } catch (e) {
    notes.push(`The model call failed (${clip(e.message, 160)}); deterministic findings only.`);
    return { proposals, notes };
  }
}
