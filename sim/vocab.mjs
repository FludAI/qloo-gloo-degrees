// Hard words from a character's lines.
//
// hardWords(lines, { floor }) tokenizes the lines, drops names and
// non-words, keeps the words the frequency list ranks at `floor` or
// beyond (or does not rank at all), and returns them ordered by how
// often the character says them, each with the `where` of its first
// occurrence. Plain ESM, Node 22, no dependencies beyond node:.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FREQ_PATH = join(HERE, 'freq', 'en_50k.txt');
export const DEFAULT_FLOOR = 5000;

let cachedFreq = null;

/** Read a `word count` list into a Map of word -> 1-based rank. */
export function loadFrequencyList(path = DEFAULT_FREQ_PATH) {
  if (path === DEFAULT_FREQ_PATH && cachedFreq) return cachedFreq;
  const ranks = new Map();
  const text = readFileSync(path, 'utf8');
  let rank = 0;
  for (const line of text.split('\n')) {
    const word = line.trim().split(/\s+/)[0];
    if (!word) continue;
    rank += 1;
    if (!ranks.has(word)) ranks.set(word, rank);
  }
  if (path === DEFAULT_FREQ_PATH) cachedFreq = ranks;
  return ranks;
}

const TOKEN = /[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]/g;
const WORD = /^[a-z][a-z'-]*[a-z]$/;
// Text between two tokens that closes a sentence: a terminator with
// nothing but space, quotes, brackets or dashes around it.
const SENTENCE_BREAK = /^[\s"'“”‘’()\[\]—-]*[.!?…][\s"'“”‘’()\[\]—-]*$/;

/**
 * Split one line into tokens with their casing context.
 * Returns [{ raw, word, initial }], where `initial` is true when the
 * token opens the line or follows a sentence end.
 */
export function tokenize(text) {
  const out = [];
  const str = String(text ?? '');
  let lastEnd = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(str))) {
    const between = str.slice(lastEnd, m.index);
    const initial = out.length === 0 || SENTENCE_BREAK.test(between);
    const raw = m[0].replace(/’/g, "'");
    out.push({ raw, word: raw.toLowerCase(), initial });
    lastEnd = m.index + m[0].length;
  }
  return out;
}

function isAllCaps(raw) {
  return raw.length > 1 && raw === raw.toUpperCase();
}

function isCapitalized(raw) {
  return /^[A-Z]/.test(raw) && !isAllCaps(raw);
}

const CLITIC = /^(.*?)(n't|'s|'re|'ve|'ll|'d|'m)$/;

/**
 * Rank of a word in the list. Subtitle lists split contractions, so a
 * word like "don't" or "driver's" that the list does not know is
 * ranked by its base ("do", "driver"); "can't" and "won't" fall back
 * to "can" and "won". The clitic itself is never a hard word.
 */
export function rankOf(word, freq) {
  const direct = freq.get(word);
  if (direct !== undefined) return direct;
  const m = word.match(CLITIC);
  if (!m) return null;
  const base = m[1];
  if (!base) return null;
  const candidates = m[2] === "n't" ? [base, base + 'n'] : [base];
  for (const c of candidates) {
    const r = freq.get(c);
    if (r !== undefined) return r;
  }
  return null;
}

/**
 * @param {Array<string | { text: string, where?: object }>} lines
 * @param {{ floor?: number, freq?: Map<string, number>, names?: Iterable<string>, limit?: number }} opts
 * @returns {Array<{ word: string, count: number, rank: number | null, where: object }>}
 *
 * A word is dropped as a name when the character never says it in
 * lowercase and either says it capitalized mid-sentence or the
 * frequency list does not know it. Extra names can be passed in
 * `names`. A word is hard when its rank is `floor` or beyond, or when
 * the list does not rank it. Ties in count go to the rarer word, then
 * to the one said first, so the order is stable for the same input.
 */
export function hardWords(lines, opts = {}) {
  const floor = Number.isFinite(opts.floor) ? opts.floor : DEFAULT_FLOOR;
  const freq = opts.freq ?? loadFrequencyList();
  const knownNames = new Set([...(opts.names ?? [])].map((n) => String(n).toLowerCase()));

  const stats = new Map(); // word -> { count, lower, capMid, where, order }
  let order = 0;
  for (const entry of lines ?? []) {
    const text = typeof entry === 'string' ? entry : entry?.text;
    const where = typeof entry === 'string' ? {} : entry?.where ?? {};
    if (!text) continue;
    for (const tok of tokenize(text)) {
      if (tok.word.length < 3 || !WORD.test(tok.word)) continue;
      let s = stats.get(tok.word);
      if (!s) {
        s = { count: 0, lower: false, capMid: false, where, order: order++ };
        stats.set(tok.word, s);
      }
      s.count += 1;
      if (tok.raw === tok.word) s.lower = true;
      else if (isCapitalized(tok.raw) && !tok.initial) s.capMid = true;
    }
  }

  const out = [];
  for (const [word, s] of stats) {
    if (knownNames.has(word)) continue;
    const rank = rankOf(word, freq);
    const looksLikeName = !s.lower && (s.capMid || rank === null);
    if (looksLikeName) continue;
    if (rank !== null && rank < floor) continue;
    out.push({ word, count: s.count, rank, where: s.where, order: s.order });
  }
  out.sort((a, b) =>
    b.count - a.count
    || (b.rank ?? Infinity) - (a.rank ?? Infinity)
    || a.order - b.order);
  const limited = Number.isFinite(opts.limit) ? out.slice(0, opts.limit) : out;
  return limited.map(({ order: _o, ...rest }) => rest);
}
