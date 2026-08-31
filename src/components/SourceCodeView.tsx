import { useEffect, useState } from 'react';
import { codeToHtml, type BundledTheme, type ThemeRegistrationRaw } from 'shiki';
import { resolveDiffHighlightLanguage } from './UnifiedDiffView';
import { resolveShikiTheme } from '../theme';

export function SourceCodeView({ content, path, language = 'text' }: { content: string; path: string; language?: string }) {
  const [theme, setTheme] = useState<BundledTheme | ThemeRegistrationRaw>(() => resolveShikiTheme(document.documentElement.dataset.theme));
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => setTheme(resolveShikiTheme(document.documentElement.dataset.theme)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    if (content.length > 1_000_000) {
      queueMicrotask(() => { if (active) setHtml(''); });
      return () => { active = false; };
    }
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const resolved = resolveDiffHighlightLanguage(language, path, lines) ?? 'plaintext';
    void codeToHtml(content, { lang: resolved, theme })
      .then((value) => { if (active) setHtml(value); })
      .catch(() => { if (active) setHtml(''); });
    return () => { active = false; };
  }, [content, language, path, theme]);

  if (!html) return <pre className="source-code-fallback">{content}</pre>;
  return <div className="code-view source-code-view" dangerouslySetInnerHTML={{ __html: html }} />;
}
