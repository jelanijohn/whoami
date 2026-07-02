<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { slugify, ENTRY_TYPES, type Entry } from '$lib/core';
  import { app } from '$lib/state.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import CandidateRow from '$lib/components/CandidateRow.svelte';
  import { typeMeta, sourceMeta, alpha, KEPT_COLOR, FLAGGED_COLOR } from '$lib/inbox/theme';
  import {
    computeGroups,
    filterCandidates,
    hasActiveFilters,
    sortCandidates,
    defaultDir,
    isFrivolous,
    typeOf,
    sourceOf,
    projectOf,
    type FrivolousMode,
    type GroupBy,
    type SortKey,
    type SortDir,
    type InboxContext
  } from '$lib/inbox/grouping';

  // Load the staged candidates whenever a record is open. Token presence
  // drives the "Enrich from Shortcut" affordance.
  $effect(() => {
    if (app.store) {
      app.loadCandidates();
      app.refreshTokenPresence();
    }
  });

  // --- Filter / sort / group UI state (all client-side over app.candidates) --
  let search = $state('');
  let selTypes = $state<string[]>([]);
  let selSources = $state<string[]>([]);
  let filterProject = $state(''); // '' all · '__none' unaffiliated · else slug
  let frivolousMode = $state<FrivolousMode>('all');
  let sortKey = $state<SortKey>('date');
  let sortDir = $state<SortDir>('desc');
  let groupBy = $state<GroupBy>('source');

  let expandedGroups = new SvelteSet<string>();
  let expandedItems = new SvelteSet<string>();
  let selected = new SvelteSet<string>();

  // A single project applied to every bulk-promoted item; the sentinel keeps
  // each row's own suggestion, an explicit slug (or none) overrides all.
  const KEEP = '__keep__';
  let bulkProject = $state(KEEP);
  // Per-item project overrides, keyed by path; absent ⇒ use the suggestion.
  let itemProjects = $state<Record<string, string>>({});
  // Per-item date overrides, keyed by path; absent ⇒ '' (use the row's own date).
  let itemDates = $state<Record<string, string>>({});
  // Optional free-text steer appended to the LLM triage rubric.
  let llmInstructions = $state('');
  // Running tally of this session's promotes/rejects (the session summary strip).
  let promotedCount = $state(0);
  let rejectedCount = $state(0);

  const ctx: InboxContext = {
    projectTitle: (slug) => app.projects.find((p) => p.slug === slug)?.entry.frontmatter.title ?? slug
  };

  // The derived pipeline: filter → sort → group, all over the in-memory inbox.
  const filterOpts = $derived({ search, selTypes, selSources, filterProject, frivolousMode });
  const filtered = $derived(filterCandidates(app.candidates, filterOpts, ctx));
  const sorted = $derived(sortCandidates(filtered, sortKey, sortDir));
  const groups = $derived(computeGroups(sorted, groupBy, ctx));
  const filtersActive = $derived(hasActiveFilters(filterOpts));

  const total = $derived(app.candidates.length);
  const flaggedVisible = $derived(filtered.filter(isFrivolous).length);
  const keptVisible = $derived(filtered.length - flaggedVisible);

  // Chip facets + counts over the *whole* inbox (which types/sources are present).
  const typeCounts = $derived.by(() => {
    const m: Record<string, number> = {};
    for (const c of app.candidates) m[typeOf(c)] = (m[typeOf(c)] ?? 0) + 1;
    return m;
  });
  const typesPresent = $derived(ENTRY_TYPES.filter((t) => typeCounts[t]));
  const sourceCounts = $derived.by(() => {
    const m: Record<string, number> = {};
    for (const c of app.candidates) {
      const s = sourceOf(c);
      if (s) m[s] = (m[s] ?? 0) + 1;
    }
    return m;
  });
  const sourcesPresent = $derived(Object.keys(sourceCounts).sort((a, b) => sourceMeta(a).label.localeCompare(sourceMeta(b).label)));
  const projectCounts = $derived.by(() => {
    const m: Record<string, number> = {};
    for (const c of app.candidates) {
      const p = projectOf(c);
      if (p) m[p] = (m[p] ?? 0) + 1;
    }
    return m;
  });
  const projectsWithCandidates = $derived(app.projects.filter((p) => projectCounts[p.slug]));
  const hasUnaffiliated = $derived(app.candidates.some((c) => !projectOf(c)));

  // Selection is over the currently visible (filtered) candidates.
  const visiblePaths = $derived(filtered.map((c) => c.path!).filter(Boolean));
  const selectedCount = $derived(selected.size);
  const allVisibleSelected = $derived(
    visiblePaths.length > 0 && visiblePaths.every((p) => selected.has(p))
  );
  const someVisibleSelected = $derived(visiblePaths.some((p) => selected.has(p)) && !allVisibleSelected);

  const byPath = $derived(new Map(app.candidates.map((c) => [c.path, c])));

  function getProject(c: Entry): string {
    const path = c.path ?? '';
    if (path in itemProjects) return itemProjects[path];
    return typeof c.frontmatter.project === 'string' ? c.frontmatter.project : '';
  }
  function setItemProject(path: string, slug: string) {
    itemProjects = { ...itemProjects, [path]: slug };
  }

  // Per-item date overrides, keyed by path; absent ⇒ '' (use the row's own date).
  // Mirrors itemProjects (allow-undated spec §E.3).
  function getDate(c: Entry): string {
    const path = c.path ?? '';
    return path in itemDates ? itemDates[path] : '';
  }
  function setItemDate(path: string, date: string) {
    itemDates = { ...itemDates, [path]: date };
  }

  // --- Parent assist (story-import spec §7) ----------------------------------
  // When an expanded github candidate carries a Shortcut story id that matches
  // a promoted story entry, its ULID is PREFILLED as the promote parent —
  // visibly labeled, clearable, never auto-applied without the human promote.
  let itemParents = $state<Record<string, string>>({});
  // Human label for the prefill ("sc-57886"); present only while a suggestion
  // stands, so clearing it hides the strip.
  let parentHints = $state<Record<string, string>>({});
  const parentLookedUp = new Set<string>();
  function getParent(c: Entry): string {
    const path = c.path ?? '';
    return path in itemParents ? itemParents[path] : '';
  }
  function clearItemParent(path: string) {
    itemParents = { ...itemParents, [path]: '' };
    parentHints = { ...parentHints, [path]: '' };
  }
  async function loadParentSuggestion(path: string) {
    if (parentLookedUp.has(path)) return;
    parentLookedUp.add(path);
    const c = byPath.get(path);
    if (!c) return;
    const ulid = await app.suggestShortcutParent(c);
    if (!ulid) return;
    const sc = c.frontmatter.shortcut;
    const scId =
      sc && typeof sc === 'object' && !Array.isArray(sc)
        ? String((sc as Record<string, unknown>).id ?? '')
        : '';
    itemParents = { ...itemParents, [path]: ulid };
    parentHints = { ...parentHints, [path]: `sc-${scId}` };
  }

  // --- Group expansion -------------------------------------------------------
  // Seed the first ~6 groups open on first paint and whenever the grouping key
  // changes (re-grouping invalidates the old keys entirely).
  let inited = false;
  function expandFirst(n: number) {
    expandedGroups.clear();
    for (const g of groups.slice(0, n)) expandedGroups.add(g.key);
  }
  $effect(() => {
    if (!inited && groups.length) {
      expandFirst(6);
      inited = true;
    }
  });
  function onGroupByChange() {
    expandFirst(6);
  }
  function toggleGroup(key: string) {
    expandedGroups.has(key) ? expandedGroups.delete(key) : expandedGroups.add(key);
  }
  function toggleItem(path: string) {
    if (expandedItems.has(path)) {
      expandedItems.delete(path);
    } else {
      expandedItems.add(path);
      void loadParentSuggestion(path);
    }
  }
  function expandAll() {
    for (const g of groups) expandedGroups.add(g.key);
  }
  function collapseAll() {
    expandedGroups.clear();
  }

  // --- Filter controls -------------------------------------------------------
  function toggleType(t: string) {
    selTypes = selTypes.includes(t) ? selTypes.filter((x) => x !== t) : [...selTypes, t];
  }
  function toggleSource(s: string) {
    selSources = selSources.includes(s) ? selSources.filter((x) => x !== s) : [...selSources, s];
  }
  function setSort(key: SortKey) {
    if (key === sortKey) return;
    sortKey = key;
    sortDir = defaultDir(key);
  }
  function clearFilters() {
    search = '';
    selTypes = [];
    selSources = [];
    filterProject = '';
    frivolousMode = 'all';
  }

  // --- Selection -------------------------------------------------------------
  function toggleSelect(path: string, checked: boolean) {
    checked ? selected.add(path) : selected.delete(path);
  }
  function clearSelection() {
    selected.clear();
  }
  function toggleSelectAll() {
    if (allVisibleSelected) for (const p of visiblePaths) selected.delete(p);
    else for (const p of visiblePaths) selected.add(p);
  }

  // --- Promote / reject (single + bulk), routed through project resolution ---
  // The project-resolution flow below is carried over unchanged from the prior
  // inbox: promoting an item whose slug isn't a project yet walks the distinct
  // missing slugs one at a time (create / file-under / promote-anyway).
  type PromoteItem = { path: string; project: string; date?: string; parent?: string };
  let promoteItems = $state<PromoteItem[] | null>(null);
  let unresolved = $state<string[]>([]);
  let resolveTotal = $state(0);
  let resolutions = new Map<string, string>();
  let newProjectName = $state('');
  let existingProject = $state('');
  const currentSlug = $derived(unresolved[0] ?? null);

  async function beginPromote(items: PromoteItem[]) {
    if (items.length === 0) return;
    const distinct = [...new Set(items.map((i) => i.project.trim()).filter(Boolean))];
    const missing = distinct.filter((slug) => !app.projects.some((p) => p.slug === slug));
    if (missing.length === 0) {
      promotedCount += await app.promoteCandidates(items);
      return;
    }
    promoteItems = items;
    resolutions = new Map();
    unresolved = missing;
    resolveTotal = missing.length;
    primeDialog();
  }
  function primeDialog() {
    newProjectName = currentSlug ? humanizeSlug(currentSlug) : '';
    existingProject = '';
  }
  function humanizeSlug(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const previewSlug = $derived(slugify(newProjectName));
  const affectedOthers = $derived(
    currentSlug
      ? app.candidates.filter(
          (c) => c.frontmatter.project === currentSlug && !promoteItems?.some((i) => i.path === c.path)
        ).length
      : 0
  );
  function advance() {
    unresolved = unresolved.slice(1);
    if (unresolved.length === 0) void finalize();
    else primeDialog();
  }
  async function finalize() {
    const items = promoteItems!.map((i) => ({
      path: i.path,
      project: resolutions.get(i.project.trim()) ?? i.project,
      date: i.date,
      parent: i.parent
    }));
    reset();
    clearSelection();
    promotedCount += await app.promoteCandidates(items);
  }
  function reset() {
    promoteItems = null;
    unresolved = [];
    resolveTotal = 0;
    resolutions = new Map();
  }
  async function resolveCreate() {
    if (!currentSlug || !newProjectName.trim()) return;
    const newSlug = await app.createProjectFromCandidate(newProjectName, currentSlug);
    resolutions.set(currentSlug, newSlug || currentSlug);
    advance();
  }
  function resolveExisting() {
    if (!currentSlug || !existingProject) return;
    resolutions.set(currentSlug, existingProject);
    advance();
  }
  function resolveSkip() {
    if (!currentSlug) return;
    resolutions.set(currentSlug, currentSlug);
    advance();
  }
  function cancelPromote() {
    reset();
    clearSelection();
  }
  function focusOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  async function promote(path: string, project: string, date?: string, parent?: string) {
    await beginPromote([{ path, project: project.trim(), date, parent: parent || undefined }]);
  }
  async function reject(path: string, title: string) {
    if (confirm(`Reject “${title}”? It won't be proposed again.`)) {
      await app.rejectCandidate(path, title);
      rejectedCount += 1;
    }
  }
  async function promoteSelected() {
    const items = [...selected]
      .map((path) => byPath.get(path))
      .filter((c): c is Entry => !!c)
      .map((c) => ({
        path: c.path!,
        project: bulkProject === KEEP ? getProject(c) : bulkProject === '' ? '' : bulkProject,
        date: getDate(c) || undefined,
        parent: getParent(c) || undefined
      }));
    if (items.length === 0) return;
    clearSelection();
    await beginPromote(items);
  }
  async function rejectSelected() {
    const paths = [...selected].filter((p) => byPath.has(p));
    if (paths.length === 0) return;
    if (!confirm(`Reject ${paths.length} item(s)? They won't be proposed again.`)) return;
    clearSelection();
    rejectedCount += await app.rejectCandidates(paths);
  }

  async function undoSession() {
    promotedCount = 0;
    rejectedCount = 0;
    await app.loadCandidates();
  }

  const labelCls = 'text-[11px] uppercase tracking-[0.04em] text-[var(--jv-date)]';
  const ghostBtn =
    'h-8 rounded-lg border border-[var(--color-line)] bg-white px-[9px] text-[12px] text-[var(--color-muted)] dark:bg-[var(--color-bar)] disabled:opacity-50';
</script>

<svelte:window
  onkeydown={(e) => {
    if (currentSlug && e.key === 'Escape') cancelPromote();
  }}
/>

<div class="flex flex-col">
  <!-- 1. Page header -->
  <div class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-[25px] font-[650] tracking-[-0.015em] text-[var(--color-ink)]">Inbox</h1>
      <p class="mt-1.5 max-w-[580px] text-[13px] leading-[1.5] text-[var(--color-muted)]">
        {#if total === 0}
          Inbox clear — nothing staged for review.
        {:else if !filtersActive}
          {total} candidate{total === 1 ? '' : 's'} staged for review{#if flaggedVisible}
            &nbsp;·&nbsp; {keptVisible} kept · {flaggedVisible} flagged frivolous{/if}
        {:else}
          {filtered.length} of {total} candidate{total === 1 ? '' : 's'} staged for review{#if flaggedVisible}
            &nbsp;·&nbsp; {keptVisible} kept · {flaggedVisible} flagged frivolous{/if}
        {/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      {#if app.llmReady}
        <input
          type="text"
          bind:value={llmInstructions}
          placeholder="Extra LLM instructions…"
          title="Free-text guidance the LLM also weighs when judging what's frivolous"
          disabled={app.busy}
          class="h-9 w-52 rounded-[9px] border border-[var(--color-line)] bg-white px-2.5 text-[12.5px] text-[var(--color-ink)] disabled:opacity-50 dark:bg-[var(--color-bar)]"
        />
      {/if}
      {#if app.tokenPresent.shortcut}
        <button
          onclick={() => void app.enrichInboxFromShortcut()}
          disabled={app.busy}
          title="Backfill Shortcut story metadata onto candidates that reference a ticket (sc-…) — one fetch per distinct ticket, annotation only"
          class="inline-flex h-9 items-center gap-1.5 rounded-[9px] border border-[var(--color-line)] bg-white px-3 text-[12.5px] font-medium text-[var(--color-muted)] disabled:opacity-50 dark:bg-[var(--color-bar)]"
        >
          <Icon name="bolt" size={15} /> Enrich from Shortcut
        </button>
      {/if}
      <button
        onclick={() => void app.retriageInbox()}
        disabled={app.busy}
        title="Re-run the triage prefilter over the inbox with the current rules"
        class="inline-flex h-9 items-center gap-1.5 rounded-[9px] border border-[var(--color-line)] bg-white px-3 text-[12.5px] font-medium text-[var(--color-muted)] disabled:opacity-50 dark:bg-[var(--color-bar)]"
      >
        <Icon name="filter_alt" size={15} /> Re-triage
      </button>
      <button
        onclick={() => void app.llmTriageInbox(llmInstructions)}
        disabled={app.busy || !app.llmReady}
        title={app.llmReady
          ? 'Send the kept items through the LLM to flag frivolous ones the rules miss'
          : 'Configure an AI provider (Data → AI provider) to enable LLM triage'}
        class="inline-flex h-9 items-center gap-1.5 rounded-[9px] border border-[var(--imp-feed-border)] bg-[var(--imp-feed-from)] px-3 text-[12.5px] font-semibold text-[var(--color-accent)] disabled:opacity-50"
      >
        <Icon name="auto_awesome" size={15} /> LLM triage
      </button>
    </div>
  </div>

  {#if total === 0}
    <p class="py-[54px] text-center text-[13px] text-[var(--jv-date)]">
      Inbox clear. Run a data-source import to stage new candidates.
    </p>
  {:else}
    <!-- 2. Filter / sort toolbar -->
    <div
      class="mt-[18px] flex flex-col gap-[11px] rounded-[14px] border border-[var(--color-line)] bg-white dark:bg-[var(--color-bar)]"
      style="padding:13px 15px;"
    >
      <!-- Row A — search · sort · status -->
      <div class="flex flex-wrap items-center gap-[9px]">
        <div class="relative min-w-[230px] flex-1">
          <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] leading-none text-[var(--jv-date)]">⌕</span>
          <input
            bind:value={search}
            placeholder="Filter the inbox — title, body, source…"
            class="h-[34px] w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] py-0 pl-7 pr-2.5 text-[13px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)] focus:bg-white dark:focus:bg-[var(--color-bar)]"
          />
        </div>
        <div class="flex items-center gap-1.5">
          <span class={labelCls}>Sort</span>
          <select
            value={sortKey}
            onchange={(e) => setSort(e.currentTarget.value as SortKey)}
            class="h-[34px] rounded-lg border border-[var(--color-line)] bg-white px-2.5 text-[13px] text-[var(--color-ink)] dark:bg-[var(--color-bar)]"
          >
            <option value="date">Date</option>
            <option value="title">Title</option>
            <option value="type">Type</option>
            <option value="source">Source</option>
            <option value="project">Project</option>
            <option value="size">Change size</option>
          </select>
          <button
            onclick={() => (sortDir = sortDir === 'asc' ? 'desc' : 'asc')}
            title="Toggle sort direction"
            aria-label="Toggle sort direction"
            class="size-[34px] rounded-lg border border-[var(--color-line)] bg-white text-[13px] text-[var(--color-muted)] dark:bg-[var(--color-bar)]"
            >{sortDir === 'asc' ? '↑' : '↓'}</button
          >
        </div>
        <div
          class="inline-flex items-center gap-0.5 rounded-[9px] border border-[var(--color-line)] bg-[var(--color-paper)] p-[3px]"
        >
          {#each [['all', 'All'], ['kept', 'Kept'], ['flagged', 'Flagged']] as [mode, label] (mode)}
            {@const sel = frivolousMode === mode}
            <button
              onclick={() => (frivolousMode = mode as FrivolousMode)}
              class="rounded-[7px] px-3 py-1.5 text-[12.5px] transition-all duration-100"
              style={sel
                ? `background:white;box-shadow:0 1px 2px rgba(0,0,0,0.06);font-weight:600;color:${mode === 'flagged' ? '#b07a00' : 'var(--color-ink)'};`
                : 'background:transparent;color:#8a8a86;'}
            >
              {label}
            </button>
          {/each}
        </div>
      </div>

      <!-- Row B — type chips -->
      {#if typesPresent.length}
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="{labelCls} w-[50px]">Type</span>
          {#each typesPresent as t (t)}
            {@const m = typeMeta(t)}
            {@const sel = selTypes.includes(t)}
            <button
              onclick={() => toggleType(t)}
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-all duration-100"
              style={sel
                ? `background:${alpha(m.color, 12)};border:1px solid ${alpha(m.color, 40)};color:${m.color};`
                : 'background:white;border:1px solid var(--color-line);color:var(--color-muted);'}
            >
              <span class="size-2 rounded-[2px]" style="background:{m.color}"></span>
              {m.label}
              <span class="tabular-nums opacity-60">{typeCounts[t]}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Row C — source chips -->
      {#if sourcesPresent.length}
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="{labelCls} w-[50px]">Source</span>
          {#each sourcesPresent as s (s)}
            {@const m = sourceMeta(s)}
            {@const sel = selSources.includes(s)}
            <button
              onclick={() => toggleSource(s)}
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-all duration-100"
              style={sel
                ? `background:${alpha(m.color, 8)};border:1px solid ${alpha(m.color, 33)};color:${m.color};`
                : 'background:white;border:1px solid var(--color-line);color:var(--color-muted);'}
            >
              <span style="color:{sel ? m.color : '#9a9a96'}"><Icon name={m.glyph} size={15} /></span>
              {m.label}
              <span class="tabular-nums opacity-60">{sourceCounts[s]}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Row D — project · group by · expand · select-all · clear -->
      <div class="flex flex-wrap items-center gap-[9px] border-t border-[var(--jv-hair)] pt-[11px]">
        <select
          bind:value={filterProject}
          class="h-8 max-w-[230px] rounded-lg border border-[var(--color-line)] bg-white px-2.5 text-[13px] text-[var(--color-ink)] dark:bg-[var(--color-bar)]"
        >
          <option value="">All projects</option>
          {#if hasUnaffiliated}<option value="__none">Unaffiliated</option>{/if}
          {#each projectsWithCandidates as p (p.slug)}
            <option value={p.slug}>{p.entry.frontmatter.title} ({projectCounts[p.slug]})</option>
          {/each}
        </select>

        <div class="flex items-center gap-1.5">
          <span class={labelCls}>Group by</span>
          <select
            value={groupBy}
            onchange={(e) => {
              groupBy = e.currentTarget.value as GroupBy;
              onGroupByChange();
            }}
            class="h-8 rounded-lg border border-[var(--color-line)] bg-white px-2.5 text-[13px] text-[var(--color-ink)] dark:bg-[var(--color-bar)]"
          >
            <option value="source">Source</option>
            <option value="type">Type</option>
            <option value="project">Project</option>
            <option value="status">Status</option>
            <option value="none">Flat list</option>
          </select>
        </div>

        {#if groupBy !== 'none'}
          <button onclick={expandAll} class={ghostBtn}>Expand all</button>
          <button onclick={collapseAll} class={ghostBtn}>Collapse all</button>
        {/if}

        <button
          onclick={toggleSelectAll}
          disabled={visiblePaths.length === 0}
          class="inline-flex h-8 items-center gap-2 rounded-lg border border-[var(--color-line)] bg-white px-[9px] text-[12px] text-[var(--color-muted)] disabled:opacity-50 dark:bg-[var(--color-bar)]"
        >
          <span
            class="grid size-4 place-items-center rounded-[5px]"
            style={allVisibleSelected
              ? 'background:var(--color-accent);border:1px solid var(--color-accent);'
              : someVisibleSelected
                ? `background:${alpha('var(--color-accent)', 20)};border:1.5px solid var(--color-accent);`
                : 'background:white;border:1.5px solid var(--color-edge);'}
          >
            {#if allVisibleSelected}
              <span class="text-white"><Icon name="check" size={12} strokeWidth={3} /></span>
            {/if}
          </span>
          {allVisibleSelected ? 'Deselect all' : 'Select all'}
        </button>

        {#if filtersActive}
          <button onclick={clearFilters} class="ml-auto bg-transparent text-[12px] text-[var(--color-private)]"
            >Clear filters</button
          >
        {/if}
      </div>
    </div>

    <!-- 3. Bulk action bar (sticky, when ≥1 selected) -->
    {#if selectedCount > 0}
      <div
        class="sticky top-2 z-[5] mt-3 flex flex-wrap items-center gap-[9px] rounded-[12px] px-3.5 py-2.5 backdrop-blur"
        style="border:1px solid #c8d2f3;background:rgba(244,247,255,0.92);box-shadow:0 6px 20px rgba(40,50,90,0.1)"
      >
        <span class="text-[13px] font-[650] text-[#2a3a7a]">{selectedCount} selected</span>
        <button onclick={clearSelection} class="text-[12px] text-[#7a86b8]">Clear</button>
        <div class="ml-auto flex flex-wrap items-center gap-[9px]">
          <span class="text-[11px] uppercase tracking-[0.04em] text-[#7a86b8]">Project</span>
          <select
            bind:value={bulkProject}
            class="h-8 rounded-lg border border-[var(--color-line)] bg-white px-2 text-[13px] text-[var(--color-ink)] dark:bg-[var(--color-bar)]"
          >
            <option value={KEEP}>— keep each suggestion —</option>
            <option value="">— none —</option>
            {#each app.projects as p (p.slug)}
              <option value={p.slug}>{p.entry.frontmatter.title}</option>
            {/each}
          </select>
          <button
            onclick={() => void rejectSelected()}
            disabled={app.busy}
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-white px-3 text-[12px] font-semibold text-[var(--color-private)] disabled:opacity-50"
            style="border-color:#ecc9b9"
          >
            <Icon name="close" size={14} /> Reject {selectedCount}
          </button>
          <button
            onclick={() => void promoteSelected()}
            disabled={app.busy}
            class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <Icon name="check" size={14} strokeWidth={3} /> Promote {selectedCount}
          </button>
        </div>
      </div>
    {/if}

    <!-- 4. Grouped collapsible item list -->
    {#if filtered.length === 0}
      <p class="py-[54px] text-center text-[13px] text-[var(--jv-date)]">
        No candidates match these filters.
      </p>
    {:else}
      <div class="mt-3.5 flex flex-col gap-[9px]">
        {#each groups as g (g.key)}
          {@const open = groupBy === 'none' || expandedGroups.has(g.key)}
          <div class="overflow-hidden rounded-[14px] border border-[var(--color-line)] bg-white dark:bg-[var(--color-bar)]">
            {#if groupBy !== 'none' && g.swatch}
              <button
                onclick={() => toggleGroup(g.key)}
                class="flex w-full items-center gap-[11px] border-none bg-transparent px-4 py-3 text-left"
              >
                <span
                  class="jv-chevron shrink-0 text-[20px] text-[var(--jv-chevron)] transition-transform duration-150 ease-out"
                  style="transform:rotate({open ? 90 : 0}deg)">›</span
                >
                {#if g.swatch.variant === 'tile'}
                  <span
                    class="grid size-[22px] shrink-0 place-items-center rounded-[7px]"
                    style="background:{alpha(g.swatch.color, 8)};color:{g.swatch.color}"
                  >
                    <Icon name={g.swatch.glyph ?? 'edit_note'} size={15} />
                  </span>
                {:else}
                  <span class="size-[11px] shrink-0 rounded-[3px]" style="background:{g.swatch.color}"></span>
                {/if}
                <span class="text-[14px] font-semibold text-[var(--color-ink)]">{g.label}</span>
                <span class="text-[12px] text-[var(--jv-date)]"
                  >{g.kept} kept{#if g.flagged} · {g.flagged} flagged{/if}</span
                >
                <span
                  class="ml-auto rounded-full bg-[var(--jv-chip-bg)] px-[9px] py-0.5 text-[12px] font-semibold tabular-nums text-[var(--color-muted)]"
                  >{g.candidates.length}</span
                >
              </button>
            {/if}
            {#if open}
              <div class:border-t={groupBy !== 'none'} class="border-[var(--jv-hair)]">
                {#each g.candidates as c (c.path)}
                  <div class="border-t border-[var(--jv-hair-soft)] first:border-t-0">
                    <CandidateRow
                      candidate={c}
                      projects={app.projects}
                      busy={app.busy}
                      selected={selected.has(c.path ?? '')}
                      expanded={expandedItems.has(c.path ?? '')}
                      project={getProject(c)}
                      date={getDate(c)}
                      parent={getParent(c)}
                      parentHint={parentHints[c.path ?? ''] ?? ''}
                      onselect={toggleSelect}
                      ontoggle={() => toggleItem(c.path ?? '')}
                      onprojectchange={setItemProject}
                      ondatechange={setItemDate}
                      onparentclear={clearItemParent}
                      onpromote={(p, proj, d, par) => void promote(p, proj, d, par)}
                      onreject={(p, t) => void reject(p, t)}
                    />
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- 6. Session summary -->
    {#if promotedCount > 0 || rejectedCount > 0}
      <div
        class="mt-3.5 flex items-center gap-3 rounded-[11px] border border-dashed border-[var(--color-edge)] bg-[var(--color-paper)] px-3.5 py-[11px]"
      >
        <span style="color:{KEPT_COLOR}"><Icon name="task_alt" size={18} /></span>
        <span class="text-[13px] text-[var(--color-muted)]"
          >{promotedCount} promoted · {rejectedCount} rejected this session</span
        >
        <button
          onclick={() => void undoSession()}
          class="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-white px-2.5 py-1 text-[12px] text-[var(--color-muted)] dark:bg-[var(--color-bar)]"
        >
          <Icon name="undo" size={14} /> Undo all
        </button>
      </div>
    {/if}
  {/if}
</div>

<!-- Project resolution dialog (carried over unchanged) -->
{#if currentSlug}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div
      class="w-full max-w-md space-y-3 rounded-lg border border-[var(--color-line)] bg-white p-5 shadow-lg dark:bg-[#1e1f24]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
    >
      <div class="flex items-baseline justify-between gap-2">
        <h2 id="new-project-title" class="text-base font-semibold">New project?</h2>
        {#if resolveTotal > 1}
          <span class="text-xs text-[var(--color-muted)]">
            Project {resolveTotal - unresolved.length + 1} of {resolveTotal}
          </span>
        {/if}
      </div>
      <p class="text-sm text-[var(--color-muted)]">
        Filed under
        <code class="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-white/10">{currentSlug}</code>, which
        isn't a project yet. Create it now — you can rename it — or promote without creating one.
      </p>

      <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
        Project name
        <input
          bind:value={newProjectName}
          use:focusOnMount
          placeholder="Project name"
          class="mt-1 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
          onkeydown={(e) => {
            if (e.key === 'Enter') void resolveCreate();
          }}
        />
      </label>

      {#if app.projects.length}
        <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
          …or file under an existing project
          <select
            bind:value={existingProject}
            class="mt-1 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
          >
            <option value="">— choose a project —</option>
            {#each app.projects as p (p.slug)}
              <option value={p.slug}>{p.entry.frontmatter.title}</option>
            {/each}
          </select>
        </label>
      {/if}

      <p class="text-xs text-[var(--color-muted)]">
        {#if previewSlug}
          Slug: <code class="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/10">{previewSlug}</code>
        {:else}
          Enter a name to create the project.
        {/if}
        {#if affectedOthers}
          · {affectedOthers} other inbox item{affectedOthers === 1 ? '' : 's'} on
          <code class="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/10">{currentSlug}</code> will move to it.
        {/if}
      </p>

      <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button
          class="mr-auto rounded px-2.5 py-1.5 text-sm text-[var(--color-muted)] hover:bg-gray-100 dark:hover:bg-white/10"
          onclick={cancelPromote}
        >
          Cancel
        </button>
        <button
          class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:hover:bg-white/5"
          disabled={app.busy}
          onclick={() => void resolveSkip()}
        >
          Promote anyway
        </button>
        {#if existingProject}
          <button
            class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={app.busy}
            onclick={() => void resolveExisting()}
          >
            Promote to project
          </button>
        {:else}
          <button
            class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={app.busy || !newProjectName.trim()}
            onclick={() => void resolveCreate()}
          >
            Create &amp; promote
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
