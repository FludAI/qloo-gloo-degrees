// Camera capture: the browser sends only the framed crop (a JPEG, a few hundred KB at most);
// the model reads the word inside the frame. Nothing is stored. Labeled "camera" everywhere.
import { complete, toolCall } from "./providers.mjs";
import { q } from "./db.mjs";

const READ_TOOL = {
  name: "read_word",
  description: "The word or short term the learner framed in the camera reticle.",
  input_schema: { type: "object", properties: {
    word: { type: ["string", "null"], description: "The most centered / most prominent word or short term, standard spelling. null if no readable text." },
    alternatives: { type: "array", items: { type: "string" }, maxItems: 5, description: "Other distinct words or terms visible in the frame, most central first" },
    confidence: { type: "string", enum: ["high", "low"] },
  }, required: ["word", "alternatives", "confidence"] },
};

const SYSTEM = `You read one word for a learner. The image is a crop from a phone camera pointed at printed or displayed text; the learner framed the word or short term they want to learn in the middle of it.
Return the word or term at the center of the frame, in standard spelling (correct obvious misreads, keep hyphens and multi-word terms intact, keep the original language). If several candidates are centered, prefer the most technical or unusual one. Do not translate, define, or explain. Respond only by calling read_word.`;

// `provider` is the session's model arm (a multimodal model on either side); the row says ok or empty.
export async function readWord({ image, mime = "image/jpeg", provider = "anthropic", sid = null }) {
  const out = await complete({
    provider, task: "read_word", sid, log: false,
    max_tokens: 300, system: SYSTEM, tools: [READ_TOOL], tool_choice: { type: "auto" },
    output_config: { effort: "low" },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mime, data: image } },
      { type: "text", text: "Call read_word with the word framed in the center of this image." },
    ] }],
  });
  const call = toolCall(out.res, "read_word");
  const logged = (word) => q.logModel.run(sid, out.provider, "read_word", word ? "ok" : "empty", null, out.ms, Date.now(), out.model, out.usage.input, out.usage.output, out.fallback_from, out.stop, out.note, 0);
  if (!call) { logged(null); return { word: null, alternatives: [], confidence: "low", used: out.provider }; }
  const clean = (s) => String(s ?? "").replace(/[“”"`]/g, "").trim().slice(0, 60);
  const word = typeof call.input.word === "string" ? clean(call.input.word) : "";
  logged(word);
  return {
    word: word || null, used: out.provider,
    alternatives: (call.input.alternatives ?? []).map(clean).filter((w) => w && w.toLowerCase() !== word.toLowerCase()).slice(0, 5),
    confidence: call.input.confidence === "high" ? "high" : "low",
  };
}
