# sim: a persona library for simulated learners

This folder holds twelve learner personas that a simulator can play
against the Gloo API, plus the vocabulary tool that chose their words.
Each persona is a film or television character whose tastes are public
and on screen, and whose word list is made of hard words that character
actually says. Sessions a simulator opens with these personas are
marked synthetic by the simulator; nothing here is a real person.

## Layout

```
sim/
  personas/<slug>.json   one file per persona
  vocab.mjs              hardWords(lines, { floor }) and the frequency list loader
  tools/extract.mjs      reads a transcript on disk and prints a character's hard words
  freq/en_50k.txt        English word frequency list (see freq/README.md)
  test/                  node --test "sim/test/*.test.mjs"
```

## Persona format

```json
{
  "slug": "sheldon-cooper",
  "name": "Sheldon Cooper",
  "work": { "title": "The Big Bang Theory", "kind": "tv", "year": 2007 },
  "manner": "One sentence on how this character answers a question.",
  "words_source": "transcript",
  "likes": [
    { "name": "Halo", "type": "video_game", "why": "Wednesday is Halo night and he refuses to move it." }
  ],
  "words": [
    { "word": "positronium", "where": { "season": 1, "episode": 2, "scene": "the apartment" } }
  ]
}
```

- `work.kind` is `film` or `tv`. For a film series the work is the
  series and `year` is the first film's; each word's `scene` then names
  the film.
- `manner` describes how the character answers, never the performer.
- `likes` has 5 to 10 items. `type` is one of `brand`, `movie`,
  `tv_show`, `artist`, `book`, `place`, `person`, `video_game`. `why`
  is the on-screen evidence, one sentence.
- `words` has 15 to 40 items. `where` is an object with any of
  `season`, `episode` and `scene`, at least one of them present.
- `words_source` is `transcript` when the words were extracted from
  the character's lines with `vocab.mjs`, or `curated` when they were
  written down from well-known on-screen vocabulary.

`test/personas.test.mjs` checks every file against this.

## Two rules

**Canon only.** A like is something the character is shown liking,
wearing, eating, quoting, driving or returning to on screen. Nothing
comes from a recommendation service and nothing comes from the life of
the performer. The `why` field carries the evidence and is required.

**Words, not lines.** Transcripts are read only to extract vocabulary.
The repository stores single words and where they were said; it never
stores dialogue. Single words carry no rights; lines do.

## How the words were chosen

`vocab.mjs` exports `hardWords(lines, { floor })`. It tokenizes a
character's lines, lowercases them, drops non-words and names, keeps
the words whose rank in the frequency list is `floor` or beyond (or
which the list does not rank), and returns them ordered by how often
the character says them, with one `where` per word: the first place it
was said. Ties go to the rarer word, then to the one said first, so the
output is stable for the same input.

A name is a token the character never says in lowercase that either
appears capitalized mid-sentence or is unknown to the frequency list.
Contractions are ranked by their base word, since subtitle corpora
split them. The default floor is 5000.

The frequency list is the OpenSubtitles 2018 English list from the
FrequencyWords project (CC BY-SA 4.0), kept unchanged under `freq/`
with its origin and license in `freq/README.md`. A subtitle list was
chosen because it ranks the words people say on screen.

`tools/extract.mjs` runs the same function over a transcript file on
disk. It understands two layouts: a screenplay with speaker cues and
`INT.`/`EXT.` sluglines, and a `Speaker: line` transcript with
`Scene:` or bracketed scene markers. Its output is words and `where`
only.

## Sources

Transcript-sourced personas (`"words_source": "transcript"`), with the
corpus each was read from:

| Persona | Work | Corpus |
| --- | --- | --- |
| Ferris Bueller | Ferris Bueller's Day Off (1986) | screenplay on IMSDb |
| Cher Horowitz | Clueless (1995) | screenplay on IMSDb |
| Vincent Vega | Pulp Fiction (1994) | screenplay on IMSDb |
| Miranda Priestly | The Devil Wears Prada (2006) | screenplay on IMSDb |
| Sheldon Cooper | The Big Bang Theory, season 1 | fan transcripts at bigbangtrans.wordpress.com |
| Gregory House | House, season 8 | fan transcripts at clinic-duty.livejournal.com |

The screenplays on IMSDb are shooting or draft scripts, so a word may
sit in a scene that was cut or moved in the finished film; `where`
reflects the script. For the two series, `season` and `episode` come
from the transcript pages and `scene` from their scene markers.

The forty strongest words from each extraction were kept after a hand
pass that removed slang spellings, profanity and the script's own
typos. Everything else in these files is the extraction's output.

Curated personas (`"words_source": "curated"`), whose transcripts were
not available in a speaker-attributed form: Hermione Granger, Tony
Stark, Alicia Florrick, Leslie Knope, Walter White, Fleabag. Their
word lists are vocabulary the character is known to say on screen,
with the film, season or episode in `where` where it is certain and
a scene description otherwise.

## Tests

```
node --test "sim/test/*.test.mjs"
```

`vocab.test.mjs` covers the floor, name dropping, contraction ranking
and stable ordering with a small in-test frequency list, and checks
that the shipped list loads. `personas.test.mjs` validates every
persona file against the format above.
