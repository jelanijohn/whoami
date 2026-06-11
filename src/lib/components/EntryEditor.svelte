<script lang="ts">
  import { app } from '$lib/state.svelte';
  import { ENTRY_TYPES, type Entry } from '$lib/core';
  import { closeDatePicker } from '$lib/actions/closeDatePicker';

  let { entry = null, ondone }: { entry?: Entry | null; ondone: () => void } = $props();

  const isNew = entry === null;
  const fm = entry?.frontmatter;
  const s = (k: string) => (fm && typeof fm[k] === 'string' ? (fm[k] as string) : '');

  // Form model.
  let type = $state(fm?.type ?? 'journal');
  let title = $state(fm?.title ?? '');
  let date = $state(fm?.date ?? new Date().toISOString().slice(0, 10));
  let isPrivate = $state(fm?.private ?? false);
  let tagsText = $state(Array.isArray(fm?.tags) ? (fm!.tags as string[]).join(', ') : '');
  let org = $state(s('org'));
  let role = $state(s('role'));
  let source = $state(s('source'));
  let sentiment = $state(s('sentiment'));
  let linksText = $state(
    Array.isArray(fm?.links) ? (fm!.links as string[]).join('\n') : s('links')
  );
  let body = $state(entry?.body ?? '');
  // Affiliation: the `slug` of the project entry this belongs to. Empty = none.
  let project = $state(s('project'));

  const showOrg = $derived(['role', 'project', 'win', 'education'].includes(type));
  const showRole = $derived(type === 'role');
  const showMention = $derived(type === 'mention');
  const showLinks = $derived(['project', 'role', 'mention', 'milestone'].includes(type));
  // A project entry carries its own `slug`; it doesn't affiliate to a project.
  const showProject = $derived(type !== 'project');

  function parseTags(text: string): string[] {
    return text
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  function parseLinks(text: string): string[] {
    return text
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  function buildExtra(): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (showOrg && org) extra.org = org;
    if (showRole && role) extra.role = role;
    if (showMention) {
      if (source) extra.source = source;
      if (sentiment) extra.sentiment = sentiment;
    }
    if (showLinks) {
      const links = parseLinks(linksText);
      if (links.length) extra.links = links;
    }
    if (showProject && project) extra.project = project;
    return extra;
  }

  async function save() {
    if (!title.trim()) {
      app.error = 'Title is required.';
      return;
    }
    const tags = parseTags(tagsText);
    const extra = buildExtra();

    if (isNew) {
      await app.createEntry({ type, title: title.trim(), date, private: isPrivate, tags, body, extra });
    } else {
      // Preserve every existing (incl. unknown) frontmatter key, override the
      // edited ones. Type-specific keys are set explicitly so clearing works.
      const next: Entry = {
        ...entry!,
        frontmatter: {
          ...entry!.frontmatter,
          type,
          date,
          title: title.trim(),
          private: isPrivate,
          tags,
          org: showOrg ? org : entry!.frontmatter.org,
          role: showRole ? role : entry!.frontmatter.role,
          ...extra
        },
        body
      };
      // `buildExtra` only ever *adds* `project`. When the picker is shown but
      // left empty, explicitly clear any prior affiliation.
      if (showProject && !project) delete next.frontmatter.project;
      await app.updateEntry(next);
    }
    if (!app.error) ondone();
  }
</script>

<div class="space-y-3 rounded-lg border border-[var(--color-line)] bg-white p-4 shadow-sm dark:bg-[#1e1f24] dark:shadow-none">
  <div class="flex flex-wrap gap-3">
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Type
      <select bind:value={type} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm text-[var(--color-ink)]">
        {#each ENTRY_TYPES as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Date
      <input type="date" bind:value={date} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" use:closeDatePicker />
    </label>
    <label class="mt-5 flex items-center gap-2 text-sm text-[var(--color-private)]">
      <input type="checkbox" bind:checked={isPrivate} />
      Private (never in resume/site)
    </label>
  </div>

  <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
    Title
    <input bind:value={title} placeholder="Short label" class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
  </label>

  <div class="flex flex-wrap gap-3">
    {#if showOrg}
      <label class="flex flex-1 flex-col text-xs font-medium text-[var(--color-muted)]">
        Organization
        <input bind:value={org} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
      </label>
    {/if}
    {#if showRole}
      <label class="flex flex-1 flex-col text-xs font-medium text-[var(--color-muted)]">
        Role / title
        <input bind:value={role} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
      </label>
    {/if}
  </div>

  {#if showMention}
    <div class="flex flex-wrap gap-3">
      <label class="flex flex-1 flex-col text-xs font-medium text-[var(--color-muted)]">
        Source
        <input bind:value={source} placeholder="where the mention came from" class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
      </label>
      <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
        Sentiment
        <select bind:value={sentiment} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm">
          <option value="">—</option>
          <option value="positive">positive</option>
          <option value="neutral">neutral</option>
          <option value="negative">negative</option>
        </select>
      </label>
    </div>
  {/if}

  <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
    Notes (the raw, brutally-accurate record — don't polish here)
    <textarea bind:value={body} rows="6" class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 font-mono text-sm"></textarea>
  </label>

  {#if showLinks}
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Links (one per line)
      <textarea bind:value={linksText} rows="2" class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm"></textarea>
    </label>
  {/if}

  {#if showProject && (app.projects.length || project)}
    <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
      Project
      <select bind:value={project} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm">
        <option value="">— none —</option>
        {#each app.projects as p (p.slug)}
          <option value={p.slug}>{p.entry.frontmatter.title}</option>
        {/each}
        {#if project && !app.projects.some((p) => p.slug === project)}
          <option value={project}>{project} (not listed)</option>
        {/if}
      </select>
    </label>
  {/if}

  <label class="flex flex-col text-xs font-medium text-[var(--color-muted)]">
    Tags (comma-separated)
    <input bind:value={tagsText} class="mt-1 rounded border border-[var(--color-line)] px-2 py-1 text-sm" />
  </label>

  <div class="flex justify-end gap-2">
    <button class="rounded px-3 py-1.5 text-sm text-[var(--color-muted)] hover:bg-gray-100 dark:hover:bg-white/10" onclick={ondone}>Cancel</button>
    <button
      class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      disabled={app.busy}
      onclick={save}>{isNew ? 'Add entry' : 'Save changes'}</button
    >
  </div>
</div>
