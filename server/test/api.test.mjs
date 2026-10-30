// End-to-end API checks against a real server process: mock Qloo, fake model provider.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGlooClient, TOOLS } from "../../scripts/gloo-lessons-mcp.mjs";
import { simulate, favoriteOn, parseArgs, FIXTURES } from "../../scripts/simulate-learner.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
const MCP = fileURLToPath(new URL("../../scripts/gloo-lessons-mcp.mjs", import.meta.url));
const PORT = 8799;
const MEDIA_DIR = mkdtempSync(join(tmpdir(), "gloo-api-media-")); // the test server's media store (local), read back for the run upload and the learning export
let fake, proc, calls = 0, ttsCalls = 0, reviewInstruction = null;

// Fake Anthropic Messages API: one Qloo describe call, then a proposal with one real and one invented ID.
let replyModel = "fake";
let museStyle = "tool";
let draftStyle = "ok"; // "cut": a wide (8-12 option) draft comes back cut at the cap with a fragment of the lesson in the tool call, as the live API returned it; the four-option retry is answered whole
let lastDraft = null, lastAgent = null; // the last draft_lesson request and the last agent run's opening request, as the model saw them // how the fake Muse answers: "tool" (tool_calls), "text" (the call as fenced JSON in content parts), "cut" (finish_reason length, mid-thought)
const reply = (content) => ({ id: "msg", type: "message", role: "assistant", model: replyModel, stop_reason: "tool_use", content, usage: { input_tokens: replyModel === "fake-muse" ? 7 : 10, output_tokens: replyModel === "fake-muse" ? 3 : 10 } });
before(async () => {
  fake = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = JSON.parse(body || "{}");
      // The fake Meta Model API: chat completions under /muse with a bearer token. The request is turned into the
      // Messages shape the branches below read, and the reply is turned back into a chat completion on the way out.
      const muse = req.url.startsWith("/muse/");
      replyModel = muse ? "fake-muse" : "fake";
      if (muse) {
        assert.equal(req.url, "/muse/v1/chat/completions");
        assert.match(String(req.headers.authorization ?? ""), /^Bearer test-muse-key$/);
        assert.equal(req.headers["x-api-key"], undefined);
        assert.equal(parsed.model, "muse-spark-1.3");
        assert.ok(!JSON.stringify(parsed).includes("gloo_sid"), "nothing identifies the learner");
        assert.ok((parsed.tools ?? []).every((t) => t.type === "function" && t.function?.name && t.function.parameters), "tools in the function shape");
        assert.ok(!parsed.tool_choice || parsed.tool_choice === "auto", "auto is the only tool choice the API takes");
        assert.ok(parsed.max_completion_tokens > 2500 && parsed.max_tokens === undefined, "the cap carries reasoning headroom, under its canonical name");
        assert.ok(["minimal", "low", "medium", "high", "xhigh"].includes(parsed.reasoning_effort), "a reasoning effort is always set");
        assert.ok(parsed.messages.every((m) => m.role !== "tool" || m.tool_call_id), "tool results carry their call id");
        const sys = parsed.messages.find((m) => m.role === "system");
        parsed = { ...parsed, system: sys?.content ?? "", tools: (parsed.tools ?? []).map((t) => ({ name: t.function.name, input_schema: t.function.parameters })), tool_choice: { type: "auto" },
          messages: parsed.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "tool" ? "user" : m.role,
            content: typeof m.content === "string" || m.content == null ? m.content ?? "" : m.content.map((b) => (b.type === "image_url" ? { type: "image", url: b.image_url.url } : { type: "text", text: b.text })) })) };
        const end = res.end.bind(res);
        res.end = (out) => { const a = JSON.parse(out);
          const calls = a.content.filter((b) => b.type === "tool_use"), text = a.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          const message = museStyle === "text" && calls[0] ? { role: "assistant", content: [{ type: "text", text: "Here is the lesson:\n```json\n" + JSON.stringify(calls[0].input) + "\n```" }] }
            : museStyle === "cut" ? { role: "assistant", content: "Let me think about this carefully. The term" }
            : { role: "assistant", content: text || null, tool_calls: calls.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } })) };
          end(JSON.stringify({ id: a.id, object: "chat.completion", model: a.model, choices: [{ index: 0, finish_reason: museStyle === "cut" ? "length" : museStyle === "text" ? "stop" : "tool_calls", message }],
            usage: { prompt_tokens: a.usage.input_tokens, completion_tokens: a.usage.output_tokens, total_tokens: a.usage.input_tokens + a.usage.output_tokens, completion_tokens_details: { reasoning_tokens: museStyle === "cut" ? 2500 : 2 } } })); };
      }
      if (req.url === "/tts") {
        // Fake Text-to-Speech: echoes the SSML it was sent as the "audio", so the test can read what was said;
        // when time points are asked for, every <mark> gets one, 0.25 s apart.
        ttsCalls++;
        res.setHeader("content-type", "application/json");
        const names = parsed.enableTimePointing?.includes("SSML_MARK") ? [...String(parsed.input?.ssml ?? "").matchAll(/<mark name="([^"]+)"/g)].map((m) => m[1]) : [];
        return res.end(JSON.stringify({ audioContent: Buffer.from(`MP3|${parsed.voice?.name}|${parsed.input?.ssml}`).toString("base64"), timepoints: names.map((n, i) => ({ markName: n, timeSeconds: 0.25 * i })) }));
      }
      const offered = (parsed.tools ?? []).map((t) => t.name);
      const forcedTool = ["resolve_term", "draft_lesson", "read_word", "suggest_field", "review_lesson", "judge_hook", "judge_fit"].find((n) => offered.includes(n));
      if (forcedTool === "judge_fit") {
        res.setHeader("content-type", "application/json");
        const user = String(parsed.messages?.[0]?.content ?? "");
        assert.match(user, /^Character: .+\nCanon likes: /); assert.ok(!user.includes("gloo_sid"));
        const names = (/Names on the card: (.+)$/m.exec(user)?.[1] ?? "").split("; ");
        return res.end(JSON.stringify(reply([{ type: "tool_use", id: "f1", name: "judge_fit", input: { fits: names.map((name) => ({ name, fit: /Pepsi|Penguin/.test(name) ? 3 : 1 })) } }])));
      }
      res.setHeader("content-type", "application/json");
      if (forcedTool === "judge_hook") {
        // The arm judge: the hook name and the part reach the model, nothing else about the learner; Pepsi carries "chole" a little, anything else a lot.
        const user = String(parsed.messages?.[0]?.content ?? "");
        assert.match(user, /^Word: .+\nPart: /); assert.ok(!user.includes("gloo_sid"));
        const score = /Hook name: Pepsi/.test(user) ? 1 : 2;
        return res.end(JSON.stringify(reply([{ type: "tool_use", id: "j1", name: "judge_hook", input: { score, reason: "fake judge" } }])));
      }
      if (forcedTool === "review_lesson") {
        // The reviewer: the deterministic findings and the owner's instruction reach the model; it answers with a mix of
        // good proposals and ones the server must drop (bad path, no change, invalid value, an answer its rubric rejects).
        const user = String(parsed.messages?.[0]?.content ?? "");
        const lesson = JSON.parse(user.split("\n\n")[0].replace("Lesson (JSON):\n", ""));
        assert.ok(String(parsed.system).includes("Every pick option must carry"), "product rules in the system prompt");
        if (lesson.id === "cholecystokinin") assert.ok(user.includes("- prompts[cck-cysto].answer (fix)"), "deterministic finding put to the model");
        reviewInstruction = /Owner's instruction for this review: (.+)/.exec(user)?.[1] ?? "";
        return res.end(JSON.stringify(reply([{ type: "tool_use", id: "rv1", name: "review_lesson", input: { notes: "Reviewed by the fake model.", proposals: [
          { path: "summary", after: "Chole is bile, cysto is the sac, kin is movement. The hormone that moves the bile sac.", reason: "Shorter and spoken.", severity: "improve" },
          { path: "prompts[cck-cysto].answer", after: "Cysto", reason: "Matches the accept rule.", severity: "fix" },
          { path: "roles[chole].nickname", after: "x", reason: "no such field", severity: "fix" },
          { path: "definition", after: lesson.definition, reason: "unchanged", severity: "improve" },
          { path: "pronunciation.ipa", after: "/bad/", reason: "slashes", severity: "fix" },
          { path: "prompts[cck-chole].answer", after: "Soda.", reason: "a misconception", severity: "fix" },
        ] } }])));
      }
      if (forcedTool === "suggest_field") {
        // Echo what was asked, so the test can check the field, the current value and the instruction reached the model.
        const user = String(parsed.messages?.[0]?.content ?? "");
        const field = /Field to rewrite: (\S+)/.exec(user)?.[1];
        const instruction = /Owner's instruction: (.+)/.exec(user)?.[1] ?? "";
        assert.equal(parsed.tool_choice?.type, "auto");
        assert.ok(String(parsed.system).includes("already contains its meaning"), "truthfulness rule in the system prompt");
        return res.end(JSON.stringify(reply([{ type: "tool_use", id: "s1", name: "suggest_field", input: { value: `Suggested ${field}${instruction ? ` (${instruction})` : ""}`, reason: "test" } }])));
      }
      if (forcedTool === "read_word") {
        return res.end(JSON.stringify(reply([{ type: "tool_use", id: "v1", name: "read_word", input: { word: "Cholecystokinin", alternatives: ["gallbladder"], confidence: "high" } }])));
      }
      if (forcedTool === "resolve_term") {
        return res.end(JSON.stringify(reply([{ type: "tool_use", id: "r1", name: "resolve_term", input: { term: "Breyers", reason: "brand name" } }])));
      }
      if (forcedTool === "draft_lesson") {
        lastDraft = { system: String(parsed.system), user: String(parsed.messages?.[0]?.content ?? "") };
        // Degree 2 asks for eight to twelve typed candidates per piece; the fake then names nine for "peri", one of them unknown to the mock graph.
        const many = String(parsed.system).includes("8 to 12");
        const tool = (parsed.tools ?? []).find((t) => t.name === "draft_lesson");
        assert.equal(tool.input_schema.properties.roles.items.properties.pick.properties.options.maxItems, many ? 12 : 4);
        assert.equal(muse ? parsed.max_completion_tokens - 6000 : parsed.max_tokens, many ? 6000 : 2500, "a wide draft gets a wider cap (the muse cap carries its reasoning headroom on top)");
        if (draftStyle === "cut" && many) return res.end(JSON.stringify({ ...reply([{ type: "tool_use", id: "d0", name: "draft_lesson", input: { title: "Peristalsis", summary: "peri (around) + stal" } }]), stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 6000 } }));
        const peri = many ? { pick: { question: "Say your favorite peri.", options: [
          ["Peri-Peri Sauce", "brand"], ["Perrier", "brand"], ["Obscure Peri Band", "artist"], ["Periscope", "brand"], ["Perry Mason", "tv_show"], ["Katy Perry", "artist"], ["Peridot", "brand"], ["Perrier-Jouet", "brand"], ["Peri", "movie"],
        ].map(([name, type]) => ({ name, wiki: name, type, connection: `${name} starts with the sound of peri (approximate).` })) } }
          : { pick: { question: "Say your favorite peri.", options: [["Perrier", "brand"], ["Katy Perry", "artist"], ["Perry Mason", "tv_show"], ["Periscope", "brand"]].map(([name, type]) => ({ name, wiki: name, type, connection: `${name} starts with the sound of peri (approximate).` })) } };
        return res.end(JSON.stringify(reply([{ type: "tool_use", id: "d1", name: "draft_lesson", input: {
          title: "Peristalsis", pronunciation_approx: "pair-ih-STAL-sis", summary: "peri (around) + stalsis (contraction)",
          definition: "Wave-like muscle contractions that move food through the digestive tract.",
          components: [{ part: "peri", meaning: "around" }, { part: "stalsis", meaning: "contraction" }],
          roles: [{ id: "peri", label: "peri = around", part: "peri", meaning: "around", sound_like: "perry", target: "around", look_for: "something that goes around", ...peri },
            { id: "stalsis", label: "stalsis = contraction", target: "squeeze", look_for: "something that squeezes" }],
          prompts: [{ skill: "meaning", type: "text", question: "What does peri mean?", accept_any: ["around", "surround"], answer: "Around." },
            { skill: "meaning", type: "text", question: "What does peristalsis do?", accept_all: [["move", "push", "propel"], ["food", "digest"]], answer: "Moves food along." },
            { skill: "transfer", type: "text", question: "Perimeter: what does peri tell you?", accept_any: ["around"], answer: "Around." }],
          sources: [{ label: "bad", url: "javascript:alert(1)" }] } }])));
      }
      calls++;
      if ((parsed.messages ?? []).length === 1) lastAgent = { system: String(parsed.system), user: String(parsed.messages[0].content ?? "") };
      // The first step of every agent run resolves Breyers; the next one proposes.
      const msg = (parsed.messages ?? []).length === 1
        ? reply([{ type: "tool_use", id: "t1", name: "qloo_describe", input: { entity: "Breyers", type: "brand" } }])
        : reply([{ type: "tool_use", id: "t2", name: "propose_cues", input: { cues: [
            { role: "sound", label: "Breyers", qloo_entity_id: "mock-breyers", qloo_entity_type: "brand", connection_type: "approximate sound", connection: "Breyers ≈ Brier", grounding: "resolved" },
            { role: "endpoints", label: "Invented", qloo_entity_id: "made-up-id", qloo_entity_type: "book", connection_type: "reinforcement", connection: "x", grounding: "y" },
            { role: "not-a-role", label: "Bad", qloo_entity_id: null, connection_type: "meaning", connection: "x", grounding: "y" } ] } }]);
      res.end(JSON.stringify(msg));
    });
  }).listen(8798);
  proc = spawn(process.execPath, [SERVER, "--mock"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:", ANTHROPIC_API_KEY: "test-not-a-key", ANTHROPIC_BASE_URL: "http://localhost:8798",
      TTS_ENDPOINT: "http://localhost:8798/tts", MEDIA_LOCAL: "1", MEDIA_DIR, LIMIT_TTS_PER_SESSION_HOUR: "2",
      ADMIN_TOKEN: "test-owner-token", SIM_TOKEN: "test-sim-token", QLOO_LEVELS: "1", // every session draws degree 1 (production's behavior); the degrees test forces others
      META_API_KEY: "test-muse-key", META_BASE_URL: "http://localhost:8798/muse", MODEL_ARMS: "anthropic" }, // the fake Meta backend; sessions draw the anthropic arm unless forced
    stdio: "ignore",
  });
  // A cold start on Windows can take several seconds; wait up to 30 s.
  for (let i = 0; i < 150; i++) {
    try { await fetch(`http://localhost:${PORT}/api/terms`); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
});
after(() => { proc?.kill(); fake?.close(); });

