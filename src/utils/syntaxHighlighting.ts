import type { ThemedToken } from 'shiki/types';
import type { HighlightTheme, HighlightWorkerResponse } from './highlightWorker';

// Token objects cost substantially more than their source text. Bound both the
// retained token memory and entry count; pending work is never a permanent cache.
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, { tokens: ThemedToken[][]; bytes: number }>();
let cacheBytes = 0;
const themeKeys = new WeakMap<object, string>();
const keyFor = (code: string, language: string, theme: HighlightTheme) => {
  let themeKey: string;
  if (typeof theme === 'string') themeKey = theme;
  else {
    themeKey = themeKeys.get(theme) ?? JSON.stringify(theme);
    themeKeys.set(theme, themeKey);
  }
  return JSON.stringify([language, themeKey, code]);
};

export function cachedSyntaxTokens(code: string, language: string, theme: HighlightTheme): ThemedToken[][] | undefined {
  const key = keyFor(code, language, theme);
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key); cache.set(key, value);
  return value.tokens;
}

type Job = { id: number; key: string; code: string; language: string; theme: HighlightTheme; consumers: Set<Consumer> };
type Consumer = { resolve: (tokens: ThemedToken[][]) => void; reject: (error: unknown) => void; cleanup: () => void };
const jobs = new Map<string, Job>();
let running: Job | undefined;
let worker: Worker | undefined;
let sequence = 0;
let deadline: ReturnType<typeof setTimeout> | undefined;

function failWorker(message: string) {
  worker?.terminate(); worker = undefined;
  const failed = [...jobs.values()];
  jobs.clear(); running = undefined;
  if (deadline) clearTimeout(deadline);
  deadline = undefined;
  failed.forEach((job) => finish(job, undefined, new Error(message)));
}

function finish(job: Job, tokens?: ThemedToken[][], error?: unknown) {
  jobs.delete(job.key);
  if (running === job) running = undefined;
  if (deadline) clearTimeout(deadline);
  deadline = undefined;
  if (tokens) {
    const bytes = job.key.length * 2 + tokens.reduce((sum, line) => sum + 24 + line.reduce((size, token) => size + 96 + token.content.length * 2, 0), 0);
    if (bytes <= MAX_CACHE_BYTES) {
      cache.set(job.key, { tokens, bytes }); cacheBytes += bytes;
      while (cacheBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.entries().next().value!;
        cache.delete(oldest[0]); cacheBytes -= oldest[1].bytes;
      }
    }
  }
  for (const consumer of job.consumers) {
    consumer.cleanup();
    if (tokens) consumer.resolve(tokens); else consumer.reject(error);
  }
  void pump();
}

async function pump() {
  if (running) return;
  const job = jobs.values().next().value as Job | undefined;
  if (!job) return;
  running = job;
  try {
    // Tests/SSR retain the exact same tokenizer. Desktop and browser rendering
    // use one worker, sending only one job at a time so cancelled queues can drain.
    if (typeof Worker === 'undefined') {
      const { tokenizeCode } = await import('./highlightWorker');
      finish(job, await tokenizeCode(job.code, job.language, job.theme));
      return;
    }
    if (!worker) {
      worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<HighlightWorkerResponse>) => {
        if (running?.id !== data.id) return;
        finish(running, data.tokens, data.error ? new Error(data.error) : undefined);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        // Drain all failed callers without repeatedly restarting a broken worker.
        failWorker('Syntax highlight worker failed');
      };
      worker.onmessageerror = () => failWorker('Syntax highlight worker response could not be decoded');
    }
    deadline = setTimeout(() => failWorker('Syntax highlight worker timed out'), 30_000);
    worker.postMessage({ id: job.id, code: job.code, language: job.language, theme: job.theme });
  } catch (error) {
    finish(job, undefined, error);
  }
}

export function highlightSyntax(code: string, language: string, theme: HighlightTheme, signal?: AbortSignal): Promise<ThemedToken[][]> {
  if (signal?.aborted) return Promise.reject(new DOMException('Highlighting cancelled', 'AbortError'));
  const cached = cachedSyntaxTokens(code, language, theme);
  if (cached) return Promise.resolve(cached);
  const key = keyFor(code, language, theme);
  let job = jobs.get(key);
  if (!job) {
    job = { id: ++sequence, key, code, language, theme, consumers: new Set() };
    jobs.set(key, job);
  }
  const pending = job;
  return new Promise((resolve, reject) => {
    const consumer: Consumer = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
    const cancel = () => {
      pending.consumers.delete(consumer); consumer.cleanup();
      if (!pending.consumers.size && running !== pending) jobs.delete(key);
      reject(new DOMException('Highlighting cancelled', 'AbortError'));
    };
    pending.consumers.add(consumer);
    signal?.addEventListener('abort', cancel, { once: true });
    void pump();
  });
}

/** Warm the engine during idle time; source code is never logged or persisted. */
export function scheduleHighlightWarmup(): () => void {
  const warm = () => { void highlightSyntax('', 'text', 'dark-plus').catch(() => undefined); };
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(warm);
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(warm, 200);
  return () => window.clearTimeout(id);
}
