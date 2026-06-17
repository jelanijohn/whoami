<script lang="ts">
  import { app, type LiveSource } from '$lib/state.svelte';
  import { closeDatePicker } from '$lib/actions/closeDatePicker';

  // Transient token-entry boxes (the saved value lives in the keyring, never here).
  let tokens = $state<Record<LiveSource, string>>({ github: '', asana: '', gmail: '' });

  // Refresh which sources have a saved token whenever a record is open.
  $effect(() => {
    if (app.store) app.refreshTokenPresence();
  });

  async function saveToken(source: LiveSource) {
    await app.setSourceToken(source, tokens[source]);
    tokens[source] = '';
  }

  /** Persist the non-secret params before each run so they stick. */
  function persist() {
    app.saveImportSettings($state.snapshot(app.importSettings));
  }

  async function runGithub() {
    persist();
    const g = app.importSettings.github;
    const capStr = g.discussionCharCap.trim();
    const cap = capStr ? Number(capStr) : undefined;
    await app.importGithub({
      user: g.user.trim(),
      repo: g.repo.trim() || undefined,
      since: g.since || undefined,
      until: g.until || undefined,
      limit: g.limit || undefined,
      baseUrl: g.baseUrl.trim() || undefined,
      fetchDiscussion: g.fetchDiscussion,
      commentScope: g.commentScope,
      discussionCharCap: cap && Number.isFinite(cap) && cap > 0 ? cap : undefined
    });
  }

  async function runAsana() {
    persist();
    const a = app.importSettings.asana;
    await app.importAsana({
      workspace: a.workspace.trim() || undefined,
      project: a.project.trim() || undefined,
      since: a.since || undefined,
      until: a.until || undefined,
      includeCompleted: a.includeCompleted,
      limit: a.limit || undefined
    });
  }

  async function runGmail() {
    persist();
    const m = app.importSettings.gmail;
    await app.importGmail({ query: m.query.trim(), limit: m.limit || undefined });
  }

  /** Toggle one Claude Code project root in/out of the import selection. */
  function toggleClaudeCode(root: string) {
    const sel = app.claudeCodeSelected;
    app.claudeCodeSelected = sel.includes(root) ? sel.filter((r) => r !== root) : [...sel, root];
  }

  /** Toggle one Warp working directory in/out of the import selection. */
  function toggleWarp(dir: string) {
    const sel = app.warpSelected;
    app.warpSelected = sel.includes(dir) ? sel.filter((d) => d !== dir) : [...sel, dir];
  }

  const inputCls =
    'mt-0.5 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm';
  const btnCls =
    'rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50';
  const runCls =
    'rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';
</script>

