# Who Am I

A private, locally-owned record of one person — life and career on a single
timeline — that generates a resume and a personal website on demand. The record
itself is plain Markdown in a Git repo you hold; this app reads and writes those
files but **does not own the data**.

> Two principles from the brief: **brutally accurate** (the raw truth goes in the
> record; polishing happens only when generating a resume or site) and **my eyes
> only** (it stays a set of files you hold). See [`docs/who-am-i-brief.md`](docs/who-am-i-brief.md)
> for the why; the storage/sync contract it implements is summarized in
> **The one rule** below.

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
  profile-merge.ts     Pure propose→merge for identity links (review-gated).
  index-db.ts          The derived SQLite index: incremental + full rebuild.
  record.ts            RecordStore facade — write-text-first CRUD.
  git.ts               Explicit Sync (pull --rebase / add / commit / push).
  feeds.ts             Saved, re-runnable import configs (machine-local) + refresh.
  ingest/              Provider adapters (GitHub, Asana, Gmail, LinkedIn,
                         résumé, your own website, Claude Code, Warp) →
                         candidates in the inbox.
  triage/              Prefilter + optional LLM pass: a keep|frivolous sort
                         signal; never deletes or auto-rejects.
  reduce/              Optional LLM map/reduce: roll a noisy inbox into drafts.
  llm/                 LLM provider seam — Ollama (local) + Anthropic, over Http.
  generators/          Resume (Markdown) + standalone site (HTML); private excluded.
  platform-node.ts     Node-backed Platform (tests + future CLI).
src/lib/platform-tauri.ts  Tauri-backed Platform (sql / fs / shell / http / keyring).
src/lib/state.svelte.ts    Svelte 5 runes app state driving the UI.
src/lib/{appearance,theme}.svelte.ts  Appearance + theme (dark mode) preferences.
src/lib/journal/      Pure helpers for the Journal views: grouping, date
                        formatting, and the type/project color palette.
src/lib/inbox/        Pure helpers for the Inbox triage view: candidate filter/
                        sort/group + the per-source palette and glyph map.
src/lib/components/   Titlebar, AppMenu, the collapsible candidate row, editor,
                        the credential-setup help popups, the identity
                        merge-review panel, and the Journal views
                        (Grouped · Timeline · Calendar · Table).
src/routes/          SvelteKit SPA: Journal · Import · Inbox · Projects ·
                       Profile · Resume · Personal site · Data.
src-tauri/           Rust shell: registers the fs/sql/shell/dialog/http plugins.
```

The core never imports Tauri. The Tauri frontend and the test harness each
supply a `Platform` (filesystem, SQLite, git runner, hash, plus optional HTTP +
keyring seams for ingest and the LLM, and a read-only external-SQLite seam used to
read another app's database for Warp import) — so the storage and ingest logic is
fully unit-testable off-device, and a CLI could wrap the same core.

### How a record folder is used

The record folder is a normal Git repo of Markdown (`profile.md`, `entries/*.md`).
On first open of an empty folder the app scaffolds it
(README, `.gitignore`, `.gitattributes`, `profile.md`, `entries/`). The index
lives in the OS app-data dir, one file per record folder, never inside the repo.

---

## Import & the AI pipeline

Beyond hand-written journal entries, the app can pull history in from external
sources and help you shape it — but **nothing reaches the record without your
explicit promote.**

- **Ingest** (`src/lib/core/ingest/`) — adapters for GitHub, Asana, Gmail,
  LinkedIn, an imported résumé, your own personal website, and your Claude Code
  and Warp AI history map provider data into normalized items, landing them as
  *candidates in a review inbox* (never the record). Mappers are pure and
  fixture-tested; the layer never touches the record, secrets, or the index
  directly. The website importer fetches only the pages you enter (and a sitemap
  you point at) — it is not a crawler — and treats the polished prose as a prompt
  to write the rawer truth underneath. An item that arrives without a real date is
  staged as *needs-date*: you set its date in the inbox before promoting — the app
  never silently defaults it to today (brutal accuracy).
- **Triage** (`src/lib/core/triage/`) — a deterministic prefilter that always
  runs, plus an optional LLM pass, annotates each candidate with a
  `keep | frivolous` sort signal. It only sorts: never deletes, hides, or
  auto-rejects, and the signal is stripped on promote.
- **Feeds** (`src/lib/core/feeds.ts`) — save a configured source (GitHub, Asana,
  Gmail, website, Claude Code, or Warp) as a re-runnable *feed*, then **Refresh all** to
  re-pull every one in a click. Feeds are machine-local (localStorage, never the
  record — tokens stay in the keyring), and re-running only stages what's new.
  Inbox-only like every import; nothing is auto-promoted.
- **Reduce** (`src/lib/core/reduce/`) — an optional LLM map/reduce that rolls a
  noisy inbox up into clean entry drafts for you to review.
- **LLM seam** (`src/lib/core/llm/`) — AI passes run through a provider
  abstraction: **Ollama** locally or **Anthropic** (key in the OS keyring, never
  in the record or app config). With no provider configured the app says so
  instead of failing; the AI features are entirely opt-in.

**Security stance:** text fetched from providers is treated as *data, never
instructions* — stored verbatim, and any LLM pass wraps it in fenced data blocks
with an explicit do-not-follow guard, so an imported issue title can't hijack the
model.

---

## Develop

Prerequisites: Node 20+, pnpm, Rust toolchain, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS
(on Linux: `webkit2gtk-4.1`, etc.).

```bash
pnpm install            # one-time; builds the better-sqlite3 binding for tests
pnpm test               # run the core test suite (vitest, node-backed platform)
pnpm test:watch         # the same suite in watch mode
pnpm check              # type-check (svelte-check)
pnpm tauri dev          # run the desktop app
pnpm tauri:wsl          # run on WSL (disables the dmabuf renderer)
pnpm tauri build        # produce a native bundle
```

`pnpm dev` / `pnpm build` run just the SvelteKit frontend (adapter-static SPA).

---

## What this app deliberately does NOT do

By design: no custom sync engine or server (sync is plain Git), never commits
the index or `dist/` into the repo, never lets the index become authoritative,
never auto-pushes or auto-resolves Git conflicts, never auto-promotes imported
candidates into the record (every entry is a human decision), and never
"polishes" the raw record — polishing is an output-stage concern only.
