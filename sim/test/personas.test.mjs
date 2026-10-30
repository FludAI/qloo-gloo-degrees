import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'personas');
const TYPES = new Set(['brand', 'movie', 'tv_show', 'artist', 'book', 'place', 'person', 'video_game']);
const KINDS = new Set(['film', 'tv']);
const SOURCES = new Set(['transcript', 'curated']);
const WHERE_KEYS = new Set(['season', 'episode', 'scene']);

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

test('the library holds twelve personas', () => {
  assert.equal(files.length, 12);
});

for (const file of files) {
  test(`${file} matches the persona format`, () => {
    const p = JSON.parse(readFileSync(join(DIR, file), 'utf8'));

    assert.equal(typeof p.slug, 'string');
    assert.match(p.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug is kebab-case');
    assert.equal(file, `${p.slug}.json`, 'file is named after the slug');
    assert.equal(typeof p.name, 'string');
    assert.ok(p.name.trim().length > 0);

    assert.equal(typeof p.work, 'object');
    assert.equal(typeof p.work.title, 'string');
    assert.ok(p.work.title.trim().length > 0);
    assert.ok(KINDS.has(p.work.kind), `work.kind is film or tv, got ${p.work.kind}`);
    assert.equal(typeof p.work.year, 'number');
    assert.ok(p.work.year >= 1900 && p.work.year <= 2030);

    assert.equal(typeof p.manner, 'string');
    assert.ok(p.manner.trim().length > 20, 'manner is a sentence');
    assert.equal((p.manner.match(/[.!?](\s|$)/g) ?? []).length, 1, 'manner is one sentence');

    assert.ok(SOURCES.has(p.words_source), `words_source is transcript or curated, got ${p.words_source}`);

    assert.ok(Array.isArray(p.likes));
    assert.ok(p.likes.length >= 5 && p.likes.length <= 10, `5 to 10 likes, got ${p.likes.length}`);
    const likeNames = new Set();
    for (const like of p.likes) {
      assert.equal(typeof like.name, 'string');
      assert.ok(like.name.trim().length > 0);
      assert.ok(!likeNames.has(like.name.toLowerCase()), `duplicate like ${like.name}`);
      likeNames.add(like.name.toLowerCase());
      assert.ok(TYPES.has(like.type), `${like.name}: type ${like.type} is not allowed`);
      assert.equal(typeof like.why, 'string');
      assert.ok(like.why.trim().length >= 20, `${like.name}: why is the on-screen evidence and cannot be empty`);
    }

    assert.ok(Array.isArray(p.words));
    assert.ok(p.words.length >= 15 && p.words.length <= 40, `15 to 40 words, got ${p.words.length}`);
    const seen = new Set();
    for (const entry of p.words) {
      assert.equal(typeof entry.word, 'string');
      assert.match(entry.word, /^[a-z][a-z'-]*[a-z]$/, `${entry.word}: a single lowercase word`);
      assert.ok(!seen.has(entry.word), `duplicate word ${entry.word}`);
      seen.add(entry.word);
      assert.equal(typeof entry.where, 'object');
      assert.ok(entry.where !== null);
      const keys = Object.keys(entry.where);
      assert.ok(keys.length > 0, `${entry.word}: where names a season, episode or scene`);
      for (const k of keys) assert.ok(WHERE_KEYS.has(k), `${entry.word}: where.${k} is not season, episode or scene`);
      if ('season' in entry.where) assert.equal(typeof entry.where.season, 'number');
      if ('episode' in entry.where) assert.equal(typeof entry.where.episode, 'number');
      if ('scene' in entry.where) {
        assert.equal(typeof entry.where.scene, 'string');
        assert.ok(entry.where.scene.trim().length > 0);
      }
    }

    const allowed = new Set(['slug', 'name', 'work', 'manner', 'words_source', 'likes', 'words']);
    for (const k of Object.keys(p)) assert.ok(allowed.has(k), `unexpected top-level field ${k}`);
  });
}
