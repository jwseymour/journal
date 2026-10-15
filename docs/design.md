# Journal system — design

*This document describes the current frontend: its visual direction, interface behaviour, and interaction model.*

*It is deliberately **subordinate** to `requirements.md` and deliberately **disposable**. Nothing here may constrain the data model, the extraction pipeline, or anything else behind the API. If a decision in this document appears to conflict with `requirements.md`, `requirements.md` wins and this document is wrong.*

*The frontend is expected to be substantially changed or entirely replaced at some point. This document is rewritten when that happens.*

---

## 1. Direction

### 1.1 The reference object

The intended feel is **a nice leather-bound journal**.

Warm, material, restrained, quietly high-quality. Something built to last and to be kept, rather than something optimised to be used today.

### 1.2 Translate, do not simulate

This is the most important execution note, and the main way this direction fails.

**Do not simulate the physical object.** No leather textures, no page-curl or page-turn animations, no faux stitching, no book spine, no drop-shadowed paper edges, no ribbon bookmarks. That approach dates badly and reads as pastiche.

Translate the *qualities* into a digital language instead: warmth of colour, generous margins, considered typography, restraint about what appears on screen, a sense of solidity and permanence. Where texture is used at all it should be a barely perceptible paper grain — noticeable only if looked for, never decorative.

### 1.3 One coherent style

There is **a single consistent visual language across the entire application.** The writing surface and the analysis surfaces are the same product, not two products joined together. Both use the same palette, the same typeface, the same spacing rhythm.

This is a deliberate choice made in preference to giving each surface its own optimised style.

### 1.4 Sparse and airy — via margins, not emptiness

The application should feel sparse and airy. This is achieved the way good book design achieves it:

- Generous margins
- Generous line height
- A comfortable measure — roughly 60–75 characters per line
- Restraint about what else is on the page

**Not** by leaving the screen empty. A page can be entirely full of writing and still feel calm. Airiness is a property of the typographic setting, not of low information density.

---

## 2. Palette

Minimal, warm, and low in count. **Every value is slightly warm — no pure black, no pure white, no neutral greys.**

### 2.1 Roles

| Role | Intent |
|---|---|
| Ground | Aged paper cream |
| Ink | Very dark warm brown-black, never `#000` |
| Accent | **Deep green** |
| Reserved | A distinct red, used only for destructive and error states |

There is no fourth colour. A brass/gold tone was considered and rejected (section 7).

**The accent is deep green.** Reasons, so they are not accidentally undone later:

- It leaves red free to mean one thing only — irreversible or erroneous. In a system whose central fear is losing data, "this cannot be undone" must be visually unmistakable and must not resemble a link.
- It holds its identity in the dark mode, where a red-brown accent drifts towards terracotta and stops looking like the same colour.
- Green against cream sits within the reference tradition rather than departing from it — library bindings, ledgers, cloth-bound editions, field guides.

### 2.2 Night mode

There **is** a night mode, and it is a **warm dark** — not the light palette inverted, and not a conventional cool grey dark mode.

- Ground: deep warm brown-black
- Text: a softer parchment tone at reduced brightness. Full-strength cream on a dark ground is glaring at night.
- Accent: the same green, lightened and desaturated towards sage. Saturated colours vibrate against dark grounds.

The intended reference is reading by lamplight.

### 2.3 Values

The three original values — ground, ink, accent — are unchanged in both modes. The rest fill in the roles a real interface needs, built outward from those three. Every value is warm; there is no neutral grey and no pure black or white anywhere in the set.

| Token | Day | Night | Used for |
|---|---|---|---|
| `--ground` | `#F2EADC` | `#1C1815` | The page |
| `--ground-raised` | `#F7F1E6` | `#262019` | Panels, inputs — paper on paper |
| `--ground-sunken` | `#EAE0CF` | `#151210` | Code blocks, table banding, hover |
| `--ink` | `#2A2320` | `#D9CFC0` | Body text |
| `--ink-muted` | `#6B5F55` | `#A0958A` | Dates, metadata, secondary text |
| `--ink-faint` | `#8A7C6E` | `#6E645A` | Placeholders and disabled states only |
| `--rule` | `#D8CCB8` | `#38302A` | Hairlines |
| `--rule-strong` | `#C2B4A0` | `#4A4038` | Emphasised hairlines |
| `--accent` | `#2F4A33` | `#8FAE8B` | Links, focus, active state |
| `--accent-hover` | `#3E5F42` | `#A6C2A2` | Accent hover |
| `--selection` | `#D9E0D3` | `#2C3A2C` | Text selection |
| `--danger` | `#8C2F22` | `#CC7365` | Destructive and error states, nothing else |

