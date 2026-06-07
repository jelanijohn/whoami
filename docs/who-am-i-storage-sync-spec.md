# Who Am I — Storage & Sync Spec

*Addendum to the project brief. This document is normative: it defines the contract the app must implement. Where it says **MUST**, treat it as a hard requirement; **SHOULD** is a strong default a thoughtful implementer may deviate from with reason.*

---

## 0. The one rule everything else follows from

**Plain text in a Git repo is the canonical store. SQLite is a local, derived, rebuildable index that is never synced and never authoritative.**

If the SQLite file is deleted, the app rebuilds it from the text on next launch with zero data loss. If the text and the index ever disagree, the text wins. Every write goes to the text first, then to the index — never the reverse.

This is what makes the record genuinely owned (it's just files you hold), brutally accurate (Git history *is* the audit trail of how the record changed over time), and safe to sync across machines (text merges; binary databases corrupt).

---

## 1. Decisions locked

1. **Canonical = text files under Git version control.** One file per timeline entry, plus a singleton profile file. Human-readable, diffable, owned.
2. **SQLite = derived index only.** Lives outside the repo (or gitignored), per-machine, disposable. Used for fast querying, full-text search, and powering the dashboard. Never synced.
3. **Sync = a private Git remote.** Each machine keeps its own clone on its own native filesystem and reconciles only through `git pull` / `git push`. No file is ever shared directly across the WSL/Windows boundary or across machines.

---

## 2. Repository layout

```
who-am-i/                      # the Git repo — canonical, synced via remote
├── profile.md                 # singleton: identity, summary, online handles
├── entries/                   # the one timeline — the source of truth
│   ├── 2024-03-14-shipped-x-dashboard-7g8h9j.md
│   ├── 2024-04-02-mention-techcrunch-k2m4n6.md
│   └── ...
├── assets/                    # optional: images/files referenced by entries
├── templates/                 # optional: resume / site templates (tracked)
├── .gitignore
└── README.md                  # repo-level notes for future-you

# NEVER in the repo (kept out by .gitignore and/or living outside it):
#   index.db   → OS app-data dir (e.g. Tauri appDataDir). Derived, per-machine, never synced.
#   dist/      → generated resume / site outputs. Derived. Gitignored by default.
```

### `.gitignore` (minimum)
```
index.db
index.db-wal
index.db-shm
dist/
.DS_Store
Thumbs.db
```

---

## 3. Entry file format

Every timeline event — role, project, win, skill, education, personal milestone, **and external mention** — is one Markdown file in `entries/` with a YAML frontmatter block followed by a free-form body.

### Filename
`entries/{YYYY-MM-DD}-{slug}-{id6}.md`

- `{YYYY-MM-DD}` = the event date (sorts chronologically, browsable).
- `{slug}` = short kebab-case label derived from the title.
- `{id6}` = last 6 characters of the entry's ULID.

The `id6` suffix makes filenames **collision-proof across machines** — two devices can create same-day, same-slug entries offline and they will never clash on `git pull`. The filename is for humans and Git; the canonical identity is always the `id` field inside.

### Frontmatter schema
```yaml
---
id: 01HXYZP3K7QWERTY8N7G8H9J      # ULID. Stable, time-sortable, no central coordinator. MUST be unique.
type: journal                     # journal | role | project | win | skill | education | milestone | mention
date: 2024-03-14                  # ISO 8601 date the event happened
created: 2024-03-14T09:22:00Z     # when the entry was first written (set once)
updated: 2025-01-02T14:10:00Z     # last edit (app maintains; Git is the backstop)
title: Shipped the X dashboard
private: false                    # if true → NEVER appears in any generated artifact
tags: [bloomberg, frontend]
# --- optional, type-specific fields below (free to extend; index reads them as JSON) ---
org: Bloomberg
role: Software Engineer
links:
  - https://example.com/the-thing
source: ""                        # for type: mention — where the mention came from
sentiment: ""                     # for type: mention — optional: positive | neutral | negative
---

Free-form Markdown body. Rough notes, half-memories, dead ends, unflattering
facts — all of it goes here verbatim. This is the brutally-accurate layer.
Polishing only ever happens at output time (resume, site), never by editing
the truth recorded here.
```

### Rules
- `id`, `type`, `date`, `title`, `private` are **required**. Everything else is optional.
- `id` **MUST** be a ULID (or UUIDv7) generated client-side. No server, no coordination, time-sortable, collision-safe.
- `private: true` entries **MUST** be excluded from every outward artifact (see §7). This mirrors the existing prototype behavior.
- Unknown frontmatter keys **MUST** be preserved on read/write (the app round-trips them; it does not drop fields it doesn't recognize). This lets the schema grow without migrations.
- Mentions are entries (`type: mention`) and live on the same timeline in `entries/` — they are not a separate store.

---

## 4. The profile file

`profile.md` is a singleton. YAML frontmatter for structured identity, Markdown body for narrative bio.

```yaml
---
name: Jelani John
headline: Software Engineer
identities:                       # the "definitively you" handles — seeds Mentions, disambiguates
  linkedin: https://www.linkedin.com/in/...
  github: https://github.com/...
  website: ""
location: New York, NY
---

Narrative summary / bio in Markdown. Edited freely; this is presentation-layer,
not the raw record.
```

---

## 5. The SQLite index contract

The index is a cache. Treat it as throwaway.

- **Location:** OS app-data directory (Tauri `appDataDir`), **not** inside the repo. (Gitignored-inside-repo is an acceptable fallback, but app-data is cleaner and makes the WSL/Windows separation automatic, since each environment resolves its own app-data path.)
- **Never synced. Never committed. Safe to delete at any time.**

### Schema (starting point)
```sql
-- index.db — DERIVED. Rebuilt from text. Never synced.

CREATE TABLE entries (
  id           TEXT PRIMARY KEY,   -- ULID from frontmatter
  type         TEXT NOT NULL,
  date         TEXT NOT NULL,      -- ISO 8601 event date
  title        TEXT,
  private      INTEGER NOT NULL DEFAULT 0,
  created      TEXT,
  updated      TEXT,
  body         TEXT,               -- markdown body
  source_path  TEXT NOT NULL,      -- relative path to the .md file
  content_hash TEXT NOT NULL,      -- sha256 of file bytes (for incremental rebuild)
  frontmatter  TEXT NOT NULL       -- full frontmatter as JSON (holds type-specific fields)
);

CREATE TABLE tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);

CREATE VIRTUAL TABLE entries_fts USING fts5(title, body);  -- full-text search for dashboard

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);      -- schema_version, last_rebuild, etc.
```

Type-specific fields stay in the `frontmatter` JSON blob so the table schema never needs to change when a new entry type or field appears. Query them with SQLite's JSON functions when needed.

### Rebuild algorithm
On launch (and on demand via a "reindex" action):

1. Walk `entries/*.md` and read `profile.md`.
2. For each file, compute `sha256` of its bytes.
3. **Incremental:** if a file's hash matches the indexed `content_hash`, skip it. If it's new or changed, parse frontmatter + body and upsert the row (and its tags / FTS). If an indexed `source_path` no longer exists on disk, delete its row.
4. A full rebuild = drop the tables and reparse everything. It's cheap (plain text) and **MUST** always be available as a "nuke and rebuild" escape hatch.
5. Record `last_rebuild` in `meta`.

---

## 6. Read / write flow

- **Read:** the dashboard, resume generator, and site generator all query `index.db`. They never parse the repo directly at request time (the index exists precisely so they don't have to).
- **Write (create or edit an entry):**
  1. Write/overwrite the `.md` file in `entries/` (text first — it is the source of truth).
  2. Update `updated` in that file's frontmatter.
  3. Reindex *that one file* into `index.db`.
- **Delete:** remove the `.md` file, then delete its row. (Git history preserves it; this is a "remove from current timeline," not a destructive erase.)

The index is **never** the only place a change exists, not even momentarily.

---

## 7. Outputs & privacy

- Generated artifacts — resume (Markdown + print/PDF), personal-site `.html` — are **derived**, like the index. They **SHOULD** write to a gitignored `dist/` by default. The user may choose to commit or publish a build; the app does not do so automatically.
- `private: true` entries **MUST NOT** appear in any generated artifact, in any field, ever. This includes derived/aggregate views (e.g. counts, summaries) where a private entry would leak by inference if the implementer isn't careful — when in doubt, exclude.
- The public "how the world sees me" view is built only from non-private `type: mention` entries.

---

## 8. Sync model (Git)

### Topology
- A single **private remote** is the hub (start with a private GitHub repo; swappable later — see §10).
- Each machine has **its own clone on its own native filesystem**:
  - **Windows:** clone under the Windows user profile (e.g. `C:\Users\you\who-am-i`); the native Windows app reads this clone.
  - **WSL:** a *separate* clone under the Linux home (`~/who-am-i`, on ext4) for any CLI/Claude Code work.
  - **Mac (later):** another clone. No special handling.
- The clones reconcile **only** through `git pull` / `git push`. No clone is ever opened from across the WSL↔Windows boundary.

### Why the separation is mandatory, not stylistic
SQLite over the WSL DrvFs mount (`/mnt/c/...`) has unreliable file locking and poor performance, and a database in WSL's ext4 home isn't cleanly reachable by a native Windows app. Because the index lives in each environment's own app-data dir and the only shared thing is a **Git remote of plain text**, none of that ever applies. The remote is the sync mechanism; the filesystem is never shared.

### App's relationship to Git
- The app is **Git-agnostic at its core**: it reads and writes files in a folder that happens to be a repo. Git is **not** a hard runtime dependency of create/read/edit.
- The app **SHOULD** offer an optional "Sync" action that shells out to `git pull --rebase` then `git add -A && git commit && git push`, with clear UI feedback.
- The app **MUST NOT** auto-push silently or auto-resolve conflicts. Pushing is an explicit user action. (This is a data-safety guardrail, not a convenience tradeoff.)
- The app **SHOULD** surface working-tree state (clean / dirty / behind) so the user knows whether to sync before editing — but it does not block editing on it.

### Conflict behavior
- **New entries never conflict.** Different ULIDs → different files. Two machines journaling offline merge cleanly.
- **Editing the same entry on two machines** produces a normal Git merge conflict in one `.md` file — resolvable by hand in seconds, and rare for a single user. The text format makes this tractable; a synced binary DB would make it unrecoverable.
- **The index never conflicts** because it is never synced.

---

## 9. What Claude Code should and should not do

**Implement:**
- The entry/profile file read–write–roundtrip (preserving unknown frontmatter keys).
- ULID generation, filename construction, and the `private` exclusion logic.
- The SQLite index, the incremental rebuild, and the always-available full rebuild.
- The read-from-index / write-to-text-first flow in §6.
- An optional, explicit Git "Sync" action per §8.

**Do not:**
- Build a custom sync engine, embedded-replica layer, or server. The remote is plain Git.
- Sync, commit, or place `index.db` or `dist/` in the repo.
- Let the index become authoritative, or write to it without writing the text first.
- Auto-push or auto-resolve Git conflicts.
- "Polish" or rewrite entry bodies. The record stays raw; polishing is an output-stage concern only.

---

## 10. Open / deferred

- **Remote privacy posture.** A private GitHub repo is private *to other users* but readable by the vendor — a mild tension with the "not on a vendor's server" principle, and more pointed because the repo holds the private life journey. Options, deferrable: (a) accept GitHub-private as good-enough; (b) self-host the remote (e.g. Gitea on a personal NAS / box); (c) transparent encryption at rest with `git-crypt` or `age`/SOPS so even the remote stores only ciphertext. Recommend deciding before the first real private entries land, since retrofitting encryption over existing history is annoying.
- **Per-type field sets.** The required fields are fixed (§3); the optional, type-specific fields can be firmed up as the dashboard/resume needs them, without schema migrations (they ride in the frontmatter JSON).
- **Assets handling.** Whether large referenced files (images, PDFs) live in `assets/` in-repo or are referenced by path — fine to defer until it comes up; Git LFS is the escape hatch if the repo gets heavy.
- **Mac specifics.** None expected; it's just another clone.
