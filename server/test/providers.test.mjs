// The provider layer (providers.mjs) without a network: which backend answers for which arm, the fallback when a
// key is missing and its record, the unavailable case, and the muse backend's two converters (the Anthropic
// messages shape to a chat completion request, and the completion back). Live calls are covered by the API test.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.META_API_KEY;
const { pick, available, availability, anyAvailable, complete, PROVIDERS, MODELS, toChatRequest, fromChatResponse, jsonIn, META_BASE_URL } = await import("../src/providers.mjs");

test("no keys: nothing is available and a call says so without touching the network", async () => {
  assert.deepEqual(PROVIDERS, ["anthropic", "muse"]);
  assert.deepEqual(availability(), { anthropic: false, muse: false });
  assert.equal(anyAvailable(), false);
  assert.equal(pick("muse"), null); assert.equal(pick("anthropic"), null);
  await assert.rejects(complete({ provider: "muse", task: "read_word", max_tokens: 10, messages: [] }), (e) => e.code === "MODEL_UNAVAILABLE");
  assert.equal(META_BASE_URL, "https://api.meta.ai");
});

test("each arm answers for itself when keyed; a missing key falls back to the other and records where it came from", () => {
  process.env.ANTHROPIC_API_KEY = "test-not-a-key";
  assert.deepEqual(pick("anthropic"), { provider: "anthropic", fallback_from: null });
  assert.deepEqual(pick("muse"), { provider: "anthropic", fallback_from: "muse" });
  assert.deepEqual(pick("nonsense"), { provider: "anthropic", fallback_from: null }, "an unknown arm means the default");
  process.env.META_API_KEY = "test-not-a-key-either";
  assert.deepEqual(pick("muse"), { provider: "muse", fallback_from: null });
  assert.equal(available("muse"), true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(pick("anthropic"), { provider: "muse", fallback_from: "anthropic" }, "the fallback goes both ways");
  assert.equal(MODELS.anthropic, "claude-sonnet-5-5"); assert.equal(MODELS.muse, "muse-spark-1.3");
  delete process.env.META_API_KEY;
});

test("the muse request: system, text, an image as a data URL, tools as functions, and an agent turn with tool results", () => {
  const tool = { name: "read_word", description: "The word.", input_schema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } };
  const r = toChatRequest({ model: "muse-spark-1.3", system: "Read it.", max_tokens: 300, output_config: { effort: "low" }, tools: [tool],
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }, { type: "text", text: "Call read_word." }] }] });
  assert.deepEqual(r.messages[0], { role: "system", content: "Read it." });
  assert.deepEqual(r.messages[1], { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }, { type: "text", text: "Call read_word." }] });
  assert.deepEqual(r.tools, [{ type: "function", function: { name: "read_word", description: "The word.", parameters: tool.input_schema } }]);
  assert.equal(r.tool_choice, "auto"); assert.equal(r.reasoning_effort, "low"); assert.equal(r.model, "muse-spark-1.3");
  // Muse reasons from the same cap, so the visible-output max_tokens becomes max_completion_tokens with headroom (6000 by default).
  assert.equal(r.max_completion_tokens, 6300); assert.equal(r.max_tokens, undefined);
  assert.ok(!("system" in r) && !("output_config" in r), "nothing the API would reject");
  const plain = toChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal(plain.reasoning_effort, "low", "an effort is always set: unset, the model picks its own depth");
  assert.equal(plain.max_completion_tokens, 1024 + 6000);
  assert.equal(toChatRequest({ model: "m", messages: [], output_config: { effort: "none" } }).reasoning_effort, "minimal", "\"none\" is refused by Muse");
  // An agent loop turn: the assistant's tool use becomes tool_calls, the results become tool messages in order, then the user's text.
  const turn = toChatRequest({ model: "m", messages: [
    { role: "user", content: "Find cues." },
    { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "c1", name: "qloo_describe", input: { entity: "Breyers" } }, { type: "tool_use", id: "c2", name: "qloo_find_tags", input: { query: "ice cream" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{\"status\":\"ok\"}" }, { type: "tool_result", tool_use_id: "c2", content: "{}" }, { type: "text", text: "Please finish." }] },
  ] });
  assert.deepEqual(turn.messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(turn.messages[1].tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]), [["c1", "qloo_describe", "{\"entity\":\"Breyers\"}"], ["c2", "qloo_find_tags", "{\"query\":\"ice cream\"}"]]);
  assert.equal(turn.messages[1].content, "Looking.");
  assert.deepEqual(turn.messages[2], { role: "tool", tool_call_id: "c1", content: "{\"status\":\"ok\"}" });
  assert.deepEqual(turn.messages[4], { role: "user", content: [{ type: "text", text: "Please finish." }] });
  assert.equal(turn.tools, undefined); assert.equal(turn.tool_choice, undefined);
});

