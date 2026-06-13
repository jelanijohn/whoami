<script lang="ts">
  import type { Entry, ProjectSummary } from '$lib/core';

  let {
    candidate,
    projects,
    busy = false,
    selected = false,
    onselect,
    onpromote,
    onreject
  }: {
    candidate: Entry;
    projects: ProjectSummary[];
    busy?: boolean;
    /** When `onselect` is provided, the card shows a selection checkbox. */
    selected?: boolean;
    onselect?: (path: string, checked: boolean) => void;
    onpromote: (path: string, project: string) => void;
    onreject: (path: string, title: string) => void;
  } = $props();

  const fm = $derived(candidate.frontmatter);
  const source = $derived(typeof fm.source === 'string' ? fm.source : '');
  const sourceUrl = $derived(typeof fm.source_url === 'string' ? fm.source_url : '');

  // PR change size rides the `change_size` frontmatter pass-through (GitHub
  // adapter). Read it defensively — it's an unknown nested object, present only
  // on PR candidates. Null ⇒ no badge.
  const changeSize = $derived.by(() => {
    const cs = fm.change_size;
    if (typeof cs !== 'object' || cs === null) return null;
    const rec = cs as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      additions: num(rec.additions),
      deletions: num(rec.deletions),
      changedFiles: num(rec.changed_files)
    };
  });

  // Triage signal (spec §6): a `frivolous` candidate shows a small muted badge
  // with its reason and which stage decided. Absence ⇒ untriaged ⇒ shows normally.
  const isFrivolous = $derived(fm.triage_signal === 'frivolous');
  const triageReason = $derived(typeof fm.triage_reason === 'string' ? fm.triage_reason : '');
  const triageBy = $derived(fm.triage_source === 'llm' ? 'model' : 'prefilter');
  const excerpt = $derived(
    candidate.body.length > 280 ? candidate.body.slice(0, 280).trimEnd() + '…' : candidate.body
  );

  // The adapter may have suggested a project (rides the `project` frontmatter
  // key); default the picker to it, but the human decides. A slug not yet in the
  // project list still shows as the current value.
  const suggested = $derived(typeof fm.project === 'string' ? fm.project : '');
  let project = $state('');
  $effect(() => {
    project = suggested;
  });
</script>

<article
  class="flex gap-3 rounded-lg border bg-white p-4 shadow-sm dark:bg-[#1e1f24] dark:shadow-none {selected
    ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
    : 'border-[var(--color-line)]'}"
>
  {#if onselect}
    <input
      type="checkbox"
      class="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
      checked={selected}
      aria-label="Select “{fm.title}”"
      onchange={(e) => onselect(candidate.path!, e.currentTarget.checked)}
    />
  {/if}
  <div class="min-w-0 flex-1">
  <div class="flex flex-wrap items-center gap-2">
    <span class="rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--color-accent)]">
      {fm.type}
    </span>
    {#if source}
      <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-[var(--color-muted)] dark:bg-white/10">
        {source}
      </span>
    {/if}
    <time class="text-xs text-[var(--color-muted)]">{fm.date}</time>
    {#if sourceUrl}
      <a href={sourceUrl} target="_blank" rel="noreferrer" class="text-xs text-[var(--color-accent)] hover:underline">
        source ↗
      </a>
    {/if}
    {#if changeSize}
      <span
        class="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-[var(--color-muted)] dark:bg-white/10"
        title="{changeSize.additions} additions, {changeSize.deletions} deletions across {changeSize.changedFiles} file{changeSize.changedFiles === 1 ? '' : 's'}"
      >
        <span class="text-green-700 dark:text-green-400">+{changeSize.additions}</span>
        <span class="text-[var(--color-private)]">−{changeSize.deletions}</span>
        <span class="text-[var(--color-muted)]">· {changeSize.changedFiles} file{changeSize.changedFiles === 1 ? '' : 's'}</span>
      </span>
    {/if}
    {#if isFrivolous}
      <span
        class="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"
        title="Flagged as frivolous by the {triageBy}. Promote/reject are unchanged — this is only a sort hint."
      >
        frivolous{triageReason ? `: ${triageReason}` : ''} · {triageBy}
      </span>
    {/if}
  </div>

  <h3 class="mt-1 text-base font-semibold">{fm.title}</h3>

  {#if excerpt.trim()}
    <p class="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{excerpt}</p>
  {/if}

  <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] pt-3">
    <label class="text-xs text-[var(--color-muted)]" for="proj-{fm.id}">Project</label>
    <select
      id="proj-{fm.id}"
      bind:value={project}
      class="rounded border border-[var(--color-line)] px-2 py-1 text-sm"
    >
      <option value="">— none —</option>
      {#each projects as p (p.slug)}
        <option value={p.slug}>{p.entry.frontmatter.title}</option>
      {/each}
      {#if suggested && !projects.some((p) => p.slug === suggested)}
        <option value={suggested}>{suggested} (suggested)</option>
      {/if}
    </select>

    <div class="ml-auto flex gap-2">
      <button
        class="rounded px-2.5 py-1 text-xs text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
        disabled={busy}
        onclick={() => onreject(candidate.path!, String(fm.title))}
      >
        Reject
      </button>
      <button
        class="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        disabled={busy}
        onclick={() => onpromote(candidate.path!, project)}
      >
        Promote
      </button>
    </div>
  </div>
  </div>
</article>
