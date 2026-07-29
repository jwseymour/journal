# Journal

A personal journal, intended to hold its owner's writing for the rest of their life.

Entries are plain markdown files in a directory you control. Everything else — this
application included — is built on top of them and is replaceable.

**Start with [`docs/requirements.md`](docs/requirements.md).** It is the canonical
description of what this is. [`docs/format.md`](docs/format.md) specifies exactly what is
written to disk, [`docs/design.md`](docs/design.md) covers the current frontend, and
[`docs/plan.md`](docs/plan.md) is the build order. Precedence runs in that order.

## Current state

**Milestones 1–7 of 8 are complete.** An entry can be written, autosaved as you type,
edited later, recorded by voice, and given attachments — all as plain markdown files on
disk, with the full keyboard scheme, night mode, and rendered markdown. Listing, lookup
and search are all backed by SQLite, entirely derived and disposable: delete the index
and `npm run rebuild-index` reconstructs everything — listing, lookup, and every
paragraph's embedding — from the journal files alone, with the API behaving identically
before and after.

`GET /search?q=...` finds an entry by what it means, not only by the words it uses:
BM25 full-text and vector nearest-neighbour search run in parallel over paragraph-level
chunks and are combined by reciprocal rank fusion (`requirements.md` §8).

The first derived structure — simple temporal metrics (exercise, alcohol, sleep;
`requirements.md` §5.2) — is extracted through a single provider-agnostic seam,
`ModelClient`, via `npm run reprocess`. Every record links back to the entry it came
from and resolves *when the thing happened*, not when the entry was written
(`requirements.md` §6.3).

Not yet built: reviews, lists of atomic items, the opinion model, metric
suggestion/approval, and analysis surfaces. See [`docs/plan.md`](docs/plan.md).

## The journal directory

You create it yourself. **The application never will** — it refuses to start rather than
invent somewhere to put your writing.

```
~/Journal/                        a git repository, created and maintained by hand
  .git/
  .gitattributes                  attachments marked binary — see below
  journal/
    2026/07/
      2026-07-26-2255-abcde8.md
      2026-07-26-2255-abcde8/     attachments, if any, sitting beside the entry
```

```sh
mkdir -p ~/Journal && git -C ~/Journal init
```

**`.gitattributes` is yours to create too**, not the application's — it never touches
anything git-related in your journal repository, `.gitattributes` included
(`requirements.md` §4.4, §7.4). Once you're keeping attachments, something like this in
`~/Journal/.gitattributes` keeps binary files out of git's text diffing:

```gitattributes
*.jpg binary
*.jpeg binary
*.png binary
*.m4a binary
*.wav binary
```

Git is a safety net around the files, not a feature of the system. The application never
invokes it, never reads its history, and would behave identically without it — it would
simply be less safe. Committing is a scheduled job you set up outside the application.

## Running it

Two processes, deliberately. The frontend is disposable and must never own the backend's
lifetime (`design.md` §6.4).

```sh
npm install

# terminal one — the backend
JOURNAL_DIR=~/Journal npm run dev:api      # http://127.0.0.1:4319

# terminal two — the frontend
npm run dev:web                            # http://localhost:3000
```

The first voice recording downloads a local speech-to-text model (~160MB, once, cached
after that — see `WHISPER_MODEL` below).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JOURNAL_DIR` | *required* | The journal repository root — the directory containing `journal/`. Must already exist. |
| `PORT` | `4319` | Backend port. |
| `HOST` | `127.0.0.1` | Backend bind address. Loopback; going online is a deployment change, not a default. |
| `WEB_ORIGIN` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated browser origins allowed to call the API. Never `*`. |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:4319` | Where the frontend looks for the backend. |
| `WHISPER_MODEL` | `Xenova/whisper-tiny.en` | The local speech-to-text model. One config line — a bigger model for better accuracy is one env var away. |
| `WHISPER_CACHE_DIR` | `~/.cache/journal/whisper-models` | Where the (one-time) downloaded model weights are cached. Derived, regenerable, outside the journal repository. |
| `INDEX_DB_PATH` | `~/.cache/journal/index.db` | The SQLite index — listing, lookup, and search, derived from the journal files. Delete it any time; nothing is lost. |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | The local sentence-embedding model search is built on. |
| `EMBEDDING_DIMENSIONS` | `384` | The vector length `EMBEDDING_MODEL` produces. Not autodetected — boot must never wait on loading a model to find out (same reasoning as `WHISPER_MODEL`) — so a model swap means updating this too. |
| `EMBEDDING_CACHE_DIR` | `~/.cache/journal/embedding-models` | Where the (one-time) downloaded embedding model weights are cached. |
| `AI_GATEWAY_API_KEY` | *unset* | Vercel AI Gateway credential (`requirements.md` §7.6). Extraction refuses clearly if this is missing; nothing else in the application needs it or is affected by its absence. Put it in `.env` at the repository root (already `.gitignore`d) — never in a script argument, where it would sit in shell history. |
| `EXTRACTION_MODEL` | `anthropic/claude-sonnet-5` | The `creator/model-name` string the gateway resolves. The *only* place any model or provider is named — see "The model boundary" below. |

