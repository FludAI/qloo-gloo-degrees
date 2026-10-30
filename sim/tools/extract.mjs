// Pull one character's lines out of a transcript the user has on disk
// and print the hard words. Only words and their `where` leave this
// tool; the lines themselves are read and discarded.
//
//   node sim/tools/extract.mjs --format screenplay --speaker FERRIS \
//        --where '{"scene":"film"}' --floor 5000 path/to/script.txt
//   node sim/tools/extract.mjs --format colon --speaker Sheldon \
//        --where '{"season":1,"episode":1}' path/to/episode.txt
//
// Formats: `screenplay` (centered ALL-CAPS speaker cue, indented
// dialogue, INT./EXT. sluglines) and `colon` (`Speaker: line`, with
// `Scene: ...` or `[...]` lines as scene markers). The scene marker in
// force when a line is spoken becomes that line's `where.scene`.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hardWords } from '../vocab.mjs';

const SLUG = /^\s*(\d+[A-Z]?\.?\s+)?(INT\.|EXT\.|INT\/EXT\.?|I\/E\.|INT\s|EXT\s|SCENE\s+[IVXLC\d]+\b)/;
const CUE = /^[A-Z][A-Z0-9 .'&-]*(\s*\(.*\))?$/;
const FLAT_CUE = /^[A-Z][A-Z.'&-]*(\s[A-Z][A-Z.'&-]*){0,3}(\s+V\.?O\.?)?(\s*\(.*\))?$/;

/**
 * Screenplays come in two layouts: the usual one indents the speaker
 * cue far to the right of the dialogue, and a flat one puts cues and
 * dialogue both at the margin. The layout is detected from whether
 * any cue-shaped line is indented twenty columns or more.
 */
export function linesFromScreenplay(text, speaker, where = {}) {
  const want = speaker.toUpperCase();
  const rows = text.split(/\r?\n/);
  let deep = 0;
  let flat = 0;
  for (const r of rows) {
    const cue = r.trim();
    if (!cue || !CUE.test(cue)) continue;
    if (r.length - r.trimStart().length >= 20) deep += 1;
    else if (r === cue && FLAT_CUE.test(cue)) flat += 1;
  }
  const indented = deep >= flat;
  const isCue = (line, cue) => {
    if (indented) return line.length - line.trimStart().length >= 20 && CUE.test(cue);
    return FLAT_CUE.test(cue) && !/[!?.]$/.test(cue.replace(/\s*\(.*\)$/, '').replace(/V\.?O\.?$/, '').trim());
  };
  const out = [];
  let scene = where.scene;
  let speaking = false;
  let buf = [];
  const flush = () => {
    if (speaking && buf.length) {
      out.push({ text: buf.join(' '), where: { ...where, ...(scene ? { scene } : {}) } });
    }
    buf = [];
  };
  for (const raw of rows) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); if (indented) speaking = false; continue; }
    if (SLUG.test(line)) { flush(); speaking = false; scene = line.trim().replace(/\s+/g, ' '); continue; }
    const cue = line.trim();
    if (isCue(line, cue)) {
      flush();
      const name = cue.replace(/\s*\(.*\)$/, '').trim();
      speaking = name === want || name.startsWith(want + ' ');
      continue;
    }
    if (speaking) {
      if (/^\s*\(.*\)\s*$/.test(line)) continue; // parenthetical
      const spoken = cue.replace(/\([^)]*\)/g, '').trim();
      if (spoken) buf.push(spoken);
    }
  }
  flush();
  return out;
}

export function linesFromColonTranscript(text, speaker, where = {}) {
  const out = [];
  let scene = where.scene;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sceneMark = line.match(/^Scene:\s*(.+)$/i) || line.match(/^\[(?:Cut to|Scene:?)?\s*([^\]]+)\]$/i);
    if (sceneMark) { scene = sceneMark[1].trim().replace(/\.$/, ''); continue; }
    const m = line.match(/^([^:\[\]]{1,40}):\s*(.+)$/);
    if (!m) continue;
    if (m[1].trim().toLowerCase() !== speaker.toLowerCase()) continue;
    const spoken = m[2].replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim();
    if (spoken) out.push({ text: spoken, where: { ...where, ...(scene ? { scene } : {}) } });
  }
  return out;
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const format = arg('--format', 'colon');
  const speaker = arg('--speaker');
  const where = JSON.parse(arg('--where', '{}'));
  const floor = Number(arg('--floor', '5000'));
  const argv = process.argv.slice(2);
  const files = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
  if (!speaker || !files.length) {
    console.error('usage: extract.mjs --format screenplay|colon --speaker NAME [--where JSON] [--floor N] files...');
    process.exit(2);
  }
  const lines = files.flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    return format === 'screenplay'
      ? linesFromScreenplay(text, speaker, where)
      : linesFromColonTranscript(text, speaker, where);
  });
  console.log(JSON.stringify({ speaker, lines: lines.length, words: hardWords(lines, { floor }) }, null, 2));
}
