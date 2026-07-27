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

1. **Journal entries are plain markdown files in a local directory, and they are canonical.** Not database rows. Everything must remain readable and exportable without this application existing.
2. **Everything runs locally. No hosting, no third-party infrastructure.** Calling a hosted AI API for extraction is the one exception. This is current scope, not permanent — so keep the API boundary clean enough that going online later is a deployment change, not a rewrite. Never bypass the boundary just because both sides run on the same machine.
3. **All model access goes through one internal interface.** No provider-specific detail in extraction logic, prompts, or schemas. The model and provider must be changeable without touching the pipeline.
4. **Git is a safety net around the files, not a feature.** The journal directory is a git repository, but the application must not read git history, surface it, or depend on it to function. There is no in-app version history.
5. **Nothing writes back to a journal entry.** The extraction pipeline reads entries; it never modifies them. Only the user authors entries.
6. **Everything derived is rebuildable from the entries alone, and links back to them.** If the derived store were deleted, it could be regenerated in full. Treat it as a cache, never as a record.
7. **The pipeline must have a full reprocess-from-scratch mode**, not only incremental processing. This is what keeps point 6 true in practice rather than in theory.
8. **No logic in the frontend.** All extraction, querying, aggregation, and search lives behind the API. The frontend calls endpoints and renders results.
9. **No hardcoded colours, fonts, sizes, or spacing in components.** Everything references a token. Define and review the token set before building components.
10. **The AI never creates new metrics on its own.** It may suggest; the user approves. Or the user requests directly.
11. **The opinion model never extrapolates.** It organises and summarises opinions actually expressed, linked to their source entries. It does not infer positions the user has not stated.
12. **No engagement mechanics, ever.** No streaks, gamification, reminders, notification badges, or encouragement. See `docs/design.md` §4.
13. **Entry time is not event time.** When an entry describes something that happened earlier or elsewhere, the event's own time and place come from the prose, not from the entry's metadata.

## Before implementing

Check `docs/requirements.md` §9 and `docs/plan.md` for what is still open. **Ask rather than inventing an answer.**

The typeface, palette, and keyboard scheme were open and are now settled in `docs/design.md` §3, §2.3, and §5.2. Nothing in that document is currently open.