### The API

Everything the frontend can do, `curl` can do — the frontend holds no logic and no
privileged path to the data (`requirements.md` §7.1).

```sh
curl 127.0.0.1:4319/health
curl 127.0.0.1:4319/entries
curl 127.0.0.1:4319/entries/<id>
curl -X POST 127.0.0.1:4319/entries \
  -H 'Content-Type: application/json' \
  -d '{"body":"Something on my mind."}'

# attach a file to an entry — the response's relativeLink is what a
# markdown image/link in the body should point at
curl -X POST 127.0.0.1:4319/entries/<id>/attachments \
  -F 'file=@photo.jpg'

# transcribe raw 32-bit float PCM (mono) at the rate it was captured —
# see apps/web/lib/recorder.ts for how the browser produces this
curl -X POST '127.0.0.1:4319/transcribe?sampleRate=48000' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @recording.pcm

# search by meaning, not only by word — the matching passage comes back,
# not merely the entry it lives in
curl '127.0.0.1:4319/search?q=seaside+holiday'

# extracted temporal metrics — populated by `npm run reprocess`, not live
curl '127.0.0.1:4319/metrics'
curl '127.0.0.1:4319/metrics?metric=sleep'

# discard one wrong record — correction must be easy (`requirements.md` §6.2)
curl -X DELETE 127.0.0.1:4319/metrics/<id>
```

## The index is a cache, not a record

`INDEX_DB_PATH` holds a SQLite database used for listing, id lookup, and search — it
exists so those don't require scanning and re-embedding every file on every request. It
is never the source of truth and boot never rebuilds it automatically
(`requirements.md` §6.4).

```sh
rm ~/.cache/journal/index.db
JOURNAL_DIR=~/Journal npm run rebuild-index
```

