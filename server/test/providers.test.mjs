// The provider layer (providers.mjs) without a network: which backend answers for which arm, the fallback when a
// key is missing and its record, and the unavailable case. Live calls are covered by the API test's fake servers.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.META_API_KEY;
const { pick, available, availability, anyAvailable, complete, PROVIDERS, MODELS } = await import("../src/providers.mjs");

test("no keys: nothing is available and a call says so without touching the network", async () => {
  assert.deepEqual(PROVIDERS, ["anthropic", "meta"]);
  assert.deepEqual(availability(), { anthropic: false, meta: false });
  assert.equal(anyAvailable(), false);
  assert.equal(pick("meta"), null); assert.equal(pick("anthropic"), null);
  await assert.rejects(complete({ provider: "meta", task: "read_word", max_tokens: 10, messages: [] }), (e) => e.code === "MODEL_UNAVAILABLE");
});

test("each arm answers for itself when keyed; a missing key falls back to the other and records where it came from", () => {
  process.env.ANTHROPIC_API_KEY = "test-not-a-key";
  assert.deepEqual(pick("anthropic"), { provider: "anthropic", fallback_from: null });
  assert.deepEqual(pick("meta"), { provider: "anthropic", fallback_from: "meta" });
  assert.deepEqual(pick("nonsense"), { provider: "anthropic", fallback_from: null }, "an unknown arm means the default");
  process.env.META_API_KEY = "test-not-a-key-either";
  assert.deepEqual(pick("meta"), { provider: "meta", fallback_from: null });
  assert.equal(available("meta"), true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(pick("anthropic"), { provider: "meta", fallback_from: "anthropic" }, "the fallback goes both ways");
  assert.equal(MODELS.anthropic, "claude-sonnet-5-5"); assert.equal(MODELS.meta, "muse-spark-1.3");
  delete process.env.META_API_KEY;
});