{#snippet tokenRow(source: LiveSource, placeholder: string)}
  <div class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col text-xs text-[var(--color-muted)]">
      Token (stored in OS keyring)
      <input
        type="password"
        bind:value={tokens[source]}
        {placeholder}
        class="{inputCls} w-72"
      />
    </label>
    <button class={btnCls} disabled={app.busy || !tokens[source].trim()} onclick={() => saveToken(source)}>
      Save token
    </button>
    <button class={btnCls} disabled={app.busy || !app.tokenPresent[source]} onclick={() => app.testSourceToken(source)}>
      Test
    </button>
    {#if app.tokenPresent[source]}
      <button class="text-xs text-[var(--color-private)] hover:underline" disabled={app.busy} onclick={() => app.setSourceToken(source, '')}>
        clear
      </button>
    {/if}
    <span class="text-xs {app.tokenPresent[source] ? 'text-green-700 dark:text-green-300' : 'text-[var(--color-muted)]'}">
      {app.tokenPresent[source] ? 'token saved' : 'no token'}
    </span>
  </div>
{/snippet}

<div class="max-w-2xl space-y-8">
  <section>
    <h1 class="text-lg font-semibold">Import</h1>
    <p class="mt-1 text-sm text-[var(--color-muted)]">
      Fetch from your data sources and stage the results as candidates for review. Nothing here
      writes to your record — everything lands in the <a href="/inbox" class="text-[var(--color-accent)] hover:underline">Inbox</a>,
      private by default, until you promote it. Re-running never re-proposes something you already
      promoted or rejected. Tokens are stored in the OS keyring, never in the record.
    </p>
  </section>

  <!-- Triage (applies to every import) -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">Triage</h2>
    <p class="text-xs text-[var(--color-muted)]">
      A free, local prefilter always runs — it flags obvious noise (automated email, version-bump
      PRs, routine chores) as <em>frivolous</em> so the inbox can surface real work first. It never
      deletes anything; you still promote or reject every item yourself.
    </p>
    <label class="flex items-start gap-2 text-sm {app.llmReady ? '' : 'opacity-60'}">
      <input
        type="checkbox"
        class="mt-0.5"
        disabled={!app.llmReady}
        bind:checked={app.importSettings.triage.useLlm}
      />
      <span>
        Use LLM triage for ambiguous items
        {#if app.llmConfig}(sends them to <strong>{app.llmConfig.provider}</strong>){/if}
        {#if !app.llmReady}
          <span class="text-[var(--color-muted)]">— configure a provider in Data → AI provider first</span>
        {:else if app.llmConfig?.provider === 'anthropic'}
          <span class="block text-xs text-amber-700 dark:text-amber-300">
            Only items the prefilter can't decide are sent to Anthropic — content leaves your
            machine. Gmail items are metadata-only (subject + 200-char snippet), so what could ever
            leave is minimal.
          </span>
        {/if}
      </span>
    </label>
  </section>

  <!-- Project pre-selection (applies to every import) -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">Project</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Pre-assign everything this import stages to a project. It only pre-fills the
      <a href="/inbox" class="text-[var(--color-accent)] hover:underline">Inbox</a> picker — you still
      confirm (or change) the project when you promote each item, and a choice here overrides a
      source's own guess (e.g. the GitHub repo).
    </p>
    <label class="flex flex-col text-xs text-[var(--color-muted)]">
      Assign imported items to
      <select bind:value={app.importProject} class="{inputCls} w-72">
        <option value="">— none (use each source's suggestion) —</option>
        {#each app.projects as p (p.slug)}
          <option value={p.slug}>{p.entry.frontmatter.title}</option>
        {/each}
        {#if app.importProject && !app.projects.some((p) => p.slug === app.importProject)}
          <option value={app.importProject}>{app.importProject}</option>
        {/if}
      </select>
    </label>
  </section>

  <!-- GitHub -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">GitHub</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Issues &amp; PRs you authored in a date range (Search API). A personal access token with
      <code>repo</code> read scope works.
    </p>
    {@render tokenRow('github', 'ghp_…')}
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        User (login)
        <input bind:value={app.importSettings.github.user} placeholder="octocat" class="{inputCls} w-40" />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Repo (optional)
        <input bind:value={app.importSettings.github.repo} placeholder="owner/name" class="{inputCls} w-44" />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Since
        <input type="date" bind:value={app.importSettings.github.since} class={inputCls} use:closeDatePicker />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Until
        <input type="date" bind:value={app.importSettings.github.until} class={inputCls} use:closeDatePicker />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Limit
        <input type="number" min="1" max="300" bind:value={app.importSettings.github.limit} class="{inputCls} w-20" />
      </label>
    </div>
    <div class="flex flex-wrap items-end gap-4">
      <label class="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <input type="checkbox" bind:checked={app.importSettings.github.importPrivate} />
        Mark imported entries private
      </label>
      <label class="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <input type="checkbox" bind:checked={app.importSettings.github.fetchDiscussion} />
        Fetch PR/issue discussion
      </label>
      {#if app.importSettings.github.fetchDiscussion}
        <label class="flex flex-col text-xs text-[var(--color-muted)]">
          Comments
          <select bind:value={app.importSettings.github.commentScope} class={inputCls}>
            <option value="self">My comments</option>
            <option value="all">Everyone's</option>
          </select>
        </label>
        <label class="flex flex-col text-xs text-[var(--color-muted)]">
          Discussion char cap
          <input
            type="number"
            min="1"
            placeholder="2000"
            bind:value={app.importSettings.github.discussionCharCap}
            class="{inputCls} w-24"
          />
        </label>
      {/if}
    </div>
    <button class={runCls} disabled={app.busy || !app.importSettings.github.user.trim()} onclick={runGithub}>
      Run GitHub import
    </button>
  </section>

  <!-- Asana -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">Asana</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Every task you've worked on — created, commented, assigned, or @mentioned — even ones since
      reassigned to a reviewer (the durable signal is collaborator membership, not the current
      assignee). Premium accounts use workspace search; others fall back to project enumeration
      automatically. Completed tasks are included by default for reconstruction.
    </p>
    {@render tokenRow('asana', 'personal access token')}
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Workspace gid (optional)
        <input bind:value={app.importSettings.asana.workspace} placeholder="first workspace" class="{inputCls} w-44" />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Project
        <select bind:value={app.importSettings.asana.project} class="{inputCls} w-56">
          <option value="">— all projects in workspace —</option>
          {#each app.asanaProjects as p (p.gid)}
            <option value={p.gid}>{p.name}</option>
          {/each}
          {#if app.importSettings.asana.project && !app.asanaProjects.some((p) => p.gid === app.importSettings.asana.project)}
            <option value={app.importSettings.asana.project}>{app.importSettings.asana.project}</option>
          {/if}
        </select>
      </label>
      <button class={btnCls} disabled={app.busy || !app.tokenPresent.asana} onclick={() => app.loadAsanaProjects()}>
        Load projects
      </button>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Since
        <input type="date" bind:value={app.importSettings.asana.since} class="{inputCls} w-40" />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Until
        <input type="date" bind:value={app.importSettings.asana.until} class="{inputCls} w-40" />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Limit
        <input type="number" min="1" max="500" bind:value={app.importSettings.asana.limit} class="{inputCls} w-20" />
      </label>
      <label class="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <input type="checkbox" bind:checked={app.importSettings.asana.includeCompleted} />
        Include completed
      </label>
    </div>
    <button class={runCls} disabled={app.busy} onclick={runAsana}>Run Asana import</button>
  </section>

  <!-- Gmail -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">Gmail</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Metadata only — subjects &amp; snippets, never message bodies. Needs a Gmail
      <code>readonly</code> OAuth access token. The query is the selection, e.g.
      <code>in:sent after:2019/01/01 before:2020/01/01</code>.
    </p>
    {@render tokenRow('gmail', 'OAuth access token (ya29.…)')}
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-1 flex-col text-xs text-[var(--color-muted)]">
        Search query
        <input bind:value={app.importSettings.gmail.query} placeholder="in:sent after:2019/01/01 before:2020/01/01" class="{inputCls} w-full" />
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Limit
        <input type="number" min="1" max="100" bind:value={app.importSettings.gmail.limit} class="{inputCls} w-20" />
      </label>
    </div>
    <button class={runCls} disabled={app.busy || !app.importSettings.gmail.query.trim()} onclick={runGmail}>
      Run Gmail import
    </button>
  </section>

  <!-- LinkedIn -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">LinkedIn (archive)</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Import-only — LinkedIn has no usable live API. Request your data export (Settings → Data
      privacy → Get a copy of your data), unzip it, and select the CSVs. Recognized:
      <code>Positions.csv</code>, <code>Projects.csv</code>, <code>Education.csv</code>.
    </p>
    <button class={runCls} disabled={app.busy} onclick={() => app.importLinkedin()}>
      Choose CSVs &amp; import…
    </button>
  </section>

  <!-- Claude Code -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">Claude Code (session history)</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Zero-auth, import-only. Reads your local Claude Code session logs from
      <code>~/.claude/projects/</code> and stages one candidate per session — your questions are a
      timestamped diary of what you were trying to do, pre-anchored to a project. One session = one
      candidate; only your genuine typed turns become the body (assistant prose is excluded).
    </p>
    <p class="text-xs text-[var(--color-private)]">
      Most sensitive source here, so it never touches the cloud: you pick which projects to import, a
      local prefilter runs (no LLM triage), and every candidate is private by default until you
      promote it.
    </p>
    <button class={btnCls} disabled={app.busy} onclick={() => app.loadClaudeCodeProjects()}>
      {app.claudeCodeProjects.length ? 'Rescan projects' : 'Find projects'}
    </button>
    {#if app.claudeCodeProjects.length > 0}
      <fieldset class="space-y-1 rounded border border-[var(--color-line)] p-3">
        <legend class="flex items-center gap-3 px-1 text-xs text-[var(--color-muted)]">
          <span>{app.claudeCodeSelected.length} of {app.claudeCodeProjects.length} selected</span>
          <button class="text-[var(--color-accent)] hover:underline" onclick={() => (app.claudeCodeSelected = app.claudeCodeProjects.map((p) => p.root))}>
            all
          </button>
          <button class="text-[var(--color-muted)] hover:underline" onclick={() => (app.claudeCodeSelected = [])}>
            none
          </button>
        </legend>
        <div class="max-h-56 space-y-1 overflow-y-auto">
          {#each app.claudeCodeProjects as p (p.root)}
            <label class="flex items-center gap-2 text-sm" title={p.root}>
              <input
                type="checkbox"
                checked={app.claudeCodeSelected.includes(p.root)}
                onchange={() => toggleClaudeCode(p.root)}
              />
              <span class="font-medium">{p.name}</span>
              <span class="text-xs text-[var(--color-muted)]">
                {p.sessions} session{p.sessions === 1 ? '' : 's'}
              </span>
            </label>
          {/each}
        </div>
      </fieldset>
      <button
        class={runCls}
        disabled={app.busy || app.claudeCodeSelected.length === 0}
        onclick={() => app.importClaudeCode($state.snapshot(app.claudeCodeSelected))}
      >
        Import {app.claudeCodeSelected.length} project{app.claudeCodeSelected.length === 1 ? '' : 's'}
      </button>
    {/if}
  </section>

  <!-- Warp -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">Warp (AI history)</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Zero-auth, import-only. Reads your local Warp Agent-mode history from
      <code>warp.sqlite</code> and stages one candidate per conversation — your prompts are a
      timestamped diary of what you were trying to do, pre-anchored to a project by its working
      directory. One conversation = one candidate; only your typed prompts become the body (Warp
      keeps the assistant's replies in the cloud, so they're never imported).
    </p>
    <p class="text-xs text-[var(--color-private)]">
      Most sensitive source here, so it never touches the cloud: you pick which projects to import, a
      local prefilter runs (no LLM triage), and every candidate is private by default until you
      promote it. Warp's database is opened read-only.
    </p>
    <button class={btnCls} disabled={app.busy} onclick={() => app.loadWarpProjects()}>
      {app.warpProjects.length ? 'Rescan projects' : 'Find projects'}
    </button>
    {#if app.warpProjects.length > 0}
      <fieldset class="space-y-1 rounded border border-[var(--color-line)] p-3">
        <legend class="flex items-center gap-3 px-1 text-xs text-[var(--color-muted)]">
          <span>{app.warpSelected.length} of {app.warpProjects.length} selected</span>
          <button class="text-[var(--color-accent)] hover:underline" onclick={() => (app.warpSelected = app.warpProjects.map((p) => p.dir))}>
            all
          </button>
          <button class="text-[var(--color-muted)] hover:underline" onclick={() => (app.warpSelected = [])}>
            none
          </button>
        </legend>
        <div class="max-h-56 space-y-1 overflow-y-auto">
          {#each app.warpProjects as p (p.dir)}
            <label class="flex items-center gap-2 text-sm" title={p.dir}>
              <input
                type="checkbox"
                checked={app.warpSelected.includes(p.dir)}
                onchange={() => toggleWarp(p.dir)}
              />
              <span class="font-medium">{p.name}</span>
              <span class="text-xs text-[var(--color-muted)]">
                {p.conversations} conversation{p.conversations === 1 ? '' : 's'}
              </span>
            </label>
          {/each}
        </div>
      </fieldset>
      <button
        class={runCls}
        disabled={app.busy || app.warpSelected.length === 0}
        onclick={() => app.importWarp($state.snapshot(app.warpSelected))}
      >
        Import {app.warpSelected.length} project{app.warpSelected.length === 1 ? '' : 's'}
      </button>
    {/if}
  </section>

  <!-- Résumé -->
  <section class="space-y-2 border-t border-[var(--color-line)] pt-5">
    <h2 class="text-sm font-semibold">Résumé (PDF/DOCX)</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Turn a résumé or CV into a batch of dated candidates — roles, projects, education, and dated
      wins — so you promote the real ones with one click each instead of retyping a career. Every
      item carries the verbatim résumé span it came from, so you can see at a glance that nothing was
      invented. Skills aren't imported here (they belong on your profile, not the timeline).
    </p>
    <p class="text-xs text-[var(--color-muted)]">
      Unlike the other sources, this one needs an LLM to read the prose — there is no local fallback.
      {#if app.llmConfig?.provider === 'anthropic'}
        <span class="block text-amber-700 dark:text-amber-300">
          The résumé text is sent to <strong>Anthropic</strong> to be parsed — content leaves your
          machine. A résumé is designed to be handed to strangers, but the choice is yours.
        </span>
      {/if}
    </p>
    {#if !app.llmReady || !app.docsAvailable}
      <p class="text-xs text-[var(--color-private)]">
        {#if !app.docsAvailable}
          Document reading isn't available in this build yet.
        {:else}
          Configure an AI provider in Data → AI provider first.
        {/if}
      </p>
    {/if}
    <button
      class={runCls}
      disabled={app.busy || !app.llmReady || !app.docsAvailable}
      onclick={() => app.importResume()}
    >
      Choose a résumé &amp; import…
    </button>
  </section>

  <!-- Last run -->
  {#if app.lastImportReport}
    {@const r = app.lastImportReport}
    <section class="space-y-1 rounded-lg border border-[var(--color-line)] bg-gray-50 p-4 text-sm dark:bg-white/5">
      <h2 class="text-sm font-semibold">Last import</h2>
      <p class="text-[var(--color-muted)]">
        Fetched {r.fetched} · <strong class="text-green-700 dark:text-green-300">staged {r.staged}</strong> ·
        skipped {r.skippedPromoted} promoted, {r.skippedRejected} rejected
        {#if r.errors.length}· <span class="text-amber-700 dark:text-amber-300">{r.errors.length} errors</span>{/if}
      </p>
      {#if r.staged > 0}
        <p><a href="/inbox" class="text-[var(--color-accent)] hover:underline">Review {r.staged} candidate{r.staged === 1 ? '' : 's'} in the Inbox →</a></p>
      {/if}
      {#if r.errors.length}
        <ul class="mt-1 list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
          {#each r.errors.slice(0, 8) as err (err)}<li>{err}</li>{/each}
          {#if r.errors.length > 8}<li>…and {r.errors.length - 8} more</li>{/if}
        </ul>
      {/if}
    </section>
  {/if}
</div>