This walks the journal directory from scratch and reconstructs everything: the listing
index (the same walk M1's in-memory store always did, just persisted since M5), and —
since M6 — every paragraph re-chunked and re-embedded for search, nothing carried over
from before. The application must behave identically before and after; that drill is
repeated at the end of every milestone from here on.

### How search is built

`GET /search` fuses two independent rankings over paragraph-level chunks
(`plan.md` M6):

- **BM25 full-text**, via SQLite's FTS5 — finds a passage that shares the query's words.
- **Vector nearest-neighbour**, via `sqlite-vec`, over embeddings from a local
  sentence-transformer model — finds a passage that shares the query's *meaning*, even
  when it shares none of its words.

The two rankings are combined by reciprocal rank fusion (`apps/api/src/search/rrf.ts`,
Cormack et al., 2009) rather than compared by raw score, since BM25 and cosine distance
live on incomparable scales. An optional LLM rerank stage over the fused results is part of the
design (`plan.md` M6) but has no real implementation yet — that needs `ModelClient`,
the single seam a model provider is ever named behind, which is M7's job. Until then,
`NoopReranker` (`apps/api/src/search/rerank.ts`) is the honest default: RRF's fused
order is already a real ranking, not a placeholder waiting to be replaced.

Indexing for search happens synchronously on every write, the same as the listing
index — measured at roughly 10ms per paragraph on the machine this was built on, so it
never becomes the bottleneck in an autosave. A failure to index (most likely the
one-time embedding model still downloading) never fails the write itself: the files are
canonical, the search index is a derived cache of them, and a chunk that fails to index
today is caught by the next successful write or the next `rebuild-index`.

**There is no similarity threshold.** Vector kNN is a pure top-k ranker — it always
returns the closest chunks to a query, however distant they actually are, rather than
declining to answer below some cutoff. On a small journal a nonsense query can still
return every entry, ranked by how (un)related they are; a completely empty result only
happens when the journal itself has nothing indexed yet. `plan.md` M6 doesn't call for a
cutoff, and picking one is a real policy decision — worth raising if it turns out to
matter in practice, not something to invent here.

## The model boundary

`apps/api/src/model/model-client.ts` is the single file in which any AI provider is
ever named (`requirements.md` §7.6). Everything else — prompts, Zod schemas, the
extraction pipeline — calls `ModelClient.extract()` and knows nothing about the Vercel
AI Gateway, the AI SDK, or which of Claude, GPT, or Gemini actually answered. Changing
model or provider is changing `EXTRACTION_MODEL`, or swapping what implements
`ModelClient`; nothing above that seam changes shape.

**The seed metric set is deliberately narrow.** `requirements.md` §5.2 names three
examples of "simple temporal metrics" — exercise, alcohol, sleep — and §5.3 is
absolute: the AI never creates a new metric on its own, only suggests one for approval
or extracts against one the user has requested. No suggestion/approval mechanism exists
yet (`plan.md` M8's job), so extraction is restricted to exactly those three named
examples for now — already effectively requested, in the user's own canonical
document, rather than invented at runtime. Growing the set later is additive, once M8's
approval flow exists.

**Extraction never runs live.** Unlike the free, local embedder M6 wires into every
write, an extraction call costs real money per entry. Autosave fires on every debounced
keystroke; a paid API call on every one of those would be both wasteful and a surprise
on the bill. So extraction only ever runs as a deliberate, explicit batch:

```sh
JOURNAL_DIR=~/Journal npm run reprocess
```

This is `rebuild-index`'s M7 counterpart, kept as a *separate* command rather than
folded in: `rebuild-index` stays fast, local, and free whether or not extraction is
configured, and nothing ever spends money on your behalf just because you asked to
rebuild the local indexes. `reprocess` re-sends every entry to the model and replaces
every extracted record from scratch (`requirements.md` §6.4) — nothing is carried over
from a previous run, sequentially rather than in parallel, so cost per entry stays
predictable rather than arriving as a burst.

**This is also the model-migration procedure** (`requirements.md` §7.6): run
`reprocess` once, dump `GET /metrics`, change `EXTRACTION_MODEL`, run it again, dump
again, diff the two. Verified live against the real gateway: `claude-sonnet-5` and
`claude-haiku-4-5` agreed on every metric found (same three records, same entries) but
resolved relative time expressions ("this morning", "tonight", "last night") to
slightly different clock times and paraphrased details differently — exactly the
"schema adherence and extraction quality differ between models even when the calling
code is identical" `requirements.md` §7.6 names as the reason this diff has to be a
real, exercised procedure rather than a theoretical one.

**Correcting a mistake (`requirements.md` §6.2) doesn't survive a reprocess.**
`DELETE /metrics/:id` discards one wrong record now, but running `reprocess` again — or
even just re-saving the entry it came from, once/if extraction is ever wired into live
writes — regenerates it from the entry fresh. That is the honest consequence of §6.4
taken seriously: the derived layer holds nothing that isn't reproducible from the
entries alone, and a correction that *had* to survive a full rebuild would quietly make
the derived store a record of something, which it must never be.

## Checks

```sh
npm run check          # typecheck, lint, boundary, tests
npm run check:boundary # the two standing rules, in grep
```

`scripts/check-boundary.sh` enforces the rules that are cheap to check and expensive to
lose: no storage knowledge in the frontend, and no literal colour, size, duration or font
family outside `apps/web/app/tokens.css`. It is plain grep, so it still works with no
toolchain installed.

## Layout

```
apps/
  api/            the backend, its own process
    src/record/   ids, timestamps, filenames, frontmatter — what goes on disk
    src/store/    EntryStore, the filesystem implementation of it, and the search-indexing decorator
    src/index/    the SQLite indexes — listing/lookup, search, and metrics; derived, disposable, never authoritative
    src/search/   Embedder, chunking, the search index, fusion, and the query orchestrator
    src/model/    ModelClient — the one file naming a provider — plus the extraction schema and pipeline
    src/transcribe/  the Transcriber interface, and the local Whisper implementation
    src/http/     routes, thin, no logic
    src/rebuild.ts  `npm run rebuild-index` — reconstruct the local indexes from the files alone
    src/reprocess.ts  `npm run reprocess` — re-extract every entry's metrics via the model
  web/            the frontend, its own process, disposable
    lib/keyboard.tsx  the keyboard scheme's mechanism, designed once
    lib/recorder.ts   raw-PCM microphone capture for voice entries
    components/composer.tsx  the shared text-editing surface
    app/search/   `/`, `⌘K`, and `g s` all land here — a query in, ranked passages out
packages/
  contract/       shared API types, and nothing else
```

## Known toolchain notes

- **Node 20.11.1** is what this was built and verified against. Next 16 runs on it;
  Vitest 4 does not, because it needs `node:util.styleText` (added in Node 20.12), so
  Vitest is pinned to 3.x. Raising the floor to Node 22 would let that pin be dropped.
- **`@huggingface/transformers` is pinned to `3.4.0`, deliberately not the latest.**
  Newer releases (`4.x`) depend on an `onnxruntime-node` build that ships no Intel-Mac
  binary at all — confirmed by hand: `4.2.0` fails to load before a single line of this
  project's own code runs, on the exact machine this was built on. `3.4.0`'s pinned
  `onnxruntime-node@1.20.1` is the last version pairing confirmed to work there.
  Upgrading either package needs that check repeated on real Intel Mac hardware, not just
  a newer Apple Silicon one.
- **`better-sqlite3` is pinned to `11.10.0`, not the latest.** `13.x` segfaults on Node
  20.11.1 — its own `engines` field wants Node ≥22, and the crash on this machine
  confirmed it's a hard native-ABI mismatch, not just an advisory warning. `11.10.0` is
  the last version confirmed working here with a direct insert/select smoke test.
- **`sqlite-vec`'s vec0 virtual tables reject a plain JS number bound as a `rowid`.**
  `better-sqlite3` binds a JS `number` as SQLite's REAL type by default; ordinary tables
  convert that back to INTEGER via column affinity, but `vec0`'s custom rowid handling
  does not and throws `Only integers are allowed for primary key values`. Confirmed by
  hand — binding the same value as a `BigInt` (`sqlite3_bind_int64`) works. Every insert
  and delete against a `vec0` table in this codebase binds its rowid as a `BigInt`
  (`apps/api/src/index/search-index.ts`) because of this.
- **A failed local-model load must not be cached forever.** Both `LocalEmbedder` and
  `LocalTranscriber` lazy-load their pipeline once with `#pipelinePromise ??=
  loadPipeline(...)`. Without an explicit `.catch` clearing the field back to `null` on
  failure, `??=` happily leaves a *rejected* promise in place permanently — it only
  assigns when the field is still `null`, and a rejected promise isn't null — so one
  transient failure (a network blip during the model's one-time download, say) breaks
  every later request identically until the process restarts, even after the network or
  cache is fine again. Found live: a real search request failed once, and every request
  after it failed the same way even though a fresh process loaded the same model
  without issue.
- **`ai`/`@ai-sdk/gateway`'s own `engines` field wants Node ≥22** — a warning at
  `npm install` on the Node 20.11.1 this project is pinned to, not an error. Confirmed
  by hand rather than trusted: both package construction and a real
  `generateObject` call against the live gateway work correctly on 20.11.1. Worth
  re-checking on any future `ai` upgrade, the same as every other pinned dependency
  here.
- **`zod` is pinned to `^3.25.76`, not the latest `3.24.1` this project shipped with
  through M6.** `ai@7` requires `zod@^3.25.76 || ^4.1.8` as a peer dependency; the
  minimal in-range bump was taken rather than jumping to zod 4, which would need a
  broader migration this project doesn't otherwise need yet.
- **`npm audit` reports high-severity findings** in `sharp` and `postcss`, both reached
  only through `next` itself, and (redundantly) through `@huggingface/transformers`'s own
  use of `sharp` for image preprocessing this project never calls. There is no fixed
  `next` release — 16.2.12 is the current latest, and `npm audit fix --force` "resolves"
  it by installing Next 9. `sharp` is used only by `next/image`, which this application
  does not use.

## What "local" means for voice and search

Speech-to-text and embedding both run in-process, via ONNX Runtime's native Node
bindings — not a subprocess, not a network call, nothing needing its own binary on
`PATH`. See `apps/api/src/transcribe/local-transcriber.ts` for the full reasoning,
including why that counts as "local" even though the execution mechanism is a native
addon rather than literal WASM bytecode; `apps/api/src/search/local-embedder.ts` follows
the same shape. Each passes its own `cache_dir` to `pipeline()` per call rather than
mutating the library's shared `env.cacheDir` global — with two independent local models
now loading through the same library, whichever loaded last would otherwise win a race
and point the other's next load at the wrong cache directory.

The browser side avoids `MediaRecorder`'s compressed output (webm/opus, or AAC on Safari)
entirely, capturing raw PCM instead via an `AudioWorklet` — see
`apps/web/lib/recorder.ts`. Decoding an arbitrary container format server-side would have
meant a native decoder dependency or a subprocess, exactly what the local-only
requirement exists to avoid.
