// Durable media: spoken clips and pictures, paid for once and kept across redeploys.
// Cloud Storage through Application Default Credentials (the Cloud Run runtime account);
// without credentials, a folder under server/data/media/ so the flow still works locally.
// A small in-memory LRU sits in front of either. Keys look like "audio/<sha256>.mp3".
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = /^[a-z0-9][a-z0-9/_.-]{0,200}$/;

class Lru {
  constructor({ maxItems = 300, maxBytes = 48 * 1024 * 1024 } = {}) { this.max = maxItems; this.maxBytes = maxBytes; this.bytes = 0; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v === undefined) return undefined; this.map.delete(k); this.map.set(k, v); return v; }
  set(k, v) {
    const size = v?.length ?? 64;
    if (size > this.maxBytes / 4) return;
    if (this.map.has(k)) this.delete(k);
    this.map.set(k, v); this.bytes += size;
    while (this.map.size > this.max || this.bytes > this.maxBytes) this.delete(this.map.keys().next().value);
  }
  delete(k) { const v = this.map.get(k); if (v === undefined) return; this.map.delete(k); this.bytes -= v?.length ?? 64; }
  clear() { this.map.clear(); this.bytes = 0; }
}

function localBackend(dir) {
  const path = (key) => resolve(dir, key);
  return {
    mode: "local",
    async get(key) { try { return await readFile(path(key)); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
    async put(key, bytes) { await mkdir(dirname(path(key)), { recursive: true }); await writeFile(path(key), bytes); },
    async del(key) { try { await unlink(path(key)); } catch (e) { if (e.code !== "ENOENT") throw e; } },
  };
}

async function gcsBackend(bucketName, timeoutMs) {
  const { Storage } = await import("@google-cloud/storage");
  const bucket = new Storage().bucket(bucketName);
  // Prove credentials and the bucket exist before claiming durability; otherwise fall back.
  const probe = bucket.getMetadata().then(() => true);
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("gcs probe timed out")), timeoutMs).unref?.());
  await Promise.race([probe, timer]);
  return {
    mode: "gcs",
    async get(key) {
      try { const [buf] = await bucket.file(key).download(); return buf; }
      catch (e) { if (e.code === 404) return null; throw e; }
    },
    async put(key, bytes, contentType) { await bucket.file(key).save(bytes, { contentType, resumable: false, metadata: { cacheControl: "private, max-age=0" } }); },
    async del(key) { await bucket.file(key).delete({ ignoreNotFound: true }); },
  };
}

// opts: { bucket, dir, forceLocal, probeTimeoutMs, prefix }. The backend is chosen once, on first use.
// `prefix` goes in front of every key in the backend ("degrees/" makes "audio/x.mp3" live at "degrees/audio/x.mp3"),
// so a second deployment can share a bucket with production and never read or write its objects.
const PREFIX = /^(?:[a-z0-9][a-z0-9_.-]*\/)*$/;
export function createStore(opts = {}) {
  const dir = opts.dir ?? resolve(here, "../data/media");
  const prefix = String(opts.prefix ?? "");
  if (!PREFIX.test(prefix)) throw new Error(`bad media prefix: ${prefix} (lowercase segments ending in /)`);
  const at = (key) => prefix + key;
  const lru = new Lru(opts.lru);
  const missing = new Set(); // keys known not to exist, so a miss doesn't hit the bucket twice
  let backend = null;
  const ready = async () => {
    if (backend) return backend;
    if (!opts.forceLocal && opts.bucket) {
      try { backend = await gcsBackend(opts.bucket, opts.probeTimeoutMs ?? 6000); }
      catch (e) { console.warn(`media: bucket ${opts.bucket} unavailable (${e.message.split("\n")[0]}); using ${dir}`); }
    }
    backend ??= localBackend(dir);
    return backend;
  };
  const check = (key) => { if (!KEY.test(key)) throw new Error(`bad media key: ${key}`); return key; };
  const store = {
    mode: async () => (await ready()).mode,
    prefix,
    async get(key) {
      check(key);
      const hit = lru.get(key);
      if (hit !== undefined) return hit;
      if (missing.has(key)) return null;
      const bytes = await (await ready()).get(at(key));
      if (bytes) lru.set(key, bytes); else missing.add(key);
      return bytes;
    },
    async put(key, bytes, contentType = "application/octet-stream") {
      check(key);
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await (await ready()).put(at(key), buf, contentType);
      missing.delete(key);
      lru.set(key, buf);
    },
    async del(key) { check(key); await (await ready()).del(at(key)); lru.delete(key); missing.add(key); },
    async getJson(key) { const b = await store.get(key); if (!b) return null; try { return JSON.parse(b.toString("utf8")); } catch { return null; } },
    putJson: (key, value) => store.put(key, Buffer.from(JSON.stringify(value)), "application/json"),
    forget: () => { lru.clear(); missing.clear(); },
  };
  return store;
}

// The app's store: MEDIA_BUCKET (default gloo-media-bondswipe), MEDIA_LOCAL=1 forces the folder, MEDIA_DIR moves it,
// MEDIA_PREFIX ("degrees/") keeps a second deployment's objects apart from production's in the same bucket.
export const media = createStore({
  bucket: process.env.MEDIA_BUCKET ?? "gloo-media-bondswipe",
  dir: process.env.MEDIA_DIR,
  forceLocal: process.env.MEDIA_LOCAL === "1",
  prefix: process.env.MEDIA_PREFIX ?? "",
});

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
