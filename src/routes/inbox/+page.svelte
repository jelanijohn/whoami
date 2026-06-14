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

  // Promoting an item whose assigned project doesn't exist yet pauses to offer
  // creating it (with an editable name) before the entry lands. Declining
  // promotes as-is — the slug rides along as a pass-through, the prior
  // behaviour. Creating it also relabels every other inbox item on the old slug
  // so the rest of the inbox follows the (possibly edited) name in one pass.
  let pendingPromote = $state<{ path: string; slug: string } | null>(null);
  let newProjectName = $state('');

  async function promote(path: string, project: string) {
    const slug = project.trim();
    if (slug && !(await app.projectExists(slug))) {
      newProjectName = humanizeSlug(slug);
      pendingPromote = { path, slug };
      return;
    }
    await app.promoteCandidate(path, slug);
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
  // items currently ride the old slug (they'll move to the new project too).
  const previewSlug = $derived(slugify(newProjectName));
  const affectedOthers = $derived(
    pendingPromote
      ? app.candidates.filter(
          (c) => c.path !== pendingPromote!.path && c.frontmatter.project === pendingPromote!.slug
        ).length
      : 0
  );

  async function confirmCreateProject() {
    if (!pendingPromote) return;
    const { path, slug } = pendingPromote;
    if (!newProjectName.trim()) return; // Create is disabled when empty, but guard anyway
    pendingPromote = null;
    const newSlug = await app.createProjectFromCandidate(newProjectName, slug);
    await app.promoteCandidate(path, newSlug || slug);
  }

  async function skipCreateProject() {
    if (!pendingPromote) return;
    const { path, slug } = pendingPromote;
    pendingPromote = null;
    await app.promoteCandidate(path, slug); // continue as normal — slug stays a pass-through
  }

  function cancelPromote() {
    pendingPromote = null; // abort entirely: nothing promoted, nothing created
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
    clearSelection();
    await app.promoteCandidates(items);
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
    if (pendingPromote && e.key === 'Escape') cancelPromote();
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

{#if pendingPromote}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div
      class="w-full max-w-md space-y-3 rounded-lg border border-[var(--color-line)] bg-white p-5 shadow-lg dark:bg-[#1e1f24]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
    >
      <h2 id="new-project-title" class="text-base font-semibold">New project?</h2>
      <p class="text-sm text-[var(--color-muted)]">
        This item is filed under
        <code class="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-white/10">{pendingPromote.slug}</code>, which
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
            if (e.key === 'Enter') void confirmCreateProject();
          }}
        />
      </label>

      <p class="text-xs text-[var(--color-muted)]">
        {#if previewSlug}
          Slug: <code class="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/10">{previewSlug}</code>
        {:else}
          Enter a name to create the project.
        {/if}
        {#if affectedOthers}
          · {affectedOthers} other inbox item{affectedOthers === 1 ? '' : 's'} on
          <code class="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/10">{pendingPromote.slug}</code> will move to it.
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
          onclick={() => void skipCreateProject()}
        >
          Promote anyway
        </button>
        <button
          class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={app.busy || !newProjectName.trim()}
          onclick={() => void confirmCreateProject()}
        >
          Create &amp; promote
        </button>
      </div>
    </div>
  </div>
{/if}
