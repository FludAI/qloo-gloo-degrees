// The media store's prefix: a second deployment keeps its objects apart from production's in the same bucket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/media.mjs";

test("MEDIA_PREFIX goes in front of every key on the backend and nowhere else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloo-media-prefix-"));
  const plain = createStore({ forceLocal: true, dir });
  const degrees = createStore({ forceLocal: true, dir, prefix: "degrees/" });
  assert.equal(degrees.prefix, "degrees/"); assert.equal(plain.prefix, "");
  await plain.putJson("qloo/entities.json", { a: 1 });
  await degrees.putJson("qloo/entities.json", { b: 2 });
  assert.ok(existsSync(join(dir, "qloo/entities.json")) && existsSync(join(dir, "degrees/qloo/entities.json")));
  assert.deepEqual(await plain.getJson("qloo/entities.json"), { a: 1 });
  assert.deepEqual(await degrees.getJson("qloo/entities.json"), { b: 2 });
  await degrees.del("qloo/entities.json");
  assert.equal(await degrees.getJson("qloo/entities.json"), null);
  assert.deepEqual(await plain.getJson("qloo/entities.json"), { a: 1 }, "production's object untouched");
  assert.throws(() => createStore({ forceLocal: true, dir, prefix: "Degrees" }), /bad media prefix/);
  assert.throws(() => createStore({ forceLocal: true, dir, prefix: "../x/" }), /bad media prefix/);
});
