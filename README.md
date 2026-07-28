# Journal

A personal journal, intended to hold its owner's writing for the rest of their life.

Entries are plain markdown files in a directory you control. Everything else — this
application included — is built on top of them and is replaceable.

**Start with [`docs/requirements.md`](docs/requirements.md).** It is the canonical
description of what this is. [`docs/format.md`](docs/format.md) specifies exactly what is
written to disk, [`docs/design.md`](docs/design.md) covers the current frontend, and
[`docs/plan.md`](docs/plan.md) is the build order. Precedence runs in that order.

## Current state

**Milestones 1–4 of 8 are complete.** An entry can be written, autosaved as you type,
edited later, recorded by voice, and given attachments — all as plain markdown files on
disk, with the full keyboard scheme, night mode, and rendered markdown.

Not yet built: the SQLite index and full-rebuild drill, search, AI extraction, and the
remaining derived structures (reviews, lists, the opinion model, analysis surfaces). See
[`docs/plan.md`](docs/plan.md).

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
```

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
    src/store/    EntryStore, and the filesystem implementation of it
    src/transcribe/  the Transcriber interface, and the local Whisper implementation
    src/http/     routes, thin, no logic
  web/            the frontend, its own process, disposable
    lib/keyboard.tsx  the keyboard scheme's mechanism, designed once
    lib/recorder.ts   raw-PCM microphone capture for voice entries
    components/composer.tsx  the shared text-editing surface
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
- **`npm audit` reports high-severity findings** in `sharp` and `postcss`, both reached
  only through `next` itself, and (redundantly) through `@huggingface/transformers`'s own
  use of `sharp` for image preprocessing this project never calls. There is no fixed
  `next` release — 16.2.12 is the current latest, and `npm audit fix --force` "resolves"
  it by installing Next 9. `sharp` is used only by `next/image`, which this application
  does not use.

## What "local" means for voice

Speech-to-text runs in-process, via ONNX Runtime's native Node bindings — not a
subprocess, not a network call, nothing needing its own binary on `PATH`. See
`apps/api/src/transcribe/local-transcriber.ts` for the full reasoning, including why that
counts as "local" even though the execution mechanism is a native addon rather than
literal WASM bytecode.

The browser side avoids `MediaRecorder`'s compressed output (webm/opus, or AAC on Safari)
entirely, capturing raw PCM instead via an `AudioWorklet` — see
`apps/web/lib/recorder.ts`. Decoding an arbitrary container format server-side would have
meant a native decoder dependency or a subprocess, exactly what the local-only
requirement exists to avoid.
