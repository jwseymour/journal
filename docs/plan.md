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
6. **Untouched derived data is rebuildable; touched data is protected once reviewed or edited. All derived data lives outside the journal repository** (`requirements.md` §2, §6.4).
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

---

## A numbering note

`M9` is already taken. Metric fields and structured field values (`MetricFieldsIndex`, `sumByField`, the field-suggestion flow, the categories/metric-fields UI on the analysis page) shipped as milestone M9 — the code says so throughout (`plan.md\` M9` appears across `apps/api/src/index/metrics-index.ts`, `apps/api/src/model/temporal-metrics.ts`, `apps/web/lib/api.ts`, and elsewhere) — but this document was never updated to record it. That gap is left as-is here rather than reconstructed after the fact; the milestone below is **M10**, continuing the count the code already established.

---

## M10 — Derived data becomes ownable

**Goal.** Implement the change agreed in `requirements.md` §2 and §6.4: a derived record the user reviews or edits becomes permanently theirs and is never silently overwritten, while untouched records stay a disposable cache exactly as before.

**Scope.** Five structure types — metrics, reviews, list items, opinion statements, questions. Categories and metric-field *definitions* were excluded: they already behaved as "touched" data (their own tables, never wiped by `clear()`/reprocess, populated via suggest/approve). Opinion summaries were excluded: regenerated-only by existing design, never hand-edited.

**Built**

