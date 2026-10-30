# Deploy to Google Cloud Run

The app is one container: the Express API, the built React app, and the Qloo
harness, which the server starts as a `qloo mcp` child process. Cloud Run runs
containers, so this works. Serverless *functions* would not.

## One-time setup

```bash
PROJECT=your-gcp-project
REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com speech.googleapis.com texttospeech.googleapis.com

# Durable media: spoken clips and pictures, paid for once and kept across redeploys (private bucket, same region)
gcloud storage buckets create gs://gloo-media-bondswipe --location $REGION --uniform-bucket-level-access --public-access-prevention

# Secrets: paste each value when prompted (nothing lands in shell history)
printf "Qloo key: " && read -s K && printf %s "$K" | gcloud secrets create qloo-api-key --data-file=- && unset K; echo
printf "Anthropic key: " && read -s K && printf %s "$K" | gcloud secrets create anthropic-api-key --data-file=- && unset K; echo
printf "Demo passcode: " && read -s K && printf %s "$K" | gcloud secrets create gloo-demo-passcode --data-file=- && unset K; echo
printf "Admin token: " && read -s K && printf %s "$K" | gcloud secrets create gloo-admin-token --data-file=- && unset K; echo

# Let Cloud Run's runtime account read them
SA=$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com
for s in qloo-api-key anthropic-api-key gloo-demo-passcode gloo-admin-token; do
  gcloud secrets add-iam-policy-binding $s --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
```

## Deploy (from the repo root)

This repository is the degrees deployment (`qloo.gloo.news`): the same app as `gloo.news`, with the
degree of Qloo drawn per session (`server/src/level.mjs`). It shares production's secrets and media
bucket, and `MEDIA_PREFIX=degrees/` keeps every object it writes apart from production's.

```bash
gcloud run deploy qloo-gloo-degrees --source . --region $REGION \
  --allow-unauthenticated \
  --set-secrets QLOO_API_KEY=qloo-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest,ADMIN_TOKEN=gloo-admin-token:latest,META_API_KEY=meta-api-key:latest \
  --update-env-vars CREDITS_WELCOME=20,PUBLIC_URL=https://qloo.gloo.news,MEDIA_PREFIX=degrees/,TASTE_MIN_PICKS=1 \
  --min-instances 1 --max-instances 1 --session-affinity \
  --memory 1Gi --cpu 1 --timeout 120
```

Then check it:

```bash
SMOKE_URL=$(gcloud run services describe qloo-gloo --region $REGION --format='value(status.url)') npm run smoke
```

