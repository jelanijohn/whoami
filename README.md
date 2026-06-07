# Who Am I

A private, locally-owned record of one person — life and career on a single
timeline — that generates a resume and a personal website on demand. The record
itself is plain Markdown in a Git repo you hold; this app reads and writes those
files but **does not own the data**.

> Two principles from the brief: **brutally accurate** (the raw truth goes in the
> record; polishing happens only when generating a resume or site) and **my eyes
> only** (it stays a set of files you hold). See [`docs/who-am-i-brief.md`](docs/who-am-i-brief.md)
> for the why and [`docs/who-am-i-storage-sync-spec.md`](docs/who-am-i-storage-sync-spec.md)
> for the normative storage/sync contract this app implements.

This repository is the **application** (a Tauri desktop app). The **record** it
operates on is a *separate* folder/Git repo you choose at runtime — keeping app
code and private life data cleanly apart, exactly as the spec intends.

---

## The one rule

**Plain text in the record repo is canonical. The SQLite index is a throwaway
cache, rebuilt from those files and never synced.** If text and index disagree,
the text wins. Delete the index anytime; the app rebuilds it with zero data loss.

---

## Architecture

```
src/lib/core/        Framework-agnostic TypeScript core (no Tauri, no browser).
  types.ts             Domain types + Platform interfaces (the only I/O seam).
  ids.ts               ULID identity + collision-proof filename construction.
  frontmatter.ts       YAML parse/serialize, preserving unknown keys.
  entry.ts / profile.ts  Read–write round-trip for the record files.
  index-db.ts          The derived SQLite index: incremental + full rebuild.
  record.ts            RecordStore facade — write-text-first CRUD (spec §6).
  git.ts               Explicit Sync (pull --rebase / add / commit / push).
  generators/          Resume (Markdown) + standalone site (HTML); private excluded.
  platform-node.ts     Node-backed Platform (tests + future CLI).
src/lib/platform-tauri.ts  Tauri-backed Platform (plugin-sql / -fs / -shell).
src/lib/state.svelte.ts    Svelte 5 runes app state driving the UI.
src/routes/          SvelteKit SPA: Journal · Profile · Resume · Personal site · Data.
src-tauri/           Rust shell: registers the fs/sql/shell/dialog plugins.
```

The core never imports Tauri. The Tauri frontend and the test harness each
supply a `Platform` (filesystem, SQLite, git runner, hash) — so the storage
logic is fully unit-testable off-device, and a CLI could wrap the same core.

### How a record folder is used

The record folder is a normal Git repo of Markdown (`profile.md`, `entries/*.md`)
— the layout in spec §2. On first open of an empty folder the app scaffolds it
(README, `.gitignore`, `.gitattributes`, `profile.md`, `entries/`). The index
lives in the OS app-data dir, one file per record folder, never inside the repo.

---

## Develop

Prerequisites: Node 20+, pnpm, Rust toolchain, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS
(on Linux: `webkit2gtk-4.1`, etc.).

```bash
pnpm install            # one-time; builds the better-sqlite3 binding for tests
pnpm test               # run the core test suite (vitest, node-backed platform)
pnpm check              # type-check (svelte-check)
pnpm tauri dev          # run the desktop app
pnpm tauri build        # produce a native bundle
```

`pnpm dev` / `pnpm build` run just the SvelteKit frontend (adapter-static SPA).

---

## What this app deliberately does NOT do

Per spec §9: no custom sync engine or server (sync is plain Git), never commits
the index or `dist/` into the repo, never lets the index become authoritative,
never auto-pushes or auto-resolves Git conflicts, and never "polishes" the raw
record — polishing is an output-stage concern only.
