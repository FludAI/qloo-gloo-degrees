// The arm judge (scripts/simulate-learner.mjs --arm-judge on): one model call scores how well a hook's name carries
// the sound of the word part it was picked for, 0 to 3, so hooks built under each degree and arm can be compared
// on the one thing a sound hook is for. The score goes on the cue row with the provider and model that gave it,
// and the degrees report labels the column "judged by a model". Nothing personal travels: the word, the part,
// the hook's public name and the lesson's own connection line.
import { complete, toolCall, promptVersion } from "./providers.mjs";

export const JUDGE_PROVIDER = process.env.SIM_JUDGE_PROVIDER ?? "anthropic";
const TOOL = {
  name: "judge_hook",
  description: "The sound-match score of one memory hook.",
  input_schema: { type: "object", properties: {
    score: { type: "integer", minimum: 0, maximum: 3, description: "0 no shared sound (a shared first letter is not a sound); 1 one shared syllable or a loose rhyme; 2 the part's sound is clearly heard inside the name; 3 the name says the part almost exactly" },
    reason: { type: "string", description: "One short sentence" } }, required: ["score", "reason"] },
};

export let JUDGE_PROMPT_VERSION = null;
export async function judgeHook({ word, part, sound_like = null, label, connection = "", provider = JUDGE_PROVIDER, sid = null }) {
  const { res, provider: used, model } = await complete({
    provider, task: "judge_hook", sid, max_tokens: 300, prompt_version: JUDGE_PROMPT_VERSION,
    system: `You judge one memory hook for a hard word. The hook is a public name chosen because it is supposed to sound like one part of the word. Score the SOUND match only, 0 to 3, as the tool describes. Ignore meaning, fame, taste and whether the name is a good hook in other ways; a name that merely starts with the same letter scores 0.\n\nRespond only by calling the ${TOOL.name} tool.`,
    tools: [TOOL], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: `Word: ${word}\nPart: ${part}${sound_like ? ` (the lesson says it sounds like "${sound_like}")` : ""}\nHook name: ${label}${connection ? `\nThe lesson's line for it: ${connection}` : ""}` }],
  });
  const call = toolCall(res, TOOL.name);
  if (!call) throw new Error(`judge returned no structured output (stop ${res.stop_reason ?? "?"})`);
  const n = Number(call.input?.score);
  const score = Number.isInteger(n) ? Math.max(0, Math.min(3, n)) : null;
  if (score == null) throw new Error("judge returned no score");
  return { score, reason: String(call.input?.reason ?? "").slice(0, 200), provider: used, model };
}

// The canon-fit judge (the simulator's fidelity measure): given a character and the canon likes from its persona
// file, how well would each name on a ranked card fit that character, 0 to 3? Qloo orders the card from the
// seeded likes; the judge orders it from canon; the degrees report shows how often they agree. Only public names
// travel: a fictional character, the work's title, public likes, the card's names.
const FIT_TOOL = {
  name: "judge_fit",
  description: "How well each name on a pick card fits the character.",
  input_schema: { type: "object", properties: {
    fits: { type: "array", items: { type: "object", properties: {
      name: { type: "string", description: "A name from the card, exactly as given" },
      fit: { type: "integer", minimum: 0, maximum: 3, description: "0 the character would never pick it; 1 plausible; 2 fits their shown tastes; 3 this is the one they would pick" } },
      required: ["name", "fit"] } } }, required: ["fits"] },
};
JUDGE_PROMPT_VERSION = promptVersion(judgeHook.toString(), JSON.stringify(TOOL));
export let FIT_PROMPT_VERSION = null;
export async function judgeFit({ character, likes, question = "", names, provider = JUDGE_PROVIDER, sid = null }) {
  const { res, provider: used, model } = await complete({
    provider, task: "judge_fit", sid, max_tokens: 500, prompt_version: FIT_PROMPT_VERSION,
    system: `You judge which public names a fictional film or television character would pick on a card, given only what the character is shown liking on screen (the canon likes listed) and the character as written. Score every name, 0 to 3, as the tool describes. Judge from the canon likes and the character's known tastes, not from popularity.\n\nRespond only by calling the ${FIT_TOOL.name} tool.`,
    tools: [FIT_TOOL], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: `Character: ${character.name} (${character.work?.title ?? "?"}, ${character.work?.kind ?? ""} ${character.work?.year ?? ""})\nCanon likes: ${likes.map((l) => `${l.name} (${l.type})`).join("; ") || "none listed"}${question ? `\nThe card asks: ${question}` : ""}\nNames on the card: ${names.join("; ")}` }],
  });
  const call = toolCall(res, FIT_TOOL.name);
  if (!call) throw new Error(`judge returned no structured output (stop ${res.stop_reason ?? "?"})`);
  const fits = new Map();
  for (const f of Array.isArray(call.input?.fits) ? call.input.fits : []) {
    const n = Number(f?.fit);
    if (typeof f?.name === "string" && Number.isInteger(n)) fits.set(f.name.trim().toLowerCase(), Math.max(0, Math.min(3, n)));
  }
  const out = names.map((name) => ({ name, fit: fits.get(name.trim().toLowerCase()) ?? null }));
  if (out.every((f) => f.fit == null)) throw new Error("judge scored none of the names");
  return { fits: out, provider: used, model };
}

FIT_PROMPT_VERSION = promptVersion(judgeFit.toString(), JSON.stringify(FIT_TOOL));

// Agreement between Qloo's order of a ranked card and the judge's fit: whether Qloo's top name is one the judge
// rates highest (ties count), and Spearman's rho between Qloo's order and the fit order (ties averaged), or null
// when fewer than two names carry both.
export function agreement(ranked, fits) {
  const fitOf = new Map(fits.filter((f) => f.fit != null).map((f) => [f.name, f.fit]));
  const both = ranked.filter((name) => fitOf.has(name));
  const best = Math.max(-1, ...both.map((n) => fitOf.get(n)));
  const judge_top = both.filter((n) => fitOf.get(n) === best);
  const top_hit = both.length && ranked[0] === both[0] && fitOf.get(ranked[0]) === best ? 1 : 0;
  if (both.length < 2) return { top_hit, rho: null, judge_top };
  const rankOf = (values) => { // average ranks for ties, 1-based
    const sorted = [...values].map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const r = new Array(values.length);
    for (let k = 0; k < sorted.length;) { let j = k; while (j + 1 < sorted.length && sorted[j + 1].v === sorted[k].v) j++; const avg = (k + j) / 2 + 1; for (let m = k; m <= j; m++) r[sorted[m].i] = avg; k = j + 1; }
    return r;
  };
  const n = both.length;
  const q = both.map((_, i) => n - i), f = both.map((name) => fitOf.get(name));
  const rq = rankOf(q), rf = rankOf(f);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mq = mean(rq), mf = mean(rf);
  let num = 0, dq = 0, df = 0;
  for (let i = 0; i < n; i++) { num += (rq[i] - mq) * (rf[i] - mf); dq += (rq[i] - mq) ** 2; df += (rf[i] - mf) ** 2; }
  const rho = dq && df ? Number((num / Math.sqrt(dq * df)).toFixed(3)) : 0; // all fits equal: no order to agree with, 0
  return { top_hit, rho, judge_top };
}
