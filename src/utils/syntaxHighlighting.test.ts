import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightWorkerRequest, HighlightWorkerResponse } from './highlightWorker';
import type { ThemedToken } from 'shiki/types';

class FakeWorker {
  static instances: FakeWorker[] = [];
  requests: HighlightWorkerRequest[] = [];
  onmessage?: (event: MessageEvent<HighlightWorkerResponse>) => void;
  onerror?: (event: ErrorEvent) => void;
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  postMessage(request: HighlightWorkerRequest) { this.requests.push(request); }
  reply(tokens: ThemedToken[][], error?: string) {
    this.onmessage?.({ data: { id: this.requests.at(-1)!.id, tokens: error ? undefined : tokens, error } } as MessageEvent<HighlightWorkerResponse>);
  }
}
const tokens = (code: string): ThemedToken[][] => [[{ content: code, color: '#ff0000', offset: 0 }]];
beforeEach(() => { vi.resetModules(); FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('syntax highlighting worker and cache', () => {
  it('shares concurrent identical work and makes repeat results available synchronously', async () => {
    const service = await import('./syntaxHighlighting');
    const a = service.highlightSyntax('fn main() {}', 'rust', 'dark-plus');
    const b = service.highlightSyntax('fn main() {}', 'rust', 'dark-plus');
    const worker = FakeWorker.instances[0];
    expect(worker.requests).toHaveLength(1);
    const result = tokens('fn main() {}'); worker.reply(result);
    expect(await a).toBe(result); expect(await b).toBe(result);
    expect(service.cachedSyntaxTokens('fn main() {}', 'rust', 'dark-plus')).toBe(result);
    expect(await service.highlightSyntax('fn main() {}', 'rust', 'dark-plus')).toBe(result);
    expect(worker.requests).toHaveLength(1);
  });

  it('isolates language, theme and source changes, including custom themes with the same name', async () => {
    const { highlightSyntax, cachedSyntaxTokens } = await import('./syntaxHighlighting');
    const custom = { name: 'custom', settings: [] };
    const pending = highlightSyntax('value', 'rust', custom);
    FakeWorker.instances[0].reply(tokens('value')); await pending;
    expect(cachedSyntaxTokens('other', 'rust', custom)).toBeUndefined();
    expect(cachedSyntaxTokens('value', 'typescript', custom)).toBeUndefined();
    expect(cachedSyntaxTokens('value', 'rust', 'light-plus')).toBeUndefined();
    expect(cachedSyntaxTokens('value', 'rust', { name: 'custom', settings: [{ scope: 'keyword', settings: { foreground: '#00ff00' } }] })).toBeUndefined();
  });

  it('drops obsolete queued jobs without cancelling a shared consumer', async () => {
    const { highlightSyntax } = await import('./syntaxHighlighting');
    const first = highlightSyntax('running', 'rust', 'dark-plus');
    const controller = new AbortController();
    const obsolete = highlightSyntax('obsolete', 'rust', 'dark-plus', controller.signal);
    const cancelled = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await cancelled;
    const next = highlightSyntax('next', 'rust', 'dark-plus');
    const worker = FakeWorker.instances[0]; worker.reply(tokens('running')); await first;
    expect(worker.requests.map((request) => request.code)).toEqual(['running', 'next']);
    worker.reply(tokens('next')); await next;

    const stop = new AbortController();
    const a = highlightSyntax('shared', 'rust', 'dark-plus', stop.signal);
    const b = highlightSyntax('shared', 'rust', 'dark-plus');
    const rejection = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    stop.abort(); await rejection;
    worker.reply(tokens('shared')); expect(await b).toEqual(tokens('shared'));
  });

  it('does not cache failed results and allows retry', async () => {
    const { highlightSyntax, cachedSyntaxTokens } = await import('./syntaxHighlighting');
    const pending = highlightSyntax('retry', 'rust', 'dark-plus');
    const failure = expect(pending).rejects.toThrow('grammar failed');
    FakeWorker.instances[0].reply([], 'grammar failed'); await failure;
    expect(cachedSyntaxTokens('retry', 'rust', 'dark-plus')).toBeUndefined();
    const retry = highlightSyntax('retry', 'rust', 'dark-plus');
    FakeWorker.instances[0].reply(tokens('retry')); await retry;
  });

  it('rejects all outstanding consumers when the worker crashes', async () => {
    const { highlightSyntax } = await import('./syntaxHighlighting');
    const first = expect(highlightSyntax('first', 'rust', 'dark-plus')).rejects.toThrow('worker failed');
    const second = expect(highlightSyntax('second', 'rust', 'dark-plus')).rejects.toThrow('worker failed');
    const worker = FakeWorker.instances[0];
    worker.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    await first; await second; expect(worker.terminate).toHaveBeenCalled();
  });

  it('terminates stalled workers and releases all queued consumers', async () => {
    vi.useFakeTimers();
    const { highlightSyntax } = await import('./syntaxHighlighting');
    const first = expect(highlightSyntax('first', 'rust', 'dark-plus')).rejects.toThrow('timed out');
    const second = expect(highlightSyntax('second', 'rust', 'dark-plus')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await first; await second;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalled();
  });

  it('evicts least recently used entries and refuses results exceeding the memory budget', async () => {
    const { highlightSyntax, cachedSyntaxTokens } = await import('./syntaxHighlighting');
    for (let i = 0; i < 128; i++) {
      const pending = highlightSyntax(String(i), 'rust', 'dark-plus');
      FakeWorker.instances[0].reply(tokens(String(i))); await pending;
    }
    expect(cachedSyntaxTokens('0', 'rust', 'dark-plus')).toBeDefined();
    const pending = highlightSyntax('128', 'rust', 'dark-plus');
    FakeWorker.instances[0].reply(tokens('128')); await pending;
    expect(cachedSyntaxTokens('1', 'rust', 'dark-plus')).toBeUndefined();
    expect(cachedSyntaxTokens('0', 'rust', 'dark-plus')).toBeDefined();
    const oversized = highlightSyntax('large', 'rust', 'dark-plus');
    FakeWorker.instances[0].reply([Array.from({ length: 90_000 }, () => tokens('value')[0][0])]); await oversized;
    expect(cachedSyntaxTokens('large', 'rust', 'dark-plus')).toBeUndefined();
  });
});
