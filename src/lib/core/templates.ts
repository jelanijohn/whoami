/**
 * Scaffolding templates written into a freshly-initialized record folder.
 *
 * Kept as plain string constants (no `?raw` imports) so the core has no
 * bundler dependency and stays node-testable. These mirror the layout in
 * spec §2 — the record folder is the canonical data repo, separate from this
 * app's source.
 */

/** `.gitignore` for the record (data) repo — keeps the throwaway index and
 * generated outputs out of version control (spec §2). */
export const RECORD_GITIGNORE = `index.db
index.db-wal
index.db-shm
dist/
.DS_Store
Thumbs.db
`;

/** `.gitattributes` for the record repo — pins LF so entries written on
 * Windows, WSL, and macOS merge without line-ending churn (spec §8). */
export const RECORD_GITATTRIBUTES = `* text=auto eol=lf

*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.pdf binary
`;

/** README dropped into a new record folder, addressed to future-you. */
export const RECORD_README = `# Who Am I — my record

This folder is the canonical store for my life & career record. **The plain text
in here is the source of truth.** The Who Am I app reads and writes these files;
it does not own the data.

## The one rule
Plain text is canonical. The SQLite index is a throwaway cache, rebuilt from
these files and never synced. If text and index disagree, the text wins. You can
delete the index any time and the app rebuilds it.

## Layout
- \`profile.md\` — who you are (identity, handles, bio).
- \`entries/\` — the timeline; one Markdown file per event. The source of truth.
- \`assets/\` — optional files/images referenced by entries.
- \`templates/\` — optional resume / site templates.
- \`dist/\` — generated resume / site outputs (gitignored, derived).
- \`index.db\` — NOT here; lives in the app's data dir, per-machine, never synced.

## Daily workflow
Pull before editing, commit & push after:
\`\`\`bash
git pull --rebase
git add -A && git commit -m "journal: <what changed>" && git push
\`\`\`
The app's one-click Sync runs exactly this. It never pushes silently or
auto-resolves conflicts — pushing is always deliberate.

## Recovery
- Dashboard stale? Reindex in the app, or delete \`index.db\` — it rebuilds from
  text. You cannot lose data this way.
- Lost an entry? It's in Git history (\`git log\`, \`git show\`).
`;

/** Starter `profile.md` body shown on first run. */
export const PROFILE_BODY_PLACEHOLDER = `Narrative summary / bio in Markdown. Edited freely; this is presentation-layer,
not the raw record.
`;
