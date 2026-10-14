import { scrollbarOwners } from '../scrollbars/ownership';

export interface SmoothScrollingOptions {
  navigation: boolean;
  wheel: boolean;
}

interface Motion {
  from: number;
  target: number;
  last: number;
  started: number;
  horizontal: boolean;
}

/** WheelEvent exposes no device type. Only clearly stepped input is enhanced. */
function isSteppedWheel(event: WheelEvent) {
  if (event.deltaMode !== 0) return true;
  if (event.deltaX && event.deltaY) return false;
  const delta = Math.abs(event.deltaY || event.deltaX);
  return delta >= 40 && Number.isInteger(delta) && (delta % 40 === 0 || delta % 50 === 0);
}

export function initializeSmoothScrolling(initial: SmoothScrollingOptions) {
  let options = initial;
  const root = document.documentElement;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const motions = new Map<HTMLElement, Motion>();
  let frame: number | null = null;
  let continuousUntil = 0;
  const coordinate = (element: HTMLElement, horizontal: boolean) => horizontal ? element.scrollLeft : element.scrollTop;
  const maximum = (element: HTMLElement, horizontal: boolean) => Math.max(0, horizontal
    ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight);
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    motions.clear();
  };
  const animate = (now: number) => {
    frame = null;
    for (const [element, motion] of motions) {
      // A restore, synchronized pane or another input now owns this position.
      if (!element.isConnected || Math.abs(coordinate(element, motion.horizontal) - motion.last) > 1) {
        motions.delete(element);
        continue;
      }
      motion.target = Math.max(0, Math.min(maximum(element, motion.horizontal), motion.target));
      const progress = Math.min(1, Math.max(0, (now - motion.started) / 160));
      const next = motion.from + (motion.target - motion.from) * (1 - (1 - progress) ** 3);
      if (motion.horizontal) element.scrollLeft = next;
      else element.scrollTop = next;
      motion.last = coordinate(element, motion.horizontal);
      if (progress === 1) motions.delete(element);
    }
    if (motions.size) frame = requestAnimationFrame(animate);
  };
  const deltas = (element: HTMLElement, event: WheelEvent) => {
    const horizontal = event.shiftKey || !event.deltaY && !!event.deltaX;
    const delta = horizontal ? event.deltaX || event.deltaY : event.deltaY;
    const unit = event.deltaMode === 1 ? Number.parseFloat(getComputedStyle(element).lineHeight) || 20
      : event.deltaMode === 2 ? horizontal ? element.clientWidth : element.clientHeight : 1;
    return { horizontal, delta: delta * unit };
  };
  const canHandle = (event: WheelEvent) => {
    if (!isSteppedWheel(event)) {
      // Keep the whole precise-input gesture native, including coarse samples in its inertia tail.
      continuousUntil = performance.now() + 300;
      return false;
    }
    return options.wheel && !reducedMotion?.matches && performance.now() >= continuousUntil
      && !event.ctrlKey && !event.metaKey && !event.altKey && event.cancelable;
  };
  const handleWheel = (element: HTMLElement, event: WheelEvent) => {
    if (!canHandle(event)) { stop(); return false; }
    const { horizontal, delta } = deltas(element, event);
    // Leave RTL scrolling to the webview's native coordinate convention.
    if (!delta || horizontal && getComputedStyle(element).direction === 'rtl') return false;
    const current = coordinate(element, horizontal);
    const previous = motions.get(element);
    const continuing = previous?.horizontal === horizontal && Math.abs(current - previous.last) <= 1
      && Math.sign(previous.target - current) === Math.sign(delta);
    const target = Math.max(0, Math.min(maximum(element, horizontal), (continuing ? previous.target : current) + delta));
    if (target === current) {
      // A reversal at the boundary must also discard the previous pending movement.
      motions.delete(element);
      if (!motions.size && frame !== null) { cancelAnimationFrame(frame); frame = null; }
      return false;
    }
    event.preventDefault();
    motions.set(element, { from: current, target, last: current, started: performance.now(), horizontal });
    if (frame === null) frame = requestAnimationFrame(animate);
    return true;
  };
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented) return;
    if (!canHandle(event)) { stop(); return; }
    const target = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement);
    if (target?.closest('select, input[type="number"], input[type="range"]')) { stop(); return; }
    const overlay = target?.closest('[data-versiondock-scrollbar-viewport]');
    const mergeTrack = target?.closest('[data-versiondock-overlay-scrollbar]');
    const owner = overlay ? scrollbarOwners.get(overlay) : mergeTrack
      ?.closest('[data-versiondock-scrollbar-container]')?.querySelector<HTMLElement>('[data-merge-pane]');
    for (let element = owner ?? target; element instanceof HTMLElement; element = element.parentElement ?? undefined) {
      const { horizontal } = deltas(element, event);
      const style = getComputedStyle(element);
      if (/auto|scroll/.test(horizontal ? style.overflowX : style.overflowY)) {
        if (handleWheel(element, event)) return;
        // Preserve scroll containment at the edge of a nested panel.
        if (['contain', 'none'].includes(horizontal ? style.overscrollBehaviorX : style.overscrollBehaviorY)) return;
      }
    }
  };
  const onVisibility = () => { if (document.hidden) stop(); };
  document.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('keydown', stop, true);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', stop);
  reducedMotion?.addEventListener('change', stop);
  const configure = (next: SmoothScrollingOptions) => {
    if (options.navigation !== next.navigation || options.wheel !== next.wheel) stop();
    options = next;
    root.dataset.versiondockSmoothScrolling = String(options.navigation);
  };
  configure(initial);
  return {
    handleWheel,
    configure,
    dispose() {
      stop();
      delete root.dataset.versiondockSmoothScrolling;
      document.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerdown', stop, true);
      document.removeEventListener('keydown', stop, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', stop);
      reducedMotion?.removeEventListener('change', stop);
    },
  };
}
