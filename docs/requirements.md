# Journal system — statement of intent

*This is the canonical document. It describes what the system is and what has been decided about it. It is deliberately slow-changing: most of it should still be true in ten years.*

*It contains no schemas, data structures, or technical designs. Visual and interface decisions live in `design.md`, which is subordinate to this document — nothing in `design.md` may constrain anything described here. Where something has been deliberately deferred, it is recorded as deferred rather than resolved.*

---

## 1. What this is

Fundamentally, a journal.

The purpose is to write down trains of thought, records of what I've been up to, anything on my mind, or anything at all. Free-form. There is no restriction on what an entry may contain, and no expectation that entries conform to a topic, structure, or format.

Everything else described in this document is built around that act of writing. Nothing else is the point.

---

## 2. The two core pillars

Two properties define the project. Both are non-negotiable, and both constrain everything else.

### Pillar 1 — What I write persists

I intend to keep what I write for the rest of my life.

I also know that the specific implementation I want today will change over time. That knowledge is itself a design input: I should not assume any particular application, format-specific feature, or tool will still exist or still be what I want in the future.

Therefore what I write must be:

- **Safe** — durable against loss, and against the failure or abandonment of any particular piece of software. This is meant in the sense of durability.
- **Easily exportable** — retrievable in full, without difficulty, at any time.
- **Fundamentally flexible and simple** — so that it can be repurposed by whatever system I want to build around it later.

Entries are written in plain markdown. That is the only thing the user authors.

This pillar takes precedence. It is understood to be a genuine constraint on the other functionality I want, and where the two conflict, this pillar wins.

### Pillar 2 — AI-derived structure

An AI passes over all journal entries and produces structured data capturing my trends and anything else of interest.

The purpose is analysis and tracking — to gain insight into my fluctuations and my pillars. The structured data exists so that patterns spread thinly across years of prose can be seen in one place.

The critical property: **the user only ever creates journal entries.** All secondary structures are populated by the AI reading those entries. I do not maintain the structured data by hand.

---

## 3. Relationship between the journal and everything derived from it

The journal entries are the source. The secondary structures are built autonomously as a result of them.

Everything derived is linked back to the journal entries it came from. This applies across all secondary structures, not just some of them.

---

## 4. The journal record

This section covers the source layer — the entries themselves, and the properties they must have. This is the layer that is expensive to change and that Pillar 1 protects.

### 4.1 Entry granularity

**One file per writing session**, not one per day.

A per-session entry is written once and then effectively not touched again, which makes immutability structural rather than a matter of discipline. It avoids the same file being repeatedly reopened and edited through the day, avoids conflicts when writing from more than one device, and preserves the time at which each piece of writing actually happened rather than collapsing everything under a single date.

"What did I write on a given day" is therefore a query, not a file.

### 4.2 Identity and file organisation

Files are organised by year and month, and named so that lexical order matches chronological order, with time included so that multiple sessions in one day do not collide, plus a short unique suffix.

Illustrative form: `journal/YYYY/MM/YYYY-MM-DD-HHMM-<suffix>.md`

Filenames use **local time**, because their whole purpose is browsing the files by hand and local time is how the writing is remembered. One consequence is accepted: across a change of timezone, lexical order can disagree with true chronological order. Ordering is determined by the recorded time (§4.3), never by the filename.

Filenames are not something the user needs to see or care about. They are a convenience for browsing the files directly.

**Identity lives in the entry's `id`, not in its filename.** If a file is ever renamed, nothing that refers to it breaks.

### 4.3 Entry metadata

The entry records **the time and place at which it was created, and nothing else.** No titles, no user-supplied fields, no optional extras. "Nothing else" governs what may be *written into* an entry; the entry also carries its `id` (§4.2), which is machinery rather than content.

**Time.** Always recorded with its UTC offset. A local timestamp with no offset is permanently ambiguous and cannot be reconstructed later — this matters given an expectation of travel.

**Location.** Captured automatically. **The entry records the coordinates, and only the coordinates.** The city or town name is derived from them and lives with everything else derived (§3), never in the entry file — because a name filled in years from now must not mean rewriting years of entries.

Location is **never manually entered.** If it cannot be determined automatically it is simply absent — absent, not blank or guessed — and it must take up no space in the writing interface. There is no prompt to fill it in.

Coordinates come from the device's own location services. Resolving them to a place name requires a geocoder, which is deferred (§7.5). Because the coordinates are stored and permanent, names can be produced at any point later — and being derived, they can be regenerated or corrected freely without the record ever being touched.

