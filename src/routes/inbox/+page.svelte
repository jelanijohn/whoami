<script lang="ts">
  import { slugify, type Entry } from '$lib/core';
  import { app } from '$lib/state.svelte';
  import CandidateCard from '$lib/components/CandidateCard.svelte';

  // Load the staged candidates whenever a record is open.
  $effect(() => {
    if (app.store) app.loadCandidates();
  });

  // A simple, local text filter over the staged candidates — title + body,
  // case-insensitive. The inbox is fully loaded in memory, so this is a pure
  // client-side narrow (no re-query, unlike the Journal's server-side search).
  let filterText = $state('');
  function matchesFilter(c: Entry): boolean {
    const q = filterText.trim().toLowerCase();
    if (!q) return true;
    return (
      c.frontmatter.title.toLowerCase().includes(q) || c.body.toLowerCase().includes(q)
    );
  }
  const visible = $derived(app.candidates.filter(matchesFilter));

  // Triage (spec §6): a `frivolous` signal collapses an item into a disclosure;
  // it is never removed. Absence ⇒ untriaged ⇒ treated as keep.
  const isFrivolous = (c: Entry) => c.frontmatter.triage_signal === 'frivolous';
  const kept = $derived(visible.filter((c) => !isFrivolous(c)));
  const frivolous = $derived(visible.filter(isFrivolous));

  // --- Multi-select (bulk promote/reject) ---------------------------------
  // Selection is keyed by candidate path — the same stable key the lists use.
  // Reassign the Set on every change so the runes graph re-runs.
  let selectedPaths = $state(new Set<string>());
  // A single project applied to every promoted item. The sentinel keeps each
  // card's own suggested affiliation; an explicit slug (or none) overrides all.
  const KEEP = '__keep__';
  let bulkProject = $state(KEEP);

  // An optional free-text steer the owner can add to the LLM triage run — appended
  // to the rubric as extra instructions for judging what counts as frivolous.
  let llmInstructions = $state('');

  const selectedCount = $derived(selectedPaths.size);
  const isSelected = (c: Entry) => !!c.path && selectedPaths.has(c.path);
  const allKeptSelected = $derived(kept.length > 0 && kept.every(isSelected));
  const someKeptSelected = $derived(kept.some(isSelected) && !allKeptSelected);

  function toggleSelect(path: string, checked: boolean) {
    const next = new Set(selectedPaths);
    if (checked) next.add(path);
    else next.delete(path);
    selectedPaths = next;
  }
  function clearSelection() {
    selectedPaths = new Set();
  }
  function toggleSelectAllKept() {
    const next = new Set(selectedPaths);
    if (allKeptSelected) for (const c of kept) next.delete(c.path!);
    else for (const c of kept) next.add(c.path!);
    selectedPaths = next;
  }

  // Promoting items whose assigned project doesn't exist yet pauses to resolve
  // each missing project before the entries land — create it (with an editable
  // name), file under an existing project, or promote as-is (the slug rides
  // along as a pass-through, the prior behaviour). Single and bulk promote share
  // this one resolver: it walks the *distinct* missing slugs (resolving once per
  // slug, not per item), and creating a project also relabels every other inbox
  // item on that slug, so the rest of the inbox follows the chosen name in one
  // pass. `resolutions` maps each old slug to the slug the items finally land on.
  type PromoteItem = { path: string; project: string };
  let promoteItems = $state<PromoteItem[] | null>(null); // full set awaiting promotion
  let unresolved = $state<string[]>([]); // distinct missing slugs, FIFO
  let resolveTotal = $state(0); // count for the "X of Y" progress hint
  let resolutions = new Map<string, string>(); // oldSlug -> final slug
  let newProjectName = $state('');
  // A slug chosen from the dialog's existing-projects picker. When set, the
  // items on the current slug are filed under it instead of creating a project.
  let existingProject = $state('');
  const currentSlug = $derived(unresolved[0] ?? null);

  /** Resolve every missing project among `items`, then promote them. Items whose
   * project already exists (or is none) need no prompt. */
  async function beginPromote(items: PromoteItem[]) {
    if (items.length === 0) return;
    const distinct = [...new Set(items.map((i) => i.project.trim()).filter(Boolean))];
    const missing = distinct.filter((slug) => !app.projects.some((p) => p.slug === slug));
    if (missing.length === 0) {
      await app.promoteCandidates(items);
      return;
    }
    promoteItems = items;
    resolutions = new Map();
    unresolved = missing;
    resolveTotal = missing.length;
    primeDialog();
  }

  /** Seed the dialog fields for whichever slug is now at the head of the queue. */
  function primeDialog() {
    newProjectName = currentSlug ? humanizeSlug(currentSlug) : '';
    existingProject = '';
  }

  async function promote(path: string, project: string) {
    await beginPromote([{ path, project: project.trim() }]);
  }

  /** A friendly default project name from a kebab/snake-case slug. */
  function humanizeSlug(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // The slug the typed name will actually produce, plus how many *other* staged
  // items (not in this batch) ride the current slug — they'll move to the new
  // project too when it's created.
  const previewSlug = $derived(slugify(newProjectName));
  const affectedOthers = $derived(
    currentSlug
      ? app.candidates.filter(
          (c) =>
            c.frontmatter.project === currentSlug &&
            !promoteItems?.some((i) => i.path === c.path)
        ).length
      : 0
  );

  /** Advance the queue; finalize once every missing slug has a decision. */
  function advance() {
    unresolved = unresolved.slice(1);
    if (unresolved.length === 0) void finalize();
    else primeDialog();
  }

  /** Promote the whole batch, mapping each item's slug through `resolutions`. */
  async function finalize() {
    const items = promoteItems!.map((i) => ({
      path: i.path,
      project: resolutions.get(i.project.trim()) ?? i.project
    }));
    reset();
    clearSelection();
    await app.promoteCandidates(items);
  }

  function reset() {
    promoteItems = null;
    unresolved = [];
    resolveTotal = 0;
    resolutions = new Map();
  }

  async function resolveCreate() {
    if (!currentSlug || !newProjectName.trim()) return; // Create is disabled when empty; guard anyway
    const newSlug = await app.createProjectFromCandidate(newProjectName, currentSlug);
    resolutions.set(currentSlug, newSlug || currentSlug);
    advance();
  }

  function resolveExisting() {
    if (!currentSlug || !existingProject) return;
    resolutions.set(currentSlug, existingProject); // file under the chosen project; create nothing
    advance();
  }

  function resolveSkip() {
    if (!currentSlug) return;
    resolutions.set(currentSlug, currentSlug); // promote as-is — slug stays a pass-through
    advance();
  }

  function cancelPromote() {
    reset(); // abort the whole batch: nothing promoted, nothing created
    clearSelection();
  }

  /** Focus + select the name field when the dialog opens. */
  function focusOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function reject(path: string, title: string) {
    if (confirm(`Reject “${title}”? It won't be proposed again.`)) {
      void app.rejectCandidate(path, title);
    }
  }

  async function promoteSelected() {
    const items = app.candidates.filter(isSelected).map((c) => ({
      path: c.path!,
      project:
        bulkProject === KEEP
          ? typeof c.frontmatter.project === 'string'
            ? c.frontmatter.project
            : ''
          : bulkProject
    }));
    if (items.length === 0) return;
    // Clear the selection up front: the items are already captured, and the
    // bulk info bar shouldn't linger whether promotion finishes immediately or
    // detours through the project-resolution dialog (finalize/cancel also clear).
    clearSelection();
    await beginPromote(items);
  }
  async function rejectSelected() {
    const paths = app.candidates.filter(isSelected).map((c) => c.path!);
    if (paths.length === 0) return;
    if (!confirm(`Reject ${paths.length} item(s)? They won't be proposed again.`)) return;
    clearSelection();
    await app.rejectCandidates(paths);
  }
  async function rejectAllFrivolous() {
    if (!confirm(`Reject all ${frivolous.length} item(s) flagged as frivolous? They won't be proposed again.`)) {
      return;
    }
    // A human click, never automatic — one confirmation, one batched pass.
    await app.rejectCandidates(frivolous.map((c) => c.path!));
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (currentSlug && e.key === 'Escape') cancelPromote();
  }}
