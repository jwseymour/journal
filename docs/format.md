# The record format

*This document specifies exactly what is written to disk. It is the concrete form of `requirements.md` §4, and it exists separately only because `requirements.md` deliberately carries no schemas.*

*It is **subordinate** to `requirements.md` — every rule here is a consequence of something decided there, and where they disagree, `requirements.md` wins. It is **not disposable** in the way `design.md` is: `design.md` describes an interface expected to be replaced, whereas this describes files intended to outlive every application that reads them. Changing anything here is a migration, not an edit.*

---

## 1. Directory layout

The journal directory is a git repository, created and maintained by hand. The application never initialises it and never invokes git (`requirements.md` §4.4, §7.4).

```
~/Journal/                                  git repository root
  .git/
  .gitattributes                            attachments marked binary; no line-ending translation
  journal/
    2026/
      07/
        2026-07-26-2255-abcde8.md           an entry
        2026-07-26-2255-abcde8/             its attachments, if any
          voice-2255.m4a
```

Year and month directories are the entry's **local** year and month, matching its filename.

Nothing outside this directory is needed to read the journal. There is no manifest, no index file, no sidecar. The directory alone is the record, and `cp -r` is a complete export.

## 2. Filenames

```
YYYY-MM-DD-HHMM-<suffix>.md
```

Date and time are **local time at creation** (`requirements.md` §4.2). The suffix is the last six characters of the entry's `id`, lowercased — so the filename is derived from identity, while identity never depends on the filename.

Filenames are a convenience for browsing the files by hand. Nothing in the system resolves an entry by its name.

## 3. The entry file

```markdown
---
id: 01K3F9X2VQ8N7M4TQXYZ8ABCDE
created: 2026-07-26T22:55:13+01:00
location: { lat: 51.507200, lon: -0.127600 }
---

The body begins here.
```

YAML frontmatter, then the body. Three fields, and no others.

**`id`** — a ULID. Assigned by the backend at creation, never changes, never reused. This is the entry's identity (`requirements.md` §4.2).

**`created`** — RFC 3339, always carrying its UTC offset. The moment the writing session began, not the moment it was saved. A local time without an offset is permanently ambiguous and cannot be reconstructed (`requirements.md` §4.3).

**`location`** — coordinates only, at whatever precision the device reported, unrounded. **The key is absent entirely when location is unavailable** — absent, not null, not empty. There is no place name here; the place name is derived (`requirements.md` §4.3).

### Not in the file

No title. No tags. No word count. No modification time. No schema version. No place name. No user-supplied field of any kind (`requirements.md` §4.3).

Two of these are worth stating as deliberate rather than forgotten:

- **No modification time.** An edit therefore leaves no trace in the file. Change is detected by hashing content, which is the only signal that survives `cp -r` and `git checkout` — both of which reset filesystem timestamps.
- **No schema version.** The format is three fields and intended to stay that way. If it ever must change, the frontmatter is self-describing enough to migrate by inspection.

### Body

Stored **byte-verbatim**. Never trimmed, reflowed, normalised, or reformatted. UTF-8, no BOM, LF line endings, one guaranteed trailing newline. That is the entire set of transformations, and it exists only so the files are well-formed text.

Frontmatter is the block delimited by the first `---` at byte zero and the next `---` on its own line. Everything after it is body, including any `---` that appears there. A body that begins with a horizontal rule, or contains YAML, must round-trip unharmed.

## 4. Attachments

One directory per entry, named with the same stem as the entry file, sitting beside it. Referenced from the body by relative link:

```markdown
![](2026-07-26-2255-abcde8/photo.jpg)
```

The link resolves in any markdown viewer, with or without this application, which is the requirement (`requirements.md` §4.6). Attachments are committed to git alongside the entries (`requirements.md` §7.4).

This is the one place where something depends on an entry's filename rather than its `id`. That is unavoidable given portable relative links, and is accepted in `requirements.md` §4.6.

## 5. Writing safely

Every write is atomic: a temporary file in the same directory, `fsync`, then `rename` over the target. A partial or truncated entry must not be reachable, ever, including through power loss mid-write.

The application writes an entry only in response to the user writing it (`requirements.md` §2, §4.4). It never rewrites an entry to record derived information, and it never renames or moves a file after creation.

There is one narrow deletion. An entry file is created on the first keystroke of a session; if, when the session closes, the body is whitespace-only, that file is removed. This is not a delete feature — it is declining to commit an entry that was never written. A file with any content in it is never deleted by the application. If a whitespace-only file survives a crash it stays; a startup sweep that deletes files is a worse risk than a stray empty entry.

## 6. The derived store

Everything derived lives in the application's own data directory, **outside the journal repository**. It is a cache (`requirements.md` §6.4) and must never be committed beside the record, nor appear in an export.

Its format is an implementation detail and is free to change without notice, because it can always be rebuilt from the files described above.
