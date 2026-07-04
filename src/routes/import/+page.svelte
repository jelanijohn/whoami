<script lang="ts">
  import { app, type LiveSource, type TokenSource, type Feed, type FeedKind } from '$lib/state.svelte';
  import { isPickerKind } from '$lib/core';
  import { closeDatePicker } from '$lib/actions/closeDatePicker';
  import CredentialHelp from '$lib/components/CredentialHelp.svelte';
  import IdentityMergeReview from '$lib/components/IdentityMergeReview.svelte';
  import Icon from '$lib/components/Icon.svelte';

  // Transient token-entry boxes (the saved value lives in the keyring, never here).
  let tokens = $state<Record<TokenSource, string>>({ github: '', asana: '', gmail: '', shortcut: '' });

  // Per-source "Save as feed" label drafts (inline text inputs, spec §6.1).
  let feedLabels = $state<Record<string, string>>({});
  // The feed currently being edited inline in the list (spec §6.2), or null.
  let editingId = $state<string | null>(null);

  // Which source accordion rows are expanded (design handoff). One open by
  // default; multiple may be open at once.
  let open = $state<Set<string>>(new Set(['github']));
  function toggleOpen(id: string) {
    const next = new Set(open);
    next.has(id) ? next.delete(id) : next.add(id);
    open = next;
  }

  // The expandable "Defaults" panel under the bar (triage + project copy).
  let showDefaults = $state(false);

  /** Snapshot the current form state for `kind` into a new feed (spec §6.1). */
  function saveAsFeed(kind: FeedKind) {
    const label = (feedLabels[kind] ?? '').trim();
    if (!label) return;
    app.saveCurrentAsFeed(kind, label);
    feedLabels[kind] = '';
    app.message = `Saved feed “${label}”`;
  }

  /** Count of enabled feeds (drives the Refresh-all button label/disabled). */
  const enabledCount = $derived(app.feeds.filter((f) => f.enabled).length);

  /** A short relative-ish label for a feed's last run, or 'never'. */
  function lastRun(iso?: string): string {
    if (!iso) return 'never';
    const d = new Date(iso);
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    return d.toISOString().slice(0, 10);
  }

  async function deleteFeed(feed: Feed) {
    if (confirm(`Delete feed “${feed.label}”?`)) {
      if (editingId === feed.id) editingId = null;
      app.removeFeed(feed.id);
    }
  }

  // Refresh which sources have a saved token whenever a record is open.
  $effect(() => {
    if (app.store) app.refreshTokenPresence();
  });

  async function saveToken(source: TokenSource) {
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
      discussionCharCap: cap && Number.isFinite(cap) && cap > 0 ? cap : undefined,
      mode: g.mode,
      branch: g.branch.trim() || undefined,
      excludeMerges: g.excludeMerges,
      excludePrCommits: g.excludePrCommits
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

  async function runShortcut() {
    persist();
    const s = app.importSettings.shortcut;
    await app.importShortcut({ since: s.since || undefined, until: s.until || undefined });
  }

  async function runGmail() {
    persist();
    const m = app.importSettings.gmail;
    await app.importGmail({ query: m.query.trim(), limit: m.limit || undefined });
  }

  // "Describe it — AI builds the search" (waid's Gmail query helper). The
  // generated query only fills the editable field; nothing runs until Run.
  let gmailAiPrompt = $state('');
  let gmailAiBusy = $state(false);
  async function generateGmailQuery() {
    if (gmailAiBusy || !gmailAiPrompt.trim()) return;
    gmailAiBusy = true;
    try {
      const query = await app.suggestGmailQuery(gmailAiPrompt);
      if (query) app.importSettings.gmail.query = query;
    } finally {
      gmailAiBusy = false;
    }
  }

  async function runWebsite() {
    persist();
    const w = app.importSettings.website;
    const urls = w.urls
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const maxStr = String(w.maxPages).trim();
    const maxPages = maxStr ? Number(maxStr) : undefined;
    await app.importWebsite({
      urls,
      sitemapUrl: w.sitemapUrl.trim() || undefined,
      maxPages: maxPages && Number.isFinite(maxPages) && maxPages > 0 ? maxPages : undefined
    });
  }
  /** True when the website form has nothing to fetch (no URLs and no sitemap). */
  const websiteEmpty = $derived(
    !app.importSettings.website.urls.trim() && !app.importSettings.website.sitemapUrl.trim()
  );

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

  // --- Source registry (design handoff): metadata for the three accordion
  // groups. Behavior is unchanged — each row's body is the existing per-source
  // form, just moved inside a collapsible row.
  type Cat = 'connected' | 'local' | 'archive';
  interface SourceMeta {
    id: string;
    name: string;
    glyph: string;
    sub: string;
    cat: Cat;
  }
  const SOURCES: SourceMeta[] = [
    { id: 'github', name: 'GitHub', glyph: 'commit', sub: 'Issues & PRs you authored', cat: 'connected' },
    { id: 'asana', name: 'Asana', glyph: 'task_alt', sub: 'Tasks you touched', cat: 'connected' },
    { id: 'shortcut', name: 'Shortcut', glyph: 'bookmarks', sub: 'Stories you follow', cat: 'connected' },
    { id: 'gmail', name: 'Gmail', glyph: 'mail', sub: 'Subjects & snippets only', cat: 'connected' },
    { id: 'claude-code', name: 'Claude Code', glyph: 'terminal', sub: 'Session history · ~/.claude/projects', cat: 'local' },
    { id: 'warp', name: 'Warp', glyph: 'bolt', sub: 'Agent-mode history · warp.sqlite', cat: 'local' },
    { id: 'neuroskill', name: 'NeuroSkill', glyph: 'activity', sub: 'EEG focus sessions · activity.sqlite', cat: 'local' },
    { id: 'linkedin', name: 'LinkedIn', glyph: 'work', sub: 'CSV data export', cat: 'archive' },
    { id: 'resume', name: 'Résumé', glyph: 'description', sub: 'PDF / DOCX', cat: 'archive' },
    { id: 'website', name: 'Website (your own)', glyph: 'language', sub: 'Public pages · sitemap or URLs', cat: 'archive' }
  ];
  const GROUPS: { cat: Cat; title: string; note: string }[] = [
    { cat: 'connected', title: 'Connected services', note: 'Live APIs · token in OS keyring' },
    { cat: 'local', title: 'Local history', note: 'Zero-auth · always private' },
    { cat: 'archive', title: 'Archives & documents', note: 'One-off file imports' }
  ];

  /** Render-time status derived from existing app state (design handoff §3). */
  function sourceStatus(id: string): 'ok' | 'warn' | 'neutral' {
    if (id === 'github' || id === 'asana' || id === 'shortcut' || id === 'gmail')
      return app.tokenPresent[id] ? 'ok' : 'warn';
    if (id === 'resume') return app.llmReady && app.docsAvailable ? 'ok' : 'warn';
    if (id === 'website') return app.llmReady ? 'ok' : 'warn';
    if (id === 'linkedin') return 'neutral';
    return 'ok'; // claude-code / warp — zero-auth, always ready
  }
  /** "Set up" = has what it needs to run; drives the setup-progress meter. */
  function sourceReady(id: string): boolean {
    const st = sourceStatus(id);
    return id === 'linkedin' ? true : st === 'ok';
  }
  function statusLabel(s: SourceMeta): string {
    const st = sourceStatus(s.id);
    if (st === 'ok') return s.cat === 'connected' ? 'Connected' : s.cat === 'local' ? 'Ready' : '';
    if (st === 'warn') return s.cat === 'archive' ? 'Needs AI provider' : 'Needs token';
    return s.cat === 'archive' ? 'File import' : '';
  }
  function statusCls(id: string): string {
    const st = sourceStatus(id);
    if (st === 'ok') return 'text-[var(--imp-ok)]';
    if (st === 'warn') return 'text-[var(--color-private)]';
    return 'text-[var(--color-muted)]';
  }
  /** Most-recent run across the feeds of this source kind, or '—' if untracked. */
  function lastRunFor(id: string): string {
    const stamps = app.feeds
      .filter((f) => f.kind === id && f.lastRunAt)
      .map((f) => f.lastRunAt as string)
      .sort();
    return stamps.length ? lastRun(stamps[stamps.length - 1]) : '—';
  }

  const readyCount = $derived(SOURCES.filter((s) => sourceReady(s.id)).length);
  const totalSources = SOURCES.length;
  const readyPct = $derived(Math.round((readyCount / totalSources) * 100));

  const inputCls =
    'mt-0.5 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm';
  const btnCls =
    'rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50';
  const runCls =
    'inline-flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';
</script>

{#snippet tokenRow(source: TokenSource, placeholder: string)}
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
    <CredentialHelp topic={source} />
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

{#snippet saveAsFeedRow(kind: FeedKind)}
  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-2">
    <input
      bind:value={feedLabels[kind]}
      placeholder="Save these settings as a feed…"
      class="{inputCls} w-60"
      onkeydown={(e) => { if (e.key === 'Enter') saveAsFeed(kind); }}
    />
    <button class={btnCls} disabled={!feedLabels[kind]?.trim()} onclick={() => saveAsFeed(kind)}>
      <Icon name="bookmark_add" size={16} />
      Save as feed
    </button>
  </div>
{/snippet}

<!-- The collapsed header shared by every source row (design handoff §3). -->
{#snippet sourceHeader(s: SourceMeta)}
  {@const isOpen = open.has(s.id)}
  {@const label = statusLabel(s)}
  <button
    class="flex w-full items-center gap-3 px-[15px] py-3 text-left"
    onclick={() => toggleOpen(s.id)}
    aria-expanded={isOpen}
  >
    <span class="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] bg-[var(--imp-tile-bg)] text-[var(--color-muted)]">
      <Icon name={s.glyph} size={19} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="text-sm font-semibold">{s.name}</span>
      <span class="truncate text-xs text-[var(--color-muted)]">{s.sub}</span>
    </span>
    <span class="inline-flex flex-none items-center gap-1.5 text-[11px] font-semibold {statusCls(s.id)}">
      <span class="h-[7px] w-[7px] rounded-full bg-current"></span>{label}
    </span>
    <span class="hidden w-[84px] flex-none text-right text-[11px] text-[var(--color-muted)] sm:block">
      last run {lastRunFor(s.id)}
    </span>
    <span class="jv-chevron flex-none text-[var(--color-muted)] transition-transform {isOpen ? 'rotate-180' : ''}">
      <Icon name="expand_more" size={20} />
    </span>
  </button>
{/snippet}

{#snippet groupHead(title: string, note: string)}
  <div class="mb-2.5 flex items-center gap-2.5">
    <h2 class="text-xs font-bold uppercase tracking-wide">{title}</h2>
    <span class="text-[11.5px] text-[var(--color-muted)]">{note}</span>
    <span class="h-px flex-1 bg-[var(--jv-hair)]"></span>
  </div>
{/snippet}

<!-- Body wrapper: the accent top hairline + padding shared by every open row. -->
{#snippet bodyOpen(children: import('svelte').Snippet)}
  <div class="jv-rise border-t border-[var(--jv-hair)] px-[15px] pb-4 pt-3.5">
    <div class="space-y-2">
      {@render children()}
    </div>
  </div>
{/snippet}

<div class="mx-auto max-w-[1080px] space-y-0 px-1 pb-16">
  <header>
    <h1 class="text-[25px] font-semibold tracking-tight">Import</h1>
    <p class="mt-1 max-w-xl text-sm leading-relaxed text-[var(--color-muted)]">
      Pull from your sources into the
      <a href="/inbox" class="text-[var(--color-accent)] hover:underline">Inbox</a> — everything lands
      private until you promote it, and re-runs never re-propose what you've already handled.
      Tokens are stored in the OS keyring, never in the record.
    </p>
  </header>

  <!-- Hero: feeds (left) + last refresh (right) -->
  <div class="mt-4 grid grid-cols-1 gap-3.5 md:grid-cols-2">
    <!-- Feeds card -->
    <div
      class="flex flex-col gap-3 rounded-[14px] border border-[var(--imp-feed-border)] p-[18px]"
      style="background:linear-gradient(135deg,var(--imp-feed-from),var(--imp-feed-to));"
    >
      <div class="flex items-center gap-2.5">
        <span class="text-[var(--color-accent)]"><Icon name="bookmarks" size={20} /></span>
        <span class="text-[13px] font-semibold text-[var(--imp-feed-ink)]">
          {enabledCount} feed{enabledCount === 1 ? '' : 's'} ready to run
        </span>
        <button
          class="{runCls} ml-auto"
          disabled={app.busy || enabledCount === 0}
          onclick={() => app.refreshAll()}
        >
          <Icon name="sync" size={17} />
          Refresh all
        </button>
      </div>

      {#if app.feeds.length === 0}
        <p class="text-xs text-[var(--imp-feed-faint)]">
          No feeds yet — configure a source below and use “Save as feed”.
        </p>
      {:else}
        <div class="flex flex-col gap-1.5">
          {#each app.feeds as feed (feed.id)}
            <div class="rounded-lg bg-white/60 px-2.5 py-2 dark:bg-white/5">
              <div class="flex items-center gap-2.5">
                <button
                  class="flex h-[18px] w-[30px] flex-none rounded-full p-0.5 {feed.enabled ? 'justify-end bg-[var(--color-accent)]' : 'justify-start bg-[var(--color-line)]'}"
                  title={feed.enabled ? 'Enabled — included in Refresh all' : 'Disabled — skipped by Refresh all'}
                  onclick={() => app.updateFeed(feed.id, { enabled: !feed.enabled })}
                >
                  <span class="block h-3.5 w-3.5 rounded-full bg-white"></span>
                </button>
                <span class="truncate text-[12.5px] font-medium {feed.enabled ? '' : 'opacity-50'}">
                  {feed.label}
                </span>
                <span class="flex-none rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-[var(--color-accent)]">
                  {feed.kind}
                </span>
                <span class="ml-auto flex flex-none items-center gap-1.5">
                  <span class="text-[10.5px] text-[var(--imp-feed-faint)]">last run {lastRun(feed.lastRunAt)}</span>
                  <button
                    class="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-[var(--color-accent)]/10 text-[var(--color-accent)] disabled:opacity-50"
                    title="Run now"
                    disabled={app.busy}
                    onclick={() => app.runFeed(feed)}
                  >
                    <Icon name="play_arrow" size={15} />
                  </button>
                  <button
                    class="rounded px-1.5 text-[11px] text-[var(--color-muted)] hover:underline"
                    onclick={() => (editingId = editingId === feed.id ? null : feed.id)}
                  >
                    {editingId === feed.id ? 'Close' : 'Edit'}
                  </button>
                </span>
              </div>

              {#if editingId === feed.id}
                <div class="mt-2 space-y-2 border-t border-dashed border-[var(--color-line)] pt-2">
                  <div class="flex flex-wrap items-end gap-3">
                    <label class="flex flex-col text-xs text-[var(--color-muted)]">
                      Label
                      <input
                        value={feed.label}
                        class="{inputCls} w-48"
                        onchange={(e) => app.updateFeed(feed.id, { label: e.currentTarget.value })}
                      />
                    </label>
                    <label class="flex flex-col text-xs text-[var(--color-muted)]">
                      Project
                      <select
                        value={feed.project}
                        class="{inputCls} w-48"
                        onchange={(e) => app.updateFeed(feed.id, { project: e.currentTarget.value })}
                      >
                        <option value="">— none —</option>
                        {#each app.projects as p (p.slug)}
                          <option value={p.slug}>{p.entry.frontmatter.title}</option>
                        {/each}
                        {#if feed.project && !app.projects.some((p) => p.slug === feed.project)}
                          <option value={feed.project}>{feed.project}</option>
                        {/if}
                      </select>
                    </label>
                    {#if feed.kind === 'github' || feed.kind === 'asana' || feed.kind === 'shortcut'}
                      <label class="flex flex-col text-xs text-[var(--color-muted)]">
                        Window
                        <select
                          value={feed.window}
                          class={inputCls}
                          onchange={(e) => app.updateFeed(feed.id, { window: e.currentTarget.value as 'fixed' | 'rolling' })}
                        >
                          <option value="fixed">Fixed (use saved since/until)</option>
                          <option value="rolling">Rolling (since = last run)</option>
                        </select>
                      </label>
                    {/if}
                  </div>
                  {#if !isPickerKind(feed.kind)}
                    <div class="flex flex-wrap items-center gap-4">
                      <label class="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                        <input
                          type="checkbox"
                          checked={feed.private}
                          onchange={() => app.updateFeed(feed.id, { private: !feed.private })}
                        />
                        Stage private
                      </label>
                      <label class="flex items-center gap-1.5 text-xs text-[var(--color-muted)] {app.llmReady ? '' : 'opacity-60'}">
                        <input
                          type="checkbox"
                          checked={feed.useLlm}
                          disabled={!app.llmReady}
                          onchange={() => app.updateFeed(feed.id, { useLlm: !feed.useLlm })}
                        />
                        Use LLM triage
                      </label>
                    </div>
                  {:else}
                    <p class="text-xs text-[var(--color-private)]">
                      Always private &amp; prefilter-only — chat history never reaches the cloud.
                    </p>
                  {/if}
                  <label class="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                    <input
                      type="checkbox"
                      checked={feed.runOnOpen}
                      onchange={() => app.updateFeed(feed.id, { runOnOpen: !feed.runOnOpen })}
                    />
                    Run on open (when this folder is opened)
                  </label>
                  <div class="flex items-center justify-between gap-2">
                    <p class="text-xs text-[var(--color-muted)]">
                      Fetch params come from when you saved it. To change them, configure the source
                      below and save a new feed.
                    </p>
                    <button class="flex-none text-xs text-[var(--color-private)] hover:underline" onclick={() => deleteFeed(feed)}>
                      Delete feed
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Last refresh card -->
    <div class="flex flex-col rounded-[14px] border border-[var(--imp-ok-border)] bg-[var(--imp-ok-bg)] p-[18px]">
      {#if !app.lastRefreshReport && !app.lastImportReport}
        <div class="flex items-center gap-1.5">
          <span class="text-[var(--imp-ok)]"><Icon name="check_circle" size={18} /></span>
          <span class="text-[13px] font-semibold text-[var(--imp-ok-deep)]">Last refresh</span>
        </div>
        <p class="mt-2 text-xs text-[var(--imp-ok-soft)]">Run a refresh to see results here.</p>
      {/if}

      {#if app.lastRefreshReport}
        {@const rr = app.lastRefreshReport}
        <div class="flex items-center gap-1.5">
          <span class="text-[var(--imp-ok)]"><Icon name="check_circle" size={18} /></span>
          <span class="text-[13px] font-semibold text-[var(--imp-ok-deep)]">Last refresh</span>
        </div>
        <div class="mt-2.5 flex items-baseline gap-1.5">
          <span class="text-[34px] font-bold leading-none tracking-tight text-[var(--imp-ok-deep)]">{rr.totalStaged}</span>
          <span class="text-[13px] text-[var(--imp-ok-mid)]">staged for review</span>
        </div>
        <div class="mt-1 text-xs text-[var(--imp-ok-soft)]">
          {rr.totalFetched} fetched across {rr.results.length} feed{rr.results.length === 1 ? '' : 's'}
        </div>
        <div class="mt-2.5 flex flex-col gap-1.5">
          {#each rr.results as r (r.id)}
            <div class="flex items-center gap-2 text-[11.5px] text-[var(--imp-ok-mid)]">
              {#if r.report}
                <span class="font-semibold text-[var(--imp-ok-deep)]">+{r.report.staged}</span>
                <span class="truncate">{r.label}</span>
                <span class="ml-auto flex-none text-[var(--imp-ok-soft)]">
                  {r.report.skippedPromoted + r.report.skippedRejected + r.report.skippedSuperseded} known
                </span>
              {:else}
                <span class="truncate text-amber-700 dark:text-amber-300">{r.label} — failed: {r.error}</span>
              {/if}
            </div>
          {/each}
        </div>
        {#if rr.totalStaged > 0}
          <a href="/inbox" class="mt-auto inline-flex items-center gap-1.5 pt-3 text-[12.5px] font-semibold text-[var(--imp-ok-deep)] hover:underline">
            Review {rr.totalStaged} in Inbox <Icon name="arrow_forward" size={16} />
          </a>
        {/if}
      {/if}

      {#if app.lastImportReport}
        {@const r = app.lastImportReport}
        <div class="{app.lastRefreshReport ? 'mt-3 border-t border-[var(--imp-ok-border)] pt-3' : 'mt-2.5'} text-[11.5px] text-[var(--imp-ok-mid)]">
          <span class="font-semibold text-[var(--imp-ok-deep)]">Last import</span> · fetched {r.fetched} ·
          staged {r.staged} · {r.skippedPromoted + r.skippedRejected} already known
          {#if r.skippedSuperseded}· {r.skippedSuperseded} covered by imported PRs{/if}
          {#if r.errors.length}· <span class="text-amber-700 dark:text-amber-300">{r.errors.length} error{r.errors.length === 1 ? '' : 's'}</span>{/if}
        </div>
        {#if r.staged > 0 && !app.lastRefreshReport}
          <a href="/inbox" class="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--imp-ok-deep)] hover:underline">
            Review {r.staged} in Inbox <Icon name="arrow_forward" size={16} />
          </a>
        {/if}
      {/if}
    </div>
  </div>

  <!-- Setup progress + defaults bar -->
  <div class="mt-3.5 flex flex-wrap items-center gap-4 rounded-[11px] border border-[var(--color-line)] bg-[var(--color-bar)] px-4 py-3">
    <div class="flex items-center gap-2.5">
      <span class="text-[12.5px] font-semibold">{readyCount} of {totalSources} sources set up</span>
      <span class="h-1.5 w-28 overflow-hidden rounded-full bg-[var(--color-line)]">
        <span class="block h-full rounded-full bg-[var(--imp-ok)]" style="width:{readyPct}%;"></span>
      </span>
    </div>
    <div class="flex items-center gap-2.5 border-l border-[var(--color-line)] pl-4">
      <span class="text-xs text-[var(--color-muted)]">Stage to</span>
      <select
        bind:value={app.importProject}
        class="max-w-[10rem] rounded border border-[var(--color-line)] bg-transparent px-1.5 py-0.5 text-xs"
      >
        <option value="">No project</option>
        {#each app.projects as p (p.slug)}
          <option value={p.slug}>{p.entry.frontmatter.title}</option>
        {/each}
        {#if app.importProject && !app.projects.some((p) => p.slug === app.importProject)}
          <option value={app.importProject}>{app.importProject}</option>
        {/if}
      </select>
      <span class="text-[var(--color-line)]">·</span>
      <span class="inline-flex items-center gap-1.5 text-xs text-[var(--imp-ok-deep)]">
        <span class="h-[7px] w-[7px] rounded-full bg-[var(--imp-ok)]"></span>Local triage on
      </span>
    </div>
    <button
      class="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-1 text-xs text-[var(--color-muted)] hover:bg-gray-50 dark:hover:bg-white/5"
      onclick={() => (showDefaults = !showDefaults)}
      aria-expanded={showDefaults}
    >
      <Icon name="tune" size={16} />
      Defaults
    </button>
  </div>

  {#if showDefaults}
    <div class="jv-rise mt-2 space-y-4 rounded-[11px] border border-[var(--color-line)] bg-[var(--color-bar)] p-4">
      <div class="space-y-1.5">
        <h3 class="text-sm font-semibold">Triage</h3>
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
      </div>
      <div class="space-y-1.5 border-t border-[var(--color-line)] pt-4">
        <h3 class="text-sm font-semibold">Stage to project</h3>
        <p class="text-xs text-[var(--color-muted)]">
          Pre-assign everything this import stages to a project (set it in the bar above). It only
          pre-fills the
          <a href="/inbox" class="text-[var(--color-accent)] hover:underline">Inbox</a> picker — you still
          confirm (or change) the project when you promote each item, and a choice here overrides a
          source's own guess (e.g. the GitHub repo).
        </p>
      </div>
    </div>
  {/if}

  <!-- Source groups (accordion) -->
  {#each GROUPS as g (g.cat)}
    <section class="mt-[22px]">
      {@render groupHead(g.title, g.note)}
      <div class="flex flex-col gap-2">
        {#each SOURCES.filter((s) => s.cat === g.cat) as s (s.id)}
          <div class={open.has(s.id)
            ? 'overflow-hidden rounded-[13px] border border-[var(--color-accent)] bg-[var(--color-bar)] ring-1 ring-[var(--color-accent)]/25'
            : 'overflow-hidden rounded-[13px] border border-[var(--color-line)] bg-[var(--color-bar)]'}>
            {@render sourceHeader(s)}

            {#if open.has(s.id)}
              {#if s.id === 'github'}
                {#snippet githubBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Issues &amp; PRs you authored in a date range (Search API). A personal access token
                    with <code>repo</code> read scope works.
                  </p>
                  {@render tokenRow('github', 'ghp_…')}
                  <div class="inline-flex gap-0.5 rounded-[11px] border border-[var(--color-line)] bg-white p-[3px] dark:bg-[var(--color-bar)]">
                    {#each [['items', 'Issues & PRs'], ['commits', 'Commits']] as [value, label] (value)}
                      <button
                        onclick={() => (app.importSettings.github.mode = value as 'items' | 'commits')}
                        class="rounded-lg px-[13px] py-[6px] text-[13px] transition-all duration-100"
                        class:font-semibold={app.importSettings.github.mode === value}
                        class:font-medium={app.importSettings.github.mode !== value}
                        style={app.importSettings.github.mode === value
                          ? 'background:var(--color-accent);color:#fff;'
                          : 'background:transparent;color:var(--color-muted);'}
                      >
                        {label}
                      </button>
                    {/each}
                  </div>
                  <div class="flex flex-wrap items-end gap-2">
                    <label class="flex flex-col text-xs text-[var(--color-muted)]">
                      User (login)
                      <input bind:value={app.importSettings.github.user} placeholder="octocat" class="{inputCls} w-40" />
                    </label>
                    <label class="flex flex-col text-xs text-[var(--color-muted)]">
                      Repo ({app.importSettings.github.mode === 'commits' ? 'required' : 'optional'})
                      <input bind:value={app.importSettings.github.repo} placeholder="owner/name" class="{inputCls} w-44" />
                    </label>
                    {#if app.importSettings.github.mode === 'commits'}
                      <label class="flex flex-col text-xs text-[var(--color-muted)]">
                        Branch
                        <input bind:value={app.importSettings.github.branch} placeholder="default branch" class="{inputCls} w-44" />
                      </label>
                    {/if}
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
                    {#if app.importSettings.github.mode === 'commits'}
                      <label class="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                        <input type="checkbox" bind:checked={app.importSettings.github.excludeMerges} />
                        Exclude merge commits
                      </label>
                      <label class="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                        <input type="checkbox" bind:checked={app.importSettings.github.excludePrCommits} />
                        Skip commits from imported PRs
                      </label>
                    {:else}
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
                    {/if}
                  </div>
                  {#if app.importSettings.github.mode === 'commits'}
                    <p class="text-xs text-[var(--color-muted)]">
                      One repo per run — change size is included; the diff is never imported.
                    </p>
                  {/if}
                  <div class="space-y-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <h4 class="text-xs font-semibold">Shortcut ticket enrichment</h4>
                    <p class="text-xs text-[var(--color-muted)]">
                      Commits/PRs mentioning a ticket (e.g. <code>sc-57886</code>) are always tagged with
                      it. With a token saved, imports also pull that story's metadata (name, state, epic…)
                      onto the candidate — one fetch per distinct ticket.
                    </p>
                    {@render tokenRow('shortcut', 'Shortcut API token')}
                    <div class="flex flex-wrap items-end gap-4">
                      <label class="flex flex-col text-xs text-[var(--color-muted)]">
                        Ticket ref pattern (regex)
                        <input bind:value={app.importSettings.shortcut.refPattern} placeholder="sc-\d+" class="{inputCls} w-40 font-mono" />
                      </label>
                      <label class="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                        <input type="checkbox" bind:checked={app.importSettings.shortcut.enrich} />
                        Enrich during import
                      </label>
                      <label class="flex items-center gap-2 text-xs text-[var(--color-muted)]" title="Client-ticket prose stays out unless you opt in; bounded to ~500 chars">
                        <input type="checkbox" bind:checked={app.importSettings.shortcut.includeDescription} />
                        Include story description
                      </label>
                    </div>
                  </div>
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button
                      class={runCls}
                      disabled={app.busy
                        || !app.importSettings.github.user.trim()
                        || (app.importSettings.github.mode === 'commits' && !app.importSettings.github.repo.trim())}
                      onclick={runGithub}
                    >
                      <Icon name="sync" size={17} />
                      Run GitHub import
                    </button>
                  </div>
                  {@render saveAsFeedRow('github')}
                {/snippet}
                {@render bodyOpen(githubBody)}
              {:else if s.id === 'asana'}
                {#snippet asanaBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Every task you've worked on — created, commented, assigned, or @mentioned — even ones
                    since reassigned to a reviewer (the durable signal is collaborator membership, not the
                    current assignee). Premium accounts use workspace search; others fall back to project
                    enumeration automatically. Completed tasks are included by default for reconstruction.
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
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button class={runCls} disabled={app.busy} onclick={runAsana}>
                      <Icon name="sync" size={17} />
                      Run Asana import
                    </button>
                  </div>
                  {@render saveAsFeedRow('asana')}
                {/snippet}
                {@render bodyOpen(asanaBody)}
              {:else if s.id === 'shortcut'}
                {#snippet shortcutBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Stories you follow — following accretes from owning, requesting, or commenting and
                    survives reassignment, so handed-off work still comes back. The window is on
                    <em>last updated</em>; archived stories are included (abandoned work is exactly the
                    lessons material the record keeps). Descriptions come along, bounded. Same token as
                    the ticket enrichment under GitHub.
                  </p>
                  {@render tokenRow('shortcut', 'Shortcut API token')}
                  <div class="flex flex-wrap items-end gap-2">
                    <label class="flex flex-col text-xs text-[var(--color-muted)]">
                      Since (updated)
                      <input type="date" bind:value={app.importSettings.shortcut.since} class="{inputCls} w-40" use:closeDatePicker />
                    </label>
                    <label class="flex flex-col text-xs text-[var(--color-muted)]">
                      Until (updated)
                      <input type="date" bind:value={app.importSettings.shortcut.until} class="{inputCls} w-40" use:closeDatePicker />
                    </label>
                  </div>
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button class={runCls} disabled={app.busy || !app.tokenPresent.shortcut} onclick={runShortcut}>
                      <Icon name="sync" size={17} />
                      Run Shortcut import
                    </button>
                  </div>
                  {@render saveAsFeedRow('shortcut')}
                {/snippet}
                {@render bodyOpen(shortcutBody)}
              {:else if s.id === 'gmail'}
                {#snippet gmailBody()}
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
                  <div class="flex flex-wrap items-end gap-2 {app.llmReady ? '' : 'opacity-60'}">
                    <label class="flex flex-1 flex-col text-xs text-[var(--color-muted)]">
                      Or describe it — AI builds the search
                      <input
                        bind:value={gmailAiPrompt}
                        placeholder="unread from my manager this week"
                        class="{inputCls} w-full"
                        disabled={!app.llmReady || gmailAiBusy}
                        onkeydown={(e) => e.key === 'Enter' && generateGmailQuery()}
                      />
                    </label>
                    <button
                      class={btnCls}
                      disabled={app.busy || gmailAiBusy || !app.llmReady || !gmailAiPrompt.trim()}
                      onclick={generateGmailQuery}
                    >
                      {gmailAiBusy ? 'Generating…' : 'Generate'}
                    </button>
                  </div>
                  {#if !app.llmReady}
                    <p class="text-xs text-[var(--color-muted)]">
                      The describe-it helper needs an AI provider — configure one in Data → AI provider.
                    </p>
                  {/if}
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button class={runCls} disabled={app.busy || !app.importSettings.gmail.query.trim()} onclick={runGmail}>
                      <Icon name="sync" size={17} />
                      Run Gmail import
                    </button>
                  </div>
                  {@render saveAsFeedRow('gmail')}
                {/snippet}
                {@render bodyOpen(gmailBody)}
              {:else if s.id === 'claude-code'}
                {#snippet claudeBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Zero-auth, import-only. Reads your local Claude Code session logs from
                    <code>~/.claude/projects/</code> and stages one candidate per session — your questions
                    are a timestamped diary of what you were trying to do, pre-anchored to a project. One
                    session = one candidate; only your genuine typed turns become the body (assistant prose
                    is excluded).
                  </p>
                  <p class="flex items-start gap-1.5 text-xs text-[var(--color-private)]">
                    <span class="flex-none pt-px"><Icon name="lock" size={14} /></span>
                    <span>
                      Most sensitive source here, so it never touches the cloud: you pick which projects to
                      import, a local prefilter runs (no LLM triage), and every candidate is private by
                      default until you promote it.
                    </span>
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
                    <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                      <button
                        class={runCls}
                        disabled={app.busy || app.claudeCodeSelected.length === 0}
                        onclick={() => app.importClaudeCode($state.snapshot(app.claudeCodeSelected))}
                      >
                        <Icon name="download" size={17} />
                        Import {app.claudeCodeSelected.length} project{app.claudeCodeSelected.length === 1 ? '' : 's'}
                      </button>
                    </div>
                    {@render saveAsFeedRow('claude-code')}
                  {/if}
                {/snippet}
                {@render bodyOpen(claudeBody)}
              {:else if s.id === 'warp'}
                {#snippet warpBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Zero-auth, import-only. Reads your local Warp Agent-mode history from
                    <code>warp.sqlite</code> and stages one candidate per conversation — your prompts are a
                    timestamped diary of what you were trying to do, pre-anchored to a project by its working
                    directory. One conversation = one candidate; only your typed prompts become the body
                    (Warp keeps the assistant's replies in the cloud, so they're never imported).
                  </p>
                  <p class="flex items-start gap-1.5 text-xs text-[var(--color-private)]">
                    <span class="flex-none pt-px"><Icon name="lock" size={14} /></span>
                    <span>
                      Most sensitive source here, so it never touches the cloud: you pick which projects to
                      import, a local prefilter runs (no LLM triage), and every candidate is private by
                      default until you promote it. Warp's database is opened read-only.
                    </span>
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
                    <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                      <button
                        class={runCls}
                        disabled={app.busy || app.warpSelected.length === 0}
                        onclick={() => app.importWarp($state.snapshot(app.warpSelected))}
                      >
                        <Icon name="download" size={17} />
                        Import {app.warpSelected.length} project{app.warpSelected.length === 1 ? '' : 's'}
                      </button>
                    </div>
                    {@render saveAsFeedRow('warp')}
                  {/if}
                {/snippet}
                {@render bodyOpen(warpBody)}
              {:else if s.id === 'neuroskill'}
                {#snippet neuroskillBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Zero-auth, import-only, all-SQLite. Reads your past EEG sessions from NeuroSkill's
                    <code>activity.sqlite</code> (and optional <code>labels.sqlite</code>) and stages one
                    candidate per focus session — a dated, state-while-working snapshot (focus, engagement,
                    mood, a peak-focus window). One session = one candidate. Only
                    <code>eeg_timeseries</code> and <code>labels</code> are ever read.
                  </p>
                  <p class="flex items-start gap-1.5 text-xs text-[var(--color-private)]">
                    <span class="flex-none pt-px"><Icon name="lock" size={14} /></span>
                    <span>
                      Brain-state is the most private source here, so it never touches the cloud: a local
                      prefilter runs (no LLM triage), short sessions below your threshold are flagged as
                      calibration blips, and every candidate is private by default until you promote it. The
                      NeuroSkill databases are opened read-only.
                    </span>
                  </p>
                  <label class="flex flex-col text-xs text-[var(--color-muted)]">
                    Data directory (holds <code>activity.sqlite</code> + <code>labels.sqlite</code>)
                    <input
                      bind:value={app.importSettings.neuroskill.dataDir}
                      placeholder="e.g. /mnt/c/Users/you/AppData/Local/NeuroSkill"
                      class="{inputCls} w-full max-w-xl font-mono"
                    />
                  </label>
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button
                      class={runCls}
                      disabled={app.busy || !app.importSettings.neuroskill.dataDir.trim()}
                      onclick={() => { persist(); app.importNeuroskill(app.importSettings.neuroskill.dataDir); }}
                    >
                      <Icon name="download" size={17} />
                      Import sessions
                    </button>
                  </div>
                  {@render saveAsFeedRow('neuroskill')}
                {/snippet}
                {@render bodyOpen(neuroskillBody)}
              {:else if s.id === 'linkedin'}
                {#snippet linkedinBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Import-only — LinkedIn has no usable live API. Request your data export (Settings → Data
                    privacy → Get a copy of your data), unzip it, and select the CSVs. Recognized:
                    <code>Positions.csv</code>, <code>Projects.csv</code>, <code>Education.csv</code>.
                  </p>
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button class={runCls} disabled={app.busy} onclick={() => app.importLinkedin()}>
                      <Icon name="upload_file" size={17} />
                      Choose CSVs &amp; import…
                    </button>
                  </div>
                {/snippet}
                {@render bodyOpen(linkedinBody)}
              {:else if s.id === 'resume'}
                {#snippet resumeBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Turn a résumé or CV into a batch of dated candidates — roles, projects, education, and
                    dated wins — so you promote the real ones with one click each instead of retyping a
                    career. Every item carries the verbatim résumé span it came from, so you can see at a
                    glance that nothing was invented. Skills aren't imported here (they belong on your
                    profile, not the timeline).
                  </p>
                  <p class="text-xs text-[var(--color-muted)]">
                    Unlike the other sources, this one needs an LLM to read the prose — there is no local
                    fallback.
                    {#if app.llmConfig?.provider === 'anthropic'}
                      <span class="block text-amber-700 dark:text-amber-300">
                        The résumé text is sent to <strong>Anthropic</strong> to be parsed — content leaves
                        your machine. A résumé is designed to be handed to strangers, but the choice is
                        yours.
                      </span>
                    {/if}
                  </p>
                  {#if !app.llmReady || !app.docsAvailable}
                    <p class="flex items-start gap-1.5 text-xs text-[var(--color-private)]">
                      <span class="flex-none pt-px"><Icon name="info" size={15} /></span>
                      <span>
                        {#if !app.docsAvailable}
                          Document reading isn't available in this build yet.
                        {:else}
                          Configure an AI provider in Data → AI provider first.
                        {/if}
                      </span>
                    </p>
                  {/if}
                  <label class="flex items-start gap-2 text-xs text-[var(--color-muted)]">
                    <input
                      type="checkbox"
                      class="mt-0.5"
                      bind:checked={app.importSettings.resume.allowUndated}
                      onchange={() => app.saveImportSettings($state.snapshot(app.importSettings))}
                    />
                    <span>
                      Allow undated items — keep roles/wins the parser can't date. They stage to the
                      <a href="/inbox" class="text-[var(--color-accent)] hover:underline">Inbox</a> flagged
                      <em>needs date</em>; you set a date there before promoting. Nothing is ever dated to today.
                    </span>
                  </label>
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button
                      class={runCls}
                      disabled={app.busy || !app.llmReady || !app.docsAvailable}
                      onclick={() => app.importResume()}
                    >
                      <Icon name="upload_file" size={17} />
                      Choose a résumé &amp; import…
                    </button>
                  </div>
                {/snippet}
                {@render bodyOpen(resumeBody)}
              {:else if s.id === 'website'}
                {#snippet websiteBody()}
                  <p class="text-xs text-[var(--color-muted)]">
                    Pull the dated spine — roles, projects, education, wins — out of your own personal
                    site so you promote the real ones with one click each. These candidates are
                    <em>polished-derived</em>: a website is an outward-facing artifact, so treat each one
                    as a prompt to write the rawer, more accurate truth underneath. Every item carries the
                    verbatim page span it came from, and lands private until you promote it.
                  </p>
                  <p class="text-xs text-[var(--color-muted)]">
                    Like Résumé, this one needs an LLM to read the prose — there is no local fallback.
                    {#if app.llmConfig?.provider === 'anthropic'}
                      <span class="block text-amber-700 dark:text-amber-300">
                        The fetched page text is sent to <strong>Anthropic</strong> to be structured —
                        content leaves your machine. These are your own public pages, but the choice is
                        yours.
                      </span>
                    {/if}
                  </p>
                  <p class="flex items-start gap-1.5 text-xs text-[var(--color-muted)]">
                    <span class="flex-none pt-px"><Icon name="info" size={15} /></span>
                    <span>
                      Not a crawler: it fetches only the URLs you enter (and a sitemap you point at),
                      server-rendered public pages only — no login, no following links it finds, no
                      JavaScript-rendered apps.
                    </span>
                  </p>
                  {#if !app.llmReady}
                    <p class="flex items-start gap-1.5 text-xs text-[var(--color-private)]">
                      <span class="flex-none pt-px"><Icon name="info" size={15} /></span>
                      <span>Configure an AI provider in Data → AI provider first.</span>
                    </p>
                  {/if}
                  <div class="flex flex-col gap-2">
                    <label class="flex flex-col text-xs text-[var(--color-muted)]">
                      Page URLs (one per line)
                      <textarea
                        bind:value={app.importSettings.website.urls}
                        rows="3"
                        placeholder={'https://you.example/about\nhttps://you.example/projects'}
                        class="{inputCls} w-full font-mono"
                      ></textarea>
                    </label>
                    <div class="flex flex-wrap items-end gap-2">
                      <label class="flex flex-1 flex-col text-xs text-[var(--color-muted)]">
                        Sitemap URL (optional)
                        <input
                          bind:value={app.importSettings.website.sitemapUrl}
                          placeholder="https://you.example/sitemap.xml"
                          class="{inputCls} w-full"
                        />
                      </label>
                      <label class="flex flex-col text-xs text-[var(--color-muted)]">
                        Max pages
                        <input
                          type="number"
                          min="1"
                          max="100"
                          bind:value={app.importSettings.website.maxPages}
                          class="{inputCls} w-24"
                        />
                      </label>
                    </div>
                  </div>
                  <label class="flex items-start gap-2 text-xs text-[var(--color-muted)]">
                    <input
                      type="checkbox"
                      class="mt-0.5"
                      bind:checked={app.importSettings.website.allowUndated}
                      onchange={() => app.saveImportSettings($state.snapshot(app.importSettings))}
                    />
                    <span>
                      Allow undated items — keep entries the parser can't date; set their dates in the Inbox
                      before promoting. Never dated to today.
                    </span>
                  </label>
                  <div class="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-3">
                    <button
                      class={runCls}
                      disabled={app.busy || !app.llmReady || websiteEmpty}
                      onclick={runWebsite}
                    >
                      <Icon name="sync" size={17} />
                      Run website import
                    </button>
                  </div>
                  {#if app.pendingIdentityProposal}
                    <IdentityMergeReview proposal={app.pendingIdentityProposal} />
                  {/if}
                  {@render saveAsFeedRow('website')}
                {/snippet}
                {@render bodyOpen(websiteBody)}
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>
