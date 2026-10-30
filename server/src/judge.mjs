// The arm judge (scripts/simulate-learner.mjs --arm-judge on): one model call scores how well a hook's name carries
// the sound of the word part it was picked for, 0 to 3, so hooks built under each degree and arm can be compared
// on the one thing a sound hook is for. The score goes on the cue row with the provider and model that gave it,
// and the degrees report labels the column "judged by a model". Nothing personal travels: the word, the part,
// the hook's public name and the lesson's own connection line.
import { complete, toolCall } from "./providers.mjs";

export const JUDGE_PROVIDER = process.env.SIM_JUDGE_PROVIDER ?? "anthropic";
const TOOL = {
  name: "judge_hook",
  description: "The sound-match score of one memory hook.",
  input_schema: { type: "object", properties: {
    score: { type: "integer", minimum: 0, maximum: 3, description: "0 no shared sound (a shared first letter is not a sound); 1 one shared syllable or a loose rhyme; 2 the part's sound is clearly heard inside the name; 3 the name says the part almost exactly" },
    reason: { type: "string", description: "One short sentence" } }, required: ["score", "reason"] },
};

export async function judgeHook({ word, part, sound_like = null, label, connection = "", provider = JUDGE_PROVIDER, sid = null }) {
  const { res, provider: used, model } = await complete({
    provider, task: "judge_hook", sid, max_tokens: 300,
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
