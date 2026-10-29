// End-to-end check against a running server: health -> lesson -> practice -> gloo it -> (optional) Qloo + agent.
// Usage: npm run smoke                                   (http://localhost:8787)
//        SMOKE_URL=https://your-demo.run.app npm run smoke
//        SMOKE_PASSCODE=... unlocks a passcode-gated demo; SMOKE_QLOO=1 also runs the Qloo describe and agent steps
//        (those spend event credit on a cache miss, so they are off by default).
const BASE = process.env.SMOKE_URL ?? "http://localhost:8787";
// Cookie jar keyed by name: hosts like Cloud Run add their own cookies (e.g. session affinity) alongside gloo_sid.
const jar = new Map();
async function call(method, path, body) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(BASE + path, {
    method, headers: { ...(cookie && { cookie }), ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  for (const set of res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean)) {
    const [k, v] = set.split(";")[0].split("=");
    if (k) jar.set(k.trim(), v ?? "");
  }
  return { status: res.status, body: await res.json() };
}
const ok = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) process.exitCode = 1; };

const health = (await call("GET", "/api/health")).body;
console.log("health:", JSON.stringify({ qloo: health.qloo, agent: health.agent, stt: health.stt, camera: health.camera, gated: health.gated }));
if (health.gated) {
  if (!process.env.SMOKE_PASSCODE) console.log("note: demo is passcode-gated; set SMOKE_PASSCODE to test metered paths");
  else ok((await call("POST", "/api/unlock", { code: process.env.SMOKE_PASSCODE })).body.unlocked === true, "passcode unlocks the session");
}
ok((await call("GET", "/api/terms/brier-score")).body.locked === true, "lesson locked before first attempt");
await call("POST", "/api/terms/brier-score/first-attempt", { response: "how good a forecast was" });
ok((await call("GET", "/api/terms/brier-score")).body.locked === false, "lesson unlocks after first attempt");
const a = (await call("POST", "/api/attempts", { prompt_id: "brier-mean", response: "0.065", idempotency_key: `smoke-${Date.now()}` })).body;
ok(a.outcome === "correct" && a.independent, "Brier mean 0.065 scored correct and independent");

const g = (await call("POST", "/api/glue", { text: "Gloo it, cholecystokinen", mode: "typed" })).body;
ok(g.term_id === "cholecystokinin" && g.resolution.method === "spelling", "Gloo it resolves a typo to the reviewed lesson without AI");
const v = (await call("POST", "/api/glue", { text: "glue it, brier score", mode: "voice" })).body;
ok(v.term_id === "brier-score" && v.resolution.mode === "voice", "a spoken 'gloo it, brier score' opens the Brier lesson");

if (process.env.SMOKE_QLOO === "1") {
  const describe = (await call("POST", "/api/cues/resolve", { entity: "Breyers", type: "brand" })).body;
  console.log(`qloo describe(Breyers) -> ${describe.envelope?.status ?? describe.error}:`, describe.envelope?.error ? `${describe.envelope.error.code}: ${describe.envelope.summary}` : (describe.items ?? []).slice(0, 3).map((i) => `${i.name} [${i.id}]`));
  ok(describe.envelope && describe.envelope.status !== "error", "Qloo describe reachable");

  await call("GET", "/api/level?qloo=3"); // the agent is degree 3 of Qloo
  const agent = (await call("POST", "/api/cues/agent", { term_id: "brier-score", familiar: ["Breyers", "Moneyball"] })).body;
  console.log(`agent -> ${agent.status ?? agent.error}${agent.model ? ` (${agent.model})` : ""}`);
  for (const s of agent.trace ?? []) console.log(`   ${s.tool} ${JSON.stringify(s.args)} -> ${s.status} · ${s.result_count}`);
  for (const c of agent.cues ?? []) console.log(`   cue [${c.role}] ${c.label} · ${c.source}: ${c.connection}`);
  ok(["ok", "unavailable"].includes(agent.status), "agent returned a usable state");
} else {
  console.log("skipped: Qloo describe and agent (set SMOKE_QLOO=1 to run them; they spend event credit on a cache miss)");
}

if (process.env.SMOKE_TASTE === "1") {
  // The taste loop: two picks (Pepsi, Twisted Sister), then the cholecystokinin pick cards ranked for them.
  // Spends up to 2 describes + 4 ranks on a cache miss; everything is cached after that.
  await call("POST", "/api/terms/cholecystokinin/first-attempt", { skipped: true });
  const pick = async (roleId, name) => {
    const role = (await call("GET", "/api/terms/cholecystokinin")).body.roles.find((r) => r.id === roleId);
    const o = role.pick.options.find((x) => x.name === name);
    const cues = (await call("POST", "/api/learner/cues", { term_id: "cholecystokinin", role: roleId, label: o.name, connection: o.connection, source: "pick", recognized: true })).body;
    return cues.find((c) => c.role === roleId);
  };
  const a = await pick("chole", "Pepsi-Cola"), b = await pick("cysto", "Twisted Sister");
  console.log(`picks -> ${a.label} [${a.qloo_entity_id ?? "no id"}] ${a.hook_source}, ${b.label} [${b.qloo_entity_id ?? "no id"}] ${b.hook_source}`);
  const term = (await call("GET", "/api/terms/cholecystokinin")).body;
  for (const r of term.roles) if (r.pick) console.log(`   ${r.id.padEnd(6)} ${r.pick.tailoring.source.padEnd(9)} ${r.pick.options.map((o) => o.taste != null ? `${o.name} (${o.taste})` : o.name).join(" · ")}${r.pick.tailoring.reason ? ` · ${r.pick.tailoring.reason}` : ""}`);
  const ranked = term.roles.filter((r) => r.pick?.tailoring.source === "taste");
  ok(ranked.length > 0, "at least one pick card ranked for the learner's taste");
  const inRole = term.roles.find((r) => r.id === "in");
  const c = await pick("in", inRole.pick.options[0].name);
  const hooks = (await call("GET", "/api/progress/cholecystokinin")).body.hooks;
  console.log(`third pick -> ${c.label} ${c.hook_source} at ${c.shown_rank}; progress: ${hooks.line}`);
  ok(hooks.term.total === 3, "progress counts the three hooks");
} else {
  console.log("skipped: taste loop (set SMOKE_TASTE=1; two picks and up to six Qloo calls on a cache miss)");
}
await call("DELETE", "/api/learner");
