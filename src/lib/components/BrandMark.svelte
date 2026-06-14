<script lang="ts">
  // The Who Am I brand mark: a stylized fingerprint — the app is a record of a
  // single, specific person, so identity is literally the logo. Drawn as inline
  // SVG (no external asset, no icon font) using `currentColor` so it can be
  // recolored per surface; defaults to the accent.
  let {
    size = 16,
    color = 'var(--color-accent)'
  }: {
    size?: number;
    color?: string;
  } = $props();
</script>

<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  style="color: {color}; flex-shrink: 0;"
>
  <path d="M5.4 11.5a6.6 6.6 0 0 1 12.5-2.7" />
  <path d="M17.7 12.6a12 12 0 0 1-1.4 7.2" />
  <path d="M9 12.2a3 3 0 0 1 6 .3c.1 2.9-.5 5.7-1.9 8.3" />
  <path d="M12.2 12.6a0.7 0.7 0 0 1 1.4.2c.1 2.6-.4 5.2-1.6 7.5" />
  <path d="M6.6 16c.5 1.4.6 3 .2 4.4" />
</svg>
