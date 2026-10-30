// Gloo cue agent: Claude + Qloo tools.
// Qloo grounds WHICH cultural entities a taste cluster knows; Claude decides HOW an entity can
// carry a specific part of the concept (a sound, a meaning, an operation). The learner then
// confirms recognition. Qloo affinity never sets familiarity, mastery or retention.
import { complete, anyAvailable, MODELS } from "./providers.mjs";

export const MODEL = MODELS.anthropic;
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 8);

const ENTITY_TYPES = ["artist", "book", "brand", "movie", "person", "place", "podcast", "tv_show", "videogame"];

// Pinned to Qloo workflow contract 1.0.0 (qloo mcp, harness 0.1.26).
const QLOO_TOOLS = [
  { name: "qloo_describe", description: "Resolve one named entity to its Qloo record and ID. Use this before using any entity as a signal.",
    input_schema: { type: "object", properties: { entity: { type: "string" }, type: { type: "string", enum: [...ENTITY_TYPES, "locality", "actor", "album", "author", "director"] } }, required: ["entity"] } },
  { name: "qloo_recommend", description: "Entities that people who like the given signals tend to like (aggregate affinity). signals = resolved Qloo entity IDs.",
    input_schema: { type: "object", properties: {
      target_type: { type: "string", enum: ENTITY_TYPES }, signals: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
      signal_tags: { type: "array", items: { type: "string" } }, filter_location: { type: "string" },
      explain: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["target_type"] } },
  { name: "qloo_entity_tags", description: "Qloo tags (genres, moods, traits) that characterize entities.",
    input_schema: { type: "object", properties: { entities: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
      entity_type: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["entities"] } },
  { name: "qloo_find_tags", description: "Search Qloo's tag ontology for a concept and return tag URNs.",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"] } },
];

const proposeTool = (term) => ({
  name: "propose_cues",
  description: "Finish by proposing at most 3 cues. Each must carry one named role of the concept.",
  input_schema: {
    type: "object",
    properties: {
      cues: { type: "array", maxItems: 3, items: { type: "object", properties: {
        role: { type: "string", enum: term.roles.map((r) => r.id) },
        label: { type: "string", description: "Display name of the cultural entity" },
        qloo_entity_id: { type: ["string", "null"], description: "ID exactly as returned by a Qloo tool in this session, else null" },
        qloo_entity_type: { type: ["string", "null"] },
        connection_type: { type: "string", enum: ["approximate sound", "meaning", "operation", "reinforcement"] },
        connection: { type: "string", description: "One sentence: how this entity carries the role. Say 'approximate' for sound links." },
        grounding: { type: "string", description: "Which Qloo result made this a likely-familiar pick (e.g. 'recommended for fans of X')" },
      }, required: ["role", "label", "qloo_entity_id", "connection_type", "connection", "grounding"] } },
      notes: { type: "string" },
    },
    required: ["cues"],
  },
});

const systemPrompt = (term) => `You are Gloo's cue agent. Gloo teaches hard terms by linking parts of them to things a learner already knows.

Concept: ${term.title}
Definition (reviewed, do not change): ${term.definition}
Roles you may fill:
${term.roles.map((r) => `- ${r.id}: "${r.label}" — target: ${r.target}. Look for ${r.look_for}.`).join("\n")}

Method:
1. Resolve each thing the learner says they know with qloo_describe (pick a sensible type). Never invent IDs.
2. Use qloo_recommend with the resolved IDs as signals to find what people with that taste also tend to know, choosing target types that could carry a role (brands, films, artists, books, tv_shows...).
3. From real Qloo results, pick at most 3 entities that carry a specific role through an approximate sound, a meaning, an operation, or a reinforcement. General relevance is not enough.
4. Call propose_cues. Use only qloo_entity_id values returned by Qloo in this session; otherwise null.
5. When the learner's note ("About me so far") names domains they like, look there first: a hook in a domain that has already stuck for them is worth more than a novel one; a domain whose hook failed is still allowed, but say so in the connection.

Rules:
- Qloo results describe what groups tend to like. They do not prove this learner knows an entity; the learner will confirm.
- Sound links are approximate. Never present a cue as etymology or as the scientific answer.
- Prefer entities whose name or core idea maps cleanly to a role. If nothing fits, propose fewer cues.
- Do not request or use personal data. Keep each connection to one sentence.
- Be efficient: at most ${MAX_STEPS - 1} Qloo calls.`;

// Live when any model provider has a key (providers.mjs); the session's arm picks which one answers.
export function agentMode() {
  return anyAvailable() ? "live" : "unavailable";
}

const idsIn = (envelope) => {
  const ids = new Set();
  for (const r of envelope?.results ?? []) {
    for (const k of ["entity_id", "id", "urn", "qloo_id"]) if (typeof r?.[k] === "string") ids.add(r[k]);
  }
  return ids;
};

const compact = (envelope) => JSON.stringify({
  status: envelope.status, summary: envelope.summary, error: envelope.error,
  results: (envelope.results ?? []).slice(0, 10),
}).slice(0, 7000);

function validate(term, proposal, seenIds) {
  const roles = new Set(term.roles.map((r) => r.id));
  return (proposal?.cues ?? []).filter((c) => roles.has(c.role)).slice(0, 3).map((c) => {
    const verified = c.qloo_entity_id && seenIds.has(c.qloo_entity_id);
    return {
      role: c.role, label: String(c.label).slice(0, 80),
      connection_type: c.connection_type, connection: String(c.connection).slice(0, 240),
      grounding: String(c.grounding ?? "").slice(0, 240),
      qloo_entity_id: verified ? c.qloo_entity_id : null,
      qloo_entity_type: verified ? c.qloo_entity_type ?? null : null,
      source: verified ? "qloo-grounded" : "agent (no verified Qloo ID)",
    };
  });
}

// run(op, args) -> Qloo envelope (already guarded, cached and logged by the caller)
// `focus` names the role the learner is on ("None of these" on that card): the agent fills it first.
// `provider` is the session's model arm; `sid` goes on each step's provider_calls row (task cue_agent_step).
// `brief` is the learner brief (brief.mjs: public names, lesson titles, outcomes), or null; `briefDropped` says the
// guard kept one out, which every step's row then notes.
export async function runCueAgent({ term, familiar, run, focus = null, provider = "anthropic", sid = null, brief = null, briefDropped = false }) {
  if (agentMode() !== "live") return { status: "unavailable", reason: "No model provider is configured on the server.", cues: [], trace: [] };

  const tools = [...QLOO_TOOLS, proposeTool(term)];
  let used = null;
  const trace = [];
  const seenIds = new Set();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const messages = [{ role: "user", content:
    `Things I already know and like: ${familiar.map((f) => `"${f}"`).join(", ")}.${brief ? `\nAbout me so far: ${brief}` : ""}\nFind up to 3 cues that help me learn ${term.title}.${focus ? ` I am on the piece "${focus}": fill that role first.` : ""}` }];

  for (let step = 0; step < MAX_STEPS; step++) {
    // Current models reject forced tool choice; at the step limit the model is told to finish instead.
    if (step === MAX_STEPS - 1) messages.push({ role: "user", content: "Step limit reached. Call propose_cues now with the best cues from the Qloo results you already have." });
    const out = await complete({ provider, task: "cue_agent_step", sid, brief_chars: brief ? brief.length : 0, brief_dropped: briefDropped, max_tokens: 1500, system: systemPrompt(term), tools, messages, tool_choice: { type: "auto" } });
    const res = out.res;
    used = { provider: out.provider, model: out.model, fallback_from: out.fallback_from };
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;
    messages.push({ role: "assistant", content: res.content });

    const calls = res.content.filter((b) => b.type === "tool_use");
    const final = calls.find((c) => c.name === "propose_cues");
    if (final) {
      return { status: "ok", ...used, cues: validate(term, final.input, seenIds), notes: final.input.notes ?? "", trace, usage };
    }
    if (calls.length === 0) {
      messages.push({ role: "user", content: "Please finish by calling propose_cues." });
      continue;
    }
    const results = [];
    for (const call of calls) {
      const op = call.name.replace(/^qloo_/, "");
      const envelope = await run(op, call.input);
      idsIn(envelope).forEach((id) => seenIds.add(id));
      trace.push({ tool: call.name, args: call.input, status: envelope.status, result_count: envelope.result_count ?? 0 });
      results.push({ type: "tool_result", tool_use_id: call.id, content: compact(envelope), is_error: envelope.status === "error" });
    }
    messages.push({ role: "user", content: results });
  }
  return { status: "partial", ...used, cues: [], notes: "Step limit reached without a proposal.", trace, usage };
}

// Deterministic stand-in for UI work without model or Qloo keys. Always labeled SYNTHETIC.
export async function runSyntheticAgent({ term, familiar, run }) {
  const trace = [];
  const ids = [];
  for (const f of familiar.slice(0, 3)) {
    const env = await run("describe", { entity: f });
    trace.push({ tool: "qloo_describe", args: { entity: f }, status: env.status, result_count: env.result_count ?? 0 });
    const id = env.results?.[0]?.entity_id;
    if (id) ids.push(id);
  }
  if (ids.length) {
    const env = await run("recommend", { target_type: "brand", signals: ids, limit: 5 });
    trace.push({ tool: "qloo_recommend", args: { target_type: "brand", signals: ids }, status: env.status, result_count: env.result_count ?? 0 });
  }
  const cues = term.editorial_cues.slice(0, 3).map((c) => ({
    role: c.role, label: c.name, connection_type: c.kind.includes("sound") ? "approximate sound" : "reinforcement",
    connection: c.connection, grounding: "SYNTHETIC: fixture proposal, not a model or Qloo result",
    qloo_entity_id: null, qloo_entity_type: null, source: "synthetic",
  }));
  return { status: "ok", model: "synthetic", cues, notes: "Synthetic demo agent (no ANTHROPIC_API_KEY, mock Qloo).", trace, usage: null };
}