**Both time and location describe the act of writing, not the events being written about.** An entry written at home about a run that happened that morning elsewhere records home. Determining when and where the described events actually occurred is the extraction layer's job, from the prose itself.

### 4.4 Editing past entries

Editing is allowed.

**The application itself has no version-history feature.** No in-app revision browser, no diff view, no audit trail, no interface surface for any of it. Realistically this is a single-user system and I do not expect to go back and alter old entries; the application should not be designed around that possibility.

Protection against loss is handled entirely outside the application, at the storage layer (§7.4). The journal directory is a git repository, but git is a **safety net around the files, not a feature of the system**: the application does not read git history, does not surface it, and does not depend on it in order to function. If git were removed tomorrow the application would behave identically — it would simply be less safe.

### 4.5 Continuation and returning to earlier writing

Returning to a subject later produces a **new entry**, not an append to an existing one. Appending would corrupt the creation time, which is the anchor for everything temporal.

However, the interface must not push the user into a new entry prematurely — the boundary of a writing session belongs to the user, not to a timer or an automatic rule.

Related interface requirement: while writing a new entry, it should be possible to have previous entries open and visible for reference.

### 4.6 Attachments

Attachments are supported — photos, voice memos, and similar.

They live in a directory structure mirroring that of the entries, referenced from the entry by relative link, so that the whole collection remains self-contained and portable and the links resolve in any markdown viewer. They are committed alongside the entries (§7.4).

Insisting that those links resolve in a plain markdown viewer has one consequence: an attachment link is the only thing in the system that depends on an entry's filename rather than its `id`. Renaming an entry file means renaming its attachments with it. That is the price of portable links, and it is worth paying.

### 4.7 Voice and transcription

Transcription is available when creating an entry.

**The plaintext transcript is always produced and kept, as part of the entry itself.** It is treated as source material, not as derived data — spoken content becomes text in the journal record like anything else.

Optionally, the original audio may also be saved and stored as an attachment. That is an addition to the transcript, never a replacement for it.

Transcription runs on the local machine, so it introduces no dependency on an external service (§7.2).

### 4.8 No user markup

There is no strict formatting convention, and none will be introduced. Structuring the content is the AI's job, not mine.

I may incidentally fall into similar formatting habits for certain things. Where that happens, such patterns may be used as **weak hints only** by the extraction layer, never as requirements. Extraction must work correctly on an entry with no formatting whatsoever. Anything missed because a habitual formatting pattern was absent is a defect, since no convention was ever agreed.

---

## 5. Secondary data structures

### 5.1 Multiple distinct types, by design

There should be many different types of secondary structure, serving different purposes. They are not variations of one thing; they behave differently from one another and should be treated differently.

I keep thinking of more, and will continue to think of more. **The system must be designed with that fact accounted for.** Adding a new kind of structure, or a new instance of an existing kind, is an expected ongoing activity rather than an exceptional event.

### 5.2 Structures identified so far

**Simple temporal metrics.** Things explicitly stated in a journal entry and stored against time — exercise, alcohol, sleep, and so on. This is the most obvious case. The list is open-ended.

**Reviews.** For things like films, books, and music. These are more like a table with various fields, and are treated differently from simple metrics.

Each time the same thing is encountered, a new record is created for that event — not an edit to a single existing record. The intention is to track all of it, including repeat encounters with the same work.

**Models of my opinions.** For example my philosophy, or my view of my future. The defining characteristic is that any single journal entry contains only partial information on the subject, and the goal is to have it all organised in one location, as well as to be able to see how it changes over time.

There is an absolute constraint on this structure: **it must not extrapolate from what I have written.** Its function is to store, summarise, and organise the opinions I have actually expressed, all of it linked to the journal entries it came from. It does not infer positions I have not stated, and it does not extend my reasoning on my behalf.

This structure is acknowledged as potentially quite complicated, and its implementation is not yet settled.

**Lists of atomic items.** For example quotes. These behave differently again from the structures above.

### 5.3 New metrics and structures

The AI does not autonomously create new metrics.

Two routes exist for creating them:

- The AI **suggests** a new metric, and the user approves it.
- The **user requests** a new metric directly.

---

## 6. How the extraction works

### 6.1 Autonomy is the default

The majority of the work is autonomous. That is the point of the system.

