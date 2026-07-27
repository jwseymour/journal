# Implementation plan

*How the system described in `requirements.md` gets built, in what order, and how each stage is known to be finished.*

*This document is **disposable**. It is a schedule of work, not a statement of intent — it is consumed as it is executed and carries no authority over anything. Where it disagrees with `requirements.md`, it is simply wrong. Where it disagrees with `format.md` or `design.md`, the same.*

---

## Ordering principle

The order follows the precedence already set out in `requirements.md` §2: **Pillar 1 before Pillar 2.** The record is made to exist, then made trustworthy, then made pleasant to write into — and only then is anything derived from it.

This puts the most interesting work last, deliberately. Extraction is the point of the system, but the entries are the thing that must survive it, and every derived milestone is cheaper once the record beneath it is solid and the rebuild drill already works.

Milestones 1–4 build the journal. Milestone 5 establishes that everything above it is disposable. Milestones 6–8 build on top of that.

---

## Standing rules

These are checked at the end of every milestone, not just the one that introduces them.

1. **No storage knowledge in the frontend.** No `fs`, no paths, no parsing, no business logic. Lint-enforced with a banned-import rule.
2. **No literal values in components.** No colour, size, spacing, or font family. Grep-enforced in CI.
3. **The API is the only path across the boundary.** No same-process shortcut, ever, including from server components (`design.md` §6.4).
4. **Every entry write is atomic** — temp, fsync, rename (`format.md` §5).
5. **Nothing but the user writes to an entry** (`requirements.md` §4.4).
6. **Derived data is rebuildable and lives outside the journal repository** (`requirements.md` §6.4).
7. **No engagement mechanics** (`design.md` §4). Per-entry facts — date, location, length — are content and are fine. Any aggregate over writing *behaviour* is not: no counts of entries written, no calendar heatmap, no gaps, no streaks by another name.
8. **External interfaces are confined to one file each.** Model, embedder, transcriber, geocoder. No provider detail leaks past them (`requirements.md` §7.6).
9. **Read `node_modules/next/dist/docs/` before writing Next code.** This version differs from what is widely known (`AGENTS.md`).

---

## Repository shape

```
/                        the application repository (this one)
  apps/
    web/                 Next.js frontend, its own process
    api/                 backend service, its own process
  packages/
    contract/            shared API types, nothing else
  docs/
```

The backend, as it fills in over the milestones:

```
apps/api/src/
  http/                  routes — thin, no logic
  record/                frontmatter, filenames, ids  (M1)
  store/                 EntryStore interface + FsEntryStore  (M1)
  index/                 SQLite cache and rebuild  (M5)
  embed/                 Embedder  (M6)
  model/                 ModelClient  (M7)
  transcribe/            Transcriber  (M4)
```

`~/Journal/` is a separate repository entirely, created by hand, never touched by git from inside the application.

---

## M1 — The thinnest write path

**Goal.** A markdown file appears on disk when I write, and I can find it and read it again. Nothing more.

**Build**

- `npm install`, confirm Next 16 runs on the installed Node, read the routing and route-handler guides in `node_modules/next/dist/docs/`.
- Workspace split into `apps/web`, `apps/api`, `packages/contract`. Banned-import lint rule on `apps/web` from the first commit.
- Config: journal root from `JOURNAL_DIR`, resolved and validated at boot. Fail loudly and refuse to start if it is missing. Never invent or create the directory.
- `record/` — ULID generation, filename derivation, frontmatter serialise and parse, exactly per `format.md`.
- `store/` — the `EntryStore` interface (`create`, `get`, `list`) and one implementation, `FsEntryStore`. Every path, encoding and frontmatter concern lives behind it. **This interface is the seam a hosted backend later slides into**, so it is worth getting right while it has one caller.
- Atomic write: temp file in the same directory, fsync, rename.
- `id` → path resolution by directory scan into an in-memory map, invalidated on write. Correct at hundreds of entries; replaced in M5; invisible through the API.
- HTTP, JSON, bound to `127.0.0.1`, strict `Origin` allowlist, no CORS wildcard:
  - `POST /entries` → `{ id, created, path }`
  - `GET /entries?cursor=&limit=` → newest-first page of `{ id, created, excerpt }`
  - `GET /entries/:id` → metadata and full body
  - `GET /health`
  
  **Cursor-paginated from the first commit**, though M1 only scans a directory. When the index arrives in M5 the endpoint shape does not move. Excerpts are cut server-side; the frontend receives a string.
