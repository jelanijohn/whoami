<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { app } from '$lib/state.svelte';
  import { type Entry, type SortKey, type WinProposal, type AcceptedWin } from '$lib/core';
  import WinDraftReview from '$lib/components/WinDraftReview.svelte';
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

  // --- Bulk select (multi-edit private/project without the editor) ----------
  // A "Select" mode reveals row checkboxes; a sticky bar acts on the picked set.
  // Keyed by entry id (stable ULID), so selection survives a refresh.
  let selectMode = $state(false);
  const selected = new SvelteSet<string>();
  // Calendar is a read-only heatmap — selection only applies to the row views.
  const canSelect = $derived(app.view !== 'calendar');
  const selectedEntries = $derived(
    app.entries.filter((e) => selected.has(String(e.frontmatter.id)))
  );

  // Bulk project picker: a sentinel default so a stray Apply is a no-op.
  const SET_PROJECT = '__set__';
  let bulkProject = $state(SET_PROJECT);

  function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) selected.clear();
  }
  function toggleSelect(id: string, checked: boolean) {
    checked ? selected.add(id) : selected.delete(id);
  }
  function clearSelection() {
    selected.clear();
  }
  function setSelectAll(checked: boolean) {
    if (checked) for (const e of app.entries) selected.add(String(e.frontmatter.id));
    else selected.clear();
  }
  async function bulkPrivate(isPrivate: boolean) {
    await app.bulkSetPrivate(selectedEntries, isPrivate);
    selected.clear();
  }
  async function bulkApplyProject() {
    if (bulkProject === SET_PROJECT) return; // nothing chosen yet
    await app.bulkSetProject(selectedEntries, bulkProject === '' ? '' : bulkProject);
    bulkProject = SET_PROJECT;
    selected.clear();
  }

  // --- Draft wins (LLM, gated by accept) -------------------------------------
  let winProposal = $state<WinProposal | null>(null);
  let winTargets = $state<{ id: string; label: string; kind: 'role' | 'project' }[]>([]);
  async function startDraftWins() {
    winTargets = await app.winTargets();
    const p = await app.draftWins([...selected]);
    if (p) winProposal = p; // null on error/no-store; the toast already explains
  }
  async function acceptWins(accepted: AcceptedWin[]) {
    const created = await app.acceptWins(accepted);
    if (created) {
      winProposal = null;
      selectMode = false;
      selected.clear();
    }
  }
  // Leaving a selectable view drops the picked set so the bar can't linger.
  $effect(() => {
    if (!canSelect && (selectMode || selected.size)) {
      selectMode = false;
      selected.clear();
    }
  });

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

  <!-- View switcher + select-mode toggle -->
  <div class="mt-5 flex flex-wrap items-center gap-2">
    <div class="inline-flex gap-0.5 rounded-[11px] border border-[var(--color-line)] bg-white p-[3px] dark:bg-[var(--color-bar)]">
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
    {#if canSelect}
      <button
        onclick={toggleSelectMode}
        class="rounded-[9px] border px-3.5 py-[7px] text-[13px] font-medium transition-colors"
        style={selectMode
          ? 'background:var(--color-accent);color:#fff;border-color:var(--color-accent);'
          : 'background:transparent;color:var(--color-muted);border-color:var(--color-line);'}
      >
        {selectMode ? 'Done' : 'Select'}
      </button>
    {/if}
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

  <!-- Bulk-action bar (visible in select mode once something is picked) -->
  {#if selectMode && selected.size > 0}
    <div
      class="sticky top-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-3 py-2 backdrop-blur"
    >
      <span class="text-sm font-medium">{selected.size} selected</span>
      <button
        class="rounded px-2 py-0.5 text-xs text-[var(--color-muted)] hover:bg-black/5 dark:hover:bg-white/10"
        onclick={clearSelection}
      >
        Clear
      </button>
      <button
        class="rounded px-2 py-0.5 text-xs text-[var(--color-muted)] hover:bg-black/5 dark:hover:bg-white/10"
        onclick={() => setSelectAll(true)}
      >
        Select all
      </button>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <button
          class="rounded px-2.5 py-1 text-xs text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
          disabled={app.busy}
          onclick={() => void bulkPrivate(true)}
        >
          Make private
        </button>
        <button
          class="rounded px-2.5 py-1 text-xs text-[var(--color-muted)] hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
          disabled={app.busy}
          onclick={() => void bulkPrivate(false)}
        >
          Make public
        </button>
        <label class="text-xs text-[var(--color-muted)]" for="bulk-project">Project</label>
        <select
          id="bulk-project"
          bind:value={bulkProject}
          class="rounded border border-[var(--color-line)] px-2 py-1 text-sm"
        >
          <option value={SET_PROJECT}>— set project… —</option>
          <option value="">— clear project —</option>
          {#each app.projects as p (p.slug)}
            <option value={p.slug}>{p.entry.frontmatter.title}</option>
          {/each}
        </select>
        <button
          class="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={app.busy || bulkProject === SET_PROJECT}
          onclick={() => void bulkApplyProject()}
        >
          Apply
        </button>
        <button
          class="rounded border border-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
          disabled={!app.llmReady || app.busy}
          title={app.llmReady
            ? 'Draft résumé-grade wins from the selected entries'
            : 'Set an AI provider in Data → AI provider to draft wins'}
          onclick={() => void startDraftWins()}
        >
          Draft wins…
        </button>
      </div>
    </div>
  {/if}

  <!-- Wins draft review (LLM proposal — nothing is saved until accepted) -->
  {#if winProposal}
    <div class="mt-4">
      <WinDraftReview
        proposal={winProposal}
        targets={winTargets}
        onaccept={acceptWins}
        oncancel={() => (winProposal = null)}
      />
    </div>
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
      selectable={selectMode}
      {selected}
      onselect={toggleSelect}
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
      selectable={selectMode}
      {selected}
      onselect={toggleSelect}
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
      selectable={selectMode}
      {selected}
      onselect={toggleSelect}
      onselectall={setSelectAll}
      {noResults}
      {emptyMsg}
    />
  {/if}
</div>
