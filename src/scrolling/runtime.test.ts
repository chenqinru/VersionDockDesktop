import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeSmoothScrolling } from './runtime';
import { navigationScrollBehavior, scrollToPosition } from './navigation';
import { scrollbarOwners } from '../scrollbars/ownership';

let runtime: ReturnType<typeof initializeSmoothScrolling>;
let frames: Map<number, FrameRequestCallback>;
let clock: number;
let media: MediaQueryList;

function scroller(parent: HTMLElement = document.body) {
  const element = document.createElement('div');
  element.style.overflowY = 'auto';
  element.style.overflowX = 'auto';
  Object.defineProperties(element, {
    clientHeight: { value: 100, configurable: true }, scrollHeight: { value: 1000, configurable: true },
    clientWidth: { value: 100, configurable: true }, scrollWidth: { value: 1000, configurable: true },
  });
  parent.append(element);
  return element;
}
function wheel(element: Element, deltaY = 100, init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}
function advance(ms: number) {
  clock += ms;
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(clock));
}

beforeEach(() => {
  clock = 0;
  frames = new Map();
  let sequence = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  media = Object.assign(new EventTarget(), { matches: false }) as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', () => media);
  runtime = initializeSmoothScrolling({ navigation: true, wheel: true });
});
afterEach(() => {
  runtime.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('smooth scrolling', () => {
  it('animates stepped wheels and accumulates rapid steps without dropping distance', () => {
    const element = scroller();
    expect(wheel(element).defaultPrevented).toBe(true);
    expect(element.scrollTop).toBe(0);
    advance(40);
    expect(element.scrollTop).toBeGreaterThan(0);
    expect(element.scrollTop).toBeLessThan(100);
    wheel(element);
    advance(160);
    expect(element.scrollTop).toBe(200);
    expect(frames.size).toBe(0);
  });

  it('reverses direction immediately and cancels when direct manipulation starts', () => {
    const element = scroller(); element.scrollTop = 300;
    wheel(element); advance(40);
    const position = element.scrollTop;
    wheel(element, -100); advance(160);
    expect(element.scrollTop).toBeCloseTo(position - 100);
    wheel(element);
    element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    element.scrollTop = 800;
    advance(200);
    expect(element.scrollTop).toBe(800);
    expect(frames.size).toBe(0);
  });

  it('cancels a pending step when input reverses at the boundary before the first frame', () => {
    const element = scroller();
    wheel(element);
    expect(wheel(element, -100).defaultPrevented).toBe(false);
    advance(160);
    expect(element.scrollTop).toBe(0);
    expect(frames.size).toBe(0);
  });

  it('keeps precise touchpad gestures and their inertia native and cancels pending animation', () => {
    const element = scroller();
    wheel(element); advance(30);
    const position = element.scrollTop;
    expect(wheel(element, 3.5).defaultPrevented).toBe(false);
    expect(wheel(element, 80).defaultPrevented).toBe(false);
    advance(160);
    expect(element.scrollTop).toBe(position);
    advance(301);
    expect(wheel(element).defaultPrevented).toBe(true);
  });

  it('does not intercept zoom, diagonal gestures, prevented or noncancelable events', () => {
    const element = scroller();
    expect(wheel(element, 100, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(element, 100, { metaKey: true }).defaultPrevented).toBe(false);
    expect(wheel(element, 100, { cancelable: false }).defaultPrevented).toBe(false);
    expect(wheel(element, 100, { deltaX: 20 }).defaultPrevented).toBe(false);
    advance(301);
    element.addEventListener('wheel', event => event.preventDefault(), { once: true });
    wheel(element);
    advance(200);
    expect(element.scrollTop).toBe(0);
  });

  it('normalizes line/page units and supports horizontal and shift scrolling', () => {
    const element = scroller(); element.style.lineHeight = '24px';
    wheel(element, 3, { deltaMode: 1 }); advance(160);
    expect(element.scrollTop).toBe(72);
    wheel(element, 1, { deltaMode: 2 }); advance(160);
    expect(element.scrollTop).toBe(172);
    wheel(element, 100, { shiftKey: true }); advance(160);
    expect(element.scrollLeft).toBe(100);
    wheel(element, 0, { deltaX: 100 }); advance(160);
    expect(element.scrollLeft).toBe(200);
  });

  it('chooses the nearest scrollable panel, chains at its edge and honors containment', () => {
    const parent = scroller();
    const child = scroller(parent);
    wheel(child); advance(160);
    expect(child.scrollTop).toBe(100);
    expect(parent.scrollTop).toBe(0);
    child.scrollTop = 900;
    wheel(child); advance(160);
    expect(parent.scrollTop).toBe(100);
    child.style.overscrollBehaviorY = 'contain';
    expect(wheel(child).defaultPrevented).toBe(false);
    advance(160);
    expect(parent.scrollTop).toBe(100);
  });

  it('resolves portalled and custom merge scrollbars to their content', () => {
    const element = scroller();
    const viewport = document.createElement('div');
    viewport.dataset.versiondockScrollbarViewport = '';
    document.body.append(viewport);
    scrollbarOwners.set(viewport, element);
    wheel(viewport); advance(160);
    expect(element.scrollTop).toBe(100);
    const frame = document.createElement('div');
    frame.dataset.versiondockScrollbarContainer = '';
    document.body.append(frame);
    const pane = scroller(frame); pane.dataset.mergePane = 'center';
    const track = document.createElement('div'); track.dataset.versiondockOverlayScrollbar = 'vertical'; frame.append(track);
    wheel(track); advance(160);
    expect(pane.scrollTop).toBe(100);
  });

  it('stops when a container is removed, restored externally or interrupted by the keyboard', () => {
    const removed = scroller(); wheel(removed); removed.remove(); advance(160);
    expect(removed.scrollTop).toBe(0);
    const element = scroller(); wheel(element); advance(40);
    element.scrollTop = 400; advance(160);
    expect(element.scrollTop).toBe(400);
    wheel(element); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' })); advance(160);
    expect(element.scrollTop).toBe(400);
  });

  it('clamps to the current content size when filtering shortens a list during animation', () => {
    const element = scroller(); wheel(element, 800); advance(40);
    Object.defineProperty(element, 'scrollHeight', { value: 300, configurable: true });
    advance(160);
    expect(element.scrollTop).toBe(200);
  });

  it('applies settings immediately and respects live reduced-motion changes for both kinds of scrolling', () => {
    const element = scroller();
    expect(navigationScrollBehavior()).toBe('smooth');
    runtime.configure({ navigation: false, wheel: false });
    expect(navigationScrollBehavior()).toBe('instant');
    expect(wheel(element).defaultPrevented).toBe(false);
    runtime.configure({ navigation: true, wheel: true });
    wheel(element); advance(40);
    const position = element.scrollTop;
    Object.defineProperty(media, 'matches', { value: true }); media.dispatchEvent(new Event('change'));
    advance(160);
    expect(element.scrollTop).toBe(position);
    expect(navigationScrollBehavior()).toBe('instant');
    expect(wheel(element).defaultPrevented).toBe(false);
  });

  it('uses the navigation policy for explicit positions and cleans up all listeners on disposal', () => {
    const element = scroller(); element.scrollTo = vi.fn();
    scrollToPosition(element, { top: 200 });
    expect(element.scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'smooth' });
    runtime.configure({ navigation: false, wheel: true });
    scrollToPosition(element, { top: 300 });
    expect(element.scrollTo).toHaveBeenLastCalledWith({ top: 300, behavior: 'instant' });
    wheel(element); runtime.dispose();
    advance(200);
    expect(element.scrollTop).toBe(0);
    expect(wheel(element).defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
    expect(document.documentElement.dataset.versiondockSmoothScrolling).toBeUndefined();
  });
});