- Structured JSON errors with stable machine-readable codes, not bare status codes — a future remote frontend will need them.
- `tokens.css`: the full palette from `design.md` §2.3 both modes, Literata self-hosted, one type scale, one spacing scale.
- Three routes: `/` list, `/entry/new`, `/entry/[id]` read-only. All data over `fetch` to the API base URL.
- Tests: round-trip fidelity above all — a body opening with `---`, a body full of YAML, emoji, pasted CRLF, fifty thousand words. If the parser can corrupt an entry, Pillar 1 is already broken and nothing after this matters.

**Not in this milestone.** Editing, deletion, location, attachments, voice, search, extraction, night mode, the keyboard scheme, chrome toggling, the reference pane, rendered markdown, any index or database, any git operation.

**Done when**

- An entry written in the browser reads as clean markdown when `cat`-ed in a terminal.
- `curl` returns the same data with the frontend not running.
- `grep -rE "node:fs|from ['\"]fs['\"]" apps/web` is empty.
- `grep -rE "#[0-9a-fA-F]{3,6}|[0-9]+px" apps/web` is empty.
- Deleting all application state leaves `~/Journal/` complete and untouched.

---

## M2 — The record made trustworthy

**Goal.** Everything that stops the system losing or corrupting writing. Pillar 1 work, and it comes before anything pleasant.

**Build**

- `PUT /entries/:id` — editing (`requirements.md` §4.4).
- **Content-hash preconditions on every write.** These files will be edited in a text editor outside the application; that is a stated benefit of plain files, not an edge case. A hash mismatch returns 409 and the interface says so plainly. This is the one realistic way the application could ever destroy writing, and it is worth more care than anything else in this milestone.
- Tolerance for the directory changing underneath: files appearing, changing, or vanishing is normal, not an error.
- Draft lifecycle per `format.md` §5 — file on first keystroke, autosave, `created` is the first keystroke, whitespace-only files removed on close. Crash-tested.
- Silent location capture. Zero interface footprint, never prompted for, absent on denial or failure, and never able to block or delay a save (`requirements.md` §4.3).

**Done when.** The process can be killed mid-write in a loop without ever producing a truncated or half-written entry, and an entry edited in an external editor mid-session produces a clear conflict rather than a silent overwrite.

---

## M3 — The writing surface

**Goal.** The application becomes the thing described in `design.md` rather than a test harness.

**Build**

- Complete token set, both modes, reviewed before components (`design.md` §6.1). Night mode.
- Measure, leading, margins — the typographic setting that makes it feel airy without being empty (`design.md` §1.4).
- Toggleable chrome, with hidden as a full-capability state, not a reduced mode.
- The keyboard scheme from `design.md` §5.2, implemented whole. Every combination verified against Chrome and Safari rather than assumed interceptable.
- Rendered markdown, with `⌘⇧P` toggling source; reading always rendered.
- The reference pane — previous entries visible while writing (`requirements.md` §4.5).
- Every surface built for its real states: empty, loading, error, and very large (`design.md` §6.5).

**Done when.** A long real entry can be written start to finish without the mouse, and the list stays responsive with a synthetic corpus of tens of thousands of entries.

---

## M4 — Attachments and voice

**Goal.** Complete the writing interface. Attachments come first because retaining audio depends on them.

**Build**

- Per-entry attachment directories, relative links, `.gitattributes` in the journal repository (`format.md` §4).
- `Transcriber` interface — one file, swappable, mirroring the pattern every other external capability uses.
- Local implementation: whisper.cpp as a subprocess. One-time model download; model size is a config line.
- `⌘⌥R` records via `MediaRecorder`, posts audio to the backend, transcript returns and enters the body as text.
- The transcript is always produced and always kept as part of the entry. Retaining the audio as an attachment is optional and additional, never a substitute (`requirements.md` §4.7).

**Done when.** A spoken entry produces a plain-text entry indistinguishable in the record from a typed one, and the optional audio resolves from the markdown in an external viewer.

---

## M5 — The derived layer, proven disposable

