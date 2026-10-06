import { describe, expect, it } from 'vitest';
import { codeToTokensBase } from 'shiki';
import { ensureHighlighter, resolveHighlightLanguage } from './highlighter';

const samples = {
  astro: '---\nconst title = "Title";\n---\n<h1>{title}</h1>',
  c: 'int value = 1;', cpp: '#include <vector>\nint value = 1;',
  csharp: 'public class App { int value = 1; }', css: '.name { color: red; }',
  dart: 'int value = 1;', go: 'package main\nvar value = 1',
  html: '<div class="name">你好</div>', java: 'class App { int value = 1; }',
  javascript: 'const value = 1;', json: '{"value":1}', jsonc: '// comment\n{"value":1}',
  jsx: 'const node = <div>Hello</div>;', kotlin: 'val value = 1',
  less: '@color: red; .name { color: @color; }', markdown: '# Title\n**text**',
  mdx: 'export const value = 1\n\n# Title\n<Component value={value}/>',
  php: '<?php $value = 1; ?>', python: 'value = 1 # comment', ruby: 'value = 1\nputs value',
  rust: 'fn main() { let value = 1; }', sass: '.name\n  color: red',
  scss: '$color: red; .name { color: $color; }', shell: 'echo "hello"',
  sql: 'SELECT id FROM items WHERE id = 1;',
  svelte: '<script lang="ts">let value = 1;</script><p>{value}</p>',
  swift: 'let value = 1', toml: 'name = "test"\nvalue = 1',
  tsx: 'const node = <div>{1}</div>;', typescript: 'const value: number = 1;',
  vue: '<script setup lang="ts">const value = 1;</script><template><p>{{ value }}</p></template>',
  xml: '<?xml version="1.0"?><root value="1"/>', yaml: 'name: test\nvalue: 1',
};

describe('shared highlighter', () => {
  it.each(Object.entries(samples))('keeps %s token colors identical to the original Shiki renderer', async (language, code) => {
    const resolved = resolveHighlightLanguage(language)!;
    const highlighter = await ensureHighlighter(resolved);
    for (const theme of ['dark-plus', 'light-plus'] as const) {
      const actual = highlighter.codeToTokensBase(code, { lang: resolved, theme });
      const original = await codeToTokensBase(code, { lang: resolved, theme });
      expect(actual).toEqual(original);
      expect(actual.map(line => line.map(token => token.content).join('')).join('\n')).toBe(code);
    }
  });

  it('shares one engine across concurrent language loads and keeps aliases usable', async () => {
    const [script, markup, component] = await Promise.all([
      ensureHighlighter('ts'), ensureHighlighter('html'), ensureHighlighter('vue'),
    ]);
    expect(script).toBe(markup);
    expect(markup).toBe(component);
    expect(script.getLoadedLanguages()).toContain('typescript');
    expect(resolveHighlightLanguage('bash')).toBe('shell');
    expect(resolveHighlightLanguage('constructor')).toBeNull();
    expect(resolveHighlightLanguage('__proto__')).toBeNull();
    expect(resolveHighlightLanguage('unsupported-language')).toBeNull();
  });
});
