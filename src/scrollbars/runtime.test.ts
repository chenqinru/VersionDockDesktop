import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeGlobalScrollbars } from './runtime';
import { scrollbarContains } from './ownership';

let dispose: (() => void) | undefined;
let hit: Element | undefined;
let frames: Map<number, FrameRequestCallback>;
let sequence = 0;

function flush() {
  const batch = [...frames.values()];
  frames.clear();
  batch.forEach(callback => callback(0));
}

function scroller() {
  const element = document.createElement('div');
  element.style.overflowX = 'auto';
  element.style.overflowY = 'auto';
  const content = document.createElement('div');
  element.append(content);
  document.body.append(element);
  Object.defineProperties(element, {
    clientHeight: { value: 100 }, clientWidth: { value: 200 },
    offsetHeight: { value: 100 }, offsetWidth: { value: 200 },
    scrollHeight: { value: 1000 }, scrollWidth: { value: 1000 },
  });
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  hit = content;
  return element;
}

beforeEach(() => {
  frames = new Map();
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(document, 'querySelectorAll').mockImplementation(((selector: string) => document.documentElement.querySelectorAll(selector === ':hover' ? '[data-test-no-hover]' : selector)) as typeof document.querySelectorAll);
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => hit ? [hit] : [] });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit ?? null });
});

