# Architecture

The repo is the **application** (a Tauri desktop app). The **record** it
operates on is a separate folder/Git repo you choose at runtime — app code and
private life data stay cleanly apart.

## The one rule

**Plain text in the record repo is canonical. The SQLite index is a throwaway
cache, rebuilt from those files and never synced.** If text and index disagree,
the text wins. Delete the index anytime; the app rebuilds it with zero data
loss. Every code path writes text first, then updates the index — never the
reverse.

## Module map

```
src/lib/core/        Framework-agnostic TypeScript core (no Tauri, no browser).
  types.ts             Domain types + Platform interfaces (the only I/O seam).
  ids.ts               ULID identity + collision-proof filename construction.
  frontmatter.ts       YAML parse/serialize, preserving unknown keys.
  entry.ts / profile.ts  Read–write round-trip for the record files.
  profile-merge.ts     Pure propose→merge for identity links (review-gated).
  index-db.ts          The derived SQLite index: incremental + full rebuild.
  record.ts            RecordStore facade — write-text-first CRUD.
  merge.ts             Pure merge-at-promote: N same-ticket candidates → ONE
                         entry with multi-row provenance (deterministic, no LLM).
  git.ts               Explicit Sync (pull --rebase / add / commit / push).
  feeds.ts             Saved, re-runnable import configs (machine-local) + refresh.
  ingest/              Provider adapters (GitHub, Asana, Shortcut, Gmail,
                         LinkedIn, résumé, your own website, Claude Code, Warp,
                         NeuroSkill EEG sessions) → candidates in the inbox.
  triage/              Prefilter + optional LLM pass: a keep|frivolous sort
                         signal; never deletes or auto-rejects.
  reduce/              Optional LLM map/reduce: roll a noisy inbox into drafts.
  wins/                Optional LLM pass: draft résumé-grade wins from picked
                         journal entries (one synthesis call, evidence-gated).
  llm/                 LLM provider seam — Ollama (local) + Anthropic, over Http.
  generators/          Resume (Markdown) + standalone site (HTML); private
                         excluded; wins nest under their role/project.
  platform-node.ts     Node-backed Platform (tests + future CLI).
src/lib/platform-tauri.ts  Tauri-backed Platform (sql / fs / shell / http /
                        keyring / OAuth connect).
src/lib/state.svelte.ts    Svelte 5 runes app state driving the UI.
src/lib/{appearance,theme}.svelte.ts  Appearance + theme (dark mode) preferences.
src/lib/journal/      Pure helpers for the Journal views: grouping, date
                        formatting, and the type/project color palette.
src/lib/inbox/        Pure helpers for the Inbox triage view: candidate filter/
                        sort/group + the per-source palette and glyph map.
src/lib/components/   Titlebar, AppMenu, the collapsible candidate row, editor,
                        the credential-setup help popups, the identity
                        merge-review panel, the win-draft review panel, and the
                        Journal views (Grouped · Timeline · Calendar · Table).
src/routes/          SvelteKit SPA: Journal · Import · Inbox · Projects ·
                       Profile · Resume · Personal site · Data.
src-tauri/           Rust shell: registers the fs/sql/shell/dialog/http/opener
                       plugins + the Gmail OAuth consent command (gmail_oauth.rs).
```

## The Platform seam

The core never imports Tauri. The Tauri frontend and the test harness each
supply a `Platform` (filesystem, SQLite, git runner, hash, plus optional HTTP +
keyring seams for ingest and the LLM, a read-only external-SQLite seam used to
read another app's database for Warp and NeuroSkill import, and a desktop-only
OAuth-connect seam for the Gmail consent flow) — so the storage and ingest
logic is fully unit-testable off-device, and a CLI could wrap the same core.

## How a record folder is used

The record folder is a normal Git repo of Markdown (`profile.md`,
`entries/*.md`). On first open of an empty folder the app scaffolds it
(README, `.gitignore`, `.gitattributes`, `profile.md`, `entries/`). The index
lives in the OS app-data dir, one file per record folder, never inside the
repo. Sync is explicit Git (pull --rebase / add / commit / push) — never
automatic.
