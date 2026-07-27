# Journal

A personal journal, intended to hold its owner's writing for the rest of their life.

Entries are plain markdown files in a directory you control. Everything else — this
application included — is built on top of them and is replaceable.

**Start with [`docs/requirements.md`](docs/requirements.md).** It is the canonical
description of what this is. [`docs/format.md`](docs/format.md) specifies exactly what is
written to disk, [`docs/design.md`](docs/design.md) covers the current frontend, and
[`docs/plan.md`](docs/plan.md) is the build order. Precedence runs in that order.

## Current state

**Milestone 1 of 8 is complete** — the thinnest write path. An entry can be written in
the browser, lands on disk as clean markdown, and can be listed and read again.

Not yet built: editing, location capture, attachments, voice, the full keyboard scheme,
rendered markdown, night-mode toggling, search, and all AI extraction. See
[`docs/plan.md`](docs/plan.md).

## The journal directory

You create it yourself. **The application never will** — it refuses to start rather than
invent somewhere to put your writing.

```
~/Journal/              a git repository, created and maintained by hand
  .git/
  journal/              entries live here, filed by local year and month
```

```sh
mkdir -p ~/Journal && git -C ~/Journal init
```

Git is a safety net around the files, not a feature of the system. The application never
invokes it, never reads its history, and would behave identically without it — it would
simply be less safe. Committing is a scheduled job you set up outside the application.
See `requirements.md` §4.4 and §7.4.

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

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JOURNAL_DIR` | *required* | The journal repository root — the directory containing `journal/`. Must already exist. |
| `PORT` | `4319` | Backend port. |
| `HOST` | `127.0.0.1` | Backend bind address. Loopback; going online is a deployment change, not a default. |
| `WEB_ORIGIN` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated browser origins allowed to call the API. Never `*`. |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:4319` | Where the frontend looks for the backend. |

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
```

## Checks

```sh
npm run check          # typecheck, lint, boundary, tests
npm run check:boundary # the two standing rules, in grep
```

`scripts/check-boundary.sh` enforces the rules that are cheap to check and expensive to
lose: no storage knowledge in the frontend, and no literal colour, size or font family
outside `apps/web/app/tokens.css`. It is plain grep, so it still works with no toolchain
installed.

## Layout

```
apps/
  api/          the backend, its own process
    src/record/ ids, timestamps, filenames, frontmatter — what goes on disk
    src/store/  EntryStore, and the filesystem implementation of it
    src/http/   routes, thin, no logic
  web/          the frontend, its own process, disposable
packages/
  contract/     shared API types, and nothing else
```

## Known toolchain notes

- **Node 20.11.1** is what this was built and verified against. Next 16 runs on it;
  Vitest 4 does not, because it needs `node:util.styleText` (added in Node 20.12), so
  Vitest is pinned to 3.x. Raising the floor to Node 22 would let that pin be dropped.
- **`npm audit` reports high-severity findings** in `sharp` and `postcss`, both reached
  only through `next` itself. There is no fixed release — 16.2.12 is the current latest,
  and `npm audit fix --force` "resolves" it by installing Next 9. `sharp` is used only by
  `next/image`, which this application does not use.