Anything explicit in a journal entry is auto-committed without approval — explicit statements are high-confidence and do not need reviewing. There may be some things that warrant approval, but they are the exception rather than the rule. The system should not be gated behind constant user confirmation.

### 6.2 Mistakes must be easy to fix

Because most writes happen without review, it must be simple to rectify a mistake when the AI gets something wrong. Correctability is the safeguard that makes broad autonomy acceptable.

### 6.3 Event time versus entry time

Following from section 4.3: the time an entry was written is not the time the things in it happened. Where a described event has its own time, that must be determined from the prose rather than assumed from the entry's timestamp.

### 6.4 Everything derived is rebuildable, and is rebuilt in full

Everything derived from the entries can be reconstructed from the entries alone. If all of it were deleted, nothing would be lost that could not simply be produced again. It is a cache, never a record. This follows directly from section 3, and is the practical form of Pillar 1's precedence: the entries owe nothing to the structures built on them.

Keeping that true in practice rather than in principle requires that rebuilding actually be exercised. So the pipeline has a **full reprocess-from-scratch mode** alongside incremental processing — a first-class operation, not a maintenance utility.

This is also what makes changing model affordable (§7.6): re-running extraction across the whole corpus and comparing the output is how a model change is validated, and it is only cheap because the derived layer is disposable.

---

## 7. Architecture, platform, and storage

### 7.1 A clear divide between frontend and backend

**There is a hard separation between the frontend and the backend.** This is a requirement, not an implementation preference.

The purpose is that I can change large parts of the frontend, or replace it entirely, whenever I want, without that touching anything that matters. The backend must therefore be organised so that this is genuinely cheap rather than nominally possible.

**All logic lives behind the boundary** — extraction, querying, aggregation, search, and anything else. The frontend calls the backend and renders what comes back. It contains no business logic, no extraction rules, no analysis, and no knowledge of how anything is stored.

An HTTP API is accepted as the means of implementing this boundary. That is a decision about mechanism and may be revised if something clearly better exists; the separation itself may not.

A consequence worth stating: because the boundary is clean, more than one frontend could exist against the same backend, and any given frontend is disposable.

### 7.2 Local first

**Everything runs locally, on my own machine, against my own file system.** No hosting, no third-party infrastructure, no external services.

This is a deliberate decision for now, made to avoid the overhead of depending on external services at this stage. It is not a permanent commitment: the system may go online later, and that intention still stands.

It is worth noting that this arrangement is the *strongest possible* version of Pillar 1. Plain markdown files sitting in a folder on a disk I control depend on nothing — no provider, no account, no network, no application. Going local is a simplification of the architecture, not a compromise of it.

**Going online later is precisely what §7.1 protects.** Because all logic sits behind the API boundary and the frontend holds none of it, moving from a local backend to a hosted one should be a change of storage adapter and deployment target, not a rewrite. Nothing in the current design may assume the backend is local in a way that would make that move expensive.

### 7.3 Storage

**The markdown files are canonical, and they live in an ordinary directory on the local file system.** Entries exist as actual markdown files that can be opened, read, copied, and searched with any tool, with or without this application. Export is not a feature to be built — it is `cp -r`.

**Encryption is not a priority.** It is acceptable if it is required for other reasons, provided it makes no difference to the user experience. No bespoke per-entry encryption scheme is called for, and nothing about it should compromise the plainness and portability of the stored files.

### 7.4 Protection against loss

No revision history exists inside the application (§4.4), so protection is handled at the storage layer.

- **The journal directory is a git repository.** Commits provide the recoverable history the application deliberately lacks. Plain markdown is close to an ideal fit for git — small, diffable, text.
- **A remote is what makes it a real backup.** A local-only repository does not survive disk failure. Pushing to a private remote gives offsite redundancy.
- **iCloud may additionally sync the directory**, for a second copy.

**Git remains outside the system.** It is operated at the file level and the application must not depend on it. See §4.4.

**Implementation hazard worth knowing:** a live git working tree inside an iCloud-synced folder is a known source of repository corruption, because iCloud may sync `.git` internals while git is mid-write. If both are used, they should not be layered over the same directory. A private git remote alone is the simpler arrangement and already provides offsite backup.

Two sub-decisions, now settled:

