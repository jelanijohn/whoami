<script lang="ts">
  import { app } from '$lib/state.svelte';
  import {
    DEFAULT_OLLAMA_URL,
    DEFAULT_OLLAMA_MODEL,
    DEFAULT_ANTHROPIC_MODEL,
    type LlmProvider
  } from '$lib/core';

  let lastRebuild = $state<string | null>(null);
  let commitMsg = $state('');

  async function refreshMeta() {
    lastRebuild = app.store ? await app.store.lastRebuild() : null;
  }
  $effect(() => {
    void app.entries;
    if (app.store) refreshMeta();
  });

  async function doSync() {
    await app.sync(commitMsg.trim() || undefined);
    commitMsg = '';
  }

  // --- LLM provider settings (plan §3) --------------------------------------
  let provider = $state<LlmProvider>(app.llmConfig?.provider ?? 'ollama');
  let model = $state(app.llmConfig?.model ?? DEFAULT_OLLAMA_MODEL);
  let baseUrl = $state(app.llmConfig?.baseUrl ?? DEFAULT_OLLAMA_URL);
  let anthropicKey = $state('');

  function onProviderChange() {
    // Offer a sensible default model when the provider flips.
    if (provider === 'ollama' && (!model || model.startsWith('claude'))) model = DEFAULT_OLLAMA_MODEL;
    if (provider === 'anthropic' && (!model || !model.startsWith('claude')))
      model = DEFAULT_ANTHROPIC_MODEL;
  }

  async function saveLlm() {
    await app.saveLlmConfig({
      provider,
      model: model.trim(),
      ...(provider === 'ollama' ? { baseUrl: baseUrl.trim() || DEFAULT_OLLAMA_URL } : {})
    });
  }

  async function saveKey() {
    await app.setAnthropicKey(anthropicKey);
    anthropicKey = '';
  }
</script>

<div class="max-w-2xl space-y-6">
  <section>
    <h1 class="text-lg font-semibold">Data &amp; sync</h1>
    <p class="mt-1 text-sm text-[var(--color-muted)]">
      The text files are canonical. The index is a throwaway cache you can rebuild any time without
      data loss.
    </p>
    <dl class="mt-3 space-y-1 text-sm">
      <div class="flex gap-2">
        <dt class="w-32 text-[var(--color-muted)]">Record folder</dt>
        <dd class="font-mono text-xs break-all">{app.recordRoot}</dd>
      </div>
      <div class="flex gap-2">
        <dt class="w-32 text-[var(--color-muted)]">Entries indexed</dt>
        <dd>{app.entries.length}{app.includePrivate ? '' : ' (public)'}</dd>
      </div>
      <div class="flex gap-2">
        <dt class="w-32 text-[var(--color-muted)]">Last reindex</dt>
        <dd>{lastRebuild ?? '—'}</dd>
      </div>
    </dl>
  </section>

  <section class="space-y-2">
    <h2 class="text-sm font-semibold">Index</h2>
    <div class="flex gap-2">
      <button class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50" disabled={app.busy} onclick={() => app.reindex(false)}>
        Reindex (incremental)
      </button>
      <button class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50" disabled={app.busy} onclick={() => app.reindex(true)}>
        Full rebuild (nuke &amp; rebuild)
      </button>
    </div>
    <p class="text-xs text-[var(--color-muted)]">
      Dashboard looks stale? Rebuild. You cannot lose data this way — it reparses the text.
    </p>
  </section>

  <section class="space-y-2">
    <h2 class="text-sm font-semibold">AI provider (optional)</h2>
    <p class="text-xs text-[var(--color-muted)]">
      Powers the per-project retrospective (Stage 2). Entirely optional — the project rollup works
      without it. Your settings live on this machine, never in the record repo; an Anthropic key is
      stored in the OS keyring, never in a file.
    </p>
    <div class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Provider
        <select
          bind:value={provider}
          onchange={onProviderChange}
          class="mt-0.5 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
        >
          <option value="ollama">Ollama (local)</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label class="flex flex-col text-xs text-[var(--color-muted)]">
        Model
        <input
          bind:value={model}
          class="mt-0.5 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
        />
      </label>
      {#if provider === 'ollama'}
        <label class="flex flex-col text-xs text-[var(--color-muted)]">
          Base URL
          <input
            bind:value={baseUrl}
            class="mt-0.5 w-56 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
          />
        </label>
      {/if}
      <button
        class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50"
        disabled={app.busy}
        onclick={saveLlm}
      >
        Save provider
      </button>
    </div>

    {#if provider === 'anthropic'}
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex flex-col text-xs text-[var(--color-muted)]">
          Anthropic API key (stored in keyring)
          <input
            type="password"
            bind:value={anthropicKey}
            placeholder="sk-ant-…"
            class="mt-0.5 w-64 rounded border border-[var(--color-line)] px-2 py-1.5 text-sm"
          />
        </label>
        <button
          class="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-gray-50"
          disabled={app.busy || !anthropicKey.trim()}
          onclick={saveKey}
        >
          Save key
        </button>
      </div>
    {/if}

    <div class="flex items-center gap-2">
      <button
        class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        disabled={app.busy || !app.llmReady}
        onclick={() => app.testLlm()}
      >
        Test connection
      </button>
      <span class="text-xs text-[var(--color-muted)]">
        {#if app.llmReady}
          Ready · {app.llmConfig?.provider} ({app.llmConfig?.model})
        {:else if app.llmConfig}
          Saved, but not ready (key missing or no platform support)
        {:else}
          No provider configured
        {/if}
      </span>
    </div>
  </section>

  <section class="space-y-2">
    <h2 class="text-sm font-semibold">Git sync</h2>
    {#if app.git && !app.git.isRepo}
      <div class="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        This folder isn't a Git repository yet.
        <button class="ml-2 rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white" onclick={() => app.gitInit()}>
          Initialize git
        </button>
        <p class="mt-1 text-xs">Then add a private remote with <code>git remote add origin …</code> from a terminal.</p>
      </div>
    {:else}
      <div class="flex gap-2">
        <input
          bind:value={commitMsg}
          placeholder="commit message (optional)"
          class="flex-1 rounded border border-[var(--color-line)] px-3 py-1.5 text-sm"
        />
        <button class="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={app.busy} onclick={doSync}>
          Sync now
        </button>
      </div>
      <p class="text-xs text-[var(--color-muted)]">
        Sync runs <code>git pull --rebase</code>, then <code>add</code>/<code>commit</code>/<code>push</code>.
        It never pushes silently or auto-resolves conflicts — a conflict stops and waits for you.
      </p>
    {/if}
  </section>
</div>
