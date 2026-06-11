/**
 * WebKitGTK — the webview Tauri uses on Linux/WSL — does not dismiss the native
 * `<input type="date">` calendar popover when you click outside it (unlike
 * Chromium). Blurring the input closes the popover, so on any pointer-down that
 * lands outside the input we blur it.
 *
 * Pointer-downs on the GTK calendar popover itself are dispatched to a separate
 * native surface and never reach `window`, so interacting with the calendar
 * doesn't trigger a blur.
 */
export function closeDatePicker(node: HTMLInputElement) {
  function onPointerDown(event: PointerEvent) {
    if (document.activeElement === node && !node.contains(event.target as Node)) {
      node.blur();
    }
  }

  // Capture phase so we still see the event if something downstream stops it.
  window.addEventListener('pointerdown', onPointerDown, true);

  return {
    destroy() {
      window.removeEventListener('pointerdown', onPointerDown, true);
    }
  };
}
