---
name: update-docs
description: Update Who Am I's README.md so it reflects the actual code. Use after shipping a feature, adding/removing a core module, route, Svelte component, Tauri plugin, or changing the storage/sync behavior or dev commands, so the README stays in sync with the code. Invoke when asked to "update the README", "sync the docs", or after a change the README should mention.
---

# Update Who Am I docs

`README.md` is the **only** user-facing doc and the one this skill maintains. It
must stay true to the code. The files in `docs/` are *not* generated — they are
authored contracts and inputs:

| File | Role | This skill's relationship |
|---|---|---|
| `README.md` | Repo landing page (humans + GitHub) | **Edit this to match the code.** |
| `docs/who-am-i-brief.md` | The original product brief (the "why") | Read-only reference. Never rewrite. |
| `docs/who-am-i-*-spec.md`, `*-todo.md` | Specs & planning notes (whichever exist) | Read-only reference. Never rewrite. |

The storage/sync behavior the README describes (text-canonical, index-is-a-
throwaway-cache, explicit Git sync) is now contained in the README itself and the
code — there is no separate storage-sync spec to defer to (it was a plan doc,
removed once the work shipped). Don't reintroduce links to deleted `docs/` files;
verify any `docs/` path you cite actually exists.

The README is the **app's** doc. The user's *record* (life data) lives in a
separate repo at `~/whoamidocs` — never document private record content here.

## Process

1. **Find what changed.** Read the diff since the README was last touched — don't
   guess:
   ```bash
   git log --oneline -15
   git diff HEAD --stat                 # uncommitted
   git log -1 --format=%h -- README.md  # commit where README last moved
   git diff $(git log -1 --format=%h -- README.md) HEAD --stat   # changes since
   ```
   Focus on changes under: `src/lib/core/` (the framework-agnostic core),
   `src/lib/platform-tauri.ts`, `src/routes/` (the SvelteKit pages),
   `src/lib/components/`, `src-tauri/` (plugin registration), and `package.json`
   scripts.

2. **Read `README.md` fully** before editing — it has an established structure
   and a terse, em-dash voice. Match it. Keep the ~80-column wrap.

3. **Map the change to the right section** (see map below) and edit surgically
   with the Edit tool. Don't reformat or rewrap sections you didn't need to touch.

4. **Verify the cross-references still hold** (see checklist).

## Section map — where a change lands

The README's sections (in order): intro · **The one rule** · **Architecture**
(annotated file tree + "How a record folder is used") · **Develop**
(Prerequisites + commands) · **What this app deliberately does NOT do**.

**New / renamed / removed `src/lib/core/` module:**
- Update the annotated file-tree block under **Architecture** — keep the
  `path    one-line description` alignment and the one-clause-per-file style.
- If it changes the I/O seam (a new `Platform` capability in `types.ts`), update
  the paragraph after the tree about the core never importing Tauri / `Platform`
  being supplied by both the Tauri frontend and the test harness.

**New / changed SvelteKit route** (`src/routes/*/+page.svelte`):
- The tree lists routes as `src/routes/  SvelteKit SPA: Journal · Profile · …`.
  Keep that dotted page list in sync with the actual `src/routes/` directories.

**New Svelte component** (`src/lib/components/`):
- Usually not individually listed — only mention it if it introduces a
  user-visible capability worth a line. Don't enumerate every component.

**New / removed Tauri plugin** (`src-tauri/` registration, `platform-tauri.ts`):
- Update the `src-tauri/` line in the tree ("registers the fs/sql/shell/dialog
  plugins") and the `platform-tauri.ts` line ("plugin-sql / -fs / -shell").

**Storage / sync / index behavior change:**
- Reconcile **The one rule** (text-canonical, index-is-throwaway-cache) and
  **How a record folder is used** with the new behavior. These two sections are
  the contract now — if a change would weaken the text-is-canonical /
  index-is-disposable invariant, stop and flag it rather than quietly editing the
  README to bless it.

**Changed scope / non-goals** (something planned shipped, or a new deliberate
omission):
- Update **What this app deliberately does NOT do** (mirrors spec §9). Move
  shipped items out; keep the spec-section reference accurate.

**New / changed dev command, prerequisite, or build step** (`package.json`
scripts, toolchain):
- Update **Develop** — Prerequisites and the fenced command block. Keep the
  inline `# comment` explaining each command. Note `pnpm dev` / `pnpm build`
  run only the frontend vs. `pnpm tauri dev` / `pnpm tauri build` for the app.

## Verify before finishing

- File-tree block matches the real `src/lib/core/`, `src/routes/`, and
  `src-tauri/` layout (no stale or missing entries).
- Command block matches `package.json` `scripts` (names and what they do).
- **The one rule** and the non-goals list still agree with the actual storage /
  sync / index behavior in `src/lib/core/` (record.ts, index-db.ts, git.ts).
- Every `docs/` link in the README resolves to a file that exists
  (`grep -oP '\]\(docs/[^)]+\)' README.md`).

## Don't

- Don't edit anything in `docs/` — those are authored contracts/inputs, read-only here.
- Don't touch `CLAUDE.md` (maintained separately) — but check it for consistency.
- Don't document the user's private record content; the record lives in a
  separate repo (`~/whoamidocs`).
- Don't invent features or restate things that didn't change.
- Don't reformat or rewrap untouched prose — keep the diff tight.
