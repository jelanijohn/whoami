<script lang="ts">
  import { app } from '$lib/state.svelte';
  import type { ProjectRollup } from '$lib/core';

  let selected = $state('');
  let rollup = $state<ProjectRollup | null>(null);
  let loading = $state(false);

  // Default the selection to the first project once they load.
  $effect(() => {
    if (!selected && app.projects.length) selected = app.projects[0].slug;
  });

  // Recompute the rollup whenever the selected project changes.
  $effect(() => {
    const slug = selected;
    if (!slug || !app.store) {
      rollup = null;
      return;
    }
    loading = true;
    app
      .projectRollup(slug)
      .then((r) => {
        rollup = r;
      })
      .finally(() => {
        loading = false;
      });
  });

  const current = $derived(app.projects.find((p) => p.slug === selected) ?? null);
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-2">
    <h1 class="text-lg font-semibold">Projects</h1>
    {#if app.projects.length}
      <select
        bind:value={selected}
        class="rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
      >
        {#each app.projects as p (p.slug)}
          <option value={p.slug}>{p.entry.frontmatter.title} ({p.count})</option>
        {/each}
      </select>
    {/if}
    <span class="ml-auto text-xs text-[var(--color-muted)]">
      {app.llmReady ? 'LLM ready — retrospective coming in Phase IV' : 'No LLM configured — rollup only'}
    </span>
  </div>

  {#if !app.projects.length}
    <p class="py-12 text-center text-sm text-[var(--color-muted)]">
      No projects yet. Create an entry with <code>type: project</code> to start tracking one.
    </p>
  {:else if loading}
    <p class="text-sm text-[var(--color-muted)]">Computing rollup…</p>
  {:else if rollup}
    <section class="space-y-3 rounded-lg border border-[var(--color-line)] bg-white p-4 shadow-sm">
      <div>
        <h2 class="text-base font-semibold">{current?.entry.frontmatter.title}</h2>
        <p class="text-sm text-[var(--color-muted)]">
          {rollup.total}
          {rollup.total === 1 ? 'entry' : 'entries'}{rollup.dateRange
            ? ` · ${rollup.dateRange.start} → ${rollup.dateRange.end}`
            : ''}{rollup.private ? ` · ${rollup.private} private` : ''}
        </p>
      </div>

      {#if rollup.total === 0}
        <p class="text-sm text-[var(--color-muted)]">
          Nothing is affiliated with this project yet. Set <code>project: {selected}</code> on entries
          (or assign on promote in the inbox).
        </p>
      {:else}
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <h3 class="text-xs font-semibold text-[var(--color-muted)] uppercase">By type</h3>
            <ul class="mt-1 space-y-0.5 text-sm">
              {#each Object.entries(rollup.byType).sort((a, b) => b[1] - a[1]) as [type, n] (type)}
                <li class="flex justify-between"><span>{type}</span><span>{n}</span></li>
              {/each}
            </ul>
          </div>

          {#if Object.keys(rollup.bySource).length}
            <div>
              <h3 class="text-xs font-semibold text-[var(--color-muted)] uppercase">By source</h3>
              <ul class="mt-1 space-y-0.5 text-sm">
                {#each Object.entries(rollup.bySource).sort((a, b) => b[1] - a[1]) as [src, n] (src)}
                  <li class="flex justify-between"><span>{src}</span><span>{n}</span></li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>

        {#if rollup.topTags.length}
          <div>
            <h3 class="text-xs font-semibold text-[var(--color-muted)] uppercase">Top tags</h3>
            <div class="mt-1 flex flex-wrap gap-1">
              {#each rollup.topTags as t (t.tag)}
                <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-[var(--color-muted)]">
                  #{t.tag} · {t.count}
                </span>
              {/each}
            </div>
          </div>
        {/if}

        {#if rollup.gaps.length}
          <div>
            <h3 class="text-xs font-semibold text-[var(--color-muted)] uppercase">Gaps</h3>
            <ul class="mt-1 space-y-0.5 text-sm text-[var(--color-muted)]">
              {#each rollup.gaps as g (g.from + g.to)}
                <li>{g.from} → {g.to} ({g.weeks} weeks)</li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</div>
