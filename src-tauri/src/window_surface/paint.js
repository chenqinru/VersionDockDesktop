/* global window, document, requestAnimationFrame */
/* eslint-disable @typescript-eslint/no-unused-expressions -- Rust invokes this function with a per-frame event and viewport. */
(function (event, target) {
  let remaining = 12;
  const send = () => {
    const payload = {
      width: window.innerWidth,
      height: window.innerHeight,
      visible: !document.hidden,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    void window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload }).catch(() => {});
  };
  if (document.hidden) { send(); return; }
  const frame = () => {
    if (--remaining <= 0) return;
    if (target && (Math.abs(window.innerWidth - target.width) > 1 || Math.abs(window.innerHeight - target.height) > 1)) {
      requestAnimationFrame(frame);
      return;
    }
    // A second callback allows a paint at the new viewport between callbacks.
    requestAnimationFrame(send);
  };
  requestAnimationFrame(frame);
})
