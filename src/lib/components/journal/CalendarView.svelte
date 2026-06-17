<script lang="ts">
  import type { Entry } from '$lib/core';
  import { typeMeta } from '$lib/journal/theme';
  import { fmtDay, monthShortYear } from '$lib/journal/grouping';

  let {
    entries,
    selectedDay,
    onselectday,
    projectTitle,
    anchor
  }: {
    entries: Entry[];
    selectedDay: string;
    onselectday: (date: string) => void;
    projectTitle: (slug: string) => string;
    /** Today (YYYY-MM-DD) — the trailing 53-week window ends the Saturday on/
     * after this date. */
    anchor: string;
  } = $props();

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (d: Date, n: number) => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  };

  /** Accent ramp: 0 empty, then ~30/50/70/100% as the day's count climbs. */
  function cellBg(c: number): string {
    if (c >= 4) return 'var(--color-accent)';
    if (c === 3) return 'color-mix(in srgb, var(--color-accent) 70%, transparent)';
    if (c === 2) return 'color-mix(in srgb, var(--color-accent) 50%, transparent)';
    if (c === 1) return 'color-mix(in srgb, var(--color-accent) 30%, transparent)';
    return 'var(--jv-heat-empty)';
  }

  const counts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const e of entries) {
      const d = String(e.frontmatter.date);
      m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  });

  // 53 Sunday-started week columns ending the Saturday on/after the anchor.
  const weeks = $derived.by(() => {
    const a = new Date(anchor + 'T00:00:00Z');
    const end = addDays(a, 6 - a.getUTCDay()); // Saturday of the anchor's week
    let cur = addDays(end, -(52 * 7 + 6)); // back to the first Sunday
    let prevMonth = -1;
    const out: { key: string; monthLabel: string; days: { key: string; count: number }[] }[] = [];
    for (let w = 0; w < 53; w++) {
      const days: { key: string; count: number }[] = [];
      let monthLabel = '';
      for (let i = 0; i < 7; i++) {
        const k = iso(cur);
        if (i === 0) {
          const mo = cur.getUTCMonth();
          if (mo !== prevMonth) {
            monthLabel = MONTHS[mo];
            prevMonth = mo;
          }
        }
        days.push({ key: k, count: counts.get(k) ?? 0 });
        cur = addDays(cur, 1);
      }
      out.push({ key: 'w' + w, monthLabel, days });
    }
    return out;
  });

  const activeDays = $derived(counts.size);
  const busiestMonth = $derived.by(() => {
    const tally = new Map<string, number>();
    for (const e of entries) {
      const k = String(e.frontmatter.date).slice(0, 7);
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    let bestKey = '';
    let bestN = -1;
    for (const [k, n] of tally) if (n > bestN) ((bestKey = k), (bestN = n));
    return bestKey ? monthShortYear(bestKey) : '—';
  });

  const selectedRows = $derived(
    selectedDay ? entries.filter((e) => String(e.frontmatter.date) === selectedDay) : []
  );

  function excerpt(body: string): string {
    return body.length > 180 ? body.slice(0, 180).trimEnd() + '…' : body;
  }
</script>

<div class="mt-4 flex flex-col gap-[14px]">
  <div class="rounded-[14px] border border-[var(--color-line)] bg-white dark:bg-[var(--color-bar)]" style="padding:18px 20px;">
    <!-- Summary stats -->
    <div class="mb-4 flex flex-wrap gap-6">
      <div>
        <div class="text-[22px] font-[650] tracking-[-0.01em]">{entries.length}</div>
        <div class="text-[11px] uppercase tracking-[0.04em] text-[var(--jv-date)]">entries in range</div>
      </div>
      <div>
        <div class="text-[22px] font-[650] tracking-[-0.01em]">{busiestMonth}</div>
        <div class="text-[11px] uppercase tracking-[0.04em] text-[var(--jv-date)]">most active month</div>
      </div>
      <div>
        <div class="text-[22px] font-[650] tracking-[-0.01em]">{activeDays}</div>
        <div class="text-[11px] uppercase tracking-[0.04em] text-[var(--jv-date)]">active days</div>
      </div>
    </div>

    <!-- Heatmap grid -->
    <div class="overflow-x-auto pb-1.5">
      <div class="flex min-w-max items-start gap-[9px]">
        <div class="flex flex-col gap-[3px] pt-4">
          {#each WEEKDAY_LABELS as w, i (i)}
            <div class="h-[13px] w-6 text-right text-[9px] leading-[13px] text-[var(--jv-faint)]">{w}</div>
          {/each}
        </div>
        <div class="flex gap-[3px]">
          {#each weeks as wk (wk.key)}
            <div class="flex flex-col gap-[3px]">
              <div class="h-[13px] whitespace-nowrap text-[9px] leading-[13px] text-[var(--jv-date)]">
                {wk.monthLabel}
              </div>
              {#each wk.days as day (day.key)}
                <button
                  onclick={() => onselectday(day.key)}
                  title="{fmtDay(day.key)}  ·  {day.count} {day.count === 1 ? 'entry' : 'entries'}"
                  aria-label="{fmtDay(day.key)}, {day.count} entries"
                  class="size-[13px] cursor-pointer rounded-[3px] p-0"
                  style="background:{cellBg(day.count)};border:{selectedDay === day.key
                    ? '2px solid var(--color-accent)'
                    : '1px solid color-mix(in srgb, var(--color-ink) 6%, transparent)'};"
                ></button>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Legend -->
    <div class="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--jv-date)]">
      <span>Less</span>
      {#each [0, 1, 2, 3, 4] as c (c)}
        <span
          class="inline-block size-[13px] rounded-[3px]"
          style="background:{cellBg(c)};border:1px solid color-mix(in srgb, var(--color-ink) 6%, transparent);"
        ></span>
      {/each}
      <span>More</span>
      <span class="ml-auto">Click a day to see its entries</span>
    </div>
  </div>

  <!-- Selected-day panel -->
  {#if selectedDay}
    <div
      class="jv-rise rounded-[14px] border border-[var(--color-line)] bg-white dark:bg-[var(--color-bar)]"
      style="padding:14px 16px;"
    >
      <div class="mb-2 flex items-center justify-between">
        <span class="text-[14px] font-semibold">{fmtDay(selectedDay)}</span>
        <button
          onclick={() => onselectday(selectedDay)}
          class="cursor-pointer border-none bg-transparent text-[12px] text-[var(--jv-date)]">✕ close</button
        >
      </div>
      {#if selectedRows.length === 0}
        <p class="m-0 py-3 text-[13px] text-[var(--jv-date)]">No entries on this day.</p>
      {:else}
        <div class="flex flex-col gap-1.5">
          {#each selectedRows as e (e.frontmatter.id)}
            {@const meta = typeMeta(String(e.frontmatter.type))}
            {@const slug = typeof e.frontmatter.project === 'string' ? (e.frontmatter.project as string) : ''}
            <div class="rounded-[9px] border border-[var(--jv-rail)] bg-[var(--jv-row-detail)]" style="padding:10px 12px;">
              <div class="flex items-center gap-[9px]">
                <span class="size-[7px] shrink-0 rounded-[2px]" style="background:{meta.color}"></span>
                <span class="text-[11px] font-semibold" style="color:{meta.color}">{meta.label}</span>
                <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-ink)]"
                  >{e.frontmatter.title}</span
                >
                {#if slug}<span class="text-[11px] text-[var(--jv-faint)]">{projectTitle(slug)}</span>{/if}
              </div>
              {#if e.body.trim()}
                <p class="mb-0 mt-1.5 text-[12px] leading-[1.5] text-[var(--color-muted)]">{excerpt(e.body)}</p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
