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

**Origination is still automatic.** All secondary structures begin life populated by the AI reading entries — I do not hand-create derived records, and autonomy remains the default (§6.1).

**Ownership, once created, is mine to take.** I may review, correct, or directly edit any derived record. Doing so — *touching* it — is a deliberate act, and it changes that record's status permanently: a touched record is mine, not the AI's, from that point on. It is never silently regenerated or overwritten by a later extraction pass.

This reverses an earlier, stricter position — that structured data was never hand-maintained. The reversal is deliberate: I am already the one checking and correcting this data in practice, and the AI layer is more useful the more I can trust and shape it. Records I have never reviewed remain exactly what they always were — a pure function of the entries, freely regenerable, disposable (§6.4). The distinction between touched and untouched is what makes both halves of this pillar true at once.

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

Protection against loss is handled entirely outside the application, at the storage layer (§7.4): S3 versioning and a scheduled local git mirror, as of M11. Whichever mechanism is in place is a **safety net around the files, not a feature of the system**: the application does not read its history, does not surface it, and does not depend on it in order to function. If it were removed tomorrow the application would behave identically — it would simply be less safe.

### 4.5 Continuation and returning to earlier writing

Returning to a subject later produces a **new entry**, not an append to an existing one. Appending would corrupt the creation time, which is the anchor for everything temporal.

However, the interface must not push the user into a new entry prematurely — the boundary of a writing session belongs to the user, not to a timer or an automatic rule.

Related interface requirement: while writing a new entry, it should be possible to have previous entries open and visible for reference.

### 4.6 Attachments

Attachments are supported — photos, voice memos, and similar.

They live in a directory structure mirroring that of the entries, referenced from the entry by relative link, so that the whole collection remains self-contained and portable and the links resolve in any markdown viewer. They are committed alongside the entries (§7.4).

Insisting that those links resolve in a plain markdown viewer has one consequence: an attachment link is the only thing in the system that depends on an entry's filename rather than its `id`. Renaming an entry file means renaming its attachments with it. That is the price of portable links, and it is worth paying.