Spoken capture calls Speech-to-Text with the service's runtime account; no key
is involved. The account needs the API enabled (above) and a role that includes
`speech.recognize` (the default compute account's Editor role does).

## The voice and the media bucket

The app speaks every line through Google Cloud Text-to-Speech (`server/src/tts.mjs`)
with one fixed voice, `en-US-Neural2-F`, so every phone hears the same thing. Each
sound piece carries IPA (`role.ipa`, next to the `say` respelling) and the server
wraps it, and the whole word, in SSML `<phoneme alphabet="ipa">` tags before
synthesis. Chirp 3 HD voices were the first choice but they do not accept SSML, and
the phoneme tag is the only way to pin a pronunciation, so the voice is Neural2.
`TTS_VOICE` overrides it; health shows the voice in use.

Clips live in the bucket `gs://gloo-media-bondswipe` (`MEDIA_BUCKET`), reached through
the runtime account (Editor is enough), as `audio/<sha256(voice + ssml)>.mp3` with a
JSON sidecar `{ text, term_id, ssml, voice, verified, created_at }`. Pictures for the
picks go to `art/<sha256(title)>` in the same bucket. SQLite on the instance stays the
hot cache and a small in-memory LRU sits in front, so a redeploy loses nothing that was
paid for. Health reports `tts: "google" | "unavailable"` and `media: "gcs" | "local"`;
without credentials (a laptop) the store is a folder under `server/data/media/` and the
browser's own voice speaks.

Rules:

- **Pay once per sentence, ever.** `POST /api/say { text, term_id }` returns the stored
  MP3 when the clip exists and synthesizes only on a miss. Hits never count against the
  per-session limit (`LIMIT_TTS_PER_SESSION_HOUR`, default 60).
- **A verified clip is never resynthesized.** `POST /api/say/verify { text, term_id,
  verified: true }` (the "sounds right" button in the info sheet's debug area, owner
  only) writes `verified/<sha256(term_id + text)>.json` pointing at the clip; that
  pin is served forever, even after the voice or the SSML builder changes. `verified:
  false` removes the pin, and the clip is rebuilt as soon as its IPA, voice or SSML
  changes (which gives it a new key).
- Both routes sit behind the passcode gate like the other metered routes. The web app
  falls back to the browser voice on 401, 503 or any failure.

Cost (checked 2026-10-24): Neural2 is $16 per 1M characters after 1M free per month,
SSML tags included; Chirp 3 HD would be $30. A lesson's spoken lines run to a few
thousand characters once, and never again. Bucket storage for a few hundred clips is
cents per month. The one real synthesis after a deploy, with an unlocked session cookie
in `jar.txt` (the smoke script keeps one):

```bash
curl -s -b jar.txt -X POST "$SMOKE_URL/api/say" -H 'content-type: application/json' -d '{"text":"chole","term_id":"cholecystokinin"}' -o chole.mp3 -D -
```

## Lessons live in the bucket too

Lesson content is a JSON packet per lesson in the same bucket, `lessons/<id>.json`
with `lessons/index.json` naming every id (`server/src/lessons.mjs`). On the first
boot the server seeds the store from `server/src/content/*.mjs`; after that the
store is the source of truth and code never overwrites a stored lesson, so the
owner's edits survive a redeploy. SQLite on the instance is only the hot cache.
The owner edits through `/api/admin/lessons` or the `/edit` console, both behind
`ADMIN_TOKEN` (header `x-gloo-admin`), a Secret Manager secret like the passcode.
See `docs/EDITING.md`.

## Custom domain

`gloo.news` is mapped to the service with a Cloud Run domain mapping (the domain is
verified in Search Console under the deploying account; DNS at Namecheap carries the
four A and four AAAA records the mapping hands out). To map another host:

```bash
gcloud beta run domain-mappings create --service qloo-gloo --domain app.gloo.news --region $REGION
gcloud beta run domain-mappings describe --domain app.gloo.news --region $REGION --format='value(status.resourceRecords)'
```

## Why one warm instance

SQLite lives on the instance's writable layer, which Cloud Run keeps in memory
and drops when the instance stops. Spoken clips and pictures are not affected:
they live in the media bucket (above). `--min-instances 1 --max-instances 1`
keeps a single warm instance so learner sessions persist, and keeps all
sessions on one database.

The degrees service also keeps that database across redeploys
(`server/src/snapshot.mjs`): every five minutes when it changed, and once more
at SIGTERM, the file is copied with SQLite's online backup to the media bucket
as `db/gloo.sqlite` under the service's `MEDIA_PREFIX`, with a sidecar
`db/gloo.sqlite.json` (time, sha256, size, revision, row counts) and a dated copy
once a day kept seven days. `server/src/boot.mjs` (the container's entry)
restores the copy before the database opens when it is newer than the local
file, after checking its sha256 and `PRAGMA integrity_check`; for 90 s after
boot it re-checks the sidecar, so a snapshot written by the revision being
replaced still lands as long as nothing was written here yet. Everything in
the file comes along: learners and their degree and model arm, attempts and
the practice schedule, picks, drafted lessons, the learner graph and briefs,
the credits ledger, the Qloo cache, call rows. `/api/health` shows `memory`
(the last snapshot, what boot restored from), and the testers and degrees
reports open with the restore line. This assumes one instance: raise
`--max-instances` and two instances would restore the same file and diverge,
so set `SNAPSHOT=0` first. The loss window is one timer interval when the
instance dies without SIGTERM. For durable multi-instance hosting, move
`server/src/db.mjs` to Cloud SQL for Postgres; the queries are plain SQL.

## Cost and quota controls

Environment variables (defaults shown):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model for the cue agent |
| `AGENT_MAX_STEPS` | `8` | Max model turns per agent run |
| `LIMIT_AGENT_PER_SESSION_HOUR` | `8` | Agent runs per browser session per hour |
| `LIMIT_AGENT_GLOBAL_DAY` | `300` | Agent runs per day across all visitors |
| `LIMIT_QLOO_PER_SESSION_HOUR` | `60` | Qloo calls per session per hour (cache hits are free) |
| `LIMIT_QLOO_GLOBAL_DAY` | `150` | Qloo calls per day across all visitors (cache hits are free; cached answers persist in SQLite for `QLOO_CACHE_TTL_HOURS`, default 168) |
| `LIMIT_STT_PER_SESSION_HOUR` | `40` | Transcriptions per session per hour |
| `LIMIT_CAMERA_PER_SESSION_HOUR` | `40` | Camera reads per session per hour |
| `LIMIT_TTS_PER_SESSION_HOUR` | `60` | New clips synthesized per session per hour (stored clips are free) |
| `TTS_VOICE` | `en-US-Neural2-F` | The one voice; changing it rebuilds unverified clips only |
| `TTS_DISABLE` | unset | `1` = never use the server voice |
| `MEDIA_BUCKET` | `gloo-media-bondswipe` | Cloud Storage bucket for clips and pictures |
| `MEDIA_LOCAL` / `MEDIA_DIR` | unset | `1` forces the local folder (tests); `MEDIA_DIR` moves it |
| `DEMO_PASSCODE` | unset | When set, camera, voice, the agent and drafting need it once per session. Off since Oct 27, 2026 (the daily caps are the traffic protection); to turn the gate back on, add `DEMO_PASSCODE=gloo-demo-passcode:latest` to `--set-secrets` and redeploy; the share link `?code=…` and the passcode sheet still work |
| `ADMIN_TOKEN` | unset | Owner token for `/api/admin/lessons` and `/edit` (header `x-gloo-admin`); unset = owner API off |
| `CREDITS_WELCOME` | `2` | Gloo on first contact (decision 33) |
| `CREDITS_WORD_COST` | `1` | Gloo per word the agent drafts (refunded if the draft fails) |
| `CREDITS_REFERRAL` | `3` | Gloo to the referrer when a referred friend completes a first word |
| `CREDITS_REFERRAL_CAP` | `10` | Paid referrals per referrer; past it rewards are held for the owner |
| `CREDITS_PROMO_BUDGET` | `3000` | Welcome plus referral Gloo across all learners, ever; past it welcomes stop and rewards are held |
| `CREDITS_SAME_IP_MINUTES` | `60` | A claim from the referrer's own address within this window is held, not paid |
| `CREDITS_SECRET` | `ADMIN_TOKEN` | Keys referral codes and the address hash; set it if the owner token ever rotates |
| `PUBLIC_URL` | request origin | Base of the referral link (`https://gloo.news`) |
| `TASTE_MIN_PICKS` | `2` | Picks a session needs before its pick cards are ranked for it; production and the degrees service run with `1`, so the cards still ahead in a first lesson are ranked after the first pick (a card already picked keeps its order) |
| `DRAFT_MAX_TOKENS` / `DRAFT_MAX_TOKENS_WIDE` | `2500` / `6000` | Output cap of a lesson draft, and of a wide draft (degree 2 asks for eight to twelve candidates per piece). A draft cut at its cap, or one without a pick card, is marked on its row (`no_cards`), drafted once more at four options (`cards_fallback`), and never shipped without a card; the degrees report counts them (`cut/text/no-cards`) |
| `MEDIA_PREFIX` | unset | Put in front of every media key (`degrees/`), so two deployments share one bucket without touching each other's clips, art, lessons or Qloo caches |
| `QLOO_LEVELS` | `0,1,2,3` | The degrees of Qloo a new session may draw (0 editorial, 1 rerank, 2 Qloo cards, 3 agent doorway); `?qloo=N` on any URL forces one for that session; `GET /api/level` reads it; `GET /api/admin/degrees?hours=&format=text` splits outcomes by degree |
| `QLOO_POP_FLOOR` | `0.3` | Degree 2: a drafted pick candidate below this Qloo popularity is dropped |
| `QLOO_DESCRIBE_PER_WORD` | `40` | Degree 2: describe calls per drafted word, at most (every resolved entity is cached for ever) |
| `QLOO_CARD_CANDIDATES` / `QLOO_CARD_KEEP` | `12` / `8` | Degree 2: candidates asked of the drafter per piece, and options kept per card (the card shows four) |
| `QLOO_TAGS_PER_REQUEST` | `10` | `entity_tags` calls one owner look at `/api/admin/learners/:sid/graph` may spend on entities not yet tagged |
| `META_API_KEY` | unset | Meta Model API key (secret `meta-api-key`), the second model backend (`server/src/providers.mjs`): Muse Spark through the API's chat-completions surface (`POST https://api.meta.ai/v1/chat/completions`). Unset = the muse arm reports unavailable and falls back to Claude, recorded on the call's row |
| `META_MODEL` / `META_BASE_URL` | `muse-spark-1.3` / `https://api.meta.ai` | The Meta model (multimodal, tool calling) and where to reach it |
| `META_REASONING_EFFORT` / `META_REASONING_HEADROOM` | `low` / `6000` | Muse Spark always reasons and its reasoning tokens count against the output cap: every muse request sets this effort (unless the task asks for one) and adds this many tokens to its cap. A call that still comes back cut, or that writes its tool call as text, is marked on its row (`stop`, `note`) and counted in the degrees report (`cut/text`) |
| `SNAPSHOT` / `SNAPSHOT_EVERY_MS` | on when `DB_PATH` is a file / `300000` | Database snapshots to the media store (above); `SNAPSHOT=0` turns them off. `SNAPSHOT_SHUTDOWN_MS` (7000) bounds the SIGTERM snapshot, `SNAPSHOT_RECHECK_MS` (90000) the sidecar re-check after boot |
| `BRIEF` / `BRIEF_MAX_CHARS` | on / `700` | The learner brief (`server/src/brief.mjs`): one paragraph per learner from their words, hooks, taste tags and last practice answers (public names and lesson titles only), kept in `learner_briefs` and recomputed after a draft, a first attempt, a pick and each answer. The level 3 agent and the drafter read it; `BRIEF=0` keeps computing it but no prompt reads it. Every model row records the characters carried (`brief`), the degrees report splits draft acceptance with and without one |
| `MODEL_ARMS` | the keyed providers | Which model arms a new session may draw (`anthropic,muse`); `?model=muse` on any URL forces one for that session; `GET /api/level` reads it under `model`; the degrees report splits every outcome by arm |

Set a budget alert on the Anthropic account too. Qloo hackathon keys expire
after the event; after that the demo shows "Qloo: key missing" and keeps the
offline lesson working.
