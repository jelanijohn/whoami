<script lang="ts">
  import type { Entry, ProjectSummary } from '$lib/core';

  let {
    candidate,
    projects,
    busy = false,
    onpromote,
    onreject
  }: {
    candidate: Entry;
    projects: ProjectSummary[];
    busy?: boolean;
    onpromote: (path: string, project: string) => void;
    onreject: (path: string, title: string) => void;
  } = $props();

  const fm = $derived(candidate.frontmatter);
  const source = $derived(typeof fm.source === 'string' ? fm.source : '');
  const sourceUrl = $derived(typeof fm.source_url === 'string' ? fm.source_url : '');
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

<article class="rounded-lg border border-[var(--color-line)] bg-white p-4 shadow-sm">
  <div class="flex flex-wrap items-center gap-2">
    <span class="rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--color-accent)]">
      {fm.type}
    </span>
    {#if source}
      <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-[var(--color-muted)]">
        {source}
      </span>
    {/if}
    <time class="text-xs text-[var(--color-muted)]">{fm.date}</time>
    {#if sourceUrl}
      <a href={sourceUrl} target="_blank" rel="noreferrer" class="text-xs text-[var(--color-accent)] hover:underline">
        source ↗
      </a>
    {/if}
  </div>

  <h3 class="mt-1 text-base font-semibold">{fm.title}</h3>

  {#if excerpt.trim()}
    <p class="mt-2 whitespace-pre-wrap text-sm text-gray-700">{excerpt}</p>
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
</article>