**The media library.** Separately from attachments, photos and video can be bulk-uploaded to a library independent of any entry — a place to get things off a phone or a camera without deciding in the moment which entry, if any, they belong to. A library item is immutable once uploaded, addressed by its own id, and carries whatever timestamp its own file metadata (EXIF, or a video container's own creation time) supplies.

An entry attachment sourced from the library is a copy, not a reference: attaching a library photo to an entry copies its bytes into that entry's own attachment directory, the same directory structure described above. This keeps the portability guarantee intact — the attachment resolves as a plain relative link with no dependency on the library existing at all — at the cost of the same bytes existing twice once both a library item and an attachment reference it. Deleting the library original afterward does not touch anything already attached to an entry.

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

**Concept notebooks.** For a subject worth gathering everything about over time — my philosophy, my view of my future, relationships, my own brain. The defining characteristic is that any single journal entry contains only a fragment of the subject, and the point of the structure is having it all in one place, organised by what it's about rather than by when it was written.

**Reframed 2026-08-30.** This started narrower, as "models of my opinions" — restricted to views, beliefs, and positions I had explicitly stated. That excluded exactly the plain facts and observations that make a subject like "my brain" or "relationships" worth gathering in the first place. The scope is now anything an entry actually says about the subject — a fact, an event, a reflection, or a stated view — not opinions specifically.

**Grouping is the primary purpose; summarising is secondary.** The main value of this structure is everything about a subject collected in one place, readable as a record. A generated, cross-entry summary is a secondary, optional layer on top of that grouping — useful, but not the reason the structure exists, and never presented ahead of the grouped record itself.

There is an absolute constraint on this structure, unchanged by the reframing above: **it must not extrapolate from what I have written.** Its function is to store and organise what I have actually written about a subject, all of it linked to the journal entries it came from. It does not infer positions or facts I have not stated, and it does not extend my reasoning on my behalf.

**Lists of atomic items.** For example quotes. These behave differently again from the structures above.

### 5.3 New metrics and structures

The AI does not autonomously create new metrics.

Two routes exist for creating them:

- The AI **suggests** a new metric, and the user approves it.
- The **user requests** a new metric directly.

---

## 6. How the extraction works

### 6.1 Review is grouped and batchable, not per-record

This section originally read the opposite way: explicit statements were auto-committed without approval, and review was the exception. That is reversed here, deliberately and on the record, not by drift — the exception swallowed the rule in practice, and correcting after the fact (§6.2) turned out to matter less than seeing what was about to be committed in the first place.

Nothing the pipeline extracts commits silently anymore. A new record, an update to an existing one, a question or todo being resolved — all of it becomes a pending item waiting on approval before it is live.

This is not constant confirmation. Review is grouped and batchable: everything a single Process run produced surfaces together, arranged by confidence, and one action approves many at once — every pending metric together, or more than that if I choose. The point is to pay the cost of review once per batch, not once per fact.

Confidence is a real signal the model attaches to each candidate. For "medium" and "high" it decides only how review is arranged — what surfaces first, what's grouped together — never whether something is shown. "Low" is the one exception: a candidate the model itself is genuinely unsure of is discarded before it ever becomes a pending item, rather than adding one more row to reject. Confidence is never stored on the committed record.

If a batch isn't acted on right away, nothing is lost: it waits in one fallback queue, not scattered across per-type pages that nothing links to.

The autonomy that remains is in what the pipeline is trusted to *propose*, not in what it's allowed to commit unseen — extraction still runs on every Process, unprompted per-field, but nothing lands without my having seen it.

### 6.2 Mistakes must be easy to fix

Because most writes happen without review, it must be simple to rectify a mistake when the AI gets something wrong. Correctability is the safeguard that makes broad autonomy acceptable.

### 6.3 Event time versus entry time

Following from section 4.3: the time an entry was written is not the time the things in it happened. Where a described event has its own time, that must be determined from the prose rather than assumed from the entry's timestamp.

### 6.4 Untouched data is rebuildable; touched data is not

**Untouched** derived records — created by the AI, never reviewed or edited (§2) — remain a pure function of the entries. If all of them were deleted, nothing would be lost that could not simply be produced again. They are a cache, never a record. This follows directly from section 3, and is the practical form of Pillar 1's precedence: the entries owe nothing to the structures built on them.

**Touched** derived records — anything I have reviewed, corrected, or edited directly (§2) — are not disposable. They are mine, and losing one loses real work, not a regenerable artefact. From the point I touch a record, it carries the same durability expectation as the entries themselves (§7.4), not the expectation of a throwaway cache.

The pipeline still has a **full reprocess-from-scratch mode** alongside incremental processing, and it remains a first-class operation, not a maintenance utility. What it means has changed: it re-runs extraction across the whole corpus, freely replacing untouched records, but it never silently overwrites a touched one. At most it proposes an update to a touched record, through the same suggest-and-approve mechanism used elsewhere (§5.3), for me to accept or ignore.

This is also the mechanism behind changing model (§7.6): re-running extraction and diffing the result against my touched records — not against unreviewed AI output — is how a model change is judged. It is a deliberate, occasional action I take on purpose, not something triggered by day-to-day provider routing (§7.6).

---

## 7. Architecture, platform, and storage

### 7.1 A clear divide between frontend and backend

**There is a hard separation between the frontend and the backend.** This is a requirement, not an implementation preference.

The purpose is that I can change large parts of the frontend, or replace it entirely, whenever I want, without that touching anything that matters. The backend must therefore be organised so that this is genuinely cheap rather than nominally possible.

**All logic lives behind the boundary** — extraction, querying, aggregation, search, and anything else. The frontend calls the backend and renders what comes back. It contains no business logic, no extraction rules, no analysis, and no knowledge of how anything is stored.

An HTTP API is accepted as the means of implementing this boundary. That is a decision about mechanism and may be revised if something clearly better exists; the separation itself may not.

A consequence worth stating: because the boundary is clean, more than one frontend could exist against the same backend, and any given frontend is disposable.

### 7.2 Local first

**As of M11, the journal is built to run online: S3 is the canonical store, and the API is meant to run on a small persistent-disk host rather than my own machine.** This is a deliberate reversal of the position below, not an accretion on top of it — made because durability and reachability outweighed the overhead of external services, once §7.1's boundary made the move cheap enough to actually take.

The strongest possible version of Pillar 1 was running fully local, depending on nothing but a disk I control. Going online gives that up in exchange for durability and reachability, deliberately: it keeps the properties Pillar 1 actually cares about — plain markdown, no lock-in, trivial full export — while relocating *where* the files live. Going back to fully local remains a supported, low-friction operation (`aws s3 sync`, a local storage adapter), not a one-way door.

**This is exactly what §7.1 was protecting.** Because all logic sat behind the API boundary and the frontend held none of it, moving from a local backend to a hosted one was a change of storage adapter and deployment target (`S3EntryStore`, a compute host), not a rewrite.

### 7.3 Storage

**The markdown files are canonical, and as of M11 they live as objects in a private S3 bucket**, one object per entry, laid out exactly as the local directory used to be. Entries remain actual markdown files, retrievable in full with any tool that speaks S3, with or without this application. Export is not a feature to be built — it is `aws s3 sync`, and import back the other direction is the same command reversed.

**Encryption is not a priority**, and S3's default at-rest encryption satisfies the same acceptance test as before: it costs nothing and makes no difference to the experience. No bespoke per-entry encryption scheme is called for, and nothing about it compromises the plainness and portability of the stored files — `aws s3 sync` still produces ordinary, unencrypted-at-the-file-level markdown the moment it lands on a local disk.

### 7.4 Protection against loss

No revision history exists inside the application (§4.4), so protection is handled at the storage layer.

- **S3 versioning provides the recoverable history the application deliberately lacks.** Every write to an object retains its prior versions automatically, outside the application.
- **A scheduled job mirrors the bucket down to a local git repository and commits.** The same "scheduled job outside the application" this section already settled on, retargeted: it now pulls from S3 before committing, rather than committing a directory the application wrote to directly. Pushing that mirror to a private remote gives the same offsite redundancy as before — and the mirror is also the "return to fully local" path if S3 is ever abandoned.

**Both remain outside the system.** Neither is operated by the application, and the application must not depend on either functioning. See §4.4.

Two sub-decisions, now settled:

- **What performs the commits.** A scheduled job outside the application. The application never invokes git, which is what keeps §4.4 literally true rather than nearly true. Committing automatically on save would be marginally more reliable, but would buy that reliability with the exact dependency §4.4 exists to avoid.
- **Whether attachments are committed.** They are. Binaries grow a repository permanently, but journal attachments are written once and never modified, so the pathological repeated-diff case does not arise. Excluding them would mean covering them with iCloud instead, which cannot be layered over the git working tree (see above) and would break the self-containment §4.6 requires. Repository size is the lesser cost.

### 7.5 Deferred as a consequence of running locally

The following were previously decided and are now **deferred, not abandoned.** They are expected to return if and when the system goes online.

- **Multi-device *clients*.** As of M11 the API itself is reachable from anywhere and gated by single-user auth — the infrastructure precondition for phone/laptop writing is met. Building an actual second client is separate, later work and remains deferred.
- **Geocoding** of coordinates into place names (§4.3). Derived, so deferring it costs nothing and it can be produced at any time from the stored coordinates.

Transcription was previously listed here, deferred unless run by a local model. It is no longer deferred: it is run locally, and so needs nothing external. See §4.7.

### 7.6 AI provider access

**Calling an external AI API is accepted.** "No third-party services" (§7.2) refers to hosting and infrastructure; the extraction pipeline may reach out to a hosted model. Pillar 2 requires this, short of running models locally.

**Requirement: the model and the provider must be easy to change.** Model quality and pricing will change many times over the life of this project, and the system must never be attached to one vendor.

Therefore: **all model access goes through a single internal interface, and no provider-specific detail appears anywhere in the extraction logic.** Prompts, schemas, and pipeline code know nothing about which provider is serving the request.

Vercel AI Gateway together with the AI SDK is the intended approach. It has been checked against the actual need: the gateway sits in front of every supported provider and resolves a `creator/model-name` string, so application code is unchanged whether it calls Claude, GPT, or Gemini, with no token markup. Schema-constrained extraction is supported across providers — `generateObject` takes a Zod schema and uses each provider's native structured-output mechanism underneath, validating and retrying on malformed output. That covers what the extraction pipeline requires. The SDK also works independently of the gateway, so the gateway itself remains swappable infrastructure rather than a lock-in.

**Critical distinction, and the reason this needs to be thorough:** a swappable interface does not mean swappable *results*. Schema adherence and extraction quality differ between models even when the calling code is identical. Prompts and schemas tuned against one model must be re-validated when the model changes — the abstraction covers the plumbing, not the behaviour.

**Two different things are both "the model changing," and only one of them matters here.** The gateway may route any given request to whichever provider is available, fast, or cheap at that moment — that happens routinely, automatically, per request, and requires no reaction from me or the system. A **model migration** is different: a deliberate, rare decision to change which model I rely on by default.

This is what makes the full reprocess-from-scratch mode (§6.4) load-bearing rather than housekeeping: it is also the mechanism for migrating models, on the rare occasions I choose to. Re-running extraction over the whole corpus and diffing the result against my touched, validated records (§6.4) — not against unreviewed AI output — is how a model change is judged.

---

## 8. Other functionality

**Search.** A very sophisticated search engine over the journal. Sophisticated specifically in that it searches by **meaning**, not only by matching words: describing what is being looked for should find it, including where the entry never used those words.

**Layout control.** How the analysis surface (§5, §6) is arranged — which graphics appear, in what order, grouped under what headings, sorted and filtered how — is not fixed. I control it two ways, and they are two editors of one thing: I describe in prose how I want the page organised and an AI carries that out, or I read and hand-edit a small layout language specific to this application's own structures. Neither is a convention I am asked to follow in an entry (§4.8) — the language is a thing the AI produces and I adjust, not markup I author from scratch. Layouts are named, several can exist, one is the default. A layout is directly authored content in the sense §9 describes — nothing can regenerate my hand-edits by re-reading entries — so it is stored durably (`format.md` §8), never as a disposable cache, and it is never encoded into an entry or document (§4.3, §10). The same mechanism is meant to extend to arranging the public surface (§10, and the still-open idea in §11); it is built generic over what each surface has to arrange. As with everything the AI proposes, it suggests and I confirm — compiling a description fills the editor, it does not silently replace what is there (§6.1).

**Further features.** I will likely think of other functionality as I go. The system needs to be designed with that in mind — additional features should be additions to what exists, not occasions for rebuilding it.

---

## 9. Documents

A third kind of content, alongside the two pillars above. A document is not a journal entry (§4) and not something the AI derives (§5, §6) — it is something I write directly, about a single subject, over however long that subject takes.

The purpose is different from an entry's. An entry records a moment of writing — free-form, chronological, one file per session. A document is the considered, continuous statement of one idea — typically a project, or a train of thought I want to develop properly — meant to be read as a finished piece rather than pieced together from entries written at different times. The immediate reason this matters is the eventual public-facing side of the project (§10): a document is the shape something takes when it's meant to be read on its own, not a private record I'm free to write disjointedly.

### 9.1 What carries over from Pillar 1, and what doesn't

A document is plain markdown, directly authored, and as canonical as an entry — safe, exportable, and simple in exactly the sense §2 describes. Like an entry, nothing but me ever writes to one; the AI never creates or edits a document (§6.1's autonomy is about derived structures only, and does not extend here).

What doesn't carry over is entry-specific:

- **A document has a title.** Entries deliberately never do (§4.3).
- **A document is revised over its working life, as the norm.** An entry is written once and, realistically, never returned to (§4.4); a document is expected to be opened and changed repeatedly while its subject is still live.
- **A document's identity has nothing to do with when it was started.** Entries are organised chronologically because that is what they are (§4.1); a document is organised by its subject.

### 9.2 Relationship to entries

A document may optionally reference specific entries it grew out of or relates to. This is a pointer I add by hand, not a derivation — citing an entry never pulls its content into the document, and a document's text is never assembled or generated from entries automatically. Everything in a document is mine, written directly, the same as an entry.

### 9.3 Visibility

A document can be made readable through the public-facing surface described in §10. Doing so is a deliberate, explicit act — a "Publish" action distinct from an ordinary save, never a side effect of any other edit — and unpublishing reverses it just as explicitly. An unpublished document is exactly as private as an entry.

A document does not carry a `public` field of its own. §11 resolves *how* visibility is tracked, for documents and everything else alike: a document is not a special case of that mechanism, just its first user. A public document exposes only what it directly contains — citing an entry (§9.2) never exposes the entry itself, so nothing about publishing a document requires deciding entry-level visibility first.

---

## 10. The public-facing surface

A separate, minimal, read-only surface exists to let published content (§11) be read by anyone, without exposing anything else in the system.

- It is a distinct application from the private journal — its own frontend, on its own domain, calling its own small API — not a public mode bolted onto the authenticated one. §7.1's frontend/backend divide applies here too: this stays swappable and separable from everything else.
- The public API only ever reads from the `public/` mirror (§11), and, at the infrastructure level, has no access to entries, documents, or anything outside that one location — privacy here does not depend solely on application logic getting a check right. It does not read `journal/` or `documents/` at all, even to double-check anything: the mirror's own contents are the complete and only answer to "what is public."
- It is read-only. Nothing about publishing happens through this surface; content is written and published entirely from the private, authenticated side, the same place it is written in the first place (§9's "nothing but me ever writes to one" applies without exception, and applies equally to entries).
- What published content looks like when read — layout, URL, ordering, whether it groups with anything else — is a presentation concern for this surface to decide, not something the canonical entry or document format (`format.md` §6) needs to encode. A document or entry's identity and content are unaffected by whether it is ever read publicly.
- Grouping published content into a series, or organising it by kind (a project write-up versus a standalone piece), is not addressed here. Nothing above blocks it later; it simply isn't needed yet.

---

## 11. Deferred — not yet decided

The following have been raised and deliberately set aside for later consideration. They are open, not rejected.

**To-do lists / longer-term goals.** No longer blocked in principle — §2 now allows a derived record to be directly maintained once touched, which is what a to-do list needs. The concrete structure — what a to-do item is, how it is created, how it is closed — is not yet designed.

**Hand-editing the concept model's generated summary.** The generated cross-entry summary is not something I edit directly — corrections go through the statements it's built from. To be reconsidered later.

**Implementation of the concept model.** The 2026-08-30 reframing (§5.2) settled its scope and where the emphasis sits; what's still open is how much further the grouping itself should go presentationally as more subjects and more content accumulate.

**Multi-device use.** Still deferred — M11 makes the API reachable and adds single-user auth, but a phone/laptop-writing client is separate, later work. See §7.5.

**Public/private access levels, beyond documents — resolved.** Making an entry, a document, or a derived record (§5 — metrics, reviews, opinions, lists, questions) public copies a rendered, privacy-safe snapshot into a separate `public/` storage location; the public-facing surface (§10) reads only from there. Visibility is never a field on the entry or document itself — for an entry that would directly violate §4.3's "nothing else," and keeping every content type on the same mechanism means there is exactly one way anything ever becomes public, not a special case for the first content type that needed it. Publishing an entry never carries its coordinates into the mirror, deliberately: location is a private-by-default fact about the act of writing, not something a "Publish" click should ever have to remember to strip. Editing a published record keeps its public copy in sync automatically, so a stale mirror is never a possibility a click was needed to prevent. A published derived record carries only its own semantic content — never the id of the private entry it came from, and never `touched`/extraction provenance. For a derived structure, publishing can also be set to a category-level default ("all reviews of this medium," "all metrics of this kind") — but a default only ever stages matching records into a confirmation queue, one click away from actually publishing; nothing is ever made public without that explicit, final act, the same "AI suggests, I approve" shape §5.3 already uses for categories themselves.

**An AI-organised public site.** Describing in plain prose how the public surface should be arranged — "put the coding projects together, at the top" — and having a system carry out that arrangement across published documents, rather than hand-maintaining a manual order or a taxonomy field on each one. Raised specifically because a fixed `kind`/category field on a document felt like the wrong shape for something this presentational and this likely to change. The mechanism now exists — §8 "Layout control", built generic over what a surface has to arrange — so this is a matter of giving the public surface a resource catalog of its own (published documents, not derived structures) and its own set of view kinds. On hold until there is enough real published content to know what arranging it actually needs.

**Grouping entries and documents into a project or collection.** An entry must never carry a citation or relation of its own (§4.3, §9's "an entry should just be for a day") — so grouping content around a subject that spans several days of writing has to be derived, not authored on the entry. The likely shape is close to the concept model (§5.2): extract the parts of an entry that belong to a given subject, linked back to their source, rather than citing whole entries by hand. What's unresolved is presentation — showing a project's worth of extracted fragments needs something better than a bare list of paragraphs pulled from different days. On hold; revisit once the public/private mechanism above is in everyday use.

**Natural-language control over the analysis page's layout — resolved.** Raised 2026-08-30, held until the page's content had been lived with; now specified in §8 "Layout control" and `format.md` §8. Prose and a small hand-editable layout language are two editors of one named, durable layout; the AI compiles a description into the language and fills the editor rather than replacing what is there. What stayed deferred is the sibling idea below — the same mechanism pointed at the public surface.

**A per-person conversation-topics structure.** Raised 2026-08-30: noting down a conversation point, thread, or question to raise with someone specific, with the system extracting and collecting them per person. Close in spirit to open questions (§5.2) or to-dos, but keyed to a person rather than existing as a flat list — the open question is what interface actually makes sense for that (linked to a concept-model subject for the person? Its own structure? Something else?). Explicitly not designed yet; I said I'd think about the interface before deciding the shape.

---

## 12. Summary of what must remain true

- The journal entries are plain markdown and are the only thing I write.
- What I write persists for life, safely, exportably, and simply.
- One file per writing session; identity lives in the entry, not the filename.
- Entries record the time and place of writing, and nothing else — automatically, never by hand.
- Spoken entries always become plaintext; audio is optional and additional.
- No user markup, ever; structuring is the AI's job.
- Documents are a third content type, alongside entries and derived structures — directly authored like an entry, but titled, revised over time, and organised by subject rather than by when they were written (§9).
- An entry or a document may be published — a snapshot mirrored to a separate location the public-facing surface reads from, never a field on the record itself — and read through a minimal, read-only surface with no access to anything else in the system; unpublished content, and all derived structures, stay private (§9.3, §10, §11).
- All structured data originates from the entries and links back to them.
- Derived data is rebuildable until I touch it; once reviewed or edited, a record is mine and is never silently overwritten.
- Many kinds of structure exist, more will be added, and the design assumes this.
- New metrics are approved or requested by me, never created unilaterally.
- Most extraction is autonomous; mistakes are easy to correct.
- Model and provider are always swappable; nothing is tied to one vendor.
- The concept model groups everything said about a subject — fact, event, reflection, or view — and never extrapolates beyond it; a generated cross-entry summary is a secondary, optional layer on top, not the reason the structure exists.
- Frontend and backend are cleanly separated; the frontend is disposable.
- As of M11, journal storage and the API are built to run online (S3, a hosted API) rather than purely on my own file system — the files stay canonical, and the separation above (§7.1) is what made that move cheap rather than a rewrite.
- Everything above the journal serves the journal, and never the reverse.