/>

<div class="space-y-4">
  <section>
    <h1 class="text-lg font-semibold">Ingest inbox</h1>
    <p class="mt-1 text-sm text-[var(--color-muted)]">
      Candidates fetched from your data sources, staged for review. Nothing here is part of your
      record yet — promote to add it (assigning a project), or reject to dismiss it for good. Raw,
      verbatim, private by default.
    </p>
  </section>

  {#if app.candidates.length === 0}
    <p class="py-12 text-center text-sm text-[var(--color-muted)]">
      The inbox is empty. Run a data-source import to stage candidates here.
    </p>
  {:else}
    {#if selectedCount > 0}
      <div
        class="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-3 py-2 backdrop-blur"
      >
        <span class="text-sm font-medium">{selectedCount} selected</span>
        <button
          class="rounded px-2 py-0.5 text-xs text-[var(--color-muted)] hover:bg-black/5 dark:hover:bg-white/10"
          onclick={clearSelection}
        >
          Clear
        </button>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <label class="text-xs text-[var(--color-muted)]" for="bulk-project">Project</label>
          <select
            id="bulk-project"
            bind:value={bulkProject}
            class="rounded border border-[var(--color-line)] px-2 py-1 text-sm"
          >
            <option value={KEEP}>— keep each suggestion —</option>
            <option value="">— none —</option>
            {#each app.projects as p (p.slug)}
              <option value={p.slug}>{p.entry.frontmatter.title}</option>
            {/each}
          </select>
          <button
            class="rounded px-2.5 py-1 text-xs text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
            disabled={app.busy}
            onclick={() => void rejectSelected()}
          >
            Reject {selectedCount}
          </button>
          <button
            class="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={app.busy}
            onclick={() => void promoteSelected()}
          >
            Promote {selectedCount}
          </button>
        </div>
      </div>
    {/if}

    <input
      type="text"
      bind:value={filterText}
      placeholder="Filter the inbox…"
      class="w-full rounded border border-[var(--color-line)] px-3 py-1.5 text-sm"
    />

    <div class="flex flex-wrap items-center gap-3">
      {#if kept.length}
        <label class="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <input
            type="checkbox"
            class="h-4 w-4 accent-[var(--color-accent)]"
            checked={allKeptSelected}
            indeterminate={someKeptSelected}
            onchange={toggleSelectAllKept}
          />
          Select all
        </label>
      {/if}
      <p class="text-xs text-[var(--color-muted)]">
        {#if filterText.trim()}
          {visible.length} of {app.candidates.length} match{#if frivolous.length}
            · {kept.length} kept, {frivolous.length} flagged frivolous{/if}
        {:else}
          {app.candidates.length} candidate{app.candidates.length === 1 ? '' : 's'} awaiting review{#if frivolous.length}
            · {kept.length} kept, {frivolous.length} flagged frivolous{/if}
        {/if}
      </p>
      <button
        class="ml-auto rounded px-2.5 py-1 text-xs text-[var(--color-muted)] hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
        title="Re-run the triage prefilter over the inbox with the current rules"
        disabled={app.busy}
        onclick={() => void app.retriageInbox()}
      >
        Re-triage
      </button>
      <input
        type="text"
        bind:value={llmInstructions}
        placeholder="Extra LLM instructions (optional)…"
        title="Free-text guidance the LLM also weighs when judging what's frivolous, e.g. “treat recruiter outreach as frivolous”"
        disabled={app.busy || !app.llmReady}
        class="w-56 rounded border border-[var(--color-line)] px-2 py-1 text-xs disabled:opacity-50"
      />
      <button
        class="rounded px-2.5 py-1 text-xs text-[var(--color-muted)] hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
        title={app.llmReady
          ? 'Send the kept items through the LLM to flag frivolous ones the rules miss'
          : 'Configure an AI provider (Data → AI provider) to enable LLM triage'}
        disabled={app.busy || !app.llmReady}
        onclick={() => void app.llmTriageInbox(llmInstructions)}
      >
        LLM triage
      </button>
    </div>

    {#if visible.length === 0}
      <p class="py-12 text-center text-sm text-[var(--color-muted)]">
        No candidates match “{filterText.trim()}”.
      </p>
    {/if}

    <div class="space-y-3">
      {#each kept as candidate (candidate.path)}
        <CandidateCard
          {candidate}
          projects={app.projects}
          busy={app.busy}
          selected={isSelected(candidate)}
          onselect={toggleSelect}
          onpromote={promote}
          onreject={reject}
        />
      {/each}
    </div>

    {#if frivolous.length}
      <details class="rounded-lg border border-[var(--color-line)] bg-gray-50 dark:bg-white/5">
        <summary class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm text-[var(--color-muted)]">
          Show {frivolous.length} flagged as frivolous
          <button
            class="ml-auto rounded px-2 py-0.5 text-xs text-[var(--color-private)] hover:bg-[var(--color-private)]/10 disabled:opacity-50"
            disabled={app.busy}
            onclick={(e) => {
              e.preventDefault();
              void rejectAllFrivolous();
            }}
          >
            Reject all {frivolous.length}
          </button>
        </summary>
        <div class="space-y-3 p-3 pt-0">
          {#each frivolous as candidate (candidate.path)}
            <CandidateCard
              {candidate}
              projects={app.projects}
              busy={app.busy}
              selected={isSelected(candidate)}
              onselect={toggleSelect}
              onpromote={promote}
              onreject={reject}
            />
          {/each}
        </div>
      </details>
    {/if}
  {/if}
</div>

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
