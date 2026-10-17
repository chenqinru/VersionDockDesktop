import type { ThemedToken } from 'shiki/types';
import type { HighlightSession, HighlightTheme, HighlightWorkerResponse } from './highlightWorker';

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

export type HighlightOptions = {
  priority?: 'interactive' | 'background';
  onChunk?: (tokens: ThemedToken[][], startLine: number) => void;
};
type Job = { id: number; key: string; code: string; language: string; theme: HighlightTheme; consumers: Set<Consumer>; tokens: ThemedToken[][]; started: boolean; session?: HighlightSession };
type Consumer = HighlightOptions & { resolve: (tokens: ThemedToken[][]) => void; reject: (error: unknown) => void; cleanup: () => void };
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

function receive(data: HighlightWorkerResponse) {
  const job = running;
  if (!job || job.id !== data.id) return;
  if (deadline) clearTimeout(deadline);
  deadline = undefined;
  if (!job.consumers.size) {
    running = undefined;
    worker?.postMessage({ action: 'cancel', id: job.id });
    jobs.delete(job.key);
    void pump();
    return;
  }
  if (data.error || !data.tokens || data.startLine !== job.tokens.length) {
    running = undefined;
    worker?.postMessage({ action: 'cancel', id: job.id });
    finish(job, undefined, new Error(data.error ?? 'Invalid syntax highlight chunk'));
    return;
  }
  if (!job.tokens.length && data.done) job.tokens = data.tokens;
  else job.tokens.push(...data.tokens);
  for (const consumer of [...job.consumers]) {
    if (job.consumers.has(consumer)) consumer.onChunk?.(data.tokens, data.startLine);
  }
  running = undefined;
  if (data.done) finish(job, job.tokens);
  else if (!job.consumers.size) {
    worker?.postMessage({ action: 'cancel', id: job.id });
    jobs.delete(job.key);
    void pump();
  } else {
    // Rotate after each chunk. Both diff sides and newly clicked files can
    // reach their first screen before a large hunk finishes tokenizing.
    jobs.delete(job.key); jobs.set(job.key, job);
    void pump();
  }
}

async function pump() {
  if (running) return;
  const queued = [...jobs.values()];
  const job = queued.find(candidate => [...candidate.consumers].some(consumer => consumer.priority !== 'background')) ?? queued[0];
  if (!job) return;
  running = job;
  try {
    // The exact same streaming tokenizer is also used by tests/SSR.
    if (typeof Worker === 'undefined') {
      const { createHighlightSession } = await import('./highlightWorker');
      job.session ??= await createHighlightSession(job.code, job.language, job.theme);
      receive({ id: job.id, ...job.session.next() });
      return;
    }
    if (!worker) {
      worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<HighlightWorkerResponse>) => {
        receive(data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        // Drain all failed callers without repeatedly restarting a broken worker.
        failWorker('Syntax highlight worker failed');
      };
      worker.onmessageerror = () => failWorker('Syntax highlight worker response could not be decoded');
    }
    deadline = setTimeout(() => failWorker('Syntax highlight worker timed out'), 30_000);
    worker.postMessage(job.started ? { action: 'continue', id: job.id }
      : { action: 'start', id: job.id, code: job.code, language: job.language, theme: job.theme });
    job.started = true;
  } catch (error) {
    receive({ id: job.id, error: error instanceof Error ? error.message : 'Syntax highlighting failed' });
  }
}

export function highlightSyntax(code: string, language: string, theme: HighlightTheme, signal?: AbortSignal, options?: HighlightOptions): Promise<ThemedToken[][]> {
  if (signal?.aborted) return Promise.reject(new DOMException('Highlighting cancelled', 'AbortError'));
  const cached = cachedSyntaxTokens(code, language, theme);
  if (cached) { options?.onChunk?.(cached, 0); return Promise.resolve(cached); }
  const key = keyFor(code, language, theme);
  let job = jobs.get(key);
  if (!job) {
    job = { id: ++sequence, key, code, language, theme, consumers: new Set(), tokens: [], started: false };
    jobs.set(key, job);
  }
  const pending = job;
  return new Promise((resolve, reject) => {
    const consumer: Consumer = { ...options, resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
    const cancel = () => {
      pending.consumers.delete(consumer); consumer.cleanup();
      if (!pending.consumers.size && running !== pending) {
        jobs.delete(key);
        if (pending.started) worker?.postMessage({ action: 'cancel', id: pending.id });
      }
      reject(new DOMException('Highlighting cancelled', 'AbortError'));
    };
    pending.consumers.add(consumer);
    signal?.addEventListener('abort', cancel, { once: true });
    if (pending.tokens.length) consumer.onChunk?.(pending.tokens.slice(), 0);
    void pump();
  });
}

/** Initialize the worker early, then warm common grammars during idle time. */
export function scheduleHighlightWarmup(): () => void {
  const controller = new AbortController();
  // Start WASM in the worker while the shell initializes, rather than making
  // the first file click pay for worker startup and engine initialization.
  const engine = highlightSyntax('', 'text', 'dark-plus', controller.signal, { priority: 'background' }).catch(() => undefined);
  const warm = async () => {
    await engine;
    // Empty input only loads a grammar; representative code also compiles its
    // lazy TextMate/Oniguruma rules before the first real file needs them.
    const samples = {
      typescript: 'import type { Item } from "module";\nexport const options = { enabled: true, value: 1 };\nexport function read(item: Item): string { return `value: ${item}`; }',
      javascript: 'import { read } from "module";\nexport const options = { enabled: true, value: 1 };\nexport function run() { return read("value"); }',
      tsx: 'export function View() { return <section className="view">{1}</section>; }',
      vue: '<script setup lang="ts">\nconst value = 1;\n</script>\n<template><section>{{ value }}</section></template>',
      json: '{ "enabled": true, "value": 1 }',
      rust: 'use std::fmt;\nfn main() { let value = "ready"; println!("{}", value); }',
      java: 'import java.util.List;\npublic class View { private String value = "ready"; }',
      python: 'from pathlib import Path\ndef read(value: str):\n    return {"value": value, "ready": True}',
    };
    for (const [language, code] of Object.entries(samples)) {
      if (controller.signal.aborted) return;
      await highlightSyntax(code, language, 'dark-plus', controller.signal, { priority: 'background' }).catch(() => undefined);
    }
  };
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(warm, { timeout: 200 });
    return () => { window.cancelIdleCallback(id); controller.abort(); };
  }
  const id = window.setTimeout(warm, 200);
  return () => { window.clearTimeout(id); controller.abort(); };
}
