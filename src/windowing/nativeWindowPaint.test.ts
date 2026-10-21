import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import source from '../../src-tauri/src/window_surface/paint.js?raw';

const run = (target: { width: number; height: number } | null) => {
  new Function(`${source}('frame-token', ${JSON.stringify(target)})`)();
};
const invoke = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('innerWidth', 880);
  vi.stubGlobal('innerHeight', 540);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  invoke.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native window paint acknowledgement', () => {
  it('does not acknowledge native bounds while the page still uses the welcome viewport', async () => {
    run({ width: 1440, height: 900 });
    await vi.advanceTimersByTimeAsync(32);
    expect(invoke).not.toHaveBeenCalled();
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
    await vi.advanceTimersByTimeAsync(16);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(invoke).toHaveBeenCalledWith('plugin:event|emit', { event: 'frame-token', payload: {
      width: 1440, height: 900, visible: true, reducedMotion: false,
    } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds waiting when the renderer never reaches the requested size', async () => {
    run({ width: 1440, height: 900 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports hidden pages without depending on animation frame delivery', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    run(null);
    expect(invoke).toHaveBeenCalledWith('plugin:event|emit', expect.objectContaining({ payload: expect.objectContaining({ visible: false }) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors reduced motion and isolates late acknowledgements to their frame token', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    run(null);
    await vi.advanceTimersByTimeAsync(32);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin:event|emit', expect.objectContaining({ event: 'frame-token', payload: expect.objectContaining({ reducedMotion: true }) }));
  });
});
