@AGENTS.md

# Journal

A personal journal intended to hold its owner's writing for the rest of their life.

## Documents

- **`docs/requirements.md`** — canonical. What the system is. Read this first.
- **`docs/format.md`** — exactly what is written to disk. Subordinate to requirements, but not disposable: it describes files meant to outlive every application that reads them. Changing it is a migration.
- **`docs/design.md`** — the current frontend's visual and interaction design. Subordinate, and disposable.
- **`docs/plan.md`** — the build order. Disposable, and carries no authority over anything.

Precedence runs in that order. If any two conflict, the higher one wins and the lower one is wrong.

## Non-negotiables

1. **Journal entries are plain markdown files, and they are canonical.** Not database rows. As of M11 they live in S3, not a local directory — a relocation of *where* canonical points, not a change to *what* it means: still plain markdown, still readable and exportable without this application existing, via `aws s3 sync`. Nothing above `EntryStore` may know or care which is true.
2. **Storage and compute are hosted as of M11: S3 for the journal, a small persistent-disk host for the API.** This is `requirements.md` §7.2's "going online," happening on purpose, and kept deliberately minimal — not general SaaS infrastructure, and kept swappable back to fully local by design (`aws s3 sync` out, a local storage adapter back in). Never bypass the API boundary just because two parts happen to run on the same host.
3. **All model access goes through one internal interface.** No provider-specific detail in extraction logic, prompts, or schemas. The model and provider must be changeable without touching the pipeline.
4. **A safety net exists around the files, independent of the application — it does not have to be git.** As of M11: S3 versioning plus a scheduled sync-to-local-git mirror. Whatever form it takes, the application must never read its history, surface it, or depend on it to function. There is no in-app version history.
5. **Nothing writes back to a journal entry.** The extraction pipeline reads entries; it never modifies them. Only the user authors entries.
6. **Untouched derived data is rebuildable from the entries alone; touched data is not.** A record the user has reviewed, corrected, or edited becomes theirs permanently and is never silently overwritten by re-extraction. Only records never touched remain a disposable cache. See `docs/requirements.md` §2, §6.4.
7. **The pipeline must have a full reprocess-from-scratch mode**, not only incremental processing. It re-derives freely over untouched records but only ever proposes updates to touched ones, for the user to accept or ignore. This is also how a deliberate model migration is validated — diffed against touched records, never run automatically off routine provider routing.
8. **No logic in the frontend.** All extraction, querying, aggregation, and search lives behind the API. The frontend calls endpoints and renders results.
9. **No hardcoded colours, fonts, sizes, or spacing in components.** Everything references a token. Define and review the token set before building components.
10. **The AI never creates new metrics on its own.** It may suggest; the user approves. Or the user requests directly.
11. **The opinion model never extrapolates.** It organises and summarises opinions actually expressed, linked to their source entries. It does not infer positions the user has not stated.
12. **No engagement mechanics, ever.** No streaks, gamification, reminders, notification badges, or encouragement. See `docs/design.md` §4.
13. **Entry time is not event time.** When an entry describes something that happened earlier or elsewhere, the event's own time and place come from the prose, not from the entry's metadata.

## Before implementing

Check `docs/requirements.md` §10 and `docs/plan.md` for what is still open. **Ask rather than inventing an answer.**

The typeface, palette, and keyboard scheme were open and are now settled in `docs/design.md` §3, §2.3, and §5.2. Nothing in that document is currently open.
