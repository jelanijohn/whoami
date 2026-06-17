<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { app } from '$lib/state.svelte';
  import { type Entry, type SortKey } from '$lib/core';
  import { projectColor, UNAFFILIATED_COLOR } from '$lib/journal/theme';
  import { computeGroups, dayGroups } from '$lib/journal/grouping';
  import EntryEditor from '$lib/components/EntryEditor.svelte';
  import JournalFilterBar from '$lib/components/journal/JournalFilterBar.svelte';
  import GroupedView from '$lib/components/journal/GroupedView.svelte';
  import TimelineView from '$lib/components/journal/TimelineView.svelte';
  import CalendarView from '$lib/components/journal/CalendarView.svelte';
  import TableView from '$lib/components/journal/TableView.svelte';

  const VIEWS: [typeof app.view, string][] = [
    ['grouped', 'Grouped'],
    ['timeline', 'Timeline'],
    ['calendar', 'Calendar'],
    ['table', 'Table']
  ];

  // --- Add / edit ------------------------------------------------------------
  let mode = $state<'idle' | 'new'>('idle');
  let editing = $state<Entry | null>(null);
  function startNew() {
    editing = null;
    mode = 'new';
  }
  function startEdit(e: Entry) {
    mode = 'idle';
    editing = e;
  }
  function done() {
    mode = 'idle';
    editing = null;
  }
  async function remove(e: Entry) {
    if (confirm(`Remove “${e.frontmatter.title}”? It stays in Git history.`)) {
      await app.deleteEntry(e);
    }
  }

  // --- View-local UI state ---------------------------------------------------
  const expandedGroups = new SvelteSet<string>();
  const expandedEntries = new SvelteSet<string>();
  let selectedDay = $state('');
  const today = new Date().toISOString().slice(0, 10);

  // --- Re-query on filter change (debounced; the query does the work) --------
  let t: ReturnType<typeof setTimeout> | undefined;
  function onFilter() {
    clearTimeout(t);
    t = setTimeout(() => app.refresh(), 150);
  }

  // --- Project slug → title / color (by project order) -----------------------
  const projInfo = $derived.by(() => {
    const title = new Map<string, string>();
    const color = new Map<string, string>();
    app.projects.forEach((p, i) => {
      title.set(p.slug, String(p.entry.frontmatter.title));
      color.set(p.slug, projectColor(i));
    });
    return { title, color };
  });
  const projectTitle = (slug: string) => projInfo.title.get(slug) ?? slug;
  const projectColorOf = (slug: string) =>
    slug ? (projInfo.color.get(slug) ?? UNAFFILIATED_COLOR) : UNAFFILIATED_COLOR;

  // --- Derived view models ---------------------------------------------------
  const groups = $derived(
    computeGroups(app.entries, app.groupBy, { projectTitle, projectColor: projectColorOf, sortDir: app.sortDir })
  );
  const days = $derived(dayGroups(app.entries));

  const noResults = $derived(app.entries.length === 0);
  const emptyMsg = $derived(
    app.activeFilters
      ? 'No entries match these filters.'
      : 'Nothing here yet. Capture the truth as it happens.'
  );
  const subtitle = $derived(
    app.entries.length === app.total
      ? `${app.total} entries on the timeline`
      : `${app.entries.length} of ${app.total} entries`
  );

  // --- Interactions ----------------------------------------------------------
  function setView(v: typeof app.view) {
    app.view = v;
    app.savePrefs();
  }
  function toggleGroup(key: string) {
    expandedGroups.has(key) ? expandedGroups.delete(key) : expandedGroups.add(key);
  }
  function toggleEntry(id: string) {
    expandedEntries.has(id) ? expandedEntries.delete(id) : expandedEntries.add(id);
  }
  function selectDay(date: string) {
    selectedDay = selectedDay === date ? '' : date;
  }
  function expandAll() {
    for (const g of groups) expandedGroups.add(g.key);
  }
  function collapseAll() {
    expandedGroups.clear();
  }
  function onGroupByChange() {
    expandedGroups.clear();
  }
  // Table header sort: re-pick key (date defaults desc, others asc), or flip
  // direction when the key is already active. Persist + re-query.
  function onSort(key: SortKey) {
    if (app.sortKey === key) {
      app.sortDir = app.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      app.sortKey = key;
      app.sortDir = key === 'date' ? 'desc' : 'asc';
    }
    app.savePrefs();
    onFilter();
  }
</script>

<div>
  <!-- Header -->
  <div class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="m-0 text-[25px] font-[650] tracking-[-0.015em]">Journal</h1>
      <p class="mt-[5px] text-[13px] text-[var(--color-muted)]">{subtitle}</p>
    </div>
    <button
      onclick={startNew}
      class="rounded-[9px] bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90"
      >+ Add entry</button
    >
  </div>

  <!-- View switcher -->
  <div class="mt-5 inline-flex gap-0.5 rounded-[11px] border border-[var(--color-line)] bg-white p-[3px] dark:bg-[var(--color-bar)]">
    {#each VIEWS as [v, label] (v)}
      <button
        onclick={() => setView(v)}
        class="rounded-lg px-[15px] py-[7px] text-[13px] transition-all duration-100"
        class:font-semibold={app.view === v}
        class:font-medium={app.view !== v}
        style={app.view === v
          ? 'background:var(--color-accent);color:#fff;'
          : 'background:transparent;color:var(--color-muted);'}
      >
        {label}
      </button>
    {/each}
  </div>

  <!-- Filter / sort bar -->
  <JournalFilterBar onfilter={onFilter} onExpandAll={expandAll} onCollapseAll={collapseAll} {onGroupByChange} />

  <!-- Inline editor (add new, or edit an existing entry) -->
  {#if mode === 'new'}
    <div class="mt-4"><EntryEditor entry={null} ondone={done} /></div>
  {:else if editing}
    <!-- Key by id so picking a different row's Edit remounts with fresh data
         (EntryEditor snapshots `entry` on init). -->
    {#key editing.frontmatter.id}
      <div class="mt-4"><EntryEditor entry={editing} ondone={done} /></div>
    {/key}
  {/if}

  <!-- Active view -->
  {#if app.view === 'grouped'}
    <GroupedView
      {groups}
      {expandedGroups}
      {expandedEntries}
      ontoggleGroup={toggleGroup}
      ontoggleEntry={toggleEntry}
      {projectTitle}
      onedit={startEdit}
      ondelete={remove}
      {noResults}
      {emptyMsg}
    />
  {:else if app.view === 'timeline'}
    <TimelineView
      {days}
      {expandedEntries}
      ontoggleEntry={toggleEntry}
      {projectTitle}
      onedit={startEdit}
      ondelete={remove}
      {noResults}
      {emptyMsg}
    />
  {:else if app.view === 'calendar'}
    <CalendarView entries={app.entries} {selectedDay} onselectday={selectDay} {projectTitle} anchor={today} />
  {:else}
    <TableView
      entries={app.entries}
      {expandedEntries}
      ontoggleEntry={toggleEntry}
      sortKey={app.sortKey}
      sortDir={app.sortDir}
      onsort={onSort}
      {projectTitle}
      {noResults}
      {emptyMsg}
    />
  {/if}
</div>
