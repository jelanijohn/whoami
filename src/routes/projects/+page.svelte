<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { extractMarkedBlock, type ProjectRollup, type ReduceProposal } from '$lib/core';

  let selected = $state('');
  let rollup = $state<ProjectRollup | null>(null);
  let loading = $state(false);
  let proposal = $state<ReduceProposal | null>(null);
  let generating = $state(false);

  // Default the selection to the first project once they load.
  $effect(() => {
    if (!selected && app.projects.length) selected = app.projects[0].slug;
  });

  // Recompute the rollup whenever the selected project changes; drop any
  // pending proposal (it belonged to the previous project).
  $effect(() => {
    const slug = selected;
    proposal = null;
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

  // The retrospective already saved into this project's entry (between the
  // reduce markers), if any. Recomputes after accept since refresh() reloads
  // app.projects.
  const saved = $derived(current ? extractMarkedBlock(current.entry.body) : '');

  async function generate() {
    generating = true;
    try {
      proposal = await app.generateRetrospective(selected);
    } finally {
      generating = false;
    }
  }

  async function accept() {
    if (!proposal) return;
    await app.acceptRetrospective(proposal);
    proposal = null;
  }
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
      {app.llmReady ? 'LLM ready — generate a retrospective below' : 'No LLM configured — rollup only'}
    </span>
  </div>

  {#if !app.projects.length}
    <p class="py-12 text-center text-sm text-[var(--color-muted)]">
      No projects yet. Create an entry with <code>type: project</code> to start tracking one.
    </p>
  {:else if loading}
    <p class="text-sm text-[var(--color-muted)]">Computing rollup…</p>
  {:else if rollup}
    <section class="space-y-3 rounded-lg border border-[var(--color-line)] bg-white p-4 shadow-sm dark:bg-[#1e1f24] dark:shadow-none">
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
                <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-[var(--color-muted)] dark:bg-white/10">
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

    <!-- Retrospective (Stage 2 reduce) — LLM-assisted, human-gated. -->
    <section class="space-y-3 rounded-lg border border-[var(--color-line)] bg-white p-4 shadow-sm dark:bg-[#1e1f24] dark:shadow-none">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-semibold">Retrospective</h2>
        <span class="text-xs text-[var(--color-muted)]">
          LLM-assisted · every fact cites the entries it came from · nothing is saved until you accept
        </span>
        <button
          class="ml-auto rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={!app.llmReady || generating || app.busy || (rollup?.total ?? 0) === 0}
          onclick={generate}
        >
          {generating ? 'Generating…' : 'Generate retrospective'}
        </button>
      </div>

      {#if !app.llmReady}
        <p class="text-sm text-[var(--color-muted)]">
          No LLM provider configured. Set one in <a class="text-[var(--color-accent)] hover:underline" href="/data">Data → AI provider</a>
          to draft a retrospective. The rollup above works without it.
        </p>
      {/if}

      {#if proposal}
        <div class="space-y-2">
          <p class="text-xs text-[var(--color-muted)]">
            Proposed from {proposal.entryCount}
            {proposal.entryCount === 1 ? 'entry' : 'entries'}.
            {proposal.currentInner ? 'This replaces the existing retrospective.' : ''}
            Review below, then accept to write it into the project entry (outside-the-markers prose is
            untouched).
          </p>
          <pre class="max-h-96 overflow-auto rounded border border-[var(--color-line)] bg-gray-50 p-3 text-xs whitespace-pre-wrap dark:bg-white/5">{proposal.inner}</pre>
          <div class="flex gap-2">
            <button
              class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              disabled={app.busy}
              onclick={accept}
            >
              Accept &amp; save
            </button>
            <button
              class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-white/5"
              onclick={() => (proposal = null)}
            >
              Discard
            </button>
          </div>
        </div>
      {:else if saved}
        <div class="space-y-2">
          <p class="text-xs text-[var(--color-muted)]">
            Saved retrospective, stored in the project entry. Regenerate to refresh it from the latest
            entries.
          </p>
          <pre class="max-h-96 overflow-auto rounded border border-[var(--color-line)] bg-gray-50 p-3 text-xs whitespace-pre-wrap dark:bg-white/5">{saved}</pre>
        </div>
      {:else if app.llmReady}
        <p class="text-sm text-[var(--color-muted)]">
          No retrospective yet. Click <span class="font-medium">Generate retrospective</span> to draft one
          from this project's {rollup.total}
          {rollup.total === 1 ? 'entry' : 'entries'}.
        </p>
      {/if}
    </section>
  {/if}
</div>
