import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { applyTheme } from '../theme';
import { ThreeWayLayout } from './ThreeWayLayout';
const highlighter = vi.hoisted(() => ({ codeToTokens: vi.fn((_code: string, options: { theme: string | { name: string } }) => ({ tokens: [[{ content: 'const value = 1;', color: typeof options.theme === 'string' ? '#aabbcc' : '#112233' }]] })), loadThemeSync: vi.fn() }));
const useShiki = vi.hoisted(() => vi.fn());
vi.mock('../utils/useShiki', () => ({ useShiki: (language: string) => { useShiki(language); return highlighter; } }));
afterEach(() => { cleanup(); applyTheme('dark2026'); vi.clearAllMocks(); });
it('updates conflict and result highlighting when the effective theme changes', async () => {
  applyTheme('light2026');
  render(<ThreeWayLayout file={{ absolutePath: '/tmp/a.ts', relativePath: 'a.ts', repoId: 'repo', content: 'const value = 1;', oursContent: 'const value = 1;', theirsContent: 'const value = 1;', baseContent: 'const value = 1;', conflicts: [], oursLabel: 'main', theirsLabel: 'feature', language: 'typescript' }} language="typescript" resolutions={{}} normalEdits={{}} nonConflictingSelections={{}} onResultChange={vi.fn()} onResolveBlock={vi.fn()} onNormalEdit={vi.fn()} onSelectNonConflicting={vi.fn()} currentConflictIndex={-1} syncScrollEnabled />);
  expect(screen.getAllByText('const value = 1;').length).toBeGreaterThan(0);
  expect(highlighter.codeToTokens.mock.calls.some(([, options]) => typeof options.theme !== 'string' && options.theme.name === '2026-light')).toBe(true);
  await act(async () => applyTheme('dracula'));
  await waitFor(() => expect(highlighter.codeToTokens.mock.calls.some(([, options]) => options.theme === 'dracula')).toBe(true));
});


it.each([
  ['tsx', 'typescript'],
  ['javascriptreact', 'javascript'],
  ['rust', 'typescript'],
  ['shell', 'shellscript'],
])('loads the rendered grammar for %s merge files', (language, renderedLanguage) => {
  render(<ThreeWayLayout file={{ absolutePath: '/tmp/a', relativePath: 'a', repoId: 'repo', content: 'const value = 1;', oursContent: 'const value = 1;', theirsContent: 'const value = 1;', baseContent: 'const value = 1;', conflicts: [], oursLabel: 'main', theirsLabel: 'feature', language }} language={language} resolutions={{}} normalEdits={{}} nonConflictingSelections={{}} onResultChange={vi.fn()} onResolveBlock={vi.fn()} onNormalEdit={vi.fn()} onSelectNonConflicting={vi.fn()} currentConflictIndex={-1} syncScrollEnabled />);
  expect(useShiki).toHaveBeenCalledWith(renderedLanguage);
  expect(highlighter.codeToTokens).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ lang: renderedLanguage }));
});
