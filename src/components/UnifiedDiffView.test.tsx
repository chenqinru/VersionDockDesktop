import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { extractDiffLineRange, highlightDiffLines, highlightParsedDiffSide, parseUnifiedDiff, resolveDiffHighlightLanguage, UnifiedDiffView } from './UnifiedDiffView';

describe('parseUnifiedDiff', () => {
  afterEach(() => {
    cleanup();
  });
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

  it('extracts line range from clicked line target or selection', () => {
    const container = document.createElement('div');
    const line1 = document.createElement('div');
    line1.setAttribute('data-line-number', '12');
    const code = document.createElement('code');
    code.textContent = 'const foo = 1;';
    line1.appendChild(code);
    container.appendChild(line1);

    expect(extractDiffLineRange(container, code)).toEqual({ start: 12, end: 12, side: 'new' });
    expect(extractDiffLineRange(container, null)).toBeUndefined();
  });

  it('triggers onShowSelectionHistory with side and revision when right-clicking a line and clicking menu item', () => {
    const onShowSelectionHistory = vi.fn();
    const diffContent = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -10,3 +10,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
    ].join('\n');

    const { container } = render(
      <UnifiedDiffView
        content={diffContent}
        path="file.ts"
        repoId="repo-1"
        oldRevision="rev-old"
        newRevision="rev-new"
        onShowSelectionHistory={onShowSelectionHistory}
      />
    );

    const cell = container.querySelector('[data-line-number="11"][data-side="old"]');
    expect(cell).toBeTruthy();

    fireEvent.contextMenu(cell!, { clientX: 100, clientY: 100 });
    const menuItem = screen.getByRole('menuitem', { name: /Show Selection History|显示选区历史/ });
    expect(menuItem).toBeTruthy();

    fireEvent.click(menuItem);
    expect(onShowSelectionHistory).toHaveBeenCalledWith({ start: 11, end: 11, side: 'old' }, 'rev-old', 'file.ts');
  });

  it('correctly extracts old vs new line numbers in inline diff rows where line numbers differ', () => {
    const container = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'diff-inline-row context';
    row.setAttribute('data-line-number', '25');
    row.setAttribute('data-new-line-number', '25');
    row.setAttribute('data-old-line-number', '18');

    const oldSpan = document.createElement('span');
    oldSpan.className = 'diff-line-number old';
    oldSpan.setAttribute('data-side', 'old');
    oldSpan.setAttribute('data-line-number', '18');
    oldSpan.textContent = '18';

    const newSpan = document.createElement('span');
    newSpan.className = 'diff-line-number new';
    newSpan.setAttribute('data-side', 'new');
    newSpan.setAttribute('data-line-number', '25');
    newSpan.textContent = '25';

    const code = document.createElement('code');
    code.textContent = 'same content';

    row.appendChild(oldSpan);
    row.appendChild(newSpan);
    row.appendChild(code);
    container.appendChild(row);

    // Clicking old line number span must return old side and line 18
    expect(extractDiffLineRange(container, oldSpan)).toEqual({ start: 18, end: 18, side: 'old' });

    // Clicking new line number span must return new side and line 25
    expect(extractDiffLineRange(container, newSpan)).toEqual({ start: 25, end: 25, side: 'new' });
  });

  it('triggers onShowSelectionHistory with accurate old line number when right-clicking old number in inline view', () => {
    const onShowSelectionHistory = vi.fn();
    const diffContent = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -10,3 +20,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = 4;',
    ].join('\n');

    const { container } = render(
      <UnifiedDiffView
        content={diffContent}
        path="file.ts"
        repoId="repo-1"
        oldRevision="rev-old"
        newRevision="rev-new"
        onShowSelectionHistory={onShowSelectionHistory}
      />
    );

    // Switch to inline (unified) view
    const inlineBtn = container.querySelector<HTMLButtonElement>('.diff-toolbar-left button');
    expect(inlineBtn).toBeTruthy();
    fireEvent.click(inlineBtn!);

    // Right-click old line number 10 (which corresponds to new line 20)
    const oldLineSpan = container.querySelector('.diff-line-number.old[data-line-number="10"]');
    expect(oldLineSpan).toBeTruthy();

    fireEvent.contextMenu(oldLineSpan!, { clientX: 100, clientY: 100 });
    const menuItem = screen.getByRole('menuitem', { name: /Show Selection History|显示选区历史/ });
    expect(menuItem).toBeTruthy();

    fireEvent.click(menuItem);
    expect(onShowSelectionHistory).toHaveBeenCalledWith({ start: 10, end: 10, side: 'old' }, 'rev-old', 'file.ts');
  });

  it('normalizes WORKTREE and WORKING pseudo-revisions to undefined when triggering new side selection history', () => {
    const onShowSelectionHistory = vi.fn();
    const diffContent = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,2 @@',
      ' context',
      '+new line',
    ].join('\n');

    const { container } = render(
      <UnifiedDiffView
        content={diffContent}
        path="file.ts"
        repoId="repo-1"
        oldRevision="HEAD"
        newRevision="WORKTREE"
        onShowSelectionHistory={onShowSelectionHistory}
      />
    );

    const contextCell = container.querySelector('[data-line-number="1"][data-side="new"]');
    expect(contextCell).toBeTruthy();

    fireEvent.contextMenu(contextCell!, { clientX: 100, clientY: 100 });
    const menuItem = screen.getByRole('menuitem', { name: /Show Selection History|显示选区历史/ });
    expect(menuItem).toBeTruthy();
    expect(menuItem).not.toBeDisabled();

    fireEvent.click(menuItem);
    expect(onShowSelectionHistory).toHaveBeenCalledWith({ start: 1, end: 1, side: 'new' }, undefined, 'file.ts');
  });

  it('disables selection history on uncommitted addition lines in working tree diff', () => {
    const onShowSelectionHistory = vi.fn();
    const diffContent = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,1 +1,2 @@',
      ' context',
      '+new line',
    ].join('\n');

    const { container } = render(
      <UnifiedDiffView
        content={diffContent}
        path="file.ts"
        repoId="repo-1"
        oldRevision="HEAD"
        newRevision="WORKTREE"
        onShowSelectionHistory={onShowSelectionHistory}
      />
    );

    const additionCell = container.querySelector('[data-line-number="2"][data-side="new"]');
    expect(additionCell).toBeTruthy();

    fireEvent.contextMenu(additionCell!, { clientX: 100, clientY: 100 });
    const menuItem = screen.getByRole('menuitem', { name: /Show Selection History|显示选区历史/ });
    expect(menuItem).toBeTruthy();
    expect(menuItem).toBeDisabled();

    fireEvent.click(menuItem);
    expect(onShowSelectionHistory).not.toHaveBeenCalled();
  });

  it('passes previousPath/oldLabel for old side selection history on renamed files', () => {
    const onShowSelectionHistory = vi.fn();
    const diffContent = [
      'diff --git a/old_name.ts b/new_name.ts',
      'similarity index 90%',
      'rename from old_name.ts',
      'rename to new_name.ts',
      '--- a/old_name.ts',
      '+++ b/new_name.ts',
      '@@ -1,1 +1,1 @@',
      '-old content',
      '+new content',
    ].join('\n');

    const { container } = render(
      <UnifiedDiffView
        content={diffContent}
        path="new_name.ts"
        oldPath="old_name.ts"
        repoId="repo-1"
        oldRevision="rev-old"
        newRevision="rev-new"
        onShowSelectionHistory={onShowSelectionHistory}
      />
    );

    // Right-click old side: should use old_name.ts
    const oldCell = container.querySelector('[data-line-number="1"][data-side="old"]');
    expect(oldCell).toBeTruthy();

    fireEvent.contextMenu(oldCell!, { clientX: 100, clientY: 100 });
    const menuItemOld = screen.getByRole('menuitem', { name: /Show Selection History|显示选区历史/ });
    expect(menuItemOld).toBeTruthy();
    fireEvent.click(menuItemOld);

    expect(onShowSelectionHistory).toHaveBeenCalledWith({ start: 1, end: 1, side: 'old' }, 'rev-old', 'old_name.ts');

    // Right-click new side: should use new_name.ts
    const newCell = container.querySelector('[data-line-number="1"][data-side="new"]');
    expect(newCell).toBeTruthy();

    fireEvent.contextMenu(newCell!, { clientX: 100, clientY: 100 });
    const menuItemNew = screen.getByRole('menuitem', { name: /Show Selection History|显示选区历史/ });
    expect(menuItemNew).toBeTruthy();
    fireEvent.click(menuItemNew);

    expect(onShowSelectionHistory).toHaveBeenCalledWith({ start: 1, end: 1, side: 'new' }, 'rev-new', 'new_name.ts');
  });
});