const session = () => {
  let cookie = "";
  return async (method, path, body, headers = {}) => {
    const res = await fetch(`http://localhost:${PORT}${path}`, {
      method, headers: { ...headers, ...(cookie && { cookie }), ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
};

test("1: lesson stays locked until the first attempt is saved or skipped", async () => {
  const s = session();
  const locked = (await s("GET", "/api/terms/brier-score")).body;
  assert.equal(locked.locked, true);
  // The locked packet carries the syllables the paw needs for the first attempt, and nothing else about the lesson.
  assert.deepEqual(locked.pronunciation.ipa_syllables, ["ˈbraɪ", "ər", "skɔːr"]);
  assert.deepEqual(locked.pieces.map((p) => [p.part, p.ipa_syllables]), [["Brier", ["ˈbraɪ", "ər"]], ["lower", null], ["0 to 1", null], ["score", null]]);
  assert.equal((await s("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["Breyers"] })).status, 409);
  await s("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  const open = (await s("GET", "/api/terms/brier-score")).body;
  assert.equal(open.locked, false);
  assert.deepEqual(open.roles[0].ipa_syllables, ["ˈbraɪ", "ər"]);
});

test("a spoken first attempt is scored against the pieces in the background", async () => {
  const s = session();
  const { body } = await s("POST", "/api/terms/cholecystokinin/first-attempt", { response: "koh lee sis toe KY nin" });
  assert.equal(body.pieces.pieces.length, 4);
  assert.ok(body.pieces.said_count >= 3);
  const term = (await s("GET", "/api/terms/cholecystokinin")).body;
  assert.equal(term.first_attempt_record.pieces.said_count, body.pieces.said_count);
});

test("agent: Qloo-returned IDs are kept, invented IDs are stripped, unknown roles dropped", async () => {
  const s = session();
  await s("POST", "/api/terms/brier-score/first-attempt", { response: "forecast accuracy" });
  assert.equal((await s("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["Breyers"] })).status, 403, "the agent is degree 3");
  await s("GET", "/api/level?qloo=3");
  const { body } = await s("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["Breyers"] });
  assert.equal(body.status, "ok");
  assert.equal(body.cues.length, 2);
  assert.equal(body.cues[0].qloo_entity_id, "mock-breyers");
  assert.equal(body.cues[0].source, "qloo-grounded");
  assert.equal(body.cues[1].qloo_entity_id, null);
  assert.equal(body.cues[1].source, "agent (no verified Qloo ID)");
  assert.equal(body.calls[0].request.operation, "describe");
});

test("7: a cue needs explicit recognition; it can be edited and removed", async () => {
  const s = session();
  const base = { term_id: "brier-score", role: "sound", label: "Breyers", connection: "sounds like Brier", source: "editorial" };
  assert.equal((await s("POST", "/api/learner/cues", base)).status, 400);
  const list = (await s("POST", "/api/learner/cues", { ...base, recognized: true })).body;
  assert.equal(list.length, 1);
  assert.ok(!("sid" in list[0]));
  assert.equal((await s("PATCH", `/api/learner/cues/${list[0].id}`, { connection: "Brier ≈ Breyers" })).status, 200);
  assert.equal((await s("DELETE", `/api/learner/cues/${list[0].id}`)).status, 200);
  assert.equal((await s("GET", "/api/learner/cues/brier-score")).body.length, 0);
});

test("a favorite pick is saved as the learner's cue for that role", async () => {
  const s = session();
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  const term = (await s("GET", "/api/terms/cholecystokinin")).body;
  const role = term.roles.find((r) => r.id === "chole");
  assert.equal(role.pick.options.length, 4);
  assert.ok(role.pick.options.every((o) => /cola|kola/i.test(o.name)));
  assert.ok(role.pick.options.every((o) => o.wiki && Array.isArray(o.say)));
  assert.equal(role.part, "chole"); assert.equal(role.meaning, "bile"); assert.equal(role.sound_like, "cola");
  const o = role.pick.options[1];
  const list = (await s("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "chole", label: o.name, connection: o.connection, source: "pick", recognized: true, qloo_entity_type: o.qloo?.type })).body;
  assert.equal(list[0].source, "pick");
  assert.equal(list[0].label, o.name);
});

test("taste: two picks become Qloo signals and the next pick cards are ranked for them", async () => {
  const s = session();
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  const before = (await s("GET", "/api/terms/cholecystokinin")).body;
  // Under two picks, every card is editorial and no Qloo call is made.
  assert.ok(before.roles.every((r) => !r.pick || r.pick.tailoring.source === "editorial"));
  assert.equal(before.roles.find((r) => r.id === "in").pick.tailoring.reason, "fewer than two picks");
  assert.equal((await s("GET", "/api/diagnostics")).body.calls.length, 0);
  assert.equal((await s("GET", "/api/health")).body.taste.signals, 0);

  const pick = async (roleId, name) => {
    const role = (await s("GET", "/api/terms/cholecystokinin")).body.roles.find((r) => r.id === roleId);
    const o = role.pick.options.find((x) => x.name === name);
    return (await s("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: roleId, label: o.name, connection: o.connection, source: "pick", recognized: true, qloo_entity_id: null, qloo_entity_type: o.qloo?.type })).body;
  };
  let cues = await pick("chole", "Pepsi-Cola");
  // The packet, not the browser, says which entity the pick stands for; its ID is resolved once (mock describe).
  assert.equal(cues[0].qloo_entity_id, "mock-pepsi"); assert.equal(cues[0].qloo_type, "brand");
  assert.equal(cues[0].hook_source, "editorial"); assert.equal(cues[0].shown_rank, 1);
  cues = await pick("cysto", "Twisted Sister");
  assert.equal(cues[1].qloo_entity_id, "mock-twisted-sister");
  assert.equal((await s("GET", "/api/health")).body.taste.signals, 2);

  const after = (await s("GET", "/api/terms/cholecystokinin")).body;
  const by = (id) => after.roles.find((r) => r.id === id).pick;
  // -in: the three brands (LinkedIn, Aspirin = Bayer, Penguin = Penguin Books) are ranked by the mock (reverse alphabetical); the film follows in editorial order.
  assert.equal(by("in").tailoring.source, "taste");
  assert.deepEqual(by("in").tailoring.ranked, ["Penguin", "LinkedIn", "Aspirin"]);
  assert.deepEqual(by("in").options.map((o) => o.name), ["Penguin", "LinkedIn", "Aspirin", "Aladdin"]);
  assert.ok(by("in").options[0].taste > by("in").options[1].taste);
  assert.equal(by("in").options[3].taste, undefined);
  // chole and cysto are already picked: kept as shown, no call, so a card never moves under its reveal.
  assert.equal(by("chole").tailoring.source, "kept"); assert.equal(by("chole").tailoring.reason, "already picked");
  assert.deepEqual(by("chole").options.map((o) => o.name), before.roles.find((r) => r.id === "chole").pick.options.map((o) => o.name));
  assert.ok(by("chole").options.every((o) => o.taste === undefined));
  assert.equal(by("cysto").tailoring.source, "kept");
  // kin: both options are the same entity (Kinetic Sand said two ways), nothing to rank, no credit spent.
  assert.equal(by("kin").tailoring.source, "editorial"); assert.equal(by("kin").tailoring.reason, "one entity");
  assert.ok(by("in").options.every((o) => o.wiki && o.connection), "every option still has a picture and a connection line");
  const calls = (await s("GET", "/api/diagnostics")).body.calls;
  // One rank (-in; kin has one entity, the picked cards are kept) and a describe per pick whose ID the server did not already know (the entity map is shared by every learner).
  const n = calls.find((c) => c.provider === "qloo-mock").n;
  assert.ok(n >= 1 && n <= 3, `calls: ${n}`);
  assert.ok((await s("GET", "/api/health")).body.taste.entities >= 4, "IDs learned from the describes and the rank answer");

  // The kin card (one entity) is counted on the report as a card rank had nothing to compare.
  const rep = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  assert.ok(rep.levels.find((l) => l.level === 1).unrankable_cards >= 1);
  assert.match(await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text(), /\b1-type\b/);
  // A pick from a ranked card is a hook from taste; the progress card says so.
  cues = await pick("in", "Penguin");
  const inCue = cues.find((c) => c.role === "in");
  assert.equal(inCue.hook_source, "taste"); assert.equal(inCue.shown_rank, 0);
  assert.equal(inCue.qloo_entity_id, "mock-penguin-books", "resolved from the rank answer, no describe needed");
  const hooks = (await s("GET", "/api/progress/cholecystokinin")).body.hooks;
  assert.equal(hooks.line, "1 of your 3 hooks came from your taste.");
  assert.deepEqual(hooks.term, { total: 3, taste: 1, editorial: 2, own: 0, agent: 0 });
  assert.equal(hooks.signals, 3);
  // An off-list favorite is the learner's own.
  const own = (await s("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "kin", label: "Ky Jelly", connection: "my own", source: "pick", recognized: true })).body;
  assert.equal(own.find((c) => c.role === "kin").hook_source, "own");
  assert.equal((await s("GET", "/api/progress/cholecystokinin")).body.hooks.term.own, 1);
  // Export carries what the stickiness link needs later: the cue's source and rank, and the cards as offered.
  const exp = (await s("GET", "/api/export")).body;
  assert.ok(exp.learner_cues.every((c) => "hook_source" in c && "shown_rank" in c));
  assert.equal(exp.pick_offers.length, 4);
});

test("13 + 24: hints block independence; retried submissions settle once", async () => {
  const s = session();
  await s("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  await s("POST", "/api/practice/hint", { prompt_id: "brier-mean" });
  const a = { prompt_id: "brier-mean", response: "0.065", idempotency_key: "retry-key-0001" };
  const [r1, r2] = await Promise.all([s("POST", "/api/attempts", a), s("POST", "/api/attempts", a)]);
  const fresh = [r1.body, r2.body].filter((r) => !r.duplicate);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].independent, false);
  const prog = (await s("GET", "/api/progress/brier-score")).body.skills.operation;
  assert.equal(prog.attempts, 1);
  assert.equal(prog.independent, 0);
});

test("26: one learner cannot see another's records", async () => {
  const a = session(), b = session();
  await a("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  await a("POST", "/api/learner/cues", { term_id: "brier-score", role: "sound", label: "Breyers", connection: "c", recognized: true });
  await a("POST", "/api/attempts", { prompt_id: "brier-loss-rain", response: "0.04", idempotency_key: "learner-a-0001" });
  await b("GET", "/api/terms");
  assert.equal((await b("GET", "/api/learner/cues/brier-score")).body.length, 0);
  assert.equal((await b("GET", "/api/export")).body.attempts.length, 0);
  assert.equal((await a("GET", "/api/export")).body.attempts.length, 1);
});

test("27: export and deletion", async () => {
  const s = session();
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { response: "koh-lee-sis-toe-kye-nin" });
  assert.equal((await s("GET", "/api/export")).body.first_attempts.length, 1);
  await s("DELETE", "/api/learner");
  assert.equal((await s("GET", "/api/export")).body.first_attempts.length, 0);
});

test("personal data is blocked before any Qloo call", async () => {
  const s = session();
  await s("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  assert.equal((await s("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["me@example.com"] })).status, 400);
  assert.equal((await s("POST", "/api/cues/resolve", { entity: "415-555-1234" })).body.envelope.error.code, "PERSONAL_DATA_BLOCKED");
});

test("gloo it: a misspelled known term opens the reviewed lesson", async () => {
  const s = session();
  const { body } = await s("POST", "/api/glue", { text: "Gloo it cholecystokinen", mode: "typed" });
  assert.equal(body.term_id, "cholecystokinin");
  assert.equal(body.created, false);
  assert.equal(body.resolution.method, "spelling");
});

test("gloo it: a new word gets a provisional lesson owned by this learner", async () => {
  const s = session(), other = session();
  const { body } = await s("POST", "/api/glue", { text: "peristalsis", mode: "typed" });
  assert.match(body.term_id, /^p-[a-f0-9]{10}$/);
  assert.equal(body.created, true);
  assert.equal((await s("GET", `/api/terms/${body.term_id}`)).body.locked, true); // first attempt still first
  await s("POST", `/api/terms/${body.term_id}/first-attempt`, { skipped: true });
  const term = (await s("GET", `/api/terms/${body.term_id}`)).body;
  assert.equal(term.provisional, true);
  assert.equal(term.review.status, "provisional");
  assert.equal(term.sources.length, 0); // non-http source dropped
  assert.ok(!JSON.stringify(term).includes("Moves food along"));
  const r = (await s("POST", "/api/attempts", { prompt_id: `${body.term_id}-q2`, response: "it pushes food through the gut", idempotency_key: "prov-attempt-1" })).body;
  assert.equal(r.outcome, "correct");
  assert.equal(r.provisional, true);
  assert.equal((await other("GET", `/api/terms/${body.term_id}`)).status, 404);
  assert.equal((await s("POST", "/api/glue", { text: "peristalsis", mode: "typed" })).body.created, false);
});

test("gloo it: a spoken capture is saved as the first attempt", async () => {
  const s = session();
  const { body } = await s("POST", "/api/glue", { text: "colla sisto kinin", mode: "voice" });
  assert.equal(body.term_id, "cholecystokinin");
  assert.equal(body.resolution.method, "sound-alike");
  const t = (await s("GET", "/api/terms/cholecystokinin")).body;
  assert.equal(t.locked, false);
  assert.match(t.first_attempt_record.response, /colla sisto kinin/);
});

test("gloo it: a camera crop is read and resolved to the reviewed lesson", async () => {
  const s = session();
  const { status, body } = await s("POST", "/api/glue", { mode: "camera", image: "x".repeat(200), mime: "image/jpeg" });
  assert.equal(status, 200);
  assert.equal(body.term_id, "cholecystokinin");
  assert.equal(body.resolution.mode, "camera");
  assert.match(body.resolution.method, /^camera/);
  assert.equal((await s("GET", "/api/terms/cholecystokinin")).body.locked, true); // a photo is not a first attempt
});

test("gloo it: the wake phrase alone over a framed word reads the frame; with a word it uses the word", async () => {
  const s = session();
  const a = (await s("POST", "/api/glue", { mode: "voice", text: "gloo it", image: "x".repeat(200) })).body;
  assert.equal(a.term_id, "cholecystokinin");
  assert.equal(a.resolution.mode, "camera");
  const b = (await s("POST", "/api/glue", { mode: "voice", text: "Gloo it, brier score", image: "x".repeat(200) })).body;
  assert.equal(b.term_id, "brier-score");
  assert.equal(b.resolution.mode, "voice");
  assert.equal((await s("POST", "/api/glue", { mode: "voice", text: "glue it" })).status, 422);
});

test("health reports capture capabilities and the gate state", async () => {
  const s = session();
  const h = (await s("GET", "/api/health")).body;
  assert.equal(h.gated, false);
  assert.equal(h.unlocked, true);
  assert.equal(h.stt, "mock");
  assert.equal(h.tts, "google");
  assert.equal(h.media, "local");
  assert.equal((await s("POST", "/api/unlock", { code: "anything" })).body.unlocked, true);
});

test("gloo it: close calls go to the LLM backup", async () => {
  const s = session();
  const { body } = await s("POST", "/api/glue", { text: "breyer", mode: "voice" });
  assert.equal(body.resolution.decision, "ambiguous");
  assert.equal(body.resolution.method, "ai");
  assert.equal(body.resolution.word, "breyers");
});

const raw = async (path, body, cookie = "") => fetch(`http://localhost:${PORT}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie && { cookie }) }, body: JSON.stringify(body) });

test("say: the server speaks the pieces from IPA, once; hits are free of the limit; verify pins the clip", async () => {
  const before = ttsCalls;
  const first = await raw("/api/say", { text: "chole means bile.", term_id: "cholecystokinin" });
  const cookie = first.headers.get("set-cookie").split(";")[0];
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "audio/mpeg");
  assert.equal(first.headers.get("x-gloo-cache"), "miss");
  const said = Buffer.from(await first.arrayBuffer()).toString();
  assert.ok(said.startsWith("MP3|en-US-"));
  assert.ok(said.includes('<mark name="m0"/><phoneme alphabet="ipa" ph="ˈkoʊ">cho</phoneme><mark name="m1"/><phoneme alphabet="ipa" ph="lə">le</phoneme>'), said);
  const marks = (res) => JSON.parse(Buffer.from(res.headers.get("x-gloo-marks"), "base64").toString("utf8"));
  assert.deepEqual(marks(first), [{ index: 0, piece: "chole", syllable: "ˈkoʊ", time: 0 }, { index: 1, piece: "chole", syllable: "lə", time: 0.25 }]);
  const again = await raw("/api/say", { text: "chole means bile.", term_id: "cholecystokinin" }, cookie);
  assert.equal(again.headers.get("x-gloo-cache"), "hit");
  assert.deepEqual(marks(again), marks(first), "a hit carries the same marks");
  assert.equal(ttsCalls, before + 1);
  const timing = await fetch(`http://localhost:${PORT}/api/say/timing?text=${encodeURIComponent("chole means bile.")}&term_id=cholecystokinin`, { headers: { cookie } });
  assert.equal(timing.status, 200);
  assert.deepEqual((await timing.json()).marks, marks(first));
  assert.equal((await fetch(`http://localhost:${PORT}/api/say/timing?text=never&term_id=cholecystokinin`, { headers: { cookie } })).status, 404);
  // Limit is 2 synths per session per hour in this harness: a third new line is refused, old lines still play.
  assert.equal((await raw("/api/say", { text: "second line", term_id: "cholecystokinin" }, cookie)).status, 200);
  assert.equal((await raw("/api/say", { text: "third line", term_id: "cholecystokinin" }, cookie)).status, 429);
  assert.equal((await raw("/api/say", { text: "chole means bile.", term_id: "cholecystokinin" }, cookie)).status, 200);
  assert.equal(ttsCalls, before + 2);
  const v = await raw("/api/say/verify", { text: "chole means bile.", term_id: "cholecystokinin", verified: true }, cookie);
  assert.equal(v.status, 200);
  assert.equal((await v.json()).verified, true);
  assert.equal((await raw("/api/say", { text: "chole means bile.", term_id: "cholecystokinin" }, cookie)).headers.get("x-gloo-cache"), "verified");
  assert.equal((await raw("/api/say/verify", { text: "never played", term_id: "cholecystokinin", verified: true }, cookie)).status, 404);
  assert.equal((await raw("/api/say", { text: "", term_id: "cholecystokinin" }, cookie)).status, 400);
  assert.equal((await raw("/api/say", { text: "x", term_id: "no-such-term" }, cookie)).status, 404);
});

// ---- The words sheet ----
test("the words sheet lists reviewed lessons, this learner's recent words, and the words looked up most", async () => {
  const s = session();
  const empty = (await s("GET", "/api/words")).body;
  assert.ok(empty.reviewed.some((w) => w.id === "cholecystokinin") && empty.reviewed.some((w) => w.id === "brier-score"));
  assert.deepEqual(empty.recent, []);
  await s("POST", "/api/glue", { mode: "typed", text: "cholecystokinin" });
  const after = (await s("GET", "/api/words")).body;
  assert.deepEqual(after.recent.map((w) => w.id), ["cholecystokinin"]);
  const pop = after.popular.find((w) => w.id === "cholecystokinin");
  assert.ok(pop && pop.count >= 1 && pop.title.startsWith("Cholecystokinin"));
  await s("DELETE", "/api/learner");
});

// ---- Gate beacons and the testers report ----
test("a gate beacon is stored per session, and the owner's report shows where each session stopped", async () => {
  const s = session();
  assert.equal((await s("POST", "/api/beacon", { event: "gate", state: "denied", source: "camera", error: "NotAllowedError", in_app: "LinkedIn", platform: "ios" })).body.ok, true);
  assert.equal((await s("POST", "/api/beacon", { event: "bad event!" })).status, 400);
  const t = session();
  await t("POST", "/api/beacon", { event: "gate", state: "live", source: "screen", platform: "desktop" });
  await t("POST", "/api/beacon", { event: "mic", state: "blocked", error: "NotAllowedError", platform: "desktop" });
  await t("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  await t("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "chole", label: "Pepsi-Cola", connection: "Pepsi ≈ chole.", source: "pick", recognized: true });
  const open = await fetch(`http://localhost:${PORT}/api/admin/testers`);
  assert.equal(open.status, 401, "the report is the owner's");
  const r = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  assert.ok(r.sessions >= 2);
  const denied = r.rows.find((x) => x.gate?.error === "NotAllowedError");
  assert.equal(denied.stage, "visited"); assert.equal(denied.gate.in_app, "LinkedIn"); assert.equal(denied.gate.platform, "ios");
  const picked = r.rows.find((x) => x.gate?.source === "screen" && x.picks === 1);
  assert.equal(picked.stage, "pick"); assert.deepEqual(picked.lessons, ["cholecystokinin"]);
  assert.deepEqual(picked.mic, { state: "blocked", error: "NotAllowedError" }, "the microphone's own outcome, apart from the gate");
  assert.ok(r.funnel.visited >= r.funnel.gate && r.funnel.gate >= r.funnel.pick && r.funnel.pick >= 1);
  const text = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
  assert.match(text, /funnel: visited \d+ > gate \d+ > read \d+ > lesson \d+ > pick \d+/);
  assert.match(text, /NotAllowedError/);
  await s("DELETE", "/api/learner"); await t("DELETE", "/api/learner");
});

// ---- Owner API: the lesson store behind ADMIN_TOKEN ----
const owner = (token = "test-owner-token") => async (method, path, body, extra = {}) => {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method, headers: { ...(token && { "x-gloo-admin": token }), ...extra, ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// ---- Degrees of Qloo ----
test("degrees: a session draws a level, ?qloo=N forces and sticks, level 0 suppresses ranking, and the report splits by level", async () => {
  const s = session();
  const drawn = (await s("GET", "/api/level")).body;
  assert.ok([0, 1, 2, 3].includes(drawn.level)); assert.equal(drawn.forced, false); assert.equal(drawn.degrees[drawn.level], drawn.degree);
  assert.equal((await s("GET", "/api/level")).body.level, drawn.level);
  // The switch rides on any request of the session, the page's own URL (/?qloo=0) included; here the API's.
  const forced = (await s("GET", "/api/level?qloo=0")).body;
  assert.deepEqual([forced.level, forced.forced, forced.degree], [0, true, "editorial"]);
  assert.equal((await s("GET", "/api/level?qloo=9")).body.level, 0, "a bad value changes nothing");
  assert.equal((await s("GET", "/api/level")).body.level, 0, "sticky");
  // At level 0 the cards are editorial for the reason 'level 0', and a pick resolves no entity (no describe).
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  const term = (await s("GET", "/api/terms/cholecystokinin")).body;
  assert.ok(term.roles.filter((r) => r.pick).every((r) => r.pick.tailoring.reason === "level 0"));
  const o = term.roles.find((r) => r.id === "chole").pick.options[0];
  const cues = (await s("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "chole", label: o.name, connection: o.connection, source: "pick", recognized: true, qloo_entity_type: o.qloo?.type })).body;
  assert.equal(cues[0].hook_source, "editorial"); assert.equal(cues[0].shown_rank, 0);
  assert.equal((await s("GET", "/api/diagnostics")).body.calls.filter((c) => c.provider.startsWith("qloo")).length, 0);
  // Another session forced to 1 sees the ranking reasons production gives.
  const s1 = session();
  assert.equal((await s1("GET", "/api/level?qloo=1")).body.level, 1);
  await s1("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  assert.equal((await s1("GET", "/api/terms/cholecystokinin")).body.roles.find((r) => r.id === "chole").pick.tailoring.reason, "fewer than two picks");
  // The report: per level, sessions, cards, first-tile picks, pictures, skips, practice, calls, latency; text too.
  assert.equal((await fetch(`http://localhost:${PORT}/api/admin/degrees`)).status, 401);
  const r = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  assert.equal(r.levels.length, 4);
  const zero = r.levels.find((l) => l.level === 0);
  assert.ok(zero.sessions >= 1); assert.ok(zero.forced >= 1); assert.ok(zero.cards >= 4); assert.ok(zero.picks >= 1); assert.ok(zero.first_tile_picks >= 1);
  assert.ok(zero.skipped_cards >= 3); assert.equal(zero.qloo_calls, 0); assert.equal(typeof zero.median_build_ms, "number"); assert.equal(typeof zero.median_pick_ms, "number");
  assert.ok(zero.rates.first_tile > 0 && zero.rates.skip > 0); assert.ok(zero.tiles >= zero.cards * 2 && zero.tiles <= zero.cards * 4);
  assert.deepEqual(Object.keys(zero.rates), ["first_tile", "picture", "skip", "practice_correct", "independent", "recall_sessions", "taste_picks", "read_ok", "draft_ok", "draft_accepted", "draft_accepted_briefed", "draft_accepted_plain"]);
  const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
  assert.match(text, /^sessions since /); assert.match(text, /\n0 +editorial /); assert.match(text, /\n3 +agent doorway /);
  // The testers report carries the level of each session.
  const t = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  assert.ok(t.rows.some((row) => row.level === 0 && row.level_forced === true));
  const tt = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
  assert.match(tt, /\blvl\b/); assert.match(tt, / 0! /);
});

test("degree 2: a new word's pick cards are built from Qloo: more candidates asked, the known and popular kept first, each with its Qloo record", async () => {
  const s = session();
  assert.equal((await s("GET", "/api/level?qloo=2")).body.level, 2);
  const { body } = await s("POST", "/api/glue", { text: "peristalsis", mode: "typed" });
  assert.equal(body.created, true);
  await s("POST", `/api/terms/${body.term_id}/first-attempt`, { skipped: true });
  const term = (await s("GET", `/api/terms/${body.term_id}`)).body;
  assert.deepEqual(term.cards, { source: "qloo", describes: 9, skipped: 0, unasked: 0, cap: 40, floor: 0.3 });
  const role = term.roles.find((r) => r.id === "peri");
  assert.equal(role.pick.built.source, "qloo"); assert.equal(role.pick.built.candidates, 9);
  const kept = role.pick.options.filter((o) => o.qloo?.entity_id);
  assert.ok(kept.length >= 4 && kept.length <= 8, `${kept.length} resolved`);
  assert.ok(role.pick.options.length <= 8 && role.pick.options.length >= 4);
  assert.ok(kept.every((o) => o.qloo.entity_id.startsWith("mock-") && o.qloo.popularity >= 0.3 && o.qloo.type && o.wiki));
  // Names that pair up by type lead (the brands here), most popular first within the group; the lone artist, film and show follow.
  const brands = kept.filter((o) => o.qloo.type === "brand");
  assert.ok(brands.length >= 2 && kept.slice(0, brands.length).every((o) => o.qloo.type === "brand"), "the pair group leads the card");
  for (let i = 1; i < brands.length; i++) assert.ok(brands[i - 1].qloo.popularity >= brands[i].qloo.popularity, "most popular first within the group");
  assert.deepEqual(role.pick.built.rankable, ["brand"]);
  assert.ok(!role.pick.options.some((o) => o.name === "Obscure Peri Band" && o.qloo?.entity_id), "a name Qloo doesn't know carries no ID");
  assert.equal(role.pick.options[0].image, null, "the mock graph has no pictures: wiki art is the fallback");
  const other = term.roles.find((r) => r.id === "stalsis");
  assert.equal(other.pick, undefined);
  // Every describe went through the metered, cached runner: nine misses, no more on a second look at the word.
  const calls = (await s("GET", "/api/diagnostics")).body.calls.filter((c) => c.provider === "qloo-mock");
  assert.deepEqual(calls, [{ provider: "qloo-mock", status: "empty", n: 1 }, { provider: "qloo-mock", status: "ok", n: 8 }]);
  await s("GET", `/api/terms/${body.term_id}`);
  assert.equal((await s("GET", "/api/diagnostics")).body.calls.filter((c) => c.provider === "qloo-mock").reduce((n, c) => n + c.n, 0), 9);
  // A degree-1 session drafting the same word gets the drafter's four options as they came and no describe.
  const s1 = session();
  assert.equal((await s1("GET", "/api/level?qloo=1")).body.level, 1);
  const one = (await s1("POST", "/api/glue", { text: "peristalsis", mode: "typed" })).body;
  await s1("POST", `/api/terms/${one.term_id}/first-attempt`, { skipped: true });
  const t1 = (await s1("GET", `/api/terms/${one.term_id}`)).body;
  assert.equal(t1.cards, undefined);
  const p1 = t1.roles.find((r) => r.id === "peri").pick;
  assert.equal(p1.options.length, 4); assert.equal(p1.built, undefined); assert.ok(p1.options.every((o) => !o.qloo?.entity_id));
  assert.equal((await s1("GET", "/api/diagnostics")).body.calls.filter((c) => c.provider === "qloo-mock").length, 0);
});

test("a wide draft cut at the cap never ships without cards: the row says so, the word is drafted again at four options, and the report counts it", async () => {
  draftStyle = "cut";
  try {
    const s = session();
    assert.equal((await s("GET", "/api/level?qloo=2")).body.level, 2);
    const { status, body } = await s("POST", "/api/glue", { text: "peristalsis", mode: "typed" });
    assert.equal(status, 200, JSON.stringify(body)); assert.equal(body.created, true);
    await s("POST", `/api/terms/${body.term_id}/first-attempt`, { skipped: true });
    const term = (await s("GET", `/api/terms/${body.term_id}`)).body;
    const peri = term.roles.find((r) => r.id === "peri");
    assert.ok(peri.pick.options.length >= 3, "the lesson has its card");
    assert.deepEqual(term.draft, { candidates: 4, asked: 12, fallback: "cards" });
    assert.equal(term.cards.source, "qloo", "the four names still go through Qloo at degree 2");
    // Two draft rows: the cut one marked, the retry marked as the fallback; the report counts the cut draft once.
    const rows = (await s("GET", "/api/export")).body.provider_calls.filter((c) => c.op === "draft_lesson");
    assert.deepEqual(rows.map((c) => [c.status, c.stop, c.note, c.tokens_out]), [["ok", "max_tokens", "cut,no_cards", 6000], ["ok", "tool_use", "cards_fallback", 10]]);
    const r = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
    const two = r.cells.find((c) => c.level === 2 && c.arm === "anthropic");
    assert.ok(two.no_cards >= 1 && two.model_cut >= 1, JSON.stringify([two.no_cards, two.model_cut]));
    assert.equal(two.drafted_briefed + two.drafted_plain, two.drafted_words, "the cut row is left out of the brief pairing");
    const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
    assert.match(text, /cut\/text\/no-cards/);
  } finally { draftStyle = "ok"; }
});

test("degree 3: the doorway fills familiar from the learner's picks, focuses the card's piece, and a proposed card picked becomes an agent hook with its verified ID", async () => {
  const s = session();
  await s("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  assert.equal((await s("GET", "/api/level?qloo=3")).body.level, 3);
  // Nothing picked yet: a sentence, no model call.
  const none = await s("POST", "/api/cues/agent", { term_id: "brier-score", role: "sound" });
  assert.equal(none.status, 400); assert.equal(none.body.status, "unavailable"); assert.match(none.body.reason, /Pick a favorite/);
  // Two picks on another lesson are what the learner knows.
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  const cck = (await s("GET", "/api/terms/cholecystokinin")).body;
  for (const [roleId, name] of [["chole", "Pepsi-Cola"], ["cysto", "Twisted Sister"]]) {
    const o = cck.roles.find((r) => r.id === roleId).pick.options.find((x) => x.name === name);
    await s("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: roleId, label: o.name, connection: o.connection, source: "pick", recognized: true, qloo_entity_type: o.qloo?.type });
  }
  const { status, body } = await s("POST", "/api/cues/agent", { term_id: "brier-score", role: "sound" });
  assert.equal(status, 200); assert.equal(body.status, "ok");
  assert.deepEqual(body.familiar, ["Twisted Sister", "Pepsi"], "the packet's entity names, newest first");
  assert.equal(body.cues[0].label, "Breyers"); assert.equal(body.cues[0].qloo_entity_id, "mock-breyers");
  assert.ok(body.calls.length >= 1);
  // Picking the proposed card: the server keeps the ID it verified, whatever the browser sends, and counts an agent hook.
  const list = (await s("POST", "/api/learner/cues", { term_id: "brier-score", role: "sound", label: "breyers", connection: body.cues[0].connection, source: "pick", recognized: true, via: "agent", qloo_entity_id: "forged", qloo_entity_type: "book" })).body;
  assert.equal(list[0].hook_source, "agent"); assert.equal(list[0].qloo_entity_id, "mock-breyers"); assert.equal(list[0].qloo_type, "brand"); assert.equal(list[0].shown_rank, null);
  const progress = (await s("GET", "/api/progress/brier-score")).body;
  assert.equal(progress.hooks.term.agent, 1);
  const r = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  const three = r.levels.find((l) => l.level === 3);
  assert.ok(three.agent_calls >= 1 && three.agent_picks >= 1);
  // A session at degree 1 cannot open the doorway even with names.
  const s1 = session();
  await s1("GET", "/api/level?qloo=1");
  await s1("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  const shut = await s1("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["Breyers"] });
  assert.equal(shut.status, 403); assert.equal(shut.body.status, "unavailable"); assert.match(shut.body.reason, /degree 3/);
});

test("learner graph: words, picks, hooks and outcomes become nodes in order; the owner reads the graph with its embedding; export and delete carry it", async () => {
  const s = session();
  await s("GET", "/api/level?qloo=1");
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { response: "koh lee sis toe KY nin" });
  const cck = (await s("GET", "/api/terms/cholecystokinin")).body;
  const o = cck.roles.find((r) => r.id === "chole").pick.options.find((x) => x.name === "Pepsi-Cola");
  await s("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "chole", label: o.name, connection: o.connection, source: "pick", recognized: true, qloo_entity_type: o.qloo?.type });
  await s("POST", "/api/attempts", { prompt_id: "cck-chole", response: "bile", idempotency_key: "graph-attempt-1" });
  const nodes = (await s("GET", "/api/export")).body.learner_nodes;
  const sid = nodes[0]?.sid;
  assert.match(sid ?? "", /^[a-f0-9]{32}$/, "the export carries the nodes with their sid");
  assert.deepEqual(nodes.map((n) => n.kind), ["word", "pick", "hook", "outcome"]);
  assert.equal(nodes[1].key, "mock-pepsi"); assert.equal(JSON.parse(nodes[2].data).sound_like, "cola");
  assert.equal((await fetch(`http://localhost:${PORT}/api/admin/learners/${sid}/graph`)).status, 401);
  assert.equal((await fetch(`http://localhost:${PORT}/api/admin/learners/${"0".repeat(32)}/graph`, { headers: { "x-gloo-admin": "test-owner-token" } })).status, 404);
  const g = await (await fetch(`http://localhost:${PORT}/api/admin/learners/${sid}/graph`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  assert.equal(g.nodes.length, 4); assert.equal(g.nodes[0].kind, "word"); assert.equal(g.nodes[0].key, "cholecystokinin");
  assert.equal(g.entities, 1); assert.equal(g.learner.qloo_level, 1);
  assert.equal(g.embedding.nodes, 4); assert.ok(g.embedding.vector["urn:gloo:word:cholecystokinin"] > 0);
  assert.deepEqual(g.trajectory.map((t) => t.drift), [0]);
  assert.equal(g.calls.calls, 1, "one entity_tags call, through the owner's own runner");
  // Deleting the learner's data removes the graph too.
  await s("DELETE", "/api/learner");
  assert.equal((await s("GET", "/api/export")).body.learner_nodes.length, 0);
});

test("model arm: ?model=muse sends the camera read, the drafter, the hearing fix and the agent to the Muse backend (chat completions), logs model and tokens per call, and the report splits by arm", async () => {
  const s = session();
  const l = (await s("GET", "/api/level?model=muse")).body;
  assert.deepEqual(l.model, { arm: "muse", forced: true, arms: ["anthropic", "muse"], available: { anthropic: true, muse: true } });
  assert.equal((await s("GET", "/api/level?model=openai")).body.model.arm, "muse", "a bad value changes nothing");
  assert.equal((await s("GET", "/api/level")).body.model.arm, "muse", "sticky");
  // Camera read: the crop goes to the Muse backend as a data URL (multimodal), the row names the model and the tokens.
  const read = (await s("POST", "/api/glue", { mode: "camera", image: "x".repeat(200), mime: "image/jpeg" })).body;
  assert.equal(read.term_id, "cholecystokinin");
  // A new word: the hearing fix (resolve_term) and the draft go to Meta too.
  const drafted = (await s("POST", "/api/glue", { text: "zzqxv", mode: "typed" })).body;
  assert.equal(drafted.created, true);
  // The agent: tool calling through the same protocol, every step logged on the arm.
  await s("GET", "/api/level?qloo=3");
  await s("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  const agent = (await s("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["Breyers"] })).body;
  assert.equal(agent.status, "ok"); assert.equal(agent.provider, "muse"); assert.equal(agent.model, "muse-spark-1.3"); assert.equal(agent.fallback_from, null);
  assert.equal(agent.cues[0].qloo_entity_id, "mock-breyers");
  const rows = (await s("GET", "/api/export")).body.provider_calls.filter((c) => ["anthropic", "muse"].includes(c.provider));
  assert.ok(rows.length >= 5, `${rows.length} model rows`);
  assert.ok(rows.every((c) => c.provider === "muse" && c.model === "muse-spark-1.3" && c.fallback_from === null), JSON.stringify(rows.map((c) => [c.provider, c.op, c.model])));
  assert.deepEqual(rows.map((c) => c.op).sort(), ["cue_agent", "cue_agent_step", "cue_agent_step", "draft_lesson", "read_word", "resolve_term"]);
  const readRow = rows.find((c) => c.op === "read_word");
  assert.equal(readRow.status, "ok"); assert.equal(readRow.tokens_in, 7); assert.equal(readRow.tokens_out, 3); assert.ok(readRow.duration_ms > 0);
  assert.equal(rows.find((c) => c.op === "cue_agent").tokens_in, 14, "the run's row sums its steps");
  // The other arm, on the same tasks, lands on the Anthropic fake.
  const a = session();
  assert.equal((await a("GET", "/api/level?model=anthropic")).body.model.arm, "anthropic");
  await a("POST", "/api/glue", { mode: "camera", image: "x".repeat(200), mime: "image/jpeg" });
  const arows = (await a("GET", "/api/export")).body.provider_calls.filter((c) => c.op === "read_word");
  assert.deepEqual(arows.map((c) => [c.provider, c.model, c.tokens_in]), [["anthropic", "claude-sonnet-5-5", 10]]);
  // The report: a models section and level-by-arm cells, plus the testers report counting Meta reads as reads.
  const r = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  const muse = r.models.find((m) => m.arm === "muse"), anth = r.models.find((m) => m.arm === "anthropic");
  assert.ok(muse.sessions >= 1 && muse.forced >= 1 && muse.reads_ok >= 1 && muse.drafts_ok >= 1 && muse.agent_calls >= 1);
  assert.ok(muse.tokens_in >= 7 && muse.tokens_out >= 3 && muse.model_calls >= 4 && muse.fallbacks === 0);
  assert.equal(typeof muse.median_ms.read_word, "number"); assert.equal(muse.rates.read_ok, 1);
  assert.ok(anth.sessions >= 1 && anth.reads_ok >= 1);
  assert.ok(r.cells.some((c) => c.level === 3 && c.arm === "muse" && c.sessions >= 1));
  const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
  assert.match(text, /by model arm\n/); assert.match(text, /\nmuse +\d/); assert.match(text, /by degree and arm/);
  const t = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  assert.ok(t.rows.some((row) => row.reads.ok >= 1 && row.level === 3));
  const h = (await s("GET", "/api/health")).body;
  assert.deepEqual(h.agent.available, { anthropic: true, muse: true }); assert.equal(h.agent.models.muse, "muse-spark-1.3");
});

test("muse quirks: a tool call written as JSON text still drafts the lesson (the row notes it); an answer cut at the cap fails cleanly with the cut on its row and in the report", async () => {
  try {
    // The first live Muse draft: the model answered, the drafter saw no tool call. Written as text, the call is read out of the text.
    museStyle = "text";
    const s = session();
    assert.equal((await s("GET", "/api/level?model=muse")).body.model.arm, "muse");
    const drafted = (await s("POST", "/api/glue", { text: "zzqxv", mode: "typed" })).body;
    assert.equal(drafted.created, true, JSON.stringify(drafted));
    await s("POST", `/api/terms/${drafted.term_id}/first-attempt`, { skipped: true });
    const term = (await s("GET", `/api/terms/${drafted.term_id}`)).body;
    assert.equal(term.title, "Peristalsis"); assert.ok(term.roles.length >= 2, "the lesson came through the text");
    const rows = (await s("GET", "/api/export")).body.provider_calls.filter((c) => c.provider === "muse");
    assert.deepEqual(rows.map((c) => [c.op, c.status, c.stop, c.note]).sort(), [["draft_lesson", "ok", "end_turn", "tool_from_text"], ["resolve_term", "ok", "end_turn", "tool_from_text"]]);
    // Cut at the cap mid-thought (what happened live): no lesson, the credit back, and the row says the answer was cut with no tool.
    museStyle = "cut";
    const c = session();
    await c("GET", "/api/level?model=muse");
    const cut = await c("POST", "/api/glue", { text: "zzqxv", mode: "typed" });
    assert.equal(cut.status, 502); assert.match(cut.body.error, /Couldn't draft a lesson/);
    const crow = (await c("GET", "/api/export")).body.provider_calls.find((x) => x.op === "draft_lesson");
    assert.deepEqual([crow.provider, crow.status, crow.stop, crow.note, crow.tokens_out], ["muse", "ok", "max_tokens", "no_tool", 3]);
    const r = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
    const muse = r.models.find((m) => m.arm === "muse");
    assert.ok(muse.model_cut >= 2 && muse.text_tools >= 2, JSON.stringify([muse.model_cut, muse.text_tools]));
    const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
    assert.match(text, /cut\/text/);
  } finally { museStyle = "tool"; }
});

test("learner brief: built after a word, a pick and an answer; the drafter and the level 3 agent read it; the rows record its size; the report splits acceptance; nothing typed reaches it", async () => {
  const s = session();
  await s("GET", "/api/level?qloo=3");
  // A fresh session's first draft carries no brief.
  const first = (await s("POST", "/api/glue", { text: "zzqxv", mode: "typed" })).body;
  assert.equal(first.created, true);
  assert.doesNotMatch(lastDraft.user, /The learner so far/); assert.doesNotMatch(lastDraft.system, /domains they like/);
  const sid = (await s("GET", "/api/export")).body.provider_calls[0].sid;
  assert.match(sid, /^[a-f0-9]{32}$/);
  const brief = async () => (await (await fetch(`http://localhost:${PORT}/api/admin/learners/${sid}/brief`, { headers: { "x-gloo-admin": "test-owner-token" } })).json()).brief;
  assert.equal(await brief(), null, "no node yet, no brief");
  // A reviewed word with a pick and an answer: the brief says what happened, in public names only.
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { response: "my spoken try xyzzy" });
  assert.match((await brief()).text, /^Met 1 word: Cholecystokinin \(CCK\) \(started\)\.$/);
  const cck = (await s("GET", "/api/terms/cholecystokinin")).body;
  const o = cck.roles.find((r) => r.id === "chole").pick.options.find((x) => x.name === "Pepsi-Cola");
  await s("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "chole", label: o.name, connection: o.connection, source: "pick", recognized: true, qloo_entity_type: o.qloo?.type });
  assert.match((await brief()).text, /Hooks: untested: chole→Pepsi-Cola\./);
  await s("POST", "/api/attempts", { prompt_id: "cck-chole", response: "bile plugh", idempotency_key: "brief-attempt-1" });
  const b = await brief(); // the taste line depends on whether an earlier test tagged Pepsi in this server's cache
  assert.match(b.text, /Met 1 word: Cholecystokinin \(CCK\) \(practiced, 1 of 1 right, recalled unaided\)\. Hooks: sound hook stuck: chole→Pepsi-Cola\. (?:Likes: [^.]+ \(brand\)|Picks so far: Pepsi-Cola \(brand\); taste tags not computed yet)\. Last answers: Cholecystokinin \(CCK\): meaning correct unaided at the now review\./);
  assert.ok(!b.text.includes("xyzzy") && !b.text.includes("plugh") && !JSON.stringify(b.facts).includes("plugh"), "nothing typed or said");
  assert.ok(b.chars <= 700 && b.nodes === 4);
  // The next draft is told about the learner; its row records how much.
  const second = (await s("POST", "/api/glue", { text: "peristalsis", mode: "typed" })).body;
  assert.equal(second.created, true);
  assert.match(lastDraft.user, /\nThe learner so far: Met 1 word: Cholecystokinin \(CCK\) \(practiced/); assert.match(lastDraft.system, /draw the pick names for each role from those domains first/);
  const drafts = (await s("GET", "/api/export")).body.provider_calls.filter((c) => c.op === "draft_lesson");
  assert.deepEqual(drafts.map((c) => c.brief), [0, b.chars]);
  // The agent at degree 3 reads it beside the familiar list; every step's row and the run's row carry it.
  await s("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  const agent = (await s("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["Breyers"] })).body;
  assert.equal(agent.status, "ok");
  assert.match(lastAgent.user, /^Things I already know and like: "Breyers"\.\nAbout me so far: Met 2 words: Brier score \(first attempt skipped\); Cholecystokinin \(CCK\) \(practiced/);
  assert.match(lastAgent.system, /5\. When the learner's note \("About me so far"\) names domains they like/);
  const rows = (await s("GET", "/api/export")).body.provider_calls.filter((c) => c.op.startsWith("cue_agent"));
  assert.ok(rows.length >= 3 && rows.every((c) => c.brief > 0 && c.note === null), JSON.stringify(rows.map((c) => [c.op, c.brief, c.note])));
  // The report: one draft with a brief, one without, acceptance split; the text has the column; export carries the brief row.
  const r = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  const cell = r.cells.find((c) => c.level === 3 && c.arm === "anthropic");
  assert.ok(cell.drafted_briefed >= 1 && cell.drafted_plain >= 1, JSON.stringify([cell.drafted_briefed, cell.drafted_plain]));
  assert.ok("draft_accepted_briefed" in cell.rates && "draft_accepted_plain" in cell.rates);
  assert.equal(r.restored_from, null);
  const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, { headers: { "x-gloo-admin": "test-owner-token" } })).text();
  assert.match(text, /briefed: acc b\/p/); assert.doesNotMatch(text, /^restored from/);
  const ex = (await s("GET", "/api/export")).body;
  assert.equal(ex.learner_briefs.length, 1); assert.equal(ex.learner_briefs[0].text, (await brief()).text);
  const g = await (await fetch(`http://localhost:${PORT}/api/admin/learners/${sid}/graph`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
  assert.equal(g.brief.text, (await brief()).text, "the graph view carries the brief");
  const h = (await s("GET", "/api/health")).body;
  assert.deepEqual(h.memory, { snapshots: "off", every_ms: 300000, instances_assumed: 1, restored_from: null, last_snapshot: null, brief_reads: "on" }, "in-memory database: no snapshots");
  // Delete takes the brief with it.
  await s("DELETE", "/api/learner");
  assert.equal((await fetch(`http://localhost:${PORT}/api/admin/learners/${sid}/brief`, { headers: { "x-gloo-admin": "test-owner-token" } })).status, 404);
});

test("synthetic learners: the mark needs the sim token, shows on /api/level and health, keeps the session out of both reports' real figures unless included, and the arm judge scores a pick onto its row", async () => {
  const marked = (slug, token) => { const s = session(); return (m, p, b) => s(m, p, b, { "x-gloo-synthetic": slug, ...(token ? { "x-gloo-sim-token": token } : {}) }); };
  // Without the token, or with a wrong one, the header does nothing and nothing says why.
  for (const bad of [marked("marty-mcfly", null), marked("marty-mcfly", "wrong-token"), marked("Not A Slug!", "test-sim-token")]) assert.equal((await bad("GET", "/api/level")).body.synthetic, null);
  const s = marked("marty-mcfly", "test-sim-token");
  const lv = (await s("GET", "/api/level?qloo=2")).body;
  assert.equal(lv.synthetic, "marty-mcfly"); assert.equal(lv.level, 2);
  const h = (await s("GET", "/api/health")).body;
  assert.deepEqual(h.synthetic, { marking: "on", persona: "marty-mcfly", judge: "anthropic" });
  assert.equal((await session()("GET", "/api/health")).body.synthetic.persona, null);
  // The synthetic session picks on a reviewed lesson and answers; a real session does the same at the same level.
  const play = async (c) => {
    await c("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
    const term = (await c("GET", "/api/terms/cholecystokinin")).body;
    const o = term.roles.find((r) => r.id === "chole").pick.options.find((x) => x.name === "Pepsi-Cola");
    await c("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "chole", label: o.name, connection: o.connection, source: "pick", recognized: true, qloo_entity_type: o.qloo?.type });
    await c("POST", "/api/attempts", { prompt_id: "cck-chole", response: "bile", idempotency_key: `syn-${Math.random().toString(36).slice(2, 12)}` });
  };
  const real = session(); await real("GET", "/api/level?qloo=2"); await play(real); await play(s);
  const admin = { headers: { "x-gloo-admin": "test-owner-token" } };
  const d = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, admin)).json();
  const two = (r) => r.cells.find((c) => c.level === 2 && c.arm === "anthropic");
  assert.equal(d.include_synthetic, false); assert.ok(d.synthetic_sessions >= 1);
  assert.equal(d.synthetic.sessions, d.synthetic_sessions); assert.equal(d.synthetic.included, false);
  const persona = d.synthetic.personas.find((p) => p.persona === "marty-mcfly" && p.level === 2);
  assert.ok(persona && persona.sessions >= 1 && persona.picks >= 1 && persona.answers >= 1, JSON.stringify(persona));
  assert.equal(persona.arm, "anthropic"); assert.equal(persona.sound_match, null);
  const merged = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&include=synthetic`, admin)).json();
  assert.equal(merged.include_synthetic, true);
  assert.equal(merged.synthetic_sessions, d.synthetic_sessions); assert.ok(merged.sessions >= d.sessions + d.synthetic_sessions, "merged counts every session (the report's own cookie-less fetches add real ones)");
  assert.equal(two(merged).sessions, two(d).sessions + d.synthetic.cells.find((c) => c.level === 2 && c.arm === "anthropic").sessions);
  const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, admin)).text();
  assert.match(text, /real \(\+\d+ synthetic, below\)/); assert.match(text, /synthetic learners \(\d+ simulated sessions, kept out/); assert.match(text, /\nmarty-mcfly +2 +anthropic /); assert.match(text, /judged by a model/); assert.match(text, /practice \(scripted\)/);
  const t = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1`, admin)).json();
  assert.ok(t.rows.every((r) => r.persona === null), "no synthetic row among the real ones"); assert.ok(t.synthetic.rows.some((r) => r.persona === "marty-mcfly" && r.stage === "correct"));
  assert.ok(t.synthetic.funnel.correct >= 1);
  const tm = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1&include=synthetic`, admin)).json();
  assert.ok(tm.rows.some((r) => r.persona === "marty-mcfly")); assert.deepEqual(tm.synthetic.rows, []); assert.ok(tm.sessions >= t.sessions + t.synthetic.sessions);
  const tt = await (await fetch(`http://localhost:${PORT}/api/admin/testers?hours=1&format=text`, admin)).text();
  assert.match(tt, /\bpersona\b/); assert.match(tt, /synthetic learners \(simulated personas/); assert.match(tt, / marty-mcfly +correct /);
  // The arm judge: the token (or the owner's) opens it; the score lands on the cue row with its provider and model.
  assert.equal((await session()("POST", "/api/sim/judge", { term_id: "cholecystokinin", role: "chole", label: "Pepsi-Cola" })).status, 401);
  assert.equal((await s("POST", "/api/sim/judge", { term_id: "cholecystokinin", role: "chole", label: "Coca-Cola" })).status, 404, "not this session's pick");
  const j = await s("POST", "/api/sim/judge", { term_id: "cholecystokinin", role: "chole", label: "pepsi-cola" });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.deepEqual([j.body.status, j.body.score, j.body.provider, j.body.model, j.body.part, j.body.label], ["ok", 1, "anthropic", "claude-sonnet-5-5", "chole", "Pepsi-Cola"]);
  const cue = (await s("GET", "/api/export")).body.learner_cues.find((c) => c.role === "chole");
  assert.deepEqual([cue.judge_score, cue.judge_provider, cue.judge_model, cue.judge_reason], [1, "anthropic", "claude-sonnet-5-5", "fake judge"]);
  assert.ok((await s("GET", "/api/export")).body.provider_calls.some((c) => c.op === "judge_hook" && c.status === "ok"));
  const d2 = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, admin)).json();
  const judged = d2.synthetic.personas.find((p) => p.persona === "marty-mcfly" && p.level === 2);
  assert.equal(judged.judged, 1); assert.equal(judged.sound_match, 1);
  assert.equal(two(d2).judged, 0, "the real cell was not judged");
  assert.match(await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, admin)).text(), /\nmarty-mcfly +2 +anthropic .* 1 \(1\) */);
  // Seeding: a fresh synthetic session's canon likes become taste signals before any word, each resolved once;
  // they are cues with hook_source seed, never hooks, and the first card it opens is ranked for them.
  const z = marked("sheldon-cooper", "test-sim-token");
  await z("GET", "/api/level?qloo=1");
  assert.equal((await session()("POST", "/api/sim/seed", { likes: [{ name: "Pepsi", type: "brand" }] })).status, 401);
  const seeded = await z("POST", "/api/sim/seed", { likes: [{ name: "Pepsi", type: "brand" }, { name: "Twisted Sister", type: "artist" }, { name: "Halo", type: "video_game" }, { name: "Somewhere", type: "locality" }] });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  assert.deepEqual(seeded.body.seeded, [{ name: "Pepsi", type: "brand", entity_id: "mock-pepsi" }, { name: "Twisted Sister", type: "artist", entity_id: "mock-twisted-sister" }, { name: "Halo", type: "videogame", entity_id: "mock-halo" }]);
  assert.deepEqual(seeded.body.skipped, [{ name: "Somewhere", type: "locality", why: "type" }]); assert.equal(seeded.body.signals, 3);
  assert.deepEqual((await z("POST", "/api/sim/seed", { likes: [{ name: "Pepsi", type: "brand" }] })).body.skipped[0].why, "already seeded");
  assert.equal((await z("POST", "/api/sim/seed", { likes: [{ name: "someone@example.com", type: "brand" }] })).status, 400);
  const zc = (await z("GET", "/api/export")).body.learner_cues;
  assert.ok(zc.length === 3 && zc.every((c) => c.source === "pick" && c.hook_source === "seed" && c.term_id === "seed" && c.shown_rank === null));
  assert.match((await (await fetch(`http://localhost:${PORT}/api/admin/learners/${(await z("GET", "/api/export")).body.provider_calls[0].sid}/brief`, admin)).json()).brief.text, /(Picks so far: Pepsi, Twisted Sister, Halo|Likes: )/, "the brief knows the seeded taste");
  await z("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  const zt = (await z("GET", "/api/terms/cholecystokinin")).body;
  assert.equal(zt.roles.find((r) => r.id === "in").pick.tailoring.source, "taste", "ranked before any pick on this lesson");
  assert.deepEqual(zt.roles.find((r) => r.id === "chole").pick.options.map((o) => o.name), ["Pepsi-Cola", "RC Cola", "Inca Kola", "Coca-Cola"], "the seeded like leads its own card, the rest ranked by one call");
  assert.equal((await z("GET", "/api/progress/cholecystokinin")).body.hooks.all.total, 0, "seeds are not hooks");
  // The canon-fit judge on the ranked chole card: Qloo put Pepsi first, the fake judge rates Pepsi 3 and the rest 1, so they agree (rho 0.775 with the three-way tie).
  const character = { name: "Sheldon Cooper", work: { title: "The Big Bang Theory", kind: "tv", year: 2007 } };
  const likes = [{ name: "Pepsi", type: "brand" }, { name: "Twisted Sister", type: "artist" }];
  assert.equal((await session()("POST", "/api/sim/fit", { term_id: "cholecystokinin", role: "in", character, likes })).status, 401);
  assert.equal((await z("POST", "/api/sim/fit", { term_id: "cholecystokinin", role: "kin", character, likes })).body.status, "unranked");
  const fit = await z("POST", "/api/sim/fit", { term_id: "cholecystokinin", role: "chole", character, likes });
  assert.equal(fit.status, 200, JSON.stringify(fit.body));
  assert.deepEqual([fit.body.status, fit.body.qloo_top, fit.body.judge_top, fit.body.top_hit, fit.body.rho, fit.body.provider], ["ok", "Pepsi-Cola", ["Pepsi-Cola"], 1, 0.775, "anthropic"]);
  assert.deepEqual(fit.body.fits.map((f) => [f.name, f.fit]), [["Pepsi-Cola", 3], ["RC Cola", 1], ["Inca Kola", 1], ["Coca-Cola", 1]]);
  assert.equal((await z("GET", "/api/export")).body.card_fits.length, 1);
  const d3 = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, admin)).json();
  const sheldon = d3.synthetic.personas.find((p) => p.persona === "sheldon-cooper");
  assert.deepEqual([sheldon.seeds, sheldon.picks, sheldon.fit_cards, sheldon.fidelity], [3, 0, 1, 1]); assert.ok(sheldon.fidelity_rho > 0.7 && sheldon.fidelity_rho < 0.8);
  const t3 = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text`, admin)).text();
  assert.match(t3, /fidelity \(judged by a model\)/); assert.match(t3, /\nsheldon-cooper +1 +anthropic +1 +3 .*100% rho 0\.7\d \(1\)/); assert.match(t3, /fidelity by degree and arm/);
  await z("DELETE", "/api/learner");
});

test("the simulator's dry run against the mock server: a fixture persona plays two words at degree 2, the rows carry cards, favorite ranks, scripted practice and spend, the file is written, and the judge scores the picks when asked", async () => {
  assert.deepEqual(favoriteOn([{ name: "Coca-Cola", qloo: { entity: "Coca-Cola" } }, { name: "Pepsi-Cola", qloo: { entity: "Pepsi" } }], FIXTURES["marty-mcfly"].likes), { rank: 1, option: { name: "Pepsi-Cola", qloo: { entity: "Pepsi" } } });
  assert.equal(favoriteOn([{ name: "RC Cola" }], FIXTURES["ferris-bueller"].likes).rank, null);
  assert.throws(() => parseArgs(["--level", "7", "--persona", "fixture:marty-mcfly"]), /0, 1, 2 or 3/);
  const out = mkdtempSync(join(tmpdir(), "gloo-sim-"));
  const prev = process.env.SIM_TOKEN; process.env.SIM_TOKEN = "test-sim-token";
  const logged = [];
  try {
    // Without the token on the server's side of the handshake the run refuses to play (the mark did not come back).
    process.env.SIM_TOKEN = "wrong";
    await assert.rejects(simulate(parseArgs(["--base", `http://localhost:${PORT}`, "--persona", "fixture:marty-mcfly", "--level", "2", "--dry-run", "--quiet"])), /did not accept the synthetic mark/);
    process.env.SIM_TOKEN = "test-sim-token";
    const r = await simulate(parseArgs(["--base", `http://localhost:${PORT}`, "--persona", "fixture:marty-mcfly", "--level", "2", "--model", "anthropic", "--words", "2", "--dry-run", "--out", out]), { log: (m) => logged.push(m) });
    const [run, cck, peri, summary] = r.lines;
    assert.deepEqual([run.kind, run.persona, run.level, run.arm, run.synthetic, run.judge, run.dry_run], ["run", "marty-mcfly", 2, "anthropic", "marty-mcfly", "off", true]);
    assert.match(run.practice_rule, /taste-blind/);
    assert.deepEqual([cck.kind, cck.word, cck.term_id, cck.created], ["word", "cholecystokinin", "cholecystokinin", false]);
    assert.deepEqual([run.seed.on, run.seed.asked, run.seed.seeded, run.seed.resolved, run.seed.signals], [true, 3, 3, 3, 3], "the likes went in first");
    const chole = cck.cards.find((c) => c.role === "chole");
    assert.deepEqual([chole.favorite_rank, chole.chosen, chole.via, chole.hook_source, chole.entity_id, chole.ranked, chole.qloo_top, chole.judge, chole.fit], [0, "Pepsi-Cola", "like", "taste", "mock-pepsi", true, "Pepsi-Cola", null, null], "the seeded like leads its card, so the favorite lands first");
    const cysto = cck.cards.find((c) => c.role === "cysto");
    assert.deepEqual([cysto.favorite_rank, cysto.chosen_rank, cysto.via], [null, 0, "first"], "no like on the card: the first tile");
    assert.ok(cck.cards.every((c) => typeof c.seconds.card === "number" && typeof c.seconds.pick === "number" && c.seconds.pick >= c.seconds.card));
    assert.ok(cck.practice.length >= 3 && cck.practice.every((p) => ["correct", "incorrect", "partial", "uncertain"].includes(p.outcome)), JSON.stringify(cck.practice));
    assert.ok(cck.cards.slice(2).some((c) => c.ranked), "the cards still ahead come back ranked (the lesson reloads after each pick)");
    assert.equal(summary.favorite_first, 1);
    assert.ok(cck.spend.qloo_calls >= 1 && cck.spend.model_calls === 0, JSON.stringify(cck.spend));
    assert.equal(cck.first_attempt, "say");
    assert.deepEqual([peri.word, peri.created, peri.built?.source], ["peristalsis", true, "qloo"], "a new word is drafted and its cards built at degree 2");
    assert.ok(peri.spend.model_calls >= 1 && peri.spend.tokens_out >= 1 && peri.spend.qloo_calls >= 1, JSON.stringify(peri.spend));
    assert.deepEqual([summary.kind, summary.words, summary.drafted, summary.errors], ["summary", 2, 1, 0]);
    assert.ok(summary.cards >= 5 && summary.answers >= 4);
    assert.equal(readFileSync(r.file, "utf8").trim().split("\n").length, 4, "run, two words, summary");
    assert.ok(logged.some((m) => /^run .*Marty McFly at degree 2/.test(m)));
    // Judged (not a dry run): every pick gets a score from the fake judge and the report's persona row shows the mean.
    const j = await simulate(parseArgs(["--base", `http://localhost:${PORT}`, "--persona", "fixture:ferris-bueller", "--level", "1", "--words", "1", "--arm-judge", "on", "--out", out, "--quiet"]));
    const word = j.lines[1];
    assert.ok(word.cards.length >= 2 && word.cards.every((c) => c.judge?.score === 2 && c.judge.provider === "anthropic" && c.judge.model === "claude-sonnet-5-5"), JSON.stringify(word.cards.map((c) => c.judge)));
    assert.equal(j.summary.sound_match, 2); assert.equal(j.summary.judged, word.cards.length);
    // Every ranked card was put to the canon-fit judge; the summary carries the fidelity.
    const rankedCards = word.cards.filter((c) => c.ranked);
    assert.ok(rankedCards.every((c) => c.fit && c.fit.top_hit != null && c.fit.qloo_top === c.qloo_top), JSON.stringify(word.cards.map((c) => [c.ranked, c.fit])));
    assert.ok(word.cards.filter((c) => !c.ranked).every((c) => c.fit === null), "an unranked card is not put to the fit judge");
    assert.equal(j.summary.fit_cards, rankedCards.length); assert.equal(j.summary.fidelity != null, rankedCards.length > 0);
    const unseeded = await simulate(parseArgs(["--base", `http://localhost:${PORT}`, "--persona", "fixture:ferris-bueller", "--level", "1", "--words", "1", "--seed-likes", "off", "--dry-run", "--quiet"]));
    assert.equal(unseeded.lines[0].seed.on, false); assert.equal(unseeded.lines[1].cards[0].ranked, false, "without seeds the first card is editorial");
    // The judged run's file went to the store under sim-runs/, line for line; the dry run uploaded nothing.
    assert.equal(j.uploaded, `sim-runs/${j.run.toLowerCase()}.jsonl`); assert.equal(unseeded.uploaded, null);
    assert.equal(readFileSync(join(MEDIA_DIR, "sim-runs", `${j.run.toLowerCase()}.jsonl`), "utf8"), readFileSync(j.file, "utf8"));
    // Every model row of the judged run carries its prompt's version; health lists the versions; the arm table shows them.
    const h = (await (await fetch(`http://localhost:${PORT}/api/health`)).json()).prompts;
    assert.ok(["draft", "resolve", "agent", "read", "judge", "fit"].every((k) => /^[a-f0-9]{8}$/.test(h[k])), JSON.stringify(h));
    const admin = { headers: { "x-gloo-admin": "test-owner-token" } };
    const text = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1&format=text&include=synthetic`, admin)).text();
    assert.match(text, /prompt versions/); assert.match(text, new RegExp(`judge_hook ${h.judge}×\\d+`)); assert.match(text, new RegExp(`draft ${h.draft}×\\d+`));
    const rep = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, admin)).json();
    assert.ok(rep.models.find((m) => m.arm === "anthropic").prompts.draft_lesson[h.draft] >= 1, "real sessions drafted under the current prompt");
    assert.ok(rep.synthetic.models.find((m) => m.arm === "anthropic").prompts.judge_hook[h.judge] >= 1, "the judged synthetic run's rows carry the judge prompt's version");
    // The learning record: one line per card the runs showed, with the persona, the pick and the judges on it.
    const learn = await (await fetch(`http://localhost:${PORT}/api/admin/learning?since=${Date.now() - 3600e3}`, admin)).json();
    assert.equal((await fetch(`http://localhost:${PORT}/api/admin/learning`)).status, 401);
    const mine = learn.records.filter((r) => r.persona === "ferris-bueller" && r.judge);
    assert.ok(mine.length >= 2, JSON.stringify(learn.records.map((r) => [r.persona, r.word, r.role])));
    const line = mine[0];
    assert.ok(line.word && line.part && line.candidates.length >= 2 && line.pick.hook_source && Number.isInteger(line.judge.score) && line.offered.order.length >= 1, JSON.stringify(line));
    assert.ok(!JSON.stringify(learn.records).includes("gloo_sid"));
    const fitted = mine.find((r) => r.fit); if (fitted) assert.equal(fitted.fit.qloo_top, fitted.offered.order[0].name);
    const drafted = learn.records.find((r) => r.provisional && r.prompt);
    assert.ok(drafted && drafted.prompt.version === h.draft, JSON.stringify(drafted?.prompt));
    const jsonl = await (await fetch(`http://localhost:${PORT}/api/admin/learning?since=${Date.now() - 3600e3}&format=jsonl`, admin)).text();
    assert.equal(jsonl.trim().split("\n").length, learn.lines);
    // The day's export: forced now, the file in the store holds today's lines; forced again, nothing changes.
    const ex = await (await fetch(`http://localhost:${PORT}/api/admin/learning/export`, { method: "POST", ...admin, headers: { ...admin.headers, "content-type": "application/json" }, body: "{}" })).json();
    assert.ok(ex.key.startsWith("learning/") && ex.lines >= learn.lines && ex.written === true, JSON.stringify(ex));
    assert.equal(readFileSync(join(MEDIA_DIR, ex.key), "utf8").trim().split("\n").length, ex.lines);
    const ex2 = await (await fetch(`http://localhost:${PORT}/api/admin/learning/export`, { method: "POST", ...admin, headers: { ...admin.headers, "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(ex2.written, false); assert.equal(ex2.lines, ex.lines);
    assert.equal((await (await fetch(`http://localhost:${PORT}/api/health`)).json()).learning.last.key, ex.key);
    const d = await (await fetch(`http://localhost:${PORT}/api/admin/degrees?hours=1`, { headers: { "x-gloo-admin": "test-owner-token" } })).json();
    const ferris = d.synthetic.personas.find((p) => p.persona === "ferris-bueller");
    assert.equal(ferris.sound_match, 2); assert.equal(ferris.level, 1);
  } finally { if (prev == null) delete process.env.SIM_TOKEN; else process.env.SIM_TOKEN = prev; }
});

test("owner: 401 without the header, 403 with the wrong token, 200 with the right one", async () => {
  assert.equal((await owner("")("GET", "/api/admin/lessons")).status, 401);
  assert.equal((await owner("not-it")("GET", "/api/admin/lessons")).status, 403);
  assert.equal((await owner("not-it")("PATCH", "/api/admin/lessons/cholecystokinin", { summary: "x" })).status, 403);
  const { status, body } = await owner()("GET", "/api/admin/lessons");
  assert.equal(status, 200);
  assert.deepEqual(body.map((l) => [l.id, l.review_status, l.version]), [["brier-score", "reviewed", 1], ["cholecystokinin", "reviewed", 1]]);
  const full = (await owner()("GET", "/api/admin/lessons/cholecystokinin")).body;
  assert.equal(full.prompts[0].answer, "Bile."); // the owner sees answers; learners never do
  assert.deepEqual(full.history, []);
  assert.equal((await owner()("GET", "/api/admin/lessons/nope")).status, 404);
  assert.equal((await session()("GET", "/api/health")).body.admin, true);
});

test("owner: a PATCH bumps the version, is validated, and reaches the learner app at once", async () => {
  const o = owner(), s = session();
  const bad = await o("PATCH", "/api/admin/lessons/cholecystokinin", { title: "", roles: [{ id: "chole", ipa: "/ˈkoʊlə/" }] });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.problems.some((p) => p.startsWith("title:")) && bad.body.problems.some((p) => p.startsWith("roles[0].ipa:")));
  const ok = await o("PATCH", "/api/admin/lessons/cholecystokinin", {
    summary: "Chole (bile) + cysto (sac) + kin (movement): the hormone that makes the bile sac move.",
    roles: [{ id: "chole", meaning: "bile (gall)", say: "koh-lee" }],
    prompts: [{ id: "cck-chole", hint: "Cola ≈ chole, approximately.", accept_any: ["bile", "gall"] }],
  }, { "x-gloo-editor": "loren" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, 2);
  assert.equal(ok.body.edited_by, "loren");
  assert.equal(ok.body.history.length, 1);
  assert.ok(!("packet" in ok.body.history[0]), "snapshots stay in the store");
  // The learner app sees the new version without a restart.
  const listed = (await s("GET", "/api/terms")).body.find((t) => t.id === "cholecystokinin");
  assert.equal(listed.version, 2);
  assert.match(listed.summary, /^Chole \(bile\)/);
  await s("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  const term = (await s("GET", "/api/terms/cholecystokinin")).body;
  assert.equal(term.version, 2);
  assert.equal(term.roles[0].meaning, "bile (gall)");
  assert.equal(term.roles[0].say, "koh-lee");
  assert.ok(!JSON.stringify(term).includes('"answer"'));
  assert.equal((await s("POST", "/api/practice/hint", { prompt_id: "cck-chole" })).body.hint, "Cola ≈ chole, approximately.");
  const r = (await s("POST", "/api/attempts", { prompt_id: "cck-chole", response: "gall", idempotency_key: "owner-edit-gall-1" })).body;
  assert.equal(r.outcome, "correct"); // the edited rubric scores
  const prog = (await s("GET", "/api/export")).body.attempts.at(-1);
  assert.equal(String(prog.content_version), "2");
});

test("owner: suggest asks the model with the field and instruction and saves nothing", async () => {
  const o = owner();
  const before = (await o("GET", "/api/admin/lessons/brier-score")).body;
  const r = await o("POST", "/api/admin/lessons/brier-score/suggest", { field: "roles.sound.meaning", instruction: "shorter" });
  assert.equal(r.status, 200);
  assert.equal(r.body.current, "the name of the score");
  assert.equal(r.body.suggestion, "Suggested roles.sound.meaning (shorter)");
  assert.equal(r.body.saved, false);
  assert.equal((await o("GET", "/api/admin/lessons/brier-score")).body.version, before.version);
  assert.equal((await o("POST", "/api/admin/lessons/brier-score/suggest", { field: "roles" })).status, 400);
  assert.equal((await o("POST", "/api/admin/lessons/brier-score/suggest", { field: "nope.x" })).status, 400);
  assert.equal((await o("POST", "/api/admin/lessons/nope/suggest", { field: "summary" })).status, 404);
});

test("owner: a learner's draft is promoted into the shared store as provisional, then published", async () => {
  const o = owner(), learner = session(), other = session();
  const { body: glued } = await learner("POST", "/api/glue", { text: "peristalsis", mode: "typed" });
  assert.equal(glued.created, true);
  assert.equal((await o("POST", "/api/admin/lessons/p-ffffffffff/promote")).status, 404);
  const p = await o("POST", `/api/admin/lessons/${glued.term_id}/promote`, {}, { "x-gloo-editor": "loren" });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.id, "peristalsis");
  assert.equal(p.body.review_status, "provisional");
  assert.equal(p.body.promoted_from.provisional_id, glued.term_id);
  assert.equal((await o("POST", `/api/admin/lessons/${glued.term_id}/promote`)).status, 409);
  // Everyone sees it now, labeled as a draft; the learner's own copy is untouched.
  const seen = (await other("GET", "/api/terms")).body.find((t) => t.id === "peristalsis");
  assert.equal(seen.provisional, true);
  assert.equal(seen.review_status, "provisional");
  await other("POST", "/api/terms/peristalsis/first-attempt", { skipped: true });
  assert.equal((await other("GET", "/api/terms/peristalsis")).body.provisional, true);
  assert.equal((await learner("GET", `/api/terms/${glued.term_id}`)).body.locked, true);
  // The resolver knows the new word by its title now.
  assert.equal((await other("POST", "/api/glue", { text: "peristalsis", mode: "typed" })).body.term_id, "peristalsis");
  const pub = await o("POST", "/api/admin/lessons/peristalsis/publish");
  assert.equal(pub.status, 200);
  assert.equal(pub.body.review_status, "reviewed");
  assert.equal(pub.body.version, 2);
  assert.equal((await other("GET", "/api/terms")).body.find((t) => t.id === "peristalsis").provisional, false);
  const a = (await other("POST", "/api/attempts", { prompt_id: "peristalsis-q1", response: "around", idempotency_key: "promoted-q1-0001" })).body;
  assert.equal(a.outcome, "correct");
  assert.equal(a.provisional, false);
});

// ---- The reviewer: proposals wait on the lesson; the owner accepts some, discards the rest ----
test("owner: review stores proposals (deterministic + model) without a version; accept applies the chosen paths; discard clears", async () => {
  const o = owner(), s = session();
  const before = (await o("GET", "/api/admin/lessons/cholecystokinin")).body;
  const r = await o("POST", "/api/admin/lessons/cholecystokinin/review", { instruction: "plainer words" }, { "x-gloo-editor": "loren" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.version, before.version, "a review is not an edit");
  assert.equal(reviewInstruction, "plainer words");
  const { pending } = r.body;
  assert.equal(pending.by, "loren");
  assert.equal(pending.instruction, "plainer words");
  const paths = pending.proposals.map((p) => p.path);
  const summary = pending.proposals.find((p) => p.path === "summary");
  assert.equal(summary.before, before.summary);
  assert.equal(summary.after, "Chole is bile, cysto is the sac, kin is movement. The hormone that moves the bile sac.");
  assert.match(summary.reason, /spoken aloud.*Shorter and spoken/s, "the deterministic reason and the model's are joined");
  const cysto = pending.proposals.find((p) => p.path === "prompts[cck-cysto].answer");
  assert.equal(cysto.severity, "fix");
  assert.equal(cysto.after, "Cysto");
  for (const p of ["roles[chole].nickname", "definition", "pronunciation.ipa", "prompts[cck-chole].answer"]) assert.ok(!paths.includes(p), `${p} dropped`);
  assert.ok(pending.notes.some((n) => /roles\[chole\]\.nickname/.test(n)));
  assert.ok(pending.notes.some((n) => /prompts\[cck-chole\]\.answer.*still fails its rubric/.test(n)));
  assert.ok(pending.notes.includes("Reviewed by the fake model."));
  assert.deepEqual((await o("GET", "/api/admin/lessons/cholecystokinin")).body.pending, pending, "GET returns the pending proposals");
  // Learners never see proposals, and nothing changed for them yet.
  const learner = (await s("GET", "/api/terms")).body.find((t) => t.id === "cholecystokinin");
  assert.equal(learner.summary, before.summary);
  assert.ok(!("pending" in learner));

  assert.equal((await o("POST", "/api/admin/lessons/cholecystokinin/proposals/accept", { paths: ["summary", "nope"] })).status, 400);
  assert.equal((await o("POST", "/api/admin/lessons/cholecystokinin/proposals/accept", { paths: [] })).status, 400);
  const a = await o("POST", "/api/admin/lessons/cholecystokinin/proposals/accept", { paths: ["summary"] }, { "x-gloo-editor": "loren" });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.version, before.version + 1);
  assert.equal(a.body.edited_by, "reviewer via loren");
  assert.equal(a.body.summary, summary.after);
  assert.equal(a.body.prompts[1].answer, "Cyst or cysto.", "the unchosen proposal is not applied");
  assert.equal(a.body.pending, undefined);
  assert.deepEqual(a.body.history[0].changed, ["summary"]);
  assert.equal((await s("GET", "/api/terms")).body.find((t) => t.id === "cholecystokinin").summary, summary.after, "live for learners");
  assert.equal((await o("POST", "/api/admin/lessons/cholecystokinin/proposals/accept", { paths: ["summary"] })).status, 400, "nothing pending");

  const again = await o("POST", "/api/admin/lessons/cholecystokinin/review", {});
  assert.ok(again.body.pending.proposals.length >= 1);
  const d = await o("POST", "/api/admin/lessons/cholecystokinin/proposals/discard");
  assert.equal(d.status, 200);
  assert.equal(d.body.pending, undefined);
  assert.equal(d.body.version, before.version + 1);
  assert.equal((await o("POST", "/api/admin/lessons/nope/review", {})).status, 404);
  assert.equal((await owner("not-it")("POST", "/api/admin/lessons/cholecystokinin/review", {})).status, 403);
});

test("owner: draft a new shared lesson for a word; it arrives provisional and is live for learners", async () => {
  const o = owner(), s = session();
  assert.equal((await o("POST", "/api/admin/lessons/draft", {})).status, 400);
  assert.equal((await o("POST", "/api/admin/lessons/draft", { word: "x", id: "Bad Id" })).status, 400);
  const r = await o("POST", "/api/admin/lessons/draft", { word: "Peristalsis", id: "peristalsis-draft" }, { "x-gloo-editor": "loren" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.id, "peristalsis-draft");
  assert.equal(r.body.review_status, "provisional");
  assert.equal(r.body.edited_by, "loren");
  assert.equal(r.body.prompts[0].id, "peristalsis-draft-q1");
  assert.deepEqual(r.body.promoted_from, { provisional_id: null, origin: "ai-draft" });
  assert.equal((await o("POST", "/api/admin/lessons/draft", { word: "Peristalsis", id: "peristalsis-draft" })).status, 409);
  assert.equal((await s("GET", "/api/terms")).body.find((t) => t.id === "peristalsis-draft").provisional, true);
});

// ---- The MCP server: the same owner API as tools, token from the environment ----
test("mcp: tool handlers edit lessons through the owner API; a wrong or missing token is an error result, not a crash", async () => {
  const mcp = createGlooClient({ url: `http://localhost:${PORT}/`, token: "test-owner-token", editor: "claude" });
  const read = (r) => { assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  assert.deepEqual(TOOLS.map((t) => t.name), ["list_lessons", "get_lesson", "patch_lesson", "suggest_field", "review_lesson", "accept_proposals", "discard_proposals", "publish_lesson", "draft_lesson"]);
  assert.ok(read(await mcp.call("list_lessons")).some((l) => l.id === "brier-score"));
  const before = read(await mcp.call("get_lesson", { id: "brier-score" }));
  assert.equal(before.prompts[0].answer.slice(0, 7), "How far");
  const patched = read(await mcp.call("patch_lesson", { id: "brier-score", patch: { roles: [{ id: "sound", say: "bry-ur" }] } }));
  assert.equal(patched.version, before.version + 1);
  assert.equal(patched.edited_by, "claude");
  assert.equal(patched.roles[0].say, "bry-ur");
  const bad = await mcp.call("patch_lesson", { id: "brier-score", patch: { title: "" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /title: a short non-empty string/);
  assert.equal(read(await mcp.call("suggest_field", { id: "brier-score", field: "summary", instruction: "shorter" })).suggestion, "Suggested summary (shorter)");
  const reviewed = read(await mcp.call("review_lesson", { id: "brier-score", instruction: "focus on the summary" }));
  assert.ok(reviewed.pending.proposals.some((p) => p.path === "summary"));
  const accepted = read(await mcp.call("accept_proposals", { id: "brier-score", paths: ["summary"] }));
  assert.equal(accepted.version, patched.version + 1);
  assert.equal(accepted.edited_by, "reviewer via claude");
  assert.equal(accepted.pending, undefined);
  read(await mcp.call("review_lesson", { id: "brier-score" }));
  assert.equal(read(await mcp.call("discard_proposals", { id: "brier-score" })).pending, undefined);
  const published = read(await mcp.call("publish_lesson", { id: "peristalsis-draft" }));
  assert.equal(published.review_status, "reviewed");
  assert.equal((await mcp.call("get_lesson", { id: "nope" })).isError, true);
  assert.equal((await mcp.call("no_such_tool", {})).isError, true);
  const wrong = await createGlooClient({ url: `http://localhost:${PORT}`, token: "not-it" }).call("list_lessons");
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /didn't match/);
  const none = await createGlooClient({ url: `http://localhost:${PORT}`, token: "" }).call("list_lessons");
  assert.match(none.content[0].text, /GLOO_ADMIN_TOKEN is not set/);
});

test("mcp: the stdio server lists its tools and answers a call, reading the token from its environment", async () => {
  const client = new Client({ name: "gloo-test", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, GLOO_URL: `http://localhost:${PORT}`, GLOO_ADMIN_TOKEN: "test-owner-token" }, stderr: "ignore" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS.map((t) => t.name).sort());
    assert.ok(tools.every((t) => t.inputSchema?.type === "object"));
    const r = await client.callTool({ name: "get_lesson", arguments: { id: "cholecystokinin" } });
    assert.ok(!r.isError);
    const lesson = JSON.parse(r.content[0].text);
    assert.equal(lesson.id, "cholecystokinin");
    assert.ok(lesson.version >= 3);
    const e = await client.callTool({ name: "get_lesson", arguments: { id: "nope" } });
    assert.equal(e.isError, true);
  } finally { await client.close(); }
});

// ---- Gloo credits (decision 33): welcome, a drafted word costs one, reviewed words are free, referrals pay the referrer ----
// A session that arrives from a given address (the referral soft signal hashes it; the test server sees everyone as localhost otherwise).
const sessionAt = (ip) => {
  let cookie = "";
  const call = async (method, path, body) => {
    const res = await fetch(`http://localhost:${PORT}${path}`, {
      method, headers: { ...(cookie && { cookie }), "x-forwarded-for": ip, ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
  call.sid = () => cookie.split("=")[1];
  return call;
};

test("credits: a new visitor has 2 Gloo; a drafted word costs 1, a reviewed word 0, a repeat scan 0; an empty balance is a 402 and old lessons still open", async () => {
  const s = session();
  const first = (await s("GET", "/api/credits")).body;
  assert.equal(first.balance, 2);
  assert.match(first.referral.code, /^[a-zA-Z0-9]{10}$/);
  assert.equal(first.referral.link, `http://localhost:${PORT}/?ref=${first.referral.code}`);
  assert.match(first.policy, /first two words are on us/);
  assert.equal(first.recent[0].event_type, "welcome_grant");
  assert.equal((await s("GET", "/api/health")).body.credits.welcome, 2);
  const reviewed = (await s("POST", "/api/glue", { text: "cholecystokinin", mode: "typed" })).body;
  assert.equal(reviewed.created, false); assert.equal(reviewed.credits, undefined);
  const drafted = (await s("POST", "/api/glue", { text: "glycolysis", mode: "typed" })).body;
  assert.equal(drafted.created, true); assert.deepEqual(drafted.credits, { charged: true, balance: 1 });
  const again = (await s("POST", "/api/glue", { text: "glycolysis", mode: "typed" })).body;
  assert.equal(again.created, false); assert.equal(again.credits, undefined);
  assert.equal((await s("GET", "/api/credits")).body.balance, 1);
  assert.equal((await s("POST", "/api/glue", { text: "mitochondria", mode: "typed" })).body.credits.balance, 0);
  const empty = await s("POST", "/api/glue", { text: "tachycardia", mode: "typed" });
  assert.equal(empty.status, 402);
  assert.deepEqual([empty.body.code, empty.body.error, empty.body.balance], ["GLOO_EMPTY", "Ready for another word? Invite a friend to earn more Gloo.", 0]);
  assert.equal((await s("GET", "/api/terms/cholecystokinin")).status, 200);
  assert.equal((await s("GET", `/api/terms/${drafted.term_id}`)).status, 200, "the words already drafted stay open");
  assert.equal((await s("POST", "/api/glue", { text: "glycolysis", mode: "typed" })).status, 200, "and a repeat scan still costs nothing");
  const ledger = (await s("GET", "/api/export")).body.credit_events;
  assert.deepEqual(ledger.map((e) => [e.event_type, e.delta]), [["welcome_grant", 2], ["word_spend", -1], ["word_spend", -1]]);
  assert.ok(ledger.every((e) => e.sid && e.account_id === null && /@credits-phase1-v1$/.test(e.reason_code)));
  await s("DELETE", "/api/learner");
  assert.equal((await s("GET", "/api/credits")).body.balance, 0, "deleting my data does not mint a second welcome");
});

test("credits: a referred friend's first completed word pays the referrer 3; self and duplicate claims are rejected; same-address claims are held for the owner", async () => {
  const a = sessionAt("203.0.113.7"), b = sessionAt("198.51.100.2"), twin = sessionAt("203.0.113.7");
  const { code } = (await a("GET", "/api/credits")).body.referral;
  assert.equal((await a("POST", "/api/referrals/claim", { code })).body.reason, "self_referral");
  assert.equal((await b("POST", "/api/referrals/claim", {})).status, 400);
  assert.equal((await b("POST", "/api/referrals/claim", { code: "nope" })).body.reason, "unknown_code");
  assert.deepEqual((await b("POST", "/api/referrals/claim", { code })).body, { recorded: true, status: "claimed", reason: null, flags: [] });
  await b("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  assert.equal((await a("GET", "/api/credits")).body.balance, 2, "a first attempt alone is not a word experience");
  await b("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "chole", label: "Pepsi-Cola", connection: "Pepsi ≈ chole.", source: "pick", recognized: true });
  const paid = (await a("GET", "/api/credits")).body;
  assert.equal(paid.balance, 5); assert.equal(paid.referral.activated, 1);
  assert.equal(paid.recent[0].event_type, "referral_reward"); assert.equal(paid.recent[0].delta, 3);
  assert.equal((await b("GET", "/api/credits")).body.balance, 2, "the friend keeps the welcome");
  assert.equal((await b("POST", "/api/referrals/claim", { code })).body.status, "activated", "a second claim changes nothing: the first attribution is reported as it stands");
  await b("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: "cysto", label: "Sister Act", connection: "Sister ≈ cysto.", source: "pick", recognized: true });
  assert.equal((await a("GET", "/api/credits")).body.balance, 5, "one reward per friend");
  // The twin arrives from the referrer's own address within the hour: the claim stands, the reward is held.
  assert.deepEqual((await twin("POST", "/api/referrals/claim", { code })).body.flags, ["same_ip"]);
  await twin("POST", "/api/terms/brier-score/first-attempt", { skipped: true });
  await twin("POST", "/api/learner/cues", { term_id: "brier-score", role: "sound", label: "Breyers", connection: "Breyers ≈ Brier.", source: "pick", recognized: true });
  assert.equal((await a("GET", "/api/credits")).body.balance, 5);
  // The owner sees both sides of it and can release or reverse with a logged reason.
  const o = owner();
  assert.equal((await session()("GET", `/api/admin/credits/${a.sid()}`)).status, 401);
  assert.equal((await o("GET", "/api/admin/credits/not-a-sid")).status, 400);
  const view = (await o("GET", `/api/admin/credits/${a.sid()}`)).body;
  assert.equal(view.balance, 5);
  assert.deepEqual(view.referrals.map((r) => r.status), ["rejected", "activated", "held"]);
  const held = view.referrals.find((r) => r.status === "held");
  assert.equal(held.reason, "flag:same_ip");
  assert.equal((await o("POST", `/api/admin/credits/${a.sid()}/adjust`, { delta: 3 })).status, 400, "a reason is required");
  const rel = await o("POST", `/api/admin/credits/${a.sid()}/adjust`, { delta: 3, reason: "checked: a real friend on the same wifi", referral_id: held.id, idempotency_key: `release-${held.id}` }, { "x-gloo-editor": "loren" });
  assert.equal(rel.status, 201); assert.equal(rel.body.balance, 8);
  assert.equal(rel.body.event.reason_code, "adjustment:loren@credits-phase1-v1");
  const dup = await o("POST", `/api/admin/credits/${a.sid()}/adjust`, { delta: 3, reason: "again", referral_id: held.id, idempotency_key: `release-${held.id}` });
  assert.equal(dup.status, 200); assert.equal(dup.body.written, false); assert.equal(dup.body.balance, 8);
  assert.equal((await o("GET", `/api/admin/credits/${a.sid()}`)).body.referrals.find((r) => r.id === held.id).status, "activated");
  assert.equal((await o("GET", `/api/admin/credits/${twin.sid()}`)).body.referred_by.referrer_sid, a.sid());
});
