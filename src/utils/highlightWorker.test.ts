import { describe, expect, it } from 'vitest';
import type { ThemedToken } from 'shiki/types';
import { createHighlightSession } from './highlightWorker';
import { ensureHighlighter } from './highlighter';

describe('streaming syntax tokenizer', () => {
  const comment = ['/*', ...Array.from({ length: 170 }, (_, index) => `comment ${index} 中文`), '*/'];
  const samples = {
    typescript: [...comment, 'const message = `start', ...Array.from({ length: 90 }, () => 'text ${1 + 2}'), 'end`;', 'export const ready: boolean = true;'].join('\n'),
    vue: ['<script setup lang="ts">', ...comment, 'const value = "ready";', '</script>', '<template>', ...Array.from({ length: 90 }, () => '<section :title="value">{{ value }}</section>'), '</template>', '<style>', '.view { color: red; }', '</style>'].join('\n'),
    python: ['message = """', ...Array.from({ length: 170 }, () => '中文 message'), '"""', 'print(message)'].join('\r\n'),
    rust: [...comment, 'fn main() { println!("ready"); }'].join('\n'),
    text: ['', 'plain\r\ntext\n', 'a'.repeat(20_000), '', 'end'].join('\n'),
  };

  it.each(Object.entries(samples))('keeps %s colors and offsets identical across chunk boundaries', async (language, code) => {
    const highlighter = await ensureHighlighter(language);
    for (const theme of ['dark-plus', 'light-plus'] as const) {
      const expected = highlighter.codeToTokensBase(code, { lang: language, theme });
      const session = await createHighlightSession(code, language, theme);
      const actual: ThemedToken[][] = [];
      let chunks = 0;
      for (;;) {
        const chunk = session.next();
        expect(chunk.startLine).toBe(actual.length);
        actual.push(...chunk.tokens); chunks += 1;
        if (chunk.done) break;
      }
      expect(actual).toEqual(expected);
      if (code.split('\n').length > 80) expect(chunks).toBeGreaterThan(1);
    }
  });

  it.each(['', '\n', 'line\n', '\r\n', 'a\r\nb\nc\r\n'])('preserves empty and trailing lines in %j', async code => {
    const session = await createHighlightSession(code, 'typescript', 'dark-plus');
    const result = session.next();
    const highlighter = await ensureHighlighter('typescript');
    expect(result.tokens).toEqual(highlighter.codeToTokensBase(code, { lang: 'typescript', theme: 'dark-plus' }));
    expect(result.done).toBe(true);
  });
});
