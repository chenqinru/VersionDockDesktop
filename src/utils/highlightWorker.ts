import type { BundledTheme, ThemeRegistrationRaw, ThemedToken } from 'shiki/types';
import { ensureHighlighter } from './highlighter';

export type HighlightTheme = BundledTheme | ThemeRegistrationRaw;
export type HighlightWorkerRequest = { id: number; code: string; language: string; theme: HighlightTheme };
export type HighlightWorkerResponse = { id: number; tokens?: ThemedToken[][]; error?: string };

const loadedThemes = new WeakMap<object, Map<string, string>>();
export async function tokenizeCode(code: string, language: string, theme: HighlightTheme): Promise<ThemedToken[][]> {
  const highlighter = await ensureHighlighter(language);
  if (typeof theme !== 'string') {
    const signature = JSON.stringify(theme);
    let themes = loadedThemes.get(highlighter);
    if (!themes) { themes = new Map(); loadedThemes.set(highlighter, themes); }
    const name = theme.name ?? signature;
    if (themes.get(name) !== signature) {
      highlighter.loadThemeSync(theme);
      themes.set(name, signature);
    }
  }
  return highlighter.codeToTokensBase(code, { lang: language, theme });
}