test("the muse answer: tool calls become tool_use blocks with parsed input, text stays text, usage and stop reason map", () => {
  const a = fromChatResponse({ id: "chatcmpl-1", model: "muse-spark-1.3", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read_word", arguments: "{\"word\":\"Cholecystokinin\",\"alternatives\":[],\"confidence\":\"high\"}" } }] } }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  assert.deepEqual(a.content, [{ type: "tool_use", id: "call_1", name: "read_word", input: { word: "Cholecystokinin", alternatives: [], confidence: "high" } }]);
  assert.equal(a.stop_reason, "tool_use"); assert.deepEqual(a.usage, { input_tokens: 7, output_tokens: 3 }); assert.equal(a.model, "muse-spark-1.3");
  const t = fromChatResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Just words." } }] });
  assert.deepEqual(t.content, [{ type: "text", text: "Just words." }]); assert.equal(t.stop_reason, "end_turn"); assert.deepEqual(t.usage, { input_tokens: null, output_tokens: null });
  const bad = fromChatResponse({ choices: [{ finish_reason: "length", message: { tool_calls: [{ function: { name: "x", arguments: "not json" } }] } }] });
  assert.equal(bad.content[0].input._raw, "not json"); assert.equal(bad.stop_reason, "max_tokens"); assert.ok(bad.content[0].id.startsWith("call_"));
  assert.deepEqual(fromChatResponse({}).content, []);
});

test("the muse answer written as text: content parts, a fenced JSON object standing in for the one tool offered, a named wrapper, and a cut answer", () => {
  assert.deepEqual(jsonIn("Sure:\n```json\n{\"a\": 1}\n```\nDone."), { a: 1 });
  assert.deepEqual(jsonIn("text {\"a\": {\"b\": [1]}} more"), { a: { b: [1] } });
  assert.equal(jsonIn("[1,2]"), null); assert.equal(jsonIn("no braces"), null); assert.equal(jsonIn("{not json}"), null);
  const draft = { title: "Peristalsis", roles: [{ id: "peri" }] };
  // Content as an array of parts, the lesson as fenced JSON, no tool_calls: the drafter still gets its tool call, and the row will say so.
  const a = fromChatResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Here is the lesson:\n```json\n" + JSON.stringify(draft) + "\n```" }] } }],
    usage: { prompt_tokens: 50, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } } }, { tools: ["draft_lesson"] });
  assert.deepEqual(a.content.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(a.content[1].name, "draft_lesson"); assert.deepEqual(a.content[1].input, draft); assert.equal(a.note, "tool_from_text");
  assert.equal(a.stop_reason, "end_turn"); assert.deepEqual(a.usage, { input_tokens: 50, output_tokens: 900, reasoning_tokens: 700 });
  // Two tools offered: a bare object cannot be placed, a wrapper naming the tool can (arguments as a string or an object).
  const bare = fromChatResponse({ choices: [{ finish_reason: "stop", message: { content: "{\"term\": \"x\"}" } }] }, { tools: ["resolve_term", "draft_lesson"] });
  assert.deepEqual(bare.content.map((b) => b.type), ["text"]); assert.equal(bare.note, null);
  const named = fromChatResponse({ choices: [{ finish_reason: "stop", message: { content: "{\"name\": \"resolve_term\", \"arguments\": \"{\\\"term\\\": \\\"breyers\\\", \\\"reason\\\": \\\"brand\\\"}\"}" } }] }, { tools: ["resolve_term", "draft_lesson"] });
  assert.deepEqual(named.content[1], { type: "tool_use", id: named.content[1].id, name: "resolve_term", input: { term: "breyers", reason: "brand" } }); assert.equal(named.note, "tool_from_text");
  const obj = fromChatResponse({ choices: [{ finish_reason: "stop", message: { content: "{\"name\": \"resolve_term\", \"input\": {\"term\": null, \"reason\": \"unsure\"}}" } }] }, { tools: ["resolve_term", "draft_lesson"] });
  assert.deepEqual(obj.content[1].input, { term: null, reason: "unsure" });
  // No tools offered: text stays text, whatever it holds.
  const none = fromChatResponse({ choices: [{ finish_reason: "stop", message: { content: "{\"a\": 1}" } }] });
  assert.deepEqual(none.content.map((b) => b.type), ["text"]); assert.equal(none.note, null);
  // Cut at the cap mid-thought: no tool call to invent, and the stop reason says why.
  const cut = fromChatResponse({ choices: [{ finish_reason: "length", message: { content: "Let me think about the term" } }], usage: { prompt_tokens: 40, completion_tokens: 2500 } }, { tools: ["draft_lesson"] });
  assert.deepEqual(cut.content.map((b) => b.type), ["text"]); assert.equal(cut.stop_reason, "max_tokens"); assert.equal(cut.note, null);
});
