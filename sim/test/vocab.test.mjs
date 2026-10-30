import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardWords, tokenize, loadFrequencyList } from '../vocab.mjs';

// A tiny frequency list so the tests do not depend on the shipped one.
const freq = new Map(Object.entries({
  the: 1, you: 2, and: 3, say: 4, cola: 5, favorite: 6, word: 7,
  doctor: 8, river: 9, stone: 10, quantum: 11, hypothesis: 12,
  ubiquitous: 13, apostrophe: 14,
}));

test('tokenize marks sentence-initial tokens', () => {
  const toks = tokenize('Hello there. Cameron is here! Yes.');
  assert.deepEqual(toks.map((t) => [t.word, t.initial]), [
    ['hello', true], ['there', false], ['cameron', true], ['is', false],
    ['here', false], ['yes', true],
  ]);
});

test('floor is respected: only words ranked at or beyond the floor, or unranked, come back', () => {
  const lines = ['say the word cola', 'quantum hypothesis is ubiquitous', 'the apostrophe'];
  const words = hardWords(lines, { floor: 10, freq }).map((w) => w.word);
  assert.ok(!words.includes('say'));
  assert.ok(!words.includes('cola'));
  assert.ok(!words.includes('word'));
  assert.ok(words.includes('stone') === false);
  assert.deepEqual(new Set(words), new Set(['quantum', 'hypothesis', 'ubiquitous', 'apostrophe']));

  const strict = hardWords(lines, { floor: 13, freq }).map((w) => w.word);
  assert.deepEqual(new Set(strict), new Set(['ubiquitous', 'apostrophe']));
});

test('unranked words count as hard', () => {
  const words = hardWords(['the sesquipedalian doctor'], { floor: 10, freq });
  assert.deepEqual(words.map((w) => w.word), ['sesquipedalian']);
  assert.equal(words[0].rank, null);
});

test('names are dropped: capitalized mid-sentence and never lowercase', () => {
  const lines = [
    'I told Cameron the quantum hypothesis.',
    'Cameron said the hypothesis was ubiquitous.',
    'Hypothesis, Sloane, is a quantum word.',
  ];
  const words = hardWords(lines, { floor: 10, freq }).map((w) => w.word);
  assert.ok(!words.includes('cameron'));
  assert.ok(!words.includes('sloane'));
  // "Hypothesis" opens a sentence once but is lowercase elsewhere: kept.
  assert.ok(words.includes('hypothesis'));
});

test('names given explicitly are dropped even in lowercase', () => {
  const words = hardWords(['the ferris and ubiquitous'], { floor: 10, freq, names: ['Ferris'] });
  assert.deepEqual(words.map((w) => w.word), ['ubiquitous']);
});

test('non-words are dropped', () => {
  const words = hardWords(["42 x-ray's $$ ok sesquipedalian ya'll"], { floor: 10, freq });
  const list = words.map((w) => w.word);
  assert.ok(!list.includes('42'));
  assert.ok(!list.includes('x'));
  assert.ok(!list.includes('ok'));
  assert.ok(list.includes('sesquipedalian'));
});

test('ranking is by count, then rarity, then first appearance, and is stable', () => {
  const lines = [
    { text: 'ubiquitous quantum', where: { episode: 1 } },
    { text: 'hypothesis ubiquitous', where: { episode: 2 } },
    { text: 'quantum ubiquitous apostrophe', where: { episode: 3 } },
  ];
  const a = hardWords(lines, { floor: 10, freq });
  const b = hardWords(lines, { floor: 10, freq });
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((w) => w.word), ['ubiquitous', 'quantum', 'apostrophe', 'hypothesis']);
  assert.deepEqual(a.map((w) => w.count), [3, 2, 1, 1]);
  // one `where` per word: the first place it was said
  assert.deepEqual(a[0].where, { episode: 1 });
  assert.deepEqual(a[1].where, { episode: 1 });
  assert.deepEqual(a[3].where, { episode: 2 });
});

test('limit caps the list', () => {
  const words = hardWords(['quantum hypothesis ubiquitous apostrophe'], { floor: 10, freq, limit: 2 });
  assert.equal(words.length, 2);
});

test('the shipped frequency list loads and ranks common words first', () => {
  const list = loadFrequencyList();
  assert.ok(list.size >= 20000);
  assert.ok(list.get('the') < 10);
  assert.ok(list.get('eradicate') > 5000);
});

test('contractions are ranked by their base word', () => {
  const list = new Map(Object.entries({ the: 1, it: 2, do: 3, can: 4, driver: 5, you: 6, encephalitis: 9000 }));
  const words = hardWords(["it's the driver's encephalitis, don't you can't"], { floor: 100, freq: list });
  assert.deepEqual(words.map((w) => w.word), ['encephalitis']);
});