- **What performs the commits.** A scheduled job outside the application. The application never invokes git, which is what keeps §4.4 literally true rather than nearly true. Committing automatically on save would be marginally more reliable, but would buy that reliability with the exact dependency §4.4 exists to avoid.
- **Whether attachments are committed.** They are. Binaries grow a repository permanently, but journal attachments are written once and never modified, so the pathological repeated-diff case does not arise. Excluding them would mean covering them with iCloud instead, which cannot be layered over the git working tree (see above) and would break the self-containment §4.6 requires. Repository size is the lesser cost.

### 7.5 Deferred as a consequence of running locally

The following were previously decided and are now **deferred, not abandoned.** They are expected to return if and when the system goes online.

- **Remote and multi-device access.** The earlier decision was that the journal be writable from phone and laptop and reachable from anywhere. That is not being built for now.
- **Geocoding** of coordinates into place names (§4.3). Derived, so deferring it costs nothing and it can be produced at any time from the stored coordinates.

Transcription was previously listed here, deferred unless run by a local model. It is no longer deferred: it is run locally, and so needs nothing external. See §4.7.

### 7.6 AI provider access

**Calling an external AI API is accepted.** "No third-party services" (§7.2) refers to hosting and infrastructure; the extraction pipeline may reach out to a hosted model. Pillar 2 requires this, short of running models locally.

**Requirement: the model and the provider must be easy to change.** Model quality and pricing will change many times over the life of this project, and the system must never be attached to one vendor.

Therefore: **all model access goes through a single internal interface, and no provider-specific detail appears anywhere in the extraction logic.** Prompts, schemas, and pipeline code know nothing about which provider is serving the request.

Vercel AI Gateway together with the AI SDK is the intended approach. It has been checked against the actual need: the gateway sits in front of every supported provider and resolves a `creator/model-name` string, so application code is unchanged whether it calls Claude, GPT, or Gemini, with no token markup. Schema-constrained extraction is supported across providers — `generateObject` takes a Zod schema and uses each provider's native structured-output mechanism underneath, validating and retrying on malformed output. That covers what the extraction pipeline requires. The SDK also works independently of the gateway, so the gateway itself remains swappable infrastructure rather than a lock-in.

**Critical distinction, and the reason this needs to be thorough:** a swappable interface does not mean swappable *results*. Schema adherence and extraction quality differ between models even when the calling code is identical. Prompts and schemas tuned against one model must be re-validated when the model changes — the abstraction covers the plumbing, not the behaviour.

This is what makes the full reprocess-from-scratch requirement (§6.4) load-bearing rather than housekeeping: it is also the mechanism for migrating models. Re-running extraction over the whole corpus and comparing output is how a model change is validated, and it is only cheap because the derived layer is disposable.

---

## 8. Other functionality

**Search.** A very sophisticated search engine over the journal. Sophisticated specifically in that it searches by **meaning**, not only by matching words: describing what is being looked for should find it, including where the entry never used those words.

**Further features.** I will likely think of other functionality as I go. The system needs to be designed with that in mind — additional features should be additions to what exists, not occasions for rebuilding it.

---

## 9. Deferred — not yet decided

The following have been raised and deliberately set aside for later consideration. They are open, not rejected.

**To-do lists / longer-term goals.** Not needed for now. To be returned to after more thought.

**Hand-editing the opinion model.** For now, not something I edit directly. To be reconsidered later.

**Implementation of the opinion model.** Recognised as the least resolved of the identified structures.

**Going online.** Remote access, multi-device use, and hosted infrastructure are deferred rather than rejected. See §7.2 and §7.5.

---

## 10. Summary of what must remain true

- The journal entries are plain markdown and are the only thing I write.
- What I write persists for life, safely, exportably, and simply.
- One file per writing session; identity lives in the entry, not the filename.
- Entries record the time and place of writing, and nothing else — automatically, never by hand.
- Spoken entries always become plaintext; audio is optional and additional.
- No user markup, ever; structuring is the AI's job.
- All structured data is derived from the entries and linked back to them.
- The derived layer is a rebuildable cache, and is rebuilt in full to keep that true.
- Many kinds of structure exist, more will be added, and the design assumes this.
- New metrics are approved or requested by me, never created unilaterally.
- Most extraction is autonomous; mistakes are easy to correct.
- Model and provider are always swappable; nothing is tied to one vendor.
- The opinion model organises what I said, and never extrapolates beyond it.
- Frontend and backend are cleanly separated; the frontend is disposable.
- Everything runs locally, on my own file system, with the files canonical — and the separation above is what keeps going online later cheap.
- Everything above the journal serves the journal, and never the reverse.