Contrast against ground, measured: day — ink 12.9:1, accent 8.2:1, muted 5.2:1, danger 6.9:1. Night — ink 11.5:1, accent 7.2:1, muted 6.0:1, danger 5.2:1. All clear AA.

`--ink-faint` is about 3.4:1 in both modes and does not clear AA. That is deliberate and it constrains its use: placeholders and disabled states only. **Nothing that has to be read may use it.**

---

## 3. Typography

**Serif**, throughout.

Type will define more of this application's character than any other single choice, and the writing surface must be comfortable to read and write in for extended periods.

**The typeface is Literata**, at every size, throughout. Self-hosted, never fetched at runtime.

It was drawn specifically for long-form reading on screen, which is the actual job here. It is warm and slightly sturdy rather than delicate, which matters twice over: it stays comfortable across a long writing session, and it holds its colour at the small sizes the analysis surfaces need (section 5.3), where a finer old-style face would go thin and papery. Runners-up were Source Serif 4, more neutral, and Newsreader.

It remains a **single token**. If a long real entry set in it reads badly, replacing it is a one-line change — which is the point of the rule below and the reason this choice is cheap to revisit.

Monospace, for the rare code block, is a system stack behind its own token. A second webfont is not worth it.

Requirements regardless of which face is chosen:

- A single type scale, defined as tokens. No ad-hoc sizes.
- Comfortable measure and generous leading in the writing surface, per section 1.4.
- Two weights at most. Restraint here is part of the aesthetic.

---

## 4. Personality

The personality follows from the reference object: **a good notebook is patient, quiet, unhurried, and permanent.** It is there when opened and silent when not.

This is expressed primarily through **what the application refuses to do.** The following are prohibited:

- Streaks, chains, or any continuity mechanic
- Gamification of any kind — points, levels, badges, achievements
- Reminders or prompts to write; no "you haven't written in N days"
- Notification dots or unread counts
- Celebratory animation or congratulatory copy
- Encouragement, motivational messaging, or writing prompts
- Anything that measures or displays engagement back to the user

Copy throughout is plain and quiet. The application does not have a chirpy voice, does not congratulate, and does not editorialise about the user's writing.

A system intended to hold someone's writing for fifty years must not behave like an application trying to maximise this week's usage.

---

## 5. Interface behaviour

### 5.1 Writing surface

The primary surface. Everything else is secondary to it.

- The default state is text on a warm ground with as little else as possible.
- Comfortable measure, generous margins and leading (section 1.4).
- **Writing happens in plain source; a key renders it.** There is no toolbar and no formatting furniture. Reading an existing entry always shows it rendered. Markdown is not a convention the user is asked to follow — it is simply respected where it appears, per `requirements.md` §4.8.
- **Chrome is toggleable.** Interface furniture — sidebars, toolbars, controls — can be shown or hidden by the user. Hidden is a first-class state, not a special mode with reduced capability.
- **While writing a new entry, previous entries can be opened and viewed for reference.** This is a required capability, not an optional extra.
- **Location must occupy no space in the writing interface.** It is captured silently and is never prompted for. If it is unavailable it is simply absent, and the interface says nothing about it. See `requirements.md` §4.3.
- **Transcription is offered when creating an entry**, with an option to also retain the audio as an attachment. The transcript is always produced. See `requirements.md` §4.7.
- **Session boundaries belong to the user.** The interface must never automatically close an entry, start a new one, or push the user into a new entry on a timer or any other automatic rule. See `requirements.md` §4.5.

### 5.2 Keyboard control

**Most of the application is controllable by keyboard**, and the shortcut scheme must be coherent and deliberately designed as a whole — not accumulated per-feature.

Requirements:

- One consistent scheme, documented in one place, designed before implementation rather than during it.
- Shortcuts follow a discoverable logic rather than being arbitrary assignments.
- Keyboard control is a primary interaction path, not an accessibility afterthought. Anything reachable by mouse should be reachable by keyboard.
- Consistent conventions across surfaces — the same action does not have different shortcuts in different places.

