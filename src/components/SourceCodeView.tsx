import { useEffect, useState } from 'react';
import { codeToHtml, type BundledTheme } from 'shiki';
import { resolveDiffHighlightLanguage } from './UnifiedDiffView';

export function SourceCodeView({ content, path, language = 'text' }: { content: string; path: string; language?: string }) {
  const [theme, setTheme] = useState<BundledTheme>(() => document.documentElement.dataset.theme === 'light' ? 'light-plus' : 'dark-plus');
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === 'light' ? 'light-plus' : 'dark-plus'));
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
