// The demo's limiter (limits.mjs): a synthetic (simulated) session has its own hourly Qloo cap; every other kind,
// and the daily Qloo cap, are what they were.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LIMIT_QLOO_PER_SESSION_HOUR = "2";
process.env.LIMIT_QLOO_PER_SESSION_HOUR_SYNTHETIC = "4";
process.env.LIMIT_QLOO_GLOBAL_DAY = "100";
const { take, caps, remaining } = await import("../src/limits.mjs");

test("a real session stops at its hourly Qloo cap; a synthetic one at its own, higher cap; both count against the day", () => {
  assert.equal(caps().qloo, 2); assert.equal(caps().qloo_synthetic, 4);
  const before = remaining("qloo");
  assert.deepEqual([take("qloo", "real").ok, take("qloo", "real").ok, take("qloo", "real").ok], [true, true, false]);
  assert.match(take("qloo", "real").reason, /Hourly qloo limit/);
  const syn = Array.from({ length: 5 }, () => take("qloo", "syn", { synthetic: true }).ok);
  assert.deepEqual(syn, [true, true, true, true, false]);
  assert.equal(before - remaining("qloo"), 6, "six calls were granted in all, each from the shared daily budget");
  // The flag changes nothing for the other kinds.
  assert.equal(take("agent", "syn", { synthetic: true }).ok, true);
});