#### The scheme

The organising rule, and the thing that makes it learnable rather than memorisable:

> **⌘ combos are only for what must work while your hands are in the text. Everything else is a plain key, live only when focus is outside a text field.**

A practical constraint shapes this as much as the aesthetic one. A browser tab does not own its whole ⌘ namespace — `⌘N`, `⌘T`, `⌘W`, `⌘Q` and others are taken by the browser and cannot be intercepted by a page. The scheme avoids them entirely rather than binding them and discovering later that they never fire.

**While typing**

| Key | Action |
|---|---|
| `⌘K` | Command palette, and search |
| `⌘S` | Save now — autosave is already running; this is for peace of mind |
| `⌘↩` | Finish the entry |
| `⌘⌥R` | Start / stop recording |
| `⌘⇧P` | Toggle source and rendered |
| `⌘\` | Toggle chrome |
| `⌘⇧\` | Toggle the reference pane |
| `⌘B` `⌘I` | Emphasis — inserts plain markdown, not a format |

**Outside a text field**

| Key | Action |
|---|---|
| `n` | New entry |
| `/` | Search |
| `j` `k` | Next / previous |
| `↩` | Open, or show more detail |
| `a` `r` `p` | Approve / reject / park (the pending-review queue) |
| `e` | Edit the open entry |
| `t` | Day / night |
| `g` then `h` `e` `s` `a` | Go to writing / entries / search / analysis |
| `?` | Shortcut sheet |
| `Esc` | Step back one level |

`Esc` always steps back and never destroys. Nothing destructive is bound, because nothing destructive exists — there is no delete (`requirements.md` §4.4). `⌘K` lists every command alongside its shortcut, which is how the scheme stays discoverable without a manual.

The pending-review queue (`/pending`, and the popup right after Process) reuses `j`/`k`/`↩` rather than inventing list-navigation keys of its own — `j`/`k` move a focus through every row in review order, `↩` opens the focused row's full text and detail. `a`/`r`/`p` are new: they decide the focused row (approve, reject, park a new-type suggestion) and, because deciding removes the row, the same focus position lands on whatever took its place — reading through the queue is `↩` to look, a decision key, repeat, with no `j`/`k` required in between unless you want to skip around.

### 5.3 Analysis surfaces

The analysis and tracking surfaces use the **print information-design tradition**: dense analytical material rendered as if printed on warm paper in serif type. The references are statistical yearbooks, almanacs, field guides, nautical tables, and Tufte-style information design.

Practically:

- Hairline rules instead of heavy gridlines; often no gridlines at all
- No chart junk, no gradients, no 3D, no drop shadows, no coloured chart backgrounds
- Data integrated into the typography rather than boxed off from it
- Small multiples and sparklines in preference to large single charts
- The same cream ground, ink, and green accent as everywhere else
- Colour used only where it carries information

**Noted for later, not yet needed anywhere:** where several stat or number blocks sit side by side in a single row, a vertical hairline should separate them — the same hairline vocabulary as everywhere else, just turned sideways, rather than relying on gap alone to imply grouping. Nothing in the app currently lays stat blocks out that way (`components/chat/stat-tile.tsx` renders one at a time); apply this the first time something does.

This is what allows one coherent style (section 1.3) to serve both a calm writing surface and a dense analytical one without compromise.

### 5.3.1 The panel kit

The analysis surface is not one hand-built layout — it is a kit of panels a *layout* arranges (`requirements.md` §8 "Layout control"). Each panel is a `Panel` component (eyebrow, optional "all →" link, body) wrapped around one **view kind** from a fixed vocabulary. The current set, each a chart primitive already in `components/analysis-charts.tsx`:

| View kind | What it draws | Reads |
|---|---|---|
| `presence` | occurrence calendar, one mark-slot per metric per day | metrics (≤5) |
| `register` | statistical-yearbook table: n, total, mean, min, max, last, trend | numeric/score metric fields |
| `horizon` | horizon-chart bands, one per field, intensity by opacity | numeric/score metric fields |
| `matrix` | every metric one row, shared day columns | metrics |
| `breakdown` | a numeric field's total split by a sibling enum field | metric fields |
| `correlation` | range-frame scatter of a metric's two numeric fields | metrics with two numeric fields |
| `reviews` | reading-diary table + per-medium tally | reviews |
| `rating-distribution` | rating histogram, overall + per-medium small multiples | reviews |
| `rating-spread` | strip plot, every rating a tick in its medium's lane | reviews |
| `questions` / `todos` | open/closed status bar + a short feed | questions / to-dos |
| `lists` / `concepts` | type/subject count table | list items / concept statements |
| `aging` | dot plot of the longest-open threads | questions + to-dos |

Adding a category still means dropping in a panel, not inventing a layout — the difference is that the arrangement is now the layout's, not the page's. A view kind whose identifiers a layout names but the catalog no longer has degrades to a quiet "couldn't resolve" note in that one panel's place, never a broken chart.

### 5.3.2 Editing a layout

The analysis page's "Customize" control opens onto the layout, not a set of toggles. It holds a switcher for the named layouts, a prose box ("Describe how you want this page arranged") that compiles into the syntax below it, and the layout language itself as an editable text field with parse errors shown as plain muted lines underneath. Copy stays quiet in the section 4 sense — "Layout saved.", "Couldn't parse line 7: unknown panel 'foo'." — no toasts, no confirmation flourish. The time-window control stays where it is; it is a per-device lens over whatever the layout specifies, not part of the layout.

---

## 6. Implementation constraints

These exist to keep the frontend genuinely cheap to change, which is the point of the whole architecture.

### 6.1 Tokens first

**Produce the complete token set before building any components, and have it reviewed.**

Every colour, type size, line height, spacing step, and border radius is defined once, as a token. This includes both day and night values.

Building components before the tokens are settled produces invented values and inconsistent drift across the interface, which is tedious to unpick later.

### 6.2 No hardcoded values in components

**No component contains a literal colour, font family, font size, or spacing value.** Everything references a token, without exception.

This is the frontend equivalent of the discipline applied to the derived data layer: it is what makes replacing or restyling the interface an afternoon's work rather than a rewrite.

### 6.3 No logic in the frontend

Per `requirements.md` §7.1: the frontend calls the API and renders what comes back. It contains no extraction logic, no analysis, no aggregation, and no knowledge of storage. If a piece of logic feels like it belongs in the frontend, it belongs behind the API.

### 6.4 Stack

Built on a Next.js template. **This is an implementation choice, not a commitment** — the frontend is expected to be replaceable, and nothing outside the frontend may depend on it. Written when the whole system still ran locally; as of M11 (`requirements.md` §7.2) the backend is hosted and the frontend is deployed alongside it, but nothing about this section changed as a result — it never depended on where the backend happened to run, only on staying separate from it (below).

The frontend is **its own process**, separate from the backend. Route handlers inside the frontend would make the backend's lifetime depend on the frontend's, which is exactly what `requirements.md` §7.1 exists to prevent: replacing the frontend must not mean moving the backend.

Styling is **CSS Modules over one file of custom properties**, not a utility framework. Utility classes carry literal values, which sits badly with section 6.2 — and this interface is few surfaces set precisely rather than many surfaces set quickly, so utilities buy little. A literal value in a `.module.css` file is greppable without tooling to police it, and the typographic details that matter here — measure in `ch`, tabular figures in the analysis tables, hanging punctuation — are plainer in real CSS. It is also two fewer dependencies in a project meant to still build in ten years.

Whether the backend is local or hosted does not license shortcuts across the API boundary. The frontend talks to the backend over the same HTTP interface either way, so that a deployment change — local to hosted, or a future move away from this frontend entirely — is never a rewrite.

### 6.5 Real states

Every surface must be designed for its real states, not only its populated one: empty, loading, error, and — importantly for this application — very large. The interface must remain usable with many thousands of entries.

---

## 7. Decisions that were open

All four are now settled. Recorded here with their outcome so the reasoning is not lost.

**Typeface.** Literata. See section 3. Still a single token, so a read-test could still overturn it for the cost of one line.

**Exact palette values.** Settled, section 2.3. The original three were kept; the supporting roles were built out from them.

**Brass/gold tone.** There is no fourth colour. Deep green is the only accent.

**Keyboard scheme.** Designed as a whole, section 5.2.

Nothing in this document is currently open.
