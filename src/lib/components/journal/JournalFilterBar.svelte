<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { ENTRY_TYPES, type SortKey } from '$lib/core';
  import { TYPE_META, alpha } from '$lib/journal/theme';

  let {
    onfilter,
    onExpandAll,
    onCollapseAll,
    onGroupByChange
  }: {
    /** Debounced re-query trigger (the route owns the timer). */
    onfilter: () => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    /** Grouping changed — the route resets which groups are expanded. */
    onGroupByChange: () => void;
  } = $props();

  const SORT_OPTIONS: [SortKey, string][] = [
    ['date', 'Date'],
    ['title', 'Title'],
    ['type', 'Type'],
    ['project', 'Project'],
    ['org', 'Org']
  ];

  const inputCls =
    'h-[34px] rounded-lg border border-[var(--color-line)] bg-white px-2.5 text-[13px] text-[var(--color-ink)] dark:bg-[var(--color-bar)]';
  const smallSelectCls =
    'h-8 rounded-lg border border-[var(--color-line)] bg-white px-2.5 text-[13px] text-[var(--color-ink)] dark:bg-[var(--color-bar)]';
  const labelCls = 'text-[11px] uppercase tracking-[0.04em] text-[var(--jv-date)]';

  // Sort/private are persisted layout prefs; the rest only re-query.
  function persistAndRequery() {
    app.savePrefs();
    onfilter();
  }
  function toggleDir() {
    app.sortDir = app.sortDir === 'asc' ? 'desc' : 'asc';
    persistAndRequery();
  }
  function togglePrivate() {
    app.includePrivate = !app.includePrivate;
    persistAndRequery();
  }
  function clearAll() {
    app.clearFilters();
    app.savePrefs();
    onfilter();
  }
</script>

<div
  class="mt-3.5 flex flex-col gap-[11px] rounded-[14px] border border-[var(--color-line)] bg-white dark:bg-[var(--color-bar)]"
  style="padding:13px 15px;"
>
  <!-- Row 1 — search · sort · private -->
  <div class="flex flex-wrap items-center gap-[9px]">
    <div class="relative min-w-[230px] flex-1">
      <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] leading-none text-[var(--jv-date)]">⌕</span>
      <input
        bind:value={app.search}
        oninput={onfilter}
        placeholder="Search titles, body, tags, org…"
        class="h-[34px] w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] py-0 pl-7 pr-2.5 text-[13px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)] focus:bg-white dark:focus:bg-[var(--color-bar)]"
      />
    </div>
    <div class="flex items-center gap-1.5">
      <span class={labelCls}>Sort</span>
      <select bind:value={app.sortKey} onchange={persistAndRequery} class={inputCls}>
        {#each SORT_OPTIONS as [value, label] (value)}
          <option {value}>{label}</option>
        {/each}
      </select>
      <button
        onclick={toggleDir}
        title="Toggle sort direction"
        aria-label="Toggle sort direction"
        class="size-[34px] rounded-lg border border-[var(--color-line)] bg-white text-[13px] text-[var(--color-muted)] dark:bg-[var(--color-bar)]"
        >{app.sortDir === 'asc' ? '↑' : '↓'}</button
      >
    </div>
    <button
      onclick={togglePrivate}
      class="h-[34px] rounded-lg px-3 text-[12px] font-medium transition-all duration-100"
      style={app.includePrivate
        ? 'background:color-mix(in srgb, var(--color-private) 10%, transparent);border:1px solid color-mix(in srgb, var(--color-private) 35%, transparent);color:var(--color-private);'
        : 'background:var(--color-bar);border:1px solid var(--color-line);color:var(--jv-date);'}
      >{app.includePrivate ? 'Private: shown' : 'Private: hidden'}</button
    >
  </div>

  <!-- Row 2 — type chips -->
  <div class="flex flex-wrap items-center gap-1.5">
    <span class="{labelCls} mr-0.5">Types</span>
    {#each ENTRY_TYPES as t (t)}
      {@const m = TYPE_META[t]}
      {@const sel = app.selTypes.includes(t)}
      <button
        onclick={() => {
          app.toggleType(t);
          onfilter();
        }}
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-all duration-100"
        style={sel
          ? `background:${alpha(m.color, 12)};border:1px solid ${alpha(m.color, 40)};color:${m.color};`
          : 'background:var(--color-bar);border:1px solid var(--color-line);color:var(--color-muted);'}
      >
        <span class="size-2 rounded-[2px]" style="background:{m.color}"></span>
        {m.label}
        <span class="tabular-nums opacity-60">{app.typeCounts[t] ?? 0}</span>
      </button>
    {/each}
  </div>

  <!-- Row 3 — project · tag · date · group controls -->
  <div class="flex flex-wrap items-center gap-[9px] border-t border-[var(--jv-hair)] pt-[11px]">
    <select bind:value={app.filterProject} onchange={onfilter} class="{smallSelectCls} max-w-[230px]">
      <option value="">All projects</option>
      {#each app.projects as p (p.slug)}
        <option value={p.slug}>{p.entry.frontmatter.title} ({p.count})</option>
      {/each}
    </select>
    <select bind:value={app.filterTag} onchange={onfilter} class={smallSelectCls}>
      <option value="">All tags</option>
      {#each app.tags as t (t.tag)}
        <option value={t.tag}>#{t.tag} ({t.count})</option>
      {/each}
    </select>
    <div class="flex items-center gap-1.5">
      <span class={labelCls}>From</span>
      <input type="date" bind:value={app.dateFrom} onchange={onfilter} class="{smallSelectCls} text-[12px]" />
      <span class={labelCls}>To</span>
      <input type="date" bind:value={app.dateTo} onchange={onfilter} class="{smallSelectCls} text-[12px]" />
    </div>

    {#if app.view === 'grouped'}
      <div class="ml-1.5 flex items-center gap-1.5 border-l border-[var(--jv-hair)] pl-3">
        <span class={labelCls}>Group by</span>
        <select
          bind:value={app.groupBy}
          onchange={() => {
            app.savePrefs();
            onGroupByChange();
          }}
          class={smallSelectCls}
        >
          <option value="project">Project</option>
          <option value="type">Type</option>
          <option value="month">Month</option>
        </select>
        <button onclick={onExpandAll} class="h-8 rounded-lg border border-[var(--color-line)] bg-white px-[9px] text-[12px] text-[var(--color-muted)] dark:bg-[var(--color-bar)]">Expand all</button>
        <button onclick={onCollapseAll} class="h-8 rounded-lg border border-[var(--color-line)] bg-white px-[9px] text-[12px] text-[var(--color-muted)] dark:bg-[var(--color-bar)]">Collapse all</button>
      </div>
    {/if}

    {#if app.activeFilters}
      <button onclick={clearAll} class="ml-auto h-8 rounded-lg border border-transparent bg-transparent px-[11px] text-[12px] text-[var(--color-private)]">Clear filters</button>
    {/if}
  </div>
</div>
