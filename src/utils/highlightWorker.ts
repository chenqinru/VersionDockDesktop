import { splitLines } from 'shiki/core';
import type { BundledTheme, GrammarState, ThemeRegistrationRaw, ThemedToken } from 'shiki/types';
import { ensureHighlighter } from './highlighter';

export type HighlightTheme = BundledTheme | ThemeRegistrationRaw;
export type HighlightWorkerRequest =
  | { action: 'start'; id: number; code: string; language: string; theme: HighlightTheme }
  | { action: 'continue' | 'cancel'; id: number };
export type HighlightChunk = { tokens: ThemedToken[][]; startLine: number; done: boolean };
export type HighlightWorkerResponse = { id: number; error?: string } & Partial<HighlightChunk>;
export type HighlightSession = { next: () => HighlightChunk };

const CHUNK_LINES = 80;
const CHUNK_CHARACTERS = 16_000;

const loadedThemes = new WeakMap<object, Map<string, string>>();
export async function createHighlightSession(code: string, language: string, theme: HighlightTheme): Promise<HighlightSession> {
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
  const lines = splitLines(code);
  let nextLine = 0;
  let grammarState: GrammarState | undefined;
  return { next: () => {
    const startLine = nextLine;
    let characters = 0;
    do {
      characters += lines[nextLine][0].length + 1;
      nextLine += 1;
    } while (nextLine < lines.length && nextLine - startLine < CHUNK_LINES && characters < CHUNK_CHARACTERS);
    const source = lines.slice(startLine, nextLine).map(([line]) => line).join('\n');
    const tokens = highlighter.codeToTokensBase(source, { lang: language, theme, grammarState });
    // Carry TextMate state across chunks so multiline comments, strings and
    // embedded languages receive exactly the same colors as a whole hunk.
    grammarState = highlighter.getLastGrammarState(tokens);
    let localOffset = 0;
    tokens.forEach((line, index) => {
      // Shiki offsets refer to the complete source, including CRLF separators.
      const adjustment = lines[startLine + index][1] - localOffset;
      line.forEach(token => { token.offset += adjustment; });
      localOffset += lines[startLine + index][0].length + 1;
    });
    return { tokens, startLine, done: nextLine === lines.length };
  } };
}
