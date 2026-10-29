// LLM backup for word resolution, and provisional lessons for words without a reviewed packet.
// Both are labeled wherever they appear. Neither is ever presented as reviewed content.
import { complete, anyAvailable, toolCall } from "./providers.mjs";
import { arr } from "./lessons.mjs";
import { consistent } from "./syllables.mjs";

const live = () => anyAvailable();
// Current models reject forced tool choice, so the instruction asks for the tool and we check for it.
// `use` = { provider, sid, task }: the session's model arm and the row the call is logged on (providers.mjs).
const forced = async (system, user, tool, use = {}) => {
  const { res } = await complete({
    provider: use.provider ?? "anthropic", task: use.task ?? tool.name, sid: use.sid ?? null,
    max_tokens: 2500, system: `${system}\n\nRespond only by calling the ${tool.name} tool.`,
    tools: [tool], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }],
  });
  const call = toolCall(res, tool.name);
  if (!call) throw new Error("model returned no structured output");
  return call.input;
};

// ---- Resolution backup: only called for close calls and misses ----
export async function resolveWithLlm(local, use = {}) {
  if (!live()) return null;
  const out = await forced(
    "You identify which word or term a learner meant. Input may be a phonetic attempt from speech recognition, a typo, or OCR noise. Return the standard spelling. If you cannot tell, set term to null.",
    `Captured (${local.mode}): "${local.input}"\nNormalized: "${local.normalized}"\nClosest library candidates: ${local.candidates.map((c) => `${c.word} (${c.method} ${c.score})`).join(", ") || "none"}`,
    { name: "resolve_term", description: "The intended term.", input_schema: { type: "object", properties: {
      term: { type: ["string", "null"], description: "Standard spelling, lowercase, or null" },
      reason: { type: "string" } }, required: ["term", "reason"] } },
    { ...use, task: "resolve_term" },
  );
  const term = typeof out.term === "string" ? out.term.toLowerCase().replace(/[^\p{L}\p{N}' -]/gu, "").trim().slice(0, 60) : null;
  return term ? { word: term, term_id: null, score: null, method: "ai", reason: String(out.reason ?? "").slice(0, 200) } : null;
}

// ---- Provisional lesson drafting ----
// The pick options Qloo can resolve: a public name with one of Qloo's entity types (cards.mjs builds degree-2 cards from them).
export const ENTITY_TYPES = ["brand", "movie", "artist", "book", "tv_show", "person", "place", "podcast", "videogame"];
const lessonTool = (maxOptions = 4) => ({
  name: "draft_lesson",
  description: "A provisional Gloo lesson. Accurate, concise, and honest about uncertainty.",
  input_schema: { type: "object", properties: {
    title: { type: "string" },
    pronunciation_approx: { type: "string", description: "Approximate learner respelling, e.g. koh-lih-sis-tuh-KY-nin" },
    pronunciation_ipa: { type: "string", description: "IPA for the whole term as spoken in US English, no slashes, e.g. ˌkoʊlɪˌsɪstoʊˈkaɪnɪn" },
    pronunciation_ipa_syllables: { type: "array", items: { type: "string" }, description: "The same IPA split into syllables, one string per syllable, in order, e.g. [\"koʊ\",\"lɪ\",\"sɪs\",\"toʊ\",\"ˈkaɪ\",\"nɪn\"]; as many entries as the respelling has hyphenated parts" },
    summary: { type: "string", description: "One or two sentences. If the term is built from real morphemes, you may open with the meaning inside the word; otherwise lead with the sound hook, then the meaning." },
    definition: { type: "string" },
    components: { type: "array", maxItems: 5, items: { type: "object", properties: {
      part: { type: "string" }, meaning: { type: "string" }, cue: { type: "string", description: "Optional approximate sound cue, marked as approximate" } },
      required: ["part", "meaning"] } },
    roles: { type: "array", minItems: 2, maxItems: 4, description: "Parts of the term a familiar cue could carry",
      items: { type: "object", properties: {
        id: { type: "string", description: "short slug" }, label: { type: "string" },
        target: { type: "string" }, look_for: { type: "string" },
        part: { type: "string", description: "The word part itself, e.g. chole" }, meaning: { type: "string", description: "What the part means, e.g. bile" },
        sound_like: { type: ["string", "null"], description: "The everyday word the part sounds like, e.g. cola; null for meaning-only roles" },
        say: { type: "string", description: "How to say the part, as a respelling a speech engine reads correctly, e.g. koh-lee" },
        ipa: { type: "string", description: "IPA for the part as it sounds inside the term (US English), no slashes, e.g. koʊli" },
        ipa_syllables: { type: "array", items: { type: "string" }, description: "The part's IPA split into syllables, one string per syllable, e.g. [\"koʊ\",\"li\"]" },
        pick: { type: "object", description: `A favorite-pick: ${maxOptions > 4 ? `${Math.max(3, maxOptions - 4)}-${maxOptions}` : "3-4"} well-known public names (brands, films, bands, books, teams) that ALL carry this part's sound or meaning, so any choice works as the cue`,
          properties: { question: { type: "string", description: "Short and spoken, e.g. Say your favorite cola." },
            options: { type: "array", minItems: 3, maxItems: maxOptions, items: { type: "object", properties: {
              name: { type: "string" }, wiki: { type: "string", description: "Exact English Wikipedia article title for its picture" },
              type: { type: "string", enum: ENTITY_TYPES, description: "What kind of public entity the name is" },
              connection: { type: "string", description: "One sentence: how this name carries the part. Say 'approximate' for sound links." } },
              required: ["name", "wiki", "type", "connection"] } } }, required: ["question", "options"] } },
        required: ["id", "label", "part", "meaning", "sound_like", "target", "look_for", "pick"] } },
    distinctions: { type: "array", maxItems: 4, items: { type: "string" }, description: "Easy confusions to keep straight" },
    prompts: { type: "array", minItems: 3, maxItems: 5, items: { type: "object", properties: {
      skill: { type: "string", enum: ["meaning", "operation", "transfer"] },
      type: { type: "string", enum: ["text", "number"] },
      question: { type: "string" }, hint: { type: "string" },
      accept_all: { type: "array", items: { type: "array", items: { type: "string" } },
        description: "For text: every group must match; each group lists lowercase keyword alternatives" },
      accept_any: { type: "array", items: { type: "string" }, description: "For text: at least one must appear" },
      expected: { type: "number", description: "For number prompts" },
      answer: { type: "string" },
      misconceptions: { type: "array", items: { type: "object", properties: {
        keywords: { type: "array", items: { type: "string" } }, feedback: { type: "string" } }, required: ["keywords", "feedback"] } } },
      required: ["skill", "type", "question", "answer"] } },
    sources: { type: "array", maxItems: 3, items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"] } },
  }, required: ["title", "summary", "definition", "roles", "prompts"] },
});
const LESSON_TOOL = lessonTool(4);

const clip = (s, n) => String(s ?? "").slice(0, n);
// IPA from the model: letters, IPA symbols, stress and length marks only; slashes and brackets dropped; null when empty.
const ipa = (s) => { const v = String(s ?? "").replace(/[/[\]]/g, "").replace(/[^\p{L}\p{M}ˈˌːˑ.‿ ]/gu, "").trim().slice(0, 60); return v || null; };
// Syllables from the model: each entry cleaned like IPA, kept only when they spell the IPA they came with;
// null otherwise (the splitter in syllables.mjs takes over).
const ipaSyllables = (v, whole) => { const list = arr(v).map(ipa).filter(Boolean).slice(0, 16); return list.length && consistent(whole, list) ? list : null; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "role";

// Packets are stored as JSON with accept lists and compiled on load; the compiler lives with the store.
export { compilePacket } from "./lessons.mjs";

// The same rule for every draft and every suggestion. "The word already contains its meaning" was the fixed
// opening line of the sample lessons; it is true of cholecystokinin and false of most words.
export const TRUTH_RULE = `Truthfulness about word parts: claim that "the word already contains its meaning" (or that its parts carry its meaning) only when the term is built from real morphemes whose meanings you can name (chole = bile, cyst = sac, kin = movement). For an eponym, a loanword, a brand or a word whose pieces are only sounds, never make that claim: lead the summary with the sound hook (what the pieces sound like, so the learner can say it) and then state the meaning plainly. Sound cues are approximate memory aids, never etymology; say "approximate" for sound links.`;

const typeOf = (t) => (ENTITY_TYPES.includes(t) ? t : null);
function shape(id, input, d, origin, { maxOptions = 4 } = {}) {
  const components = arr(d.components).slice(0, 5).map((c) => ({ part: clip(c.part, 30), meaning: clip(c.meaning, 80), cue: c.cue ? clip(c.cue, 120) : "—" }));
  const roles = arr(d.roles).slice(0, 4).map((r) => ({
    id: slug(r.id), label: clip(r.label, 50), part: clip(r.part, 30) || clip(r.label, 30), meaning: clip(r.meaning, 60), sound_like: r.sound_like ? clip(r.sound_like, 30) : null,
    say: r.say ? clip(r.say, 40) : null, ipa: ipa(r.ipa), ipa_syllables: ipaSyllables(r.ipa_syllables, ipa(r.ipa)),
    target: clip(r.target, 80), look_for: clip(r.look_for, 120),
    pick: arr(r.pick?.options).length ? { question: clip(r.pick.question, 80), options: arr(r.pick.options).slice(0, maxOptions).map((o) => ({ name: clip(o.name, 40), wiki: o.wiki ? clip(o.wiki, 80) : null, say: [],
      qloo: typeOf(o.type) ? { entity: clip(o.name, 40), type: o.type } : null, connection: clip(o.connection, 160) })) } : undefined,
  }));
  const title = clip(d.title, 80) || input;
  const nodes = [["term", title, "term"]];
  const edges = [];
  components.forEach((c, i) => {
    nodes.push([`p${i}`, c.part, "word part"], [`m${i}`, c.meaning, "concept"]);
    edges.push([`p${i}`, `m${i}`, "root meaning"], [`p${i}`, "term", "component of"]);
  });
  return {
    id, version: "draft-1", provisional: true, origin,
    review: { status: "provisional", reviewed_at: null },
    title, aliases: [input],
    pronunciation: { approx: clip(d.pronunciation_approx, 60) || "—", ipa: ipa(d.pronunciation_ipa), ipa_syllables: ipaSyllables(d.pronunciation_ipa_syllables, ipa(d.pronunciation_ipa)), note: "Approximate. Not reviewed." },
    summary: clip(d.summary, 400), definition: clip(d.definition, 400),
    components: components.length ? components : undefined,
    distinctions: arr(d.distinctions).slice(0, 4).map((x) => clip(x, 240)),
    sources: arr(d.sources).slice(0, 3).filter((s) => /^https?:\/\//.test(s.url)).map((s) => ({ label: clip(s.label, 100), url: clip(s.url, 300) })),
    roles, editorial_cues: [], graph: { nodes, edges },
    first_attempt: { question: "Try to say this word. Just do your best." },
    prompts: arr(d.prompts).slice(0, 5).map((p, i) => ({
      id: `${id}-q${i + 1}`, skill: p.skill, type: p.type, question: clip(p.question, 300), hint: p.hint ? clip(p.hint, 200) : undefined,
      accept_all: p.accept_all, accept_any: p.accept_any, expected: p.expected, answer: clip(p.answer, 300), misconceptions: p.misconceptions,
    })),
  };
}

// `candidates` above four asks for that many pick options per piece (degree 2: Qloo keeps the ones it knows, cards.mjs).
export async function draftLesson(id, word, { candidates = 4, provider = "anthropic", sid = null } = {}) {
  const n = Math.max(4, Math.min(12, Number(candidates) || 4));
  const d = await forced(
    `You draft provisional lessons for Gloo, which teaches hard terms by first using the meaning already inside them (roots, parts, origin), then linking parts to familiar cues.
Be accurate. If the term has meaningful parts, list them. Sound cues are approximate memory aids, never etymology.
${TRUTH_RULE}
Each role needs a favorite-pick: a question like "Which cola is yours?" and ${n > 4 ? `${Math.max(3, n - 4)} to ${n}` : "3-4"} well-known public names that all carry that part's sound or meaning, so whichever one the learner picks works as the cue. Give each name its entity type (brand, movie, artist, book, tv_show, person, place, podcast, videogame).${n > 4 ? " Name many: the ones a culture graph knows best will be kept, so famous names beat clever ones." : ""}
Practice prompts: short, answerable, deterministic. Text prompts need keyword rubrics (lowercase stems that a correct answer must contain). Number prompts need an exact expected value.
Only cite sources you are confident exist (major dictionaries, NIH/NCBI, Wikipedia). It is fine to cite none.
Every array field (components, roles, pick options, prompts, sources) must be a JSON array, never a string containing JSON.`,
    `Draft a provisional lesson for the term: "${word}"`,
    lessonTool(n),
    { provider, sid, task: "draft_lesson" },
  );
  return shape(id, word, d, "ai-draft", { maxOptions: n });
}

export function syntheticLesson(id, word) {
  const title = word.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return shape(id, word, {
    title, pronunciation_approx: "—",
    summary: "SYNTHETIC placeholder. Set ANTHROPIC_API_KEY to have the agent draft a real provisional lesson.",
    definition: "Not drafted (mock mode).",
    roles: [{ id: "sound", label: "Sound of the word", target: title, look_for: "something that sounds like it",
        pick: { question: "Which one sounds closest?", options: [{ name: "Option A", connection: "SYNTHETIC option." }, { name: "Option B", connection: "SYNTHETIC option." }, { name: "Option C", connection: "SYNTHETIC option." }] } },
      { id: "meaning", label: "Core meaning", target: "its meaning", look_for: "something that carries its meaning",
        pick: { question: "Which one carries the meaning?", options: [{ name: "Option A", connection: "SYNTHETIC option." }, { name: "Option B", connection: "SYNTHETIC option." }, { name: "Option C", connection: "SYNTHETIC option." }] } }],
    prompts: [{ skill: "meaning", type: "text", question: `Spell the word you glued.`, accept_any: [word.toLowerCase()], answer: word }],
  }, "synthetic");
}

// ---- One-field suggestions for the owner console: the AI proposes, a person decides, nothing is saved here ----
const SUGGEST_TOOL = {
  name: "suggest_field",
  description: "A proposed replacement for one field of a lesson. It is shown to the owner as a suggestion; nothing is saved.",
  input_schema: { type: "object", properties: {
    value: { type: "string", description: "The new value for the field, and nothing else: the same kind of content as the current value" },
    reason: { type: "string", description: "One sentence: what changed and why" } }, required: ["value", "reason"] },
};
export async function suggestField({ packet, field, current, instruction, sid = null }) {
  const out = await forced(
    `You help the owner of Gloo edit one field of a lesson. Gloo teaches hard words to people who cannot yet say them: it speaks every line aloud, shows almost no text, and teaches the sound pieces before the meaning.
Keep lines short and natural when read aloud. A respelling stays a respelling; IPA stays IPA for US English with no slashes or brackets; a pick question stays a short spoken question; a rubric keyword list stays a list.
Be accurate; do not invent sources or etymology.
${TRUTH_RULE}`,
    `Lesson (JSON):\n${JSON.stringify(packet)}\n\nField to rewrite: ${field}\nCurrent value: ${JSON.stringify(current)}\n${instruction ? `Owner's instruction: ${instruction}` : "No instruction given: improve accuracy and clarity; keep the meaning and length."}`,
    SUGGEST_TOOL,
    { sid, task: "suggest_field" },
  );
  return { value: clip(out.value, 1000), reason: clip(out.reason, 300) };
}
