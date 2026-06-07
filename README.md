# Who Am I

A private, locally-owned record of one person — life and career on a single timeline — that generates a resume and a personal website on demand. This repo **is** the record. The app reads and writes these files; it does not own the data.

> Two principles, from the brief: **brutally accurate** (the raw truth goes in here; polishing happens only when generating a resume or site) and **my eyes only** (this stays a set of files you hold).

See [`who-am-i-brief.md`](./who-am-i-brief.md) for the why, and [`who-am-i-storage-sync-spec.md`](./who-am-i-storage-sync-spec.md) for the storage/sync contract the app implements.

---

## The one rule

**Plain text in this repo is canonical. The SQLite index is a throwaway cache, rebuilt from these files and never synced.**

If the text and the index ever disagree, the text wins. You can safely delete the index at any time and the app rebuilds it.

---

## What's where

```
profile.md      → who you are (singleton: identity, handles, bio)
entries/        → the timeline. one Markdown file per event. THE source of truth.
assets/         → optional files/images referenced by entries
templates/      → optional resume / site templates
dist/           → generated resume / site outputs (gitignored, derived)
index.db        → NOT here — lives in the app's data dir, per-machine, never synced
```

You can edit any entry by hand in a text editor — the app is not required to read or write the record. The app just makes it faster and prettier.

---

## Adding an entry by hand

Create a file in `entries/` named `YYYY-MM-DD-slug-id6.md` (the `id6` is the last 6 chars of the `id`, which keeps filenames from clashing across machines). Minimum frontmatter:

```markdown
---
id: 01HXYZP3K7QWERTY8N7G8H9J
type: journal          # journal | role | project | win | skill | education | milestone | mention
date: 2024-03-14
created: 2024-03-14T09:22:00Z
updated: 2024-03-14T09:22:00Z
title: Short label
private: false         # true = never appears in resume/site/public views
tags: []
---

Rough notes, half-memories, dead ends — verbatim. Don't polish here.
```

`id`, `type`, `date`, `title`, `private` are required; everything else is optional and free to extend. Full schema is in the spec.

---

## First-time setup on a machine

Each machine gets **its own clone on its own native filesystem**. Never open one clone from across the WSL/Windows boundary — that's what causes locking and corruption. The clones reconcile only through the remote.

**Windows** (the native app reads this one) — in PowerShell or Git Bash:
```bash
cd ~                       # C:\Users\you
git clone <REMOTE_URL> who-am-i
cd who-am-i
```

**WSL** (a separate clone, for CLI / Claude Code work):
```bash
cd ~                       # ext4 home, e.g. /home/you
git clone <REMOTE_URL> who-am-i
cd who-am-i
```

**Mac (later):** identical — just another clone.

---

## Daily workflow

**Before an editing session, pull:**
```bash
git pull --rebase
```

**After making changes (by hand or via the app), commit and push:**
```bash
git add -A
git commit -m "journal: <what changed>"
git push
```

The app offers a one-click "Sync" that runs exactly this (`pull --rebase`, then `add`/`commit`/`push`). It will **not** push silently or auto-resolve conflicts — pushing is always a deliberate action.

### If a pull reports a conflict
This only happens if you edited the *same* entry on two machines (new entries never conflict — different files). Open the one conflicted `.md`, keep the right lines, then:
```bash
git add <file>
git rebase --continue   # or: git merge --continue
```

---

## Recovery / troubleshooting

- **Dashboard looks wrong or stale?** The index drifted. Trigger a reindex in the app, or just delete `index.db` from the app data dir — it rebuilds from the text on next launch. You cannot lose data this way.
- **Lost an entry?** It's in Git history (`git log`, `git show`). Removing an entry in the app deletes the file but not the history.
- **Repo feels heavy from large assets?** Consider Git LFS for `assets/` (deferred decision — see the spec).

---

## Status / open decisions

Tracked in the spec (§10). The one worth settling early: whether the remote stays a private GitHub repo or moves to a self-hosted / encrypted-at-rest setup, since this repo holds the private life journey. Decide before the first sensitive entries land.
