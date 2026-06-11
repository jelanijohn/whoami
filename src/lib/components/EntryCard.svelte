<script lang="ts">
  import type { Entry, ProjectSummary } from '$lib/core';

  let { entry, projects = [], onedit, ondelete, onassign }: {
    entry: Entry;
    projects?: ProjectSummary[];
    onedit: (e: Entry) => void;
    ondelete: (e: Entry) => void;
    onassign?: (e: Entry, slug: string) => void;
  } = $props();

  const fm = $derived(entry.frontmatter);
  const tags = $derived(Array.isArray(fm.tags) ? (fm.tags as string[]) : []);
  const excerpt = $derived(
    entry.body.length > 240 ? entry.body.slice(0, 240).trimEnd() + '…' : entry.body
  );
  const org = $derived(typeof fm.org === 'string' ? fm.org : '');
  // Current affiliation (a project slug), or '' when unfiled. Drives the
  // quick-assign picker below; a project entry has its own slug, not this.
  const project = $derived(typeof fm.project === 'string' ? fm.project : '');
  const canAssign = $derived(!!onassign && fm.type !== 'project' && (projects.length > 0 || !!project));
</script>

<article class="rounded-lg border border-[var(--color-line)] bg-white p-4 shadow-sm dark:bg-[#1e1f24] dark:shadow-none">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--color-accent)]">
          {fm.type}
        </span>
        {#if fm.private}
          <span class="rounded bg-[var(--color-private)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--color-private)]">
            private
          </span>
        {/if}
        <time class="text-xs text-[var(--color-muted)]">{fm.date}</time>
      </div>
      <h3 class="mt-1 truncate text-base font-semibold">{fm.title}</h3>
      {#if org}<p class="text-sm text-[var(--color-muted)]">{org}</p>{/if}
    </div>
    <div class="flex shrink-0 gap-1">
      <button
        class="rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-gray-100 dark:hover:bg-white/10"
        onclick={() => onedit(entry)}>Edit</button
      >
      <button
        class="rounded px-2 py-1 text-xs text-[var(--color-private)] hover:bg-[var(--color-private)]/10"
        onclick={() => ondelete(entry)}>Remove</button
      >
    </div>
  </div>

  {#if excerpt.trim()}
    <p class="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{excerpt}</p>
  {/if}

  {#if tags.length}
    <div class="mt-2 flex flex-wrap gap-1">
      {#each tags as tag (tag)}
        <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-[var(--color-muted)] dark:bg-white/10">#{tag}</span>
      {/each}
    </div>
  {/if}

  {#if canAssign}
    <div class="mt-3 flex items-center gap-2 border-t border-[var(--color-line)] pt-2">
      <label class="text-xs text-[var(--color-muted)]" for="assign-{fm.id}">Project</label>
      <select
        id="assign-{fm.id}"
        class="rounded border border-[var(--color-line)] px-2 py-1 text-xs"
        value={project}
        onchange={(e) => onassign?.(entry, (e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">— none —</option>
        {#each projects as p (p.slug)}
          <option value={p.slug}>{p.entry.frontmatter.title}</option>
        {/each}
        {#if project && !projects.some((p) => p.slug === project)}
          <option value={project}>{project} (not listed)</option>
        {/if}
      </select>
    </div>
  {/if}
</article>
