import { useEffect, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import { cachedHighlighter, ensureHighlighter } from './highlighter';

export function useShiki(language: string): HighlighterCore | null {
  const [ready, setReady] = useState(() => ({ language, highlighter: cachedHighlighter(language) }));

  useEffect(() => {
    let disposed = false;
    ensureHighlighter(language).then((highlighter) => {
      if (!disposed) setReady({ language, highlighter });
    }).catch(() => {
      if (!disposed) setReady({ language, highlighter: null });
    });
    return () => { disposed = true; };
  }, [language]);

  return ready.language === language ? ready.highlighter : null;
}
