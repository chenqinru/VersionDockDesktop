import { useEffectiveTheme } from '../theme/useEffectiveTheme';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemedToken } from 'shiki';
import { highlightDiffLines } from './UnifiedDiffView';
import { resolveShikiTheme } from '../theme';
import { useI18n } from '../i18n';
import { FileSearchWidget } from './FileSearchWidget';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';

export function SourceCodeView({ content, path, language = 'text' }: { content: string; path: string; language?: string }) {
  const { t } = useI18n();
  const theme = resolveShikiTheme(useEffectiveTheme());
  const lines = useMemo(() => content.replace(/\r\n/g, '\n').split('\n'), [content]);
  const [highlighted, setHighlighted] = useState<{ content: string; path: string; theme: typeof theme; tokens: ThemedToken[][] }>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const container = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const matches = useMemo(() => {
    const result: { line: number; start: number; end: number }[] = [];
    if (!query) return result;
    const needle = query.toLocaleLowerCase();
    lines.forEach((line, lineIndex) => {
      const haystack = line.toLocaleLowerCase();
      for (let start = haystack.indexOf(needle); start >= 0; start = haystack.indexOf(needle, start + needle.length)) result.push({ line: lineIndex, start, end: start + needle.length });
    });
    return result;
  }, [lines, query]);
  const current = matches.length ? index % matches.length : 0;
  const matchesByLine = useMemo(() => {
    const values = new Map<number, { start: number; end: number; current: boolean }[]>();
    matches.forEach((match, matchIndex) => values.set(match.line, [...values.get(match.line) ?? [], { ...match, current: matchIndex === current }]));
    return values;
  }, [matches, current]);
  const startSearch = useCallback(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true); queueMicrotask(() => { input.current?.focus(); input.current?.select(); });
  }, []);
  const closeSearch = useCallback(() => { setOpen(false); setQuery(''); setIndex(0); trigger.current?.focus(); }, []);
  const navigate = useCallback((direction: -1 | 1) => { if (matches.length) setIndex((value) => (value + direction + matches.length) % matches.length); }, [matches.length]);


  useEffect(() => {
    let active = true;
    if (content.length > 1_000_000 || lines.length > 10_000) return;
    void highlightDiffLines(lines, language, path, theme).then((tokens) => { if (active) setHighlighted({ content, path, theme, tokens }); }).catch(() => undefined);
    return () => { active = false; };
  }, [content, lines, language, path, theme]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const element = container.current;
      const scope = element?.closest('[role="dialog"]') ?? element;
      if (!element || event.defaultPrevented || event.isComposing || document.querySelector('[role="menu"]') || (!open && !scope?.contains(document.activeElement) && !scope?.matches(':hover'))) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); startSearch(); }
      else if (open && event.key === 'Escape') { event.preventDefault(); closeSearch(); }
      else if (open && (event.key === 'F3' || event.target === input.current && event.key === 'Enter')) { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [startSearch, closeSearch, navigate, open]);
  useEffect(() => {
    container.current?.querySelector<HTMLElement>('.source-search-match.current')?.scrollIntoView?.({ block: 'center', inline: 'center' });
  }, [matches, current, highlighted]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) { setQuery(''); setIndex(0); } });
    return () => { active = false; };
  }, [content, path]);

  const tokens = highlighted?.content === content && highlighted.path === path && highlighted.theme === theme ? highlighted.tokens : undefined;
  return <section ref={container} tabIndex={-1} className="source-code-workspace">
    <div className="source-code-toolbar"><IconButton title={t('Find in file')} aria-label={t('Find in file')} onClick={startSearch}><Codicon name="search" /></IconButton></div>
    <FileSearchWidget placeholder={t('Find in file')} query={query} isOpen={open} inputRef={input} onChange={(value) => { setQuery(value); setIndex(0); }} onClose={closeSearch} count={{ current: matches.length ? current + 1 : 0, total: matches.length }} onNavigate={navigate} />
    <div className="code-view source-code-view"><pre className="shiki"><code>{lines.map((line, lineIndex) => {
      let offset = 0;
      const lineMatches = matchesByLine.get(lineIndex) ?? [];
      const values = tokens?.[lineIndex]?.length ? tokens[lineIndex] : [{ content: line }];
      return <span className="line" key={lineIndex}>{values.map((token, tokenIndex) => {
        const start = offset; offset += token.content.length;
        const boundaries = new Set([start, offset]);
        lineMatches.forEach((match) => { if (match.start > start && match.start < offset) boundaries.add(match.start); if (match.end > start && match.end < offset) boundaries.add(match.end); });
        const points = [...boundaries].sort((a, b) => a - b);
        return points.slice(0, -1).map((point, part) => {
          const text = token.content.slice(point - start, points[part + 1] - start);
          const match = lineMatches.find((match) => match.start <= point && match.end > point);
          const fontStyle = 'fontStyle' in token ? token.fontStyle ?? 0 : 0;
          const style = { color: 'color' in token ? token.color : undefined, fontStyle: fontStyle & 1 ? 'italic' : undefined, fontWeight: fontStyle & 2 ? 'bold' : undefined, textDecoration: fontStyle & 4 ? 'underline' : undefined };
          return match ? <mark key={`${tokenIndex}:${part}`} className={`source-search-match${match.current ? ' current' : ''}`} style={style}>{text}</mark> : <span key={`${tokenIndex}:${part}`} style={style}>{text}</span>;
        });
      })}</span>;
    }).flatMap((line, index) => index ? ['\n', line] : [line])}</code></pre></div>
  </section>;
}
