/* global URLSearchParams, location, document, window, setTimeout, clearTimeout, requestAnimationFrame, console */
const params = new URLSearchParams(location.search);
const name = params.get('name') || '';
const theme = params.get('theme');
const initials = params.get('initials');
const color = params.get('color');

document.body.classList.toggle('light', theme === 'light');
document.body.classList.toggle('show-detach-badge', params.get('detachBadge') === 'true');
const titleEl = document.querySelector('span.titlebar-tab-title');
if (titleEl) {
  titleEl.textContent = name;
}

const iconEl = document.querySelector('.project-icon');
const lettersEl = document.querySelector('.project-icon-letters');

if (iconEl && lettersEl) {
  const resolvedInitials = initials || (name ? name.slice(0, 1).toUpperCase() : '?');
  lettersEl.textContent = resolvedInitials;
  if (resolvedInitials.length > 1) {
    iconEl.classList.add('two-letters');
  }
  if (color) {
    iconEl.style.backgroundColor = color;
  }
}

// This small standalone page has no bundled API imports. Use the same event
// command as @tauri-apps/api/event after its text, icon and styles are laid out.
const readyEvent = params.get('readyEvent');
const source = params.get('source');
if (readyEvent && source && window.__TAURI_INTERNALS__) {
  let signalled = false;
  const signalReady = () => {
    if (signalled) return;
    signalled = true;
    clearTimeout(fallback);
    document.body.getBoundingClientRect();
    void window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
      target: { kind: 'AnyLabel', label: source },
      event: readyEvent,
      payload: null,
    }).catch((error) => console.warn('Unable to signal tab preview readiness', error));
  };
  // Older hosts can suspend animation frames in hidden windows. Their fallback
  // still waits for layout, with a native background matching this page's theme.
  const fallback = setTimeout(signalReady, 80);
  requestAnimationFrame(() => requestAnimationFrame(signalReady));
}