- A `touched` column per record, in each of the five index files, off by default, added via the existing idempotent `PRAGMA table_info` / `ALTER TABLE` migration pattern.
- Per structure: `update()` (edit content, sets touched), `validate()` (mark correct as-is, sets touched, no content change), `untouch()` (reverts to AI-owned), `replaceUntouchedForEntry()`/`replaceUntouchedRaised()` (the reprocess-safe sibling of `replaceEntry`/`replaceRaised` — only touches `touched = 0` rows), `clearUntouched()` (the reprocess-safe sibling of `clear()`), and an `*_update_suggestions` table + `proposeUpdate()`/`decideUpdate()`, mirroring `MetricFieldsIndex`'s existing suggestion mechanics exactly. Questions additionally gained `touchedOpenRaisedBy()`; `resolve()` gained an `AND touched = 0` guard so a reprocess can never auto-resolve a touched question, and `reopen()` now touches the record, since reopening is itself a correction.
- HTTP: `PUT /metrics/:id` (404 via a new `record_not_found` error if gone — a real edit isn't dropped silently, unlike the tolerant no-op every other correction route uses), `POST /metrics/:id/validate` and `.../untouch` (tolerant no-op, matching `reopen`), `GET /metrics/update-suggestions`, `POST /metrics/update-suggestions/:id/{approve,reject}` — the same five-route shape repeated for reviews, lists, opinions/statements, and questions.
- `reprocess.ts` unchanged; each extractor's `reprocessAll()` now calls `clearUntouched()` instead of `clear()`, and `extractEntry()` replaces only the untouched subset for its entry. Where an entry has touched records and the fresh extraction gives a clean 1:1 positional match against them, a differing record files one update-suggestion per pair and nothing new is inserted untouched; where the counts don't line up, nothing is proposed that pass and the touched records are still protected either way — a deliberate simplification, not a full diff/matching engine.
- Frontend: `lib/api.ts` gained the client functions for all 25 new endpoints. Rather than a shared modal/overlay component, each of the five pages (metrics, reviews, lists, opinions, questions) got its own inline expand-in-row edit form — following the categories page's existing plain-`<input>`-and-button convention rather than inventing a new interaction pattern — plus a touched indicator pill and a pending-update-suggestions section styled like the categories page's suggestion list. Editing is scoped to each record's one free-text field (`detail`, `opinion`, `text`, `statement`, `question`); field-level and `eventTime` corrections are not yet surfaced in the UI, though the backend supports them.
- Tests: ~70 new tests across the five index files (touch/validate/untouch, `replaceUntouchedForEntry`, propose/decide, `clearUntouched`), the HTTP layer (`PUT`/`validate`/`untouch`/update-suggestions for metrics, representative of the identical shape on the other four), and `extractor.test.ts` (a touched record survives `reprocessAll` unchanged, a clean 1:1 match proposes an update instead of overwriting, and no suggestion is filed when fresh extraction agrees with what's stored).

**Worth knowing.** M5's "Done when" drill — `rm index.db && rebuild` reproduces the database exactly — stops being a safe, no-cost operation once touched records live inside that same database. A future reprocess or rebuild must not treat that drill as unconditionally safe now that M10 has shipped. `resolve()`'s touched-guard is unconditional rather than reprocess-only, because there is currently no live single-entry extraction path distinct from `reprocessAll`'s replay — see the comment on `QuestionsIndex.resolve` if a live path is ever added.

**Not part of this milestone.** A model-migration diff tool (compare fresh extraction against touched records corpus-wide) and the "document" type (project ideas, non-chronological writing) — both related, both separate open threads.

**Done when.** `npm run typecheck` is clean across `contract`, `api`, and `web`; the `api` test suite passes; and, verified live against an isolated server and a real browser session: editing a touched record's detail persists and shows the touched indicator, Untouch clears it, and a proposed update can be approved or rejected without disturbing an unrelated record.

---

## M11 — Going online: S3, single-user auth, hosted deploy

**Goal.** The journal becomes reachable and durable without being local. Entries move to S3 as the canonical store, replacing the local directory; a single-user auth boundary protects the API; the stack runs on a small persistent-disk host (Fly.io or equivalent) reachable over the network. A deliberate, stated reversal of "everything runs locally" — see the `requirements.md`/`CLAUDE.md` changes this milestone carries.

**Build**

- `S3EntryStore` implementing `EntryStore` (`apps/api/src/store/entry-store.ts`) unchanged — the seam this interface's own doc comment was written for. Object keys reuse `entryRelativePath()` verbatim, so the bucket's layout mirrors `journal/YYYY/MM/...` exactly.
- `PutObject` replaces `writeFileAtomic` entirely for the S3 backend. S3's per-object atomicity (a `PutObject` either lands whole or not at all; strong read-after-write consistency since Dec 2020) already gives the guarantee the temp-file/fsync/rename dance exists to provide on a POSIX filesystem — no cross-object transaction is added, because `FsEntryStore` never had one either (`create`/`update`/`addAttachment` are already independently atomic, never atomic *with each other*).
- Content-hash detection unchanged: `get()`/`update()` recompute `contentHash()` from the downloaded object body, exactly as `FsEntryStore` does from the read file — never from S3's ETag (only a true MD5 for non-multipart, non-SSE-KMS uploads, and a different algorithm than the hash shape already threaded through `packages/contract` end to end). No object metadata required for correctness in v1; `#scan()`'s equivalent is a `ListObjectsV2` diffed against the index's known keys.
- `STORAGE_BACKEND=fs|s3` config switch in `apps/api/src/config.ts`; new config `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (a scoped IAM user limited to `journal/*`). Bucket: versioning on, default SSE-S3 encryption on, no public access. `index.ts`/`rebuild.ts`/`reprocess.ts` branch on `STORAGE_BACKEND` to construct the store.
- Extract `entry-store-contract.test.ts` from today's `fs-entry-store.test.ts` (id/path shape, `edit_conflict` semantics, `discardIfBlank`'s narrow-deletion rule, attachment-conflict handling, frontmatter round-trip), parameterized over store implementation; `S3EntryStore` runs it against a local S3-compatible mock (MinIO or `aws-sdk-client-mock`) in CI, not live AWS.
- One-time migration script (`npm run migrate-to-s3`, following the `rebuild.ts`/`reprocess.ts` standalone-script pattern): `aws s3 sync` of `JOURNAL_DIR/journal/` into the bucket, plus entry-count (`store.stats().entryCount`) and sample-hash verification. Local `JOURNAL_DIR` is kept, untouched, as a frozen snapshot at cutover — not deleted.
- Safety net: bucket versioning (above) plus a scheduled job — same "outside the application" shape §7.4 already settled — that syncs `s3://.../journal/` down to a local git mirror and commits. This doubles as the "back to fully local" escape hatch: the mirror is always a ready-to-become-`JOURNAL_DIR`-again local copy.
- `index.db` stays on the compute host's persistent volume, not in S3 — `better-sqlite3` needs a real local file with locking and WAL support, which S3 doesn't provide. It's an ordinary cache today; provision the persistent volume now so that once M10 ships and some rows become durable "touched" data, adding backup (e.g. `litestream` to a separate `derived-backups/` S3 prefix, kept apart from the canonical `journal/` prefix) is an addition, not a redesign.
- Single-user auth, API-owned end to end: `AUTHORIZED_EMAIL=seymour.w.jack@gmail.com` config; Google OAuth (`/auth/google/start`, `/auth/google/callback`, verified id_token checked against it) as the primary path; password fallback (`/auth/login`) against an argon2id `AUTH_PASSWORD_HASH` config value, set via a one-off `npm run set-password` script (mirrors how every other secret already lives in `.env`); simple in-memory rate limit on the password route (e.g. 5 attempts/15 min).
- Stateless signed session cookie (`SESSION_SECRET`, `iron-session`-style, HttpOnly, `Secure`, ~30-day rolling expiry) — deliberately **no sessions table**, anywhere. Auth state must never be treated as disposable the way `index.db`'s cache rows are (and soon, some of its touched rows aren't either) — a stateless cookie sidesteps that question rather than adding another durable-row case to reason about. "Logout everywhere" is rotating `SESSION_SECRET`.
- `apps/web` reverse-proxies the API under its own origin (`next.config.ts` rewrite), so the auth cookie is same-origin (`SameSite=Strict`, no CORS needed for browser traffic) and `lib/api.ts`'s `API_BASE` becomes a relative `/api` path. This is routing, not logic — nothing about entries, extraction, or auth *decisions* moves into `apps/web`, only where bytes get forwarded; §7.1's "no logic in the frontend" and "hard separation" both still hold, and `web`/`api` stay separately deployable.
- Fallback path, documented not built: a genuinely separate-origin deploy, or a future third-party/mobile client, uses `Authorization: Bearer <token>` instead of the cookie — same signed token, same auth middleware, no ambient browser credentials to worry about. Directly serves §7.5's deferred multi-device intent at near-zero incremental cost, without pulling an actual client into this milestone.
- Tighten the existing Host+Origin allowlist middleware (`apps/api/src/http/app.ts`): require `Origin` on cookie-authenticated, state-changing requests (currently tolerant of a missing `Origin`, reasoned as "curl has no Origin" — now a missing `Origin` on a cookie-bearing request is suspicious, since legitimate non-browser callers use the bearer-token path instead).
- `.env.example` added, given how many new secrets this milestone introduces.

**Not in this milestone.** Multi-user/permission levels, the "fun secret" login flow, an actual mobile/multi-device client, public/private per-entry access control, server-revocable (non-stateless) sessions.

**Done when**

- `entry-store-contract.test.ts` passes identically against `FsEntryStore` and `S3EntryStore`.
- `aws s3 sync s3://<bucket>/journal/ <dir>` produces a directory diffable exactly like today's `JOURNAL_DIR`, with no application involved — the S3-era version of `cp -r`.
- Deleting `index.db` and re-running `rebuild-index` against `STORAGE_BACKEND=s3` reproduces it exactly, as it does today against the filesystem.
- A browser with no valid session is refused by every route except the auth routes and `/health`; a bare `curl` gets a clear `unauthorized` error code, not a silent 200.
- Killing the compute process mid-write in a loop never leaves a torn object reachable by `GetObject` — the S3-era version of M2's `kill -9` drill (verified live there: 60 kills, 21 orphaned temp files, zero corrupted entries; the S3 equivalent should show zero torn objects, full stop, since there's no temp-file step to leave debris from).

---

## M12 — Documents

**Goal.** A document — titled, directly authored, revised repeatedly over its working life, organised by subject rather than chronology — can be created, edited and read, alongside entries but never confused with them (`requirements.md` §9).

**Build**

- `DocumentStore` interface (`apps/api/src/store/document-store.ts`) — `create`, `get`, `update`, `list`, `stats` — separate from `EntryStore`, not an extension of it: a document is not an entry (`requirements.md` §9.1), and several of `EntryStore`'s methods have no analogue here. No `discardIfBlank` (creation is gated on a non-empty title, a deliberate action rather than something incidental to typing, so there is no abandoned-blank-draft case), no `addAttachment`, no `listPeriods`, and nothing resembling delete — a document is durable authored content, the same stance `requirements.md` §4.4 takes on entries.
- `FsDocumentStore`/`S3DocumentStore` mirror `FsEntryStore`/`S3EntryStore` method-for-method: same atomic-write path (`writeFileAtomic` / plain `PutObject`), same `contentHash`-guarded optimistic concurrency on `update`, same duplicate-id lexical-first-wins resolution, same opportunistic self-healing of a drifted index row on `get`. `create` performs a full replace of every editable field on `update`, not a partial patch — a document is directly authored like an entry, never AI-derived, so there is nothing to patch around (unlike the M10 touched-record shape).
- `documentRelativePath(id) = documents/<id>.md` (`apps/api/src/record/document-filename.ts`) — sibling to `journal/`, no date nesting, no slug (a document's title is edited over its life, unlike an entry's immutable `created`, so deriving the filename from it would mean renaming the file on every edit).
- `record/document-frontmatter.ts` — hand-written frontmatter serialiser/parser mirroring `record/frontmatter.ts`, reusing `normaliseBody` unchanged. Fields: `id`, `title`, `created`, `updated`, `citedEntries?` (present only when non-empty). See `format.md` §6 for the exact on-disk shape.
- `DocumentsIndex` (`apps/api/src/index/documents-index.ts`) — a sibling table in the same shared `index.db`, following the established one-class-per-structure-type pattern (`MetricsIndex`, `ReviewsIndex`, and so on) rather than extending `SqliteIndex`, which is entry-shaped throughout. Listed **newest-*updated*-first**, not newest-created-first — a working set of documents is more usefully surfaced by what was worked on most recently (`requirements.md` §9.1).
- `store/cursor.ts`'s hardcoded `VERSION` became a parameter (default `'e1'`, unchanged for every existing call site) so documents can use `'d1'` — the two cursor spaces can never be confused if one is pasted into the other's query param.
- HTTP: `POST /documents`, `GET /documents?cursor=&limit=`, `GET /documents/:id`, `PUT /documents/:id` — four routes, not the eight-route M10 shape, because nothing ever proposes an update to a document for the user to approve. Not-found and conflict reuse the already-generic `record_not_found`/`edit_conflict` — no new `ApiErrorCode` needed.
- Contract (`packages/contract/src/index.ts`): `DocumentMetadata`/`DocumentSummary`/`Document`/`DocumentPage`/`CreateDocumentRequest`/`CreateDocumentResponse`/`UpdateDocumentRequest`/`UpdateDocumentResponse`, mirroring the `Entry` group's shape, not the M10 partial-patch triad.
- Frontend: `lib/api.ts` gained `listDocuments`/`getDocument`/`createDocument`/`updateDocument`. Three pages — `app/documents` (list), `app/documents/new` (a plain title-and-body form with an explicit Create button, deliberately *not* autosave-on-keystroke like `entry/new`, since creation here is a deliberate act gated on a title rather than incidental to typing), and `app/documents/[id]` (mirrors `entry/[id]`'s read/edit toggle and conflict-banner UX exactly). Nav link, command palette entry, and keyboard chord added the same way every existing section was.
- Wiring: `index.ts` and `rebuild.ts` construct `DocumentsIndex`/`createDocumentStore` alongside the existing per-feature indexes. `reprocess.ts` is untouched — documents are never AI-derived, so there is nothing to extract or reprocess. Documents are not wrapped in `SearchingEntryStore` and are not search-indexed in this milestone.

**Not in this milestone.** Visibility/public-private (`requirements.md` §9.3 — see M13), the blog/public-facing surface itself (see M14), a citation-picker UI beyond raw entry ids, search indexing over documents, any extraction/reprocessing involvement, attachments, deletion.

**Done when.** `npm run typecheck` is clean across `contract`, `api` and `web`; the `api` test suite passes, including the document frontmatter round-trip, the store contract run against both backends, the index ordering test, and the representative HTTP tests; and, verified live against an isolated server and a real browser session: a document created through the UI lands at `documents/<id>.md` with the documented frontmatter shape, an edit round-trips and shows the new `updated` time, and a stale-hash edit (opened in two tabs) produces the same conflict banner entries already have.

---

## M13 — Document visibility

**Goal.** A document can be marked public or private, explicitly and durably, through the existing private application — no public surface yet, just the flag and the control for it (`requirements.md` §9.3).

**Build**

- Contract: `public: boolean` added to `DocumentMetadata`/`Document`/`DocumentSummary`; always present, `false` on creation. Not part of `UpdateDocumentRequest` — flipping it is a distinct action from an ordinary edit, not a side effect of one.
- `record/document-frontmatter.ts`: serialises/parses `public` per `format.md` §6.
- `DocumentStore`: a `setPublic(id, contentHash, public: boolean)` method alongside `create`/`get`/`update`/`list`, guarded by the same `contentHash` optimistic-concurrency check as `update` — publishing a stale copy should conflict exactly like editing one.
- `DocumentsIndex`: a `public` column; existing rows default to `false` on rebuild.
- HTTP: `POST /documents/:id/publish`, `POST /documents/:id/unpublish` — dedicated action routes, the same shape as the M10 `validate`/`untouch` endpoints, reusing `edit_conflict` for a stale-hash call.
- Frontend: on `app/documents/[id]`, a "Publish" control separate from Save, gated behind a confirmation step (unpublishing needs none — it's the safe direction). `app/documents` list gets a public/private badge per row, matching the existing touched-badge pattern.
- `reprocess.ts`/`rebuild.ts`: unaffected — `public` is directly authored, never derived.

**Not in this milestone.** The public-facing surface itself (M14), any grouping/series concept, slugs, document attachments.

**Done when.** `npm run typecheck` is clean; the frontmatter round-trip test covers `public`; a store-contract case confirms `setPublic` conflicts on a stale hash the same way `update` does; verified live: clicking Publish on a document flips `public: true` in the underlying S3/fs object and the list badge, and Unpublish reverses it.

---

## M14 — The public-facing surface

**Goal.** Documents marked public (M13) are readable by anyone, through a new application with no access to anything else in the system (`requirements.md` §10).

**Build**

- `apps/public-api` — a new, minimal, read-only service, its own process, its own IAM role scoped to the `documents/` S3 prefix only — never `journal/`. Routes: `GET /documents` (public ones only, newest-*created*-first — a blog reads chronologically, unlike the private list's newest-updated-first), `GET /documents/:slug`.
- Filtering (`public = 1`) happens against a read-only connection to the same `index.db`/`DocumentsIndex`, colocated on the host — never a per-request full-content S3 scan.
- Slugs are derived at read time from the title plus a short id suffix for uniqueness, and are never stored — `format.md` §6 stays untouched by presentation concerns (`requirements.md` §10).
- `apps/public-api` has no auth, no cookies, no session code at all — there is nothing behind it that needs protecting beyond the IAM scoping above.
- `apps/blog` — a new, minimal Next.js frontend, its own domain, calling only `apps/public-api`. Two pages: a list and a read view. Styled independently of `apps/web` — disposable the same way, but under no obligation to share its design system.
- Infra: a second small process (systemd unit or equivalent) alongside the existing API on the host, its own Caddy site block and subdomain/domain.

**Not in this milestone.** Series/album grouping, categorisation by kind, comments or any interactivity, search over public documents, making any derived-data surface (metrics, reviews, etc.) public — all still deferred per `requirements.md` §11.

**Done when.** With a document published via M13: an unauthenticated request to `apps/public-api` returns it, and a private document is both omitted from the list and 404s on direct fetch; the public API's IAM role is confirmed, directly, to be denied access to `journal/*` (not merely assumed from routing); the blog frontend renders the list and a full document, read-only, live against the deployed host.

---

## M15 — Unified public mirror

**Goal.** One publishing mechanism for everything, replacing M13's in-place document flag: a "Publish" action copies a rendered snapshot into a new `public/` prefix; `apps/public-api` serves only from there. Entries get publishing for the first time, without ever touching `requirements.md` §4.3 — the resolution to the "public/private beyond documents" question `requirements.md` §11 has carried since M14.

**Built**

- `PublishedIndex` (`apps/api/src/index/published-index.ts`) — a new, durable table `published(source_type, source_id, mirror_key, source_created_at, published_at, source_hash_at_publish)`, keyed on `(source_type, source_id)`. Unlike every other index in `apps/api/src/index/`, this one is not a cache: it is the sole record of a publishing decision, and needs the same backup treatment M11 earmarked for durable rows, not just `rm index.db && rebuild`.
- `Publisher` (`apps/api/src/publish/publisher.ts`) — the one file that knows the mirror exists, mirroring how `ModelClient`/`Transcriber` are each "the one file" for their concern. `publish`/`unpublish`/`resyncIfPublished`, all tolerant no-ops on a source that doesn't exist or isn't published (`validate`/`untouch`'s M10 convention, not `PUT`'s strict `record_not_found`). Snapshots are plain JSON, not markdown — `{ id, created, body, excerpt }` for an entry, `{ id, title, created, updated, body, excerpt }` for a document — written to `public/<type>s/<id>.json`. An entry's snapshot deliberately excludes `location`; there was never a version of this that included it.
- `createPublisher` (`apps/api/src/publish/create-publisher.ts`) branches on `config.storageBackend` exactly like `createEntryStore`/`createDocumentStore`, via a small `PublicBlobStore` interface (`put`/`delete`) with `Fs`/`S3` implementations — the fs one reuses `writeFileAtomic`.
- `POST /entries/:id/publish` / `.../unpublish` (new) and `POST /documents/:id/publish` / `.../unpublish` (migrated off M13's `setPublic`) all go through `Publisher`. Entry routes are tolerant-no-op, 204, no body. Document routes stay strict (`record_not_found` on a bad id, matching their pre-M15 behaviour) and return the full `Document`, since the caller needs to see the resulting `published` status. Neither carries a `contentHash` any more — publishing never writes to the source, so there is nothing to guard with one.
- `PUT /entries/:id` and `PUT /documents/:id` both call `publisher.resyncIfPublished(...)` after a successful update — inline, synchronous, not a background job — so a published record never silently drifts from its mirror.
- Documents fully off the flag: `public` removed from `DocumentMetadata` (`packages/contract`), from `record/document-frontmatter.ts`'s serialise/parse, from `DocumentsIndex`'s schema, and `DocumentStore.setPublic`/`SetDocumentPublicInput` deleted from the interface and both implementations. `DocumentSummary`/`Document` gained `published: boolean` instead — computed at the HTTP layer from `Publisher.isPublished`, never stored on the document. `StoredDocument`/`ListDocumentsResult` in `store/document-store.ts` are typed as `Omit<Document, 'published'>`/`Omit<DocumentSummary, 'published'>` specifically so the store layer cannot know this field exists.
- `apps/public-api` rewritten wholesale: `PublicDocumentsReader` (`documents`-table-specific) replaced by `PublishedIndexReader` (`index-reader.ts`), generic over `source_type`; `frontmatter-reader.ts` deleted outright — nothing here parses markdown any more, every snapshot is already JSON. Routes: `GET /documents`, `GET /documents/:slug` (unchanged shape), new `GET /entries`, `GET /entries/:slug`. An entry has no title, so its slug is derived from `created`'s date instead (`slugFor(created.slice(0, 10), id)` — `slugFor` already slugifies whatever text it's given, and a bare `YYYY-MM-DD` slugifies to itself unchanged).
- `apps/blog` gained `/entries` (list) and `/entries/[slug]` (read), reusing the documents list/read CSS modules directly since the shapes are the same minus a title; a small nav added to the shared layout.

**Not in this milestone.** Derived-structure visibility (metrics, reviews, opinions, lists, questions) — see M16. Search over documents, and a public search endpoint — see M17.

**Worth knowing — resolved, post-M15.** `infra/terraform/main.tf` used to define exactly one IAM role (`journal_api`), shared by whatever runs on the one EC2 instance it provisions — there was never a second, separately-scoped role for `apps/public-api`, despite M14's own text describing one. Since an EC2 instance can only ever carry one instance profile, this has been resolved not by adding a second host but by flipping which role is the default: the instance's own role (attached via its instance profile) is now scoped to `public/*` read-only — what `apps/public-api` uses, unmodified, so its inability to reach `journal/*`/`documents/*` is a fact about the box's credentials, not something that depends on its own routing getting a check right. `apps/api` explicitly assumes a second, broader role (`journal_api_write`) via STS at boot (`apps/api/src/store/s3-client.ts`, `S3_ASSUME_ROLE_ARN` in `.env`) to reach the fuller `journal/*`/`documents/*`/`public/*` access it needs. "The public API's IAM role is denied access to `journal/*`" is now a real, directly-testable guarantee (`aws sts get-caller-identity` / a raw S3 call from the box, under the instance role, denied on anything outside `public/*`) rather than one that depended on infrastructure that didn't exist. Still outstanding: a live confirmation of this against the real deployed instance, and `apps/public-api` itself still has no deploy/systemd/Caddy story of its own in `infra/` — it has never actually run on the box.

**Done when.** `npm run typecheck` is clean across `contract`, `api`, `web`, `public-api`, `blog`; the `api` test suite (including new `published-index.test.ts` and `publish/publisher.test.ts`) and the `public-api` test suite both pass; verified via the test suites rather than a live deploy in this pass (no real AWS credentials in this environment) — a live check (publish an entry and a document, confirm both appear via `apps/public-api` and disappear on unpublish, confirm an edit re-syncs the mirror) remains outstanding against a real deployment.

---

## M16 — Derived-structure visibility

**Goal.** Metrics, reviews, opinion statements, lists and questions — the same five structure types M10 gave a `touched` column to — can each be published individually through M15's mirror, with a category-level "public by default" setting that stages matching records for one-click confirmation rather than ever auto-publishing.

**Built**

- `VisibilityDefaultsIndex` (`apps/api/src/index/visibility-defaults-index.ts`) — a new table `visibility_defaults(structure_type, category, default_public)`, keyed on exactly the category vocabulary `CategoriesIndex` already has (`metric`, `review_medium`, `list_type`, `opinion_subject`) rather than a new taxonomy. Questions have no category (`QuestionsIndex`'s own doc comment explains why) and so never appear here — a question is only ever published one at a time, directly. Setting a default never publishes anything by itself; it only changes what `/publish-queue` offers.
- `Publisher` (`apps/api/src/publish/publisher.ts`) extended to render a snapshot for each of the five types — `MetricPublicSnapshot`, `ReviewPublicSnapshot`, `ListItemPublicSnapshot`, `OpinionStatementPublicSnapshot`, `QuestionPublicSnapshot` — each carrying only the record's own semantic content, deliberately never `entryId` or `touched`/`extractedAt` provenance: the source entry isn't itself public, and there's no reason a public reader needs to know which private entry a public review or metric was drawn from. A published question keeps its `resolution` (publishing one is meant to show the answer) but omits `resolvedEntryId`. Since none of the five have a stored `contentHash` of their own (unlike an entry or document, a record here is never a file), `resyncIfPublished` compares a hash computed fresh over the rendered snapshot's own JSON instead.
- `POST /{metrics,reviews,lists,opinions/statements,questions}/:id/publish` and `.../unpublish` — the same five-route-shape repetition M10 already used for `validate`/`untouch`, all tolerant no-ops, all going through `Publisher`.
- `GET /visibility-defaults`, `PUT /visibility-defaults` — read and set a category's default.
- `GET /publish-queue` — for every category with `default_public = true`, every record not yet in `Publisher.publishedIds(...)`, surfaced as `{ structureType, category, id, preview, eventTime }`. Nothing here is ever auto-published; confirming an item is a separate `POST .../publish` call from `apps/web`.
- `apps/web` gained `app/publish-queue` (the confirmation queue, styled like the existing pending-update-suggestions list) and a publish/unpublish control alongside the touched-indicator pill on each of the five structure-type pages.
- `reprocess.ts` untouched — publishing is a manual action layered on top of extraction, exactly like `touched` is, and never changes how extraction itself runs.

**Not in this milestone.** Search over documents, and a public search endpoint — see M17.

**Done when.** `npm run typecheck` is clean across `contract` and `api`; the `api` test suite (including `visibility-defaults-index.test.ts` and the extended `publish/publisher.test.ts`/`http/app.test.ts` coverage for the five publish routes and `/publish-queue`) passes; setting a category's default to public surfaces its records in `/publish-queue`, confirming one publishes it and removes it from the queue, and toggling the default off stops new records from queuing without touching anything already published.

---

## M17 — Search over documents, and public search

**Goal.** `GET /search` covers documents as well as entries (previously entries-only, `apps/api/src/store/searching-entry-store.ts`); `apps/public-api` gets a search endpoint over exactly what has been published, as a direct consequence of M15's mirror boundary rather than a separate leak-prevention mechanism.

**Built**

- `SearchIndex` (`apps/api/src/index/search-index.ts`) gained a `source_type TEXT NOT NULL DEFAULT 'entry'` column on `chunks`, added via the same idempotent `PRAGMA table_info`/`ALTER TABLE` migration every other index in this directory uses. The physical column is still named `entry_id` — an `ADD COLUMN` migration only ever adds, and renaming an existing column carried more risk than it was worth — but every row is now addressed by `(source_type, entry_id)`, so a document and an entry can never collide even though ids are drawn from the same ULID space. `replaceEntry`/`removeEntry` survive unchanged as thin wrappers around the new `replaceSource`/`removeSource`, so `SearchingEntryStore` needed no changes at all.
- `SearchIndexer` (`apps/api/src/search/indexer.ts`) gained `indexDocument`/`removeDocument` (document twins of `indexEntry`/`removeEntry`) and `rebuildAllDocuments` (the document twin of `rebuildAll`) — the latter deliberately does not clear the index itself, since it is meant to run immediately after `rebuildAll` in the same corpus rebuild, and clearing twice would wipe out the entries `rebuildAll` just finished indexing.
- New `SearchingDocumentStore` (`apps/api/src/store/searching-document-store.ts`), mirroring `SearchingEntryStore`'s decorator shape exactly: wraps `DocumentStore`, indexes on `create`/`update`, never fails the write if indexing fails. Wired into `apps/api/src/index.ts` boot in place of the previously-unwrapped `createDocumentStore(...)` result; `rebuild.ts` calls `rebuildAll` (entries) then `rebuildAllDocuments` (documents) in that order.
- `HybridSearcher` (`apps/api/src/search/searcher.ts`) takes a `DocumentsIndex` alongside `SqliteIndex`, and resolves each fused hit against whichever index matches its `source_type`. `SearchHit` (`packages/contract`) is now a discriminated union — `EntrySearchHit { sourceType: 'entry', entryId, created, location?, passage }` / `DocumentSearchHit { sourceType: 'document', documentId, title, created, passage }` — so a caller can never mix up which kind of result it is holding.
- `apps/web`: `lib/search-hit.ts` (new) centralises "where does this hit link to" and "what makes it unique in a list" for the two variants, shared between `app/search/page.tsx` and `app/home-search.tsx` rather than duplicated.
- Public search: a second, deliberately separate table set — `PublicSearchIndex` (`apps/api/src/index/public-search-index.ts`), tables `public_chunks`/`public_chunks_fts` in the same shared `index.db` — fed directly by `Publisher.publish`/`unpublish`/`resyncIfPublished` (chunked the moment something is mirrored, not by a separate crawl), scoped to entries and documents only: the five derived-structure types are short structured facts, not prose worth chunking. BM25 only, no vector column and no embedder dependency — `apps/public-api` stays minimal and has no embedding model of its own; the private side keeps the fuller "search by meaning" experience.
- `apps/public-api` gained `PublicSearchReader` (`src/public-search-reader.ts`, read-only, schema duplicated by hand exactly as `PublishedIndexReader` already does) and `GET /search`, resolving each chunk hit's `(sourceType, sourceId)` against a new `PublishedIndexReader.getBySourceId` to find its mirror key, then the snapshot itself for a slug/title/passage. Because `public_chunks` only ever contains what was deliberately published, no separate check is needed anywhere in this path to keep an unpublished item from surfacing — the boundary is structural.
- `apps/blog` gained `app/search` (the one Client Component in this app — a live search box has nothing to server-render) and a nav link.

**Not in this milestone.** Rebuilding the public search index from `PublishedIndex` directly (e.g. after the `public_chunks` table itself were ever lost) — today it is only ever populated by `Publisher`'s own publish/unpublish/resync calls, with no standalone rebuild path. If it were ever lost, republishing each item would recreate it, but there is no single command that does that yet.

**Done when.** `npm run typecheck` is clean across all five workspaces; the `api` test suite (including the `source_type` coverage in `search-index.test.ts`, the new `searching-document-store.test.ts`, the document coverage in `searcher.test.ts` and `indexer.test.ts`, and the public-search-indexing tests in `publish/publisher.test.ts`) and the `public-api` test suite (including new `public-search-reader.test.ts` and the `/search` coverage in `http/app.test.ts`) both pass; a query phrased in words only a document contains finds that document via `GET /search`, existing entry-search results are unchanged, and a public search query never returns a document or entry that has not been published.