afterEach(() => {
  dispose?.(); dispose = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('global scrollbar runtime', () => {
  it('keeps system mode intact and cleans up after repeated forced modes', () => {
    const element = scroller(); element.scrollTop = 150;
    dispose = initializeGlobalScrollbars({ visibility: 'system', modernUi: false, language: 'en' }).dispose;
    flush(); expect(document.querySelector('[data-versiondock-scrollbar-layer]')).toBeNull();
    dispose();
    for (let i = 0; i < 3; i++) {
      dispose = initializeGlobalScrollbars({ visibility: 'visible', modernUi: true, language: 'en' }).dispose;
      flush();
      expect(document.querySelectorAll('[data-versiondock-scrollbar-layer]')).toHaveLength(1);
      expect(document.querySelectorAll('[role="scrollbar"]')).toHaveLength(2);
      expect(element.scrollTop).toBe(150);
      dispose();
      expect(document.querySelector('[data-versiondock-scrollbar-layer]')).toBeNull();
      element.dispatchEvent(new Event('scroll')); expect(frames.size).toBe(0);
    }
  });

  it('reveals on scroll and hides after inactivity, with accessible keyboard controls', () => {
    const element = scroller();
    dispose = initializeGlobalScrollbars({ visibility: 'auto', modernUi: false, language: 'zh-CN' }).dispose;
    flush();
    const track = document.querySelector<HTMLElement>('[data-versiondock-overlay-scrollbar="vertical"]')!;
    const thumb = track.querySelector<HTMLElement>('[role="scrollbar"]')!;
    expect(scrollbarContains(element, thumb)).toBe(true);
    expect(scrollbarContains(document.createElement('section'), thumb)).toBe(false);
    expect(track.style.opacity).toBe('0'); expect(thumb.tabIndex).toBe(-1);
    element.dispatchEvent(new Event('scroll')); flush();
    expect(track.style.opacity).toBe('1'); expect(thumb.getAttribute('aria-label')).toBe('垂直滚动条');
    thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(element.scrollTop).toBe(900);
    thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(element.scrollTop).toBe(800);
    vi.advanceTimersByTime(501); expect(track.style.opacity).toBe('0');
  });

  it('ignores a custom merge scroller and removes dynamic containers', async () => {
    const element = scroller(); element.dataset.versiondockNativeScrollbar = 'hidden';
    dispose = initializeGlobalScrollbars({ visibility: 'visible', modernUi: false, language: 'en' }).dispose;
    flush(); expect(document.querySelector('[role="scrollbar"]')).toBeNull();
    delete element.dataset.versiondockNativeScrollbar;
    await Promise.resolve(); flush();
    expect(document.querySelectorAll('[role="scrollbar"]')).toHaveLength(2);
    element.remove(); await Promise.resolve(); flush();
    expect(document.querySelector('[data-versiondock-scrollbar-viewport]')).toBeNull();
  });

  it('keeps hover visible in WebKit even when the hover selector is empty', () => {
    const element = scroller();
    dispose = initializeGlobalScrollbars({ visibility: 'auto', modernUi: true, language: 'en' }).dispose;
    flush();
    const track = document.querySelector<HTMLElement>('[data-versiondock-overlay-scrollbar="vertical"]')!;
    element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 50, clientY: 50 }));
    flush(); expect(track.style.opacity).toBe('1');
    element.dispatchEvent(new Event('scroll')); flush(); vi.advanceTimersByTime(501);
    expect(track.style.opacity).toBe('1');
    element.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
    expect(track.style.opacity).toBe('0');
  });

  it('updates modes and language without losing hover or native scroll position', () => {
    const element = scroller(); element.scrollTop = 250;
    const runtime = initializeGlobalScrollbars({ visibility: 'visible', modernUi: false, language: 'en' });
    dispose = runtime.dispose; flush();
    element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 50, clientY: 50 }));
    runtime.configure({ visibility: 'auto', modernUi: true, language: 'zh-CN' }); flush();
    expect(document.querySelector<HTMLElement>('[data-versiondock-overlay-scrollbar="vertical"]')!.style.opacity).toBe('1');
    expect(document.querySelector('[aria-label="垂直滚动条"]')).not.toBeNull();
    runtime.configure({ visibility: 'system', modernUi: true, language: 'zh-CN' }); flush();
    expect(document.querySelector('[data-versiondock-scrollbar-layer]')).toBeNull();
    expect(element.scrollTop).toBe(250);
  });

  it('hides background tracks covered by a modal', () => {
    const element = scroller();
    dispose = initializeGlobalScrollbars({ visibility: 'visible', modernUi: false, language: 'en' }).dispose;
    flush();
    const track = document.querySelector<HTMLElement>('[data-versiondock-overlay-scrollbar="vertical"]')!;
    expect(track.style.display).toBe('block');
    const modal = document.createElement('section'); modal.setAttribute('aria-modal', 'true');
    document.body.append(modal); hit = modal;
    window.dispatchEvent(new Event('resize')); flush();
    expect(track.style.display).toBe('none');
    expect(element.scrollTop).toBe(0);
  });

  it('keeps tracks above selected virtual rows and updates changed stacking levels', async () => {
    const element = scroller();
    const row = element.firstElementChild as HTMLElement;
    row.style.position = 'absolute';
    row.style.transform = 'translateY(28px)';
    row.style.zIndex = '2';
    dispose = initializeGlobalScrollbars({ visibility: 'visible', modernUi: false, language: 'en' }).dispose;
    flush();
    const viewport = document.querySelector<HTMLElement>('[data-versiondock-scrollbar-viewport]')!;
    expect(viewport.style.zIndex).toBe('3');
    row.style.zIndex = '4';
    await Promise.resolve(); flush();
    expect(viewport.style.zIndex).toBe('5');
  });

  it('does not lift nested pane layers above an external menu', () => {
    const element = scroller();
    const pane = document.createElement('section');
    pane.style.position = 'relative'; pane.style.zIndex = '5';
    const child = element.firstElementChild as HTMLElement;
    child.style.position = 'relative'; child.style.zIndex = '100';
    document.body.append(pane); pane.append(element);
    dispose = initializeGlobalScrollbars({ visibility: 'visible', modernUi: false, language: 'en' }).dispose;
    flush();
    expect(document.querySelector<HTMLElement>('[data-versiondock-scrollbar-viewport]')!.style.zIndex).toBe('6');
    const menu = document.createElement('div');
    menu.style.position = 'fixed'; menu.style.zIndex = '20';
    document.body.append(menu); hit = menu;
    window.dispatchEvent(new Event('resize')); flush();
    expect(document.querySelector<HTMLElement>('[data-versiondock-overlay-scrollbar="vertical"]')!.style.display).toBe('none');
  });
});