**Goal.** Establish that everything above the record can be thrown away and rebuilt — while it is still cheap to establish. Nothing derived is built until this drill works.

**Build**

- SQLite index in the application data directory, outside the journal repository.
- `rebuild --from-scratch`: delete the database, walk the directory, reconstruct entirely from the files.
- Incremental update on change, detected by **content hash, never mtime** — mtime does not survive `cp -r` or `git checkout`, which are this project's own backup and restore story.
- Listing and `id` lookup move behind the index, with the API unchanged from M1.
- Geocoding, if wanted at this point: place names produced from stored coordinates into the index, never into the entry (`requirements.md` §4.3).

**Done when.** `rm index.db && rebuild` reproduces the database exactly and the application behaves identically. This drill is run at the end of every subsequent milestone.

---

## M6 — Search

**Goal.** Describing what is being looked for finds it, including where the entry never used those words (`requirements.md` §8).

**Build**

- `Embedder` interface, local implementation. Local specifically so that a full rebuild stays free — a hosted embedder would make re-embedding the corpus a bill and a long wait, and the rebuild that is never run is the rebuild that does not work.
- Chunking by paragraph, not by entry. A long entry covering four subjects has no single meaning to embed.
- Vectors in `sqlite-vec`, inside the same database, so the cache stays one deletable artefact.
- FTS5 BM25 and vector kNN run in parallel, fused by reciprocal rank fusion.
- Results surface the matching passage, not merely the entry.
- Optional LLM rerank over the top results for natural-language queries.

**Done when.** A query phrased in words the target entry never contains finds it, and the whole search index survives `rebuild --from-scratch` unchanged.

---

## M7 — The model boundary and the first extraction

**Goal.** One derived structure, end to end, with the provider boundary correct from the start.

**Build**

- `ModelClient` — the single file in which any provider is named (`requirements.md` §7.6). AI SDK behind it, gateway as swappable infrastructure.
- **Simple temporal metrics only.** One structure type, done properly, before the shape of the second is guessed at.
- Zod schemas and prompts that know nothing about which provider serves them.
- Event time resolved from the prose, distinct from entry time (`requirements.md` §6.3).
- Every derived record links back to its source entry (`requirements.md` §3).
- Full-corpus reprocess, built now rather than retrofitted (`requirements.md` §6.4).
- Correction: because writes land unreviewed, being able to fix one easily is the safeguard that makes that acceptable (`requirements.md` §6.2).

**Done when.** The corpus can be reprocessed end to end against two different models and the outputs diffed. That diff is the model-migration procedure, and running it once proves it exists.

---

## M8 — The remaining structures, and the analysis surfaces

**Goal.** The rest of Pillar 2, on foundations that have already been shown to hold.

**Build**

- Reviews, then lists of atomic items — each treated as its own kind of thing, not a variation of the first (`requirements.md` §5.1).
- The opinion model last. It is the least resolved of the identified structures, and its constraint is absolute: it organises what was actually said and never extrapolates (`requirements.md` §5.2).
- Metric suggestion and approval. The AI never creates a metric unilaterally (`requirements.md` §5.3).
- Analysis surfaces in the print information-design tradition — hairlines, small multiples, no chart junk, the same cream and ink and green as everywhere else (`design.md` §5.3).

**Done when.** Adding a further structure type is an addition rather than a reorganisation. That is the property `requirements.md` §5.1 asks for, and it can only be tested by having done it three times.

---

## Ordering notes

M6 and M7 are independent past the index and can be swapped. Search is placed first because it is useful immediately and validates the index under real load, while extraction is the more speculative of the two — but if derived structure matters more, the order costs nothing to reverse.

Everything before M5 is strictly sequential. Nothing derived begins until the rebuild drill works.

---

## Open

- **The derived store is assumed to be SQLite** — one local file, trivially deletable, with FTS5 and `sqlite-vec` both living in it. Not formally confirmed.
- **Transcription engine.** Local whisper.cpp is the plan, at the cost of a model download. A hosted API would remove the download and add a second external dependency.
- **Location accuracy radius** is not stored. Without it, a five-metre GPS fix cannot later be told apart from a five-kilometre Wi-Fi guess. Free to add now, unrecoverable later; left out for simplicity per `requirements.md` §4.3.
- **Node 20.11.1 sits close to Next 16's floor.** Verified at install, not assumed.
