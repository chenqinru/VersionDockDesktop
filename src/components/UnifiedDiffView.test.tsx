import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { highlightDiffLines, highlightParsedDiffSide, parseUnifiedDiff, resolveDiffHighlightLanguage } from './UnifiedDiffView';

describe('parseUnifiedDiff', () => {
  it('keeps VS Code-style diagonal shading on aligned empty split cells with seamless repetition', () => {
    const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    expect(styles).toMatch(/\.diff-code-cell\.empty code\s*\{[^}]*repeating-linear-gradient\(-45deg,[^}]*background-size:\s*10px\s*10px/s);
  });

  it('renders colored vertical bars on deletion and addition line numbers', () => {
    const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    expect(styles).toMatch(/\.diff-code-cell\.deletion,\s*\.diff-inline-row\.deletion\s*\{[^}]*box-shadow:\s*inset\s+3\.5px\s+0\s+0\s+var\(--versiondock-danger\)/s);
    expect(styles).toMatch(/\.diff-code-cell\.addition,\s*\.diff-inline-row\.addition\s*\{[^}]*box-shadow:\s*inset\s+3\.5px\s+0\s+0\s+var\(--versiondock-success\)/s);
  });

  it('aligns deletion and addition blocks with old and new line numbers', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/src/demo.ts b/src/demo.ts',
      'index 123..456 100644',
      '--- a/src/demo.ts',
      '+++ b/src/demo.ts',
      '@@ -4,3 +4,4 @@ function demo() {',
      ' keep();',
      '-oldValue();',
      '+newValue();',
      '+extra();',
      ' done();',
    ].join('\n'));

    expect(parsed.oldLabel).toBe('src/demo.ts');
    expect(parsed.newLabel).toBe('src/demo.ts');
    expect(parsed.hunkCount).toBe(1);
    expect(parsed.rows).toEqual([
      { kind: 'hunk', text: '@@ -4,3 +4,4 @@ function demo() {' },
      { kind: 'pair', oldCell: { kind: 'context', lineNumber: 4, content: 'keep();' }, newCell: { kind: 'context', lineNumber: 4, content: 'keep();' } },
      { kind: 'pair', oldCell: { kind: 'deletion', lineNumber: 5, content: 'oldValue();' }, newCell: { kind: 'addition', lineNumber: 5, content: 'newValue();' } },
      { kind: 'pair', oldCell: { kind: 'empty', lineNumber: null, content: '' }, newCell: { kind: 'addition', lineNumber: 6, content: 'extra();' } },
      { kind: 'pair', oldCell: { kind: 'context', lineNumber: 6, content: 'done();' }, newCell: { kind: 'context', lineNumber: 7, content: 'done();' } },
    ]);
  });

  it('hides patch plumbing and supports a deleted file', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/docs/old.md b/docs/old.md',
      'deleted file mode 100644',
      '--- a/docs/old.md',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-first',
      '-second',
      '\\ No newline at end of file',
    ].join('\n'), 'docs/old.md');

    expect(parsed.oldLabel).toBe('docs/old.md');
    expect(parsed.newLabel).toBe('/dev/null');
    expect(parsed.rows[0]).toEqual({ kind: 'hunk', text: '@@ -1,2 +0,0 @@' });
    expect(parsed.rows).toContainEqual({ kind: 'pair', oldCell: { kind: 'deletion', lineNumber: 2, content: 'second' }, newCell: { kind: 'empty', lineNumber: null, content: '' } });
    expect(parsed.rows.at(-1)).toEqual({ kind: 'meta', text: '\\ No newline at end of file' });
  });

  it('parses SVN labels and property-style metadata without dropping it', () => {
    const parsed = parseUnifiedDiff([
      'Index: 配置 file.txt',
      '===================================================================',
      '--- 配置 file.txt\t(revision 12)',
      '+++ 配置 file.txt\t(working copy)',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'Property changes on: 配置 file.txt',
      '___________________________________________________________________',
      'Modified: svn:keywords',
    ].join('\n'));

    expect(parsed.oldLabel).toBe('配置 file.txt');
    expect(parsed.newLabel).toBe('配置 file.txt');
    expect(parsed.rows).toContainEqual({ kind: 'meta', text: 'Property changes on: 配置 file.txt' });
    expect(parsed.rows).toContainEqual({ kind: 'meta', text: 'Modified: svn:keywords' });
  });

  it('uses the embedded TypeScript grammar for Vue patch fragments without SFC wrapper tags', async () => {
    const lines = [
      "import { computed, ref } from 'vue';",
      'const loading = ref(false);',
      'const value = computed(() => loading.value);',
    ];

    expect(resolveDiffHighlightLanguage('vue', 'src/views/detail.vue', lines)).toBe('typescript');
    expect(resolveDiffHighlightLanguage('text', 'src/views/detail.vue', lines)).toBe('typescript');

    const tokens = await highlightDiffLines(lines, 'vue', 'src/views/detail.vue', 'dark-plus');
    expect(tokens.flat().find((token) => token.content === 'import')?.color).toBeTruthy();
    expect(tokens.flat().find((token) => token.content === 'const')?.color).toBeTruthy();
    expect(new Set(tokens.flat().map((token) => token.color).filter(Boolean)).size).toBeGreaterThan(2);
  });

  it('keeps Vue SFC and template fragments on their appropriate grammar', () => {
    expect(resolveDiffHighlightLanguage('vue', 'src/App.vue', ['<script setup lang="ts">', 'const ready = true'])).toBe('vue');
    expect(resolveDiffHighlightLanguage('vue', 'src/App.vue', ['<section v-if="ready">', '{{ title }}', '</section>'])).toBe('vue');
  });

  it('highlights script and template hunks in the same Vue patch independently', async () => {
    const parsed = parseUnifiedDiff([
      '--- a/src/App.vue',
      '+++ b/src/App.vue',
      '@@ -40,2 +40,2 @@',
      "-import OldPanel from './OldPanel.vue';",
      "+import NewPanel from './NewPanel.vue';",
      '@@ -740,4 +740,5 @@',
      '-  <OldPanel',
      '-    ref="oldPanelRef"',
      '+  <NewPanel',
      '+    ref="newPanelRef"',
      '+    :loading="loading"',
      '   />',
    ].join('\n'), 'src/App.vue');

    const highlighted = await highlightParsedDiffSide(parsed, 'new', 'vue', 'src/App.vue', 'dark-plus');
    const pairs = parsed.rows.filter((row) => row.kind === 'pair');
    const importTokens = highlighted.get(pairs[0].newCell) ?? [];
    const templateTokens = highlighted.get(pairs[1].newCell) ?? [];

    expect(importTokens.find((token) => token.content === 'import')?.color).toBeTruthy();
    expect(templateTokens.find((token) => token.content === 'NewPanel')?.color).toBe('#569CD6');
    expect(new Set(importTokens.map((token) => token.color).filter(Boolean)).size).toBeGreaterThan(2);
  });

  it('renders modern divider style fold rows with pill badge and step expansion controls', () => {
    const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    expect(styles).toMatch(/\.diff-fold-row\s*\{[^}]*position:\s*relative/s);
    expect(styles).toMatch(/\.diff-fold-line\s*\{[^}]*position:\s*absolute/s);
    expect(styles).toMatch(/\.diff-fold-badge\s*\{[^}]*border-radius:\s*12px/s);
    expect(styles).toMatch(/\.diff-fold-action-btn\s*\{[^}]*border-radius:\s*3px/s);
  });
});
