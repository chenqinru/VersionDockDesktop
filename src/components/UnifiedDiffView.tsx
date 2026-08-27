import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { bundledLanguages, codeToTokensBase, type BundledLanguage, type BundledTheme, type ThemedToken } from 'shiki';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';

type DiffSide = 'old' | 'new';
type HorizontalScrollGroup = DiffSide | 'inline';
type DiffCellKind = 'context' | 'deletion' | 'addition' | 'empty';

export interface DiffCell {
  kind: DiffCellKind;
  lineNumber: number | null;
  content: string;
}

export type ParsedDiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'meta'; text: string }
  | { kind: 'pair'; oldCell: DiffCell; newCell: DiffCell };

export interface ParsedUnifiedDiff {
  oldLabel: string;
  newLabel: string;
  rows: ParsedDiffRow[];
  hunkCount: number;
}

type RenderRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'meta'; text: string }
  | { kind: 'split'; oldCell: DiffCell; newCell: DiffCell }
  | { kind: 'inline'; side: DiffSide | 'both'; oldNumber: number | null; newNumber: number | null; cell: DiffCell; peer?: DiffCell };

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:\s?(.*))?$/;
const SVN_HUNK_HEADER = /^##\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+##(?:\s?(.*))?$/;
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  rs: 'rust', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  vue: 'vue', svelte: 'svelte', astro: 'astro', py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin',
  json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', md: 'markdown', mdx: 'mdx', sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell', go: 'go', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp', swift: 'swift', dart: 'dart',
};

function languageFromPath(path: string): string {
  const extension = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'text';
}

function looksLikeMarkup(lines: string[]): boolean {
  const attributeLines = lines.filter((line) => /^\s*(?:v-|[@:#])?[\w-]+\s*=/.test(line)).length;
  return lines.some((line) => /<\/?[a-z][\w:-]*(?:\s|>|\/)/i.test(line) || /(?:\bv-|\s[@:#][\w-]+)=/.test(line))
    || (attributeLines >= 2 && lines.some((line) => /\/?>\s*$/.test(line)));
}

function looksLikeStylesheet(lines: string[]): boolean {
  const source = lines.join('\n');
  return /(?:^|\n)\s*(?:[.#][\w-]+|[a-z][\w-]*(?:\s+[.#][\w-]+)?)\s*\{/.test(source)
    && /(?:^|[;{])\s*[\w-]+\s*:\s*[^=]/.test(source);
}

// A unified patch often starts inside a Vue/Svelte block and therefore omits
// the <script>/<template>/<style> tag that an embedded grammar needs. Pick the
// contained grammar for those fragments so changed code still receives real
// syntax colors instead of falling back to monochrome text.
// eslint-disable-next-line react-refresh/only-export-components
export function resolveDiffHighlightLanguage(language: string, path: string, lines: string[]): BundledLanguage | null {
  let requested = language.trim().toLowerCase();
  if (!requested || requested === 'text' || requested === 'plaintext' || requested === 'diff') requested = languageFromPath(path);
  if (requested === 'vue' || requested === 'svelte' || requested === 'astro') {
    if (lines.some((line) => /<\/?(?:template|script|style)\b/i.test(line))) return requested as BundledLanguage;
    if (looksLikeMarkup(lines)) return requested as BundledLanguage;
    if (looksLikeStylesheet(lines)) return 'css';
    return 'typescript';
  }
  return requested in bundledLanguages ? requested as BundledLanguage : null;
}

// eslint-disable-next-line react-refresh/only-export-components
export async function highlightDiffLines(lines: string[], language: string, path: string, theme: BundledTheme): Promise<ThemedToken[][]> {
  const resolved = resolveDiffHighlightLanguage(language, path, lines);
  if (!resolved) return lines.map(() => []);
  return codeToTokensBase(lines.join('\n'), { lang: resolved, theme });
}

function diffCellGroups(parsed: ParsedUnifiedDiff, side: DiffSide): DiffCell[][] {
  const groups: DiffCell[][] = [];
  let current: DiffCell[] = [];
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  for (const row of parsed.rows) {
    if (row.kind === 'hunk' || row.kind === 'meta') {
      flush();
      continue;
    }
    current.push(side === 'old' ? row.oldCell : row.newCell);
  }
  flush();
  return groups;
}

// Highlight each hunk independently. A Vue patch can contain script hunks and
// template hunks without their surrounding SFC tags; treating the entire patch
// as one fragment makes one section's grammar corrupt every other section.
// eslint-disable-next-line react-refresh/only-export-components
export async function highlightParsedDiffSide(parsed: ParsedUnifiedDiff, side: DiffSide, language: string, path: string, theme: BundledTheme): Promise<WeakMap<DiffCell, ThemedToken[]>> {
  const groups = diffCellGroups(parsed, side);
  const tokenGroups = await Promise.all(groups.map((cells) => highlightDiffLines(cells.map((cell) => cell.content || ' '), language, path, theme)));
  const highlighted = new WeakMap<DiffCell, ThemedToken[]>();
  groups.forEach((cells, groupIndex) => cells.forEach((cell, lineIndex) => highlighted.set(cell, tokenGroups[groupIndex]?.[lineIndex] ?? [])));
  return highlighted;
}

function emptyCell(): DiffCell {
  return { kind: 'empty', lineNumber: null, content: '' };
}

function normalizePathLabel(value: string, fallback: string): string {
  const label = value.trim().replace(/^"|"$/g, '');
  if (!label || label === '/dev/null') return label || fallback;
  const withoutTimestamp = label.replace(/\t.*$/, '').replace(/\s+\((?:revision|working copy).*\)$/i, '');
  return withoutTimestamp.replace(/^[ab]\//, '') || fallback;
}

function isFileBoundary(line: string): boolean {
  return line.startsWith('diff --git ') || line.startsWith('Index: ');
}

function flushChanges(rows: ParsedDiffRow[], deleted: DiffCell[], added: DiffCell[]): void {
  const count = Math.max(deleted.length, added.length);
  for (let index = 0; index < count; index += 1) {
    rows.push({ kind: 'pair', oldCell: deleted[index] ?? emptyCell(), newCell: added[index] ?? emptyCell() });
  }
  deleted.length = 0;
  added.length = 0;
}

/** Parse Git and SVN unified patches into aligned old/new rows. */
// eslint-disable-next-line react-refresh/only-export-components
export function parseUnifiedDiff(content: string, fallbackPath = ''): ParsedUnifiedDiff {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldLabel = fallbackPath;
  let newLabel = fallbackPath;
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  let hunkCount = 0;
  const rows: ParsedDiffRow[] = [];
  const deleted: DiffCell[] = [];
  const added: DiffCell[] = [];

  for (const line of lines) {
    const hunk = line.match(HUNK_HEADER) ?? line.match(SVN_HUNK_HEADER);
    if (hunk) {
      flushChanges(rows, deleted, added);
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[3]);
      inHunk = true;
      hunkCount += 1;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }

    if (inHunk && isFileBoundary(line)) {
      flushChanges(rows, deleted, added);
      inHunk = false;
    }

    if (!inHunk) {
      if (line.startsWith('--- ')) {
        oldLabel = normalizePathLabel(line.slice(4), fallbackPath);
        continue;
      }
      if (line.startsWith('+++ ')) {
        newLabel = normalizePathLabel(line.slice(4), fallbackPath);
        continue;
      }
      if (
        !line
        || line.startsWith('diff --git ')
        || line.startsWith('Index: ')
        || /^={3,}$/.test(line)
        || line.startsWith('index ')
        || /^(?:new|deleted|old|new) file mode /.test(line)
        || /^(?:dis)?similarity index /.test(line)
      ) continue;
      rows.push({ kind: 'meta', text: line });
      continue;
    }

    if (line.startsWith(' ')) {
      flushChanges(rows, deleted, added);
      const contentLine = line.slice(1);
      rows.push({
        kind: 'pair',
        oldCell: { kind: 'context', lineNumber: oldNumber, content: contentLine },
        newCell: { kind: 'context', lineNumber: newNumber, content: contentLine },
      });
      oldNumber += 1;
      newNumber += 1;
      continue;
    }
    if (line.startsWith('-')) {
      deleted.push({ kind: 'deletion', lineNumber: oldNumber, content: line.slice(1) });
      oldNumber += 1;
      continue;
    }
    if (line.startsWith('+')) {
      added.push({ kind: 'addition', lineNumber: newNumber, content: line.slice(1) });
      newNumber += 1;
      continue;
    }
    flushChanges(rows, deleted, added);
    if (line === '\\ No newline at end of file') rows.push({ kind: 'meta', text: line });
    else if (line) rows.push({ kind: 'meta', text: line });
  }
  flushChanges(rows, deleted, added);

  return {
    oldLabel: oldLabel || fallbackPath,
    newLabel: newLabel || fallbackPath,
    rows,
    hunkCount,
  };
}

function buildRenderRows(parsed: ParsedUnifiedDiff, view: 'split' | 'inline'): RenderRow[] {
  const rows: RenderRow[] = [];
  for (const row of parsed.rows) {
    if (row.kind !== 'pair') {
      rows.push(row);
      continue;
    }
    if (view === 'split') {
      rows.push({ kind: 'split', oldCell: row.oldCell, newCell: row.newCell });
      continue;
    }
    if (row.oldCell.kind === 'context' && row.newCell.kind === 'context') {
      rows.push({ kind: 'inline', side: 'both', oldNumber: row.oldCell.lineNumber, newNumber: row.newCell.lineNumber, cell: row.oldCell });
      continue;
    }
    if (row.oldCell.kind !== 'empty') rows.push({ kind: 'inline', side: 'old', oldNumber: row.oldCell.lineNumber, newNumber: null, cell: row.oldCell, peer: row.newCell.kind === 'addition' ? row.newCell : undefined });
    if (row.newCell.kind !== 'empty') rows.push({ kind: 'inline', side: 'new', oldNumber: null, newNumber: row.newCell.lineNumber, cell: row.newCell, peer: row.oldCell.kind === 'deletion' ? row.oldCell : undefined });
  }
  return rows;
}

function changedRange(content: string, peer?: string): [number, number] | undefined {
  if (peer === undefined || content === peer) return undefined;
  let prefix = 0;
  while (prefix < content.length && prefix < peer.length && content[prefix] === peer[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < content.length - prefix && suffix < peer.length - prefix && content[content.length - 1 - suffix] === peer[peer.length - 1 - suffix]) suffix += 1;
  return [prefix, content.length - suffix];
}

function changedContent(content: string, peer?: string, tokens?: ThemedToken[]): ReactNode {
  const range = changedRange(content, peer);
  if (!tokens?.length) {
    if (!range) return content || ' ';
    return <>{content.slice(0, range[0])}{range[1] > range[0] && <mark>{content.slice(range[0], range[1])}</mark>}{content.slice(range[1])}</>;
  }
  let offset = 0;
  return tokens.map((token, index) => {
    const start = offset;
    const end = start + token.content.length;
    offset = end;
    if (!range) return <span key={`${index}:${start}`} style={{ color: token.color }}>{token.content}</span>;
    const changedStart = range ? Math.max(start, range[0]) : end;
    const changedEnd = range ? Math.min(end, range[1]) : start;
    const before = token.content.slice(0, Math.max(0, changedStart - start));
    const changed = changedEnd > changedStart ? token.content.slice(changedStart - start, changedEnd - start) : '';
    const after = token.content.slice(Math.max(0, changedEnd - start));
    return <span key={`${index}:${start}`} style={{ color: token.color }}>{before}{changed && <mark>{changed}</mark>}{after}</span>;
  });
}

function SyncedCode({ group, offset, onScroll, children }: { group: HorizontalScrollGroup; offset: number; onScroll: (group: HorizontalScrollGroup, event: UIEvent<HTMLElement>) => void; children: ReactNode }) {
  return <code
    data-diff-scroll-group={group}
    ref={(element) => { if (element && element.scrollLeft !== offset) element.scrollLeft = offset; }}
    onScroll={(event) => onScroll(group, event)}
  >{children}</code>;
}

function DiffCodeCell({ cell, peer, side, tokens, horizontalOffset, onHorizontalScroll }: { cell: DiffCell; peer?: DiffCell; side: DiffSide; tokens?: ThemedToken[]; horizontalOffset: number; onHorizontalScroll: (group: HorizontalScrollGroup, event: UIEvent<HTMLElement>) => void }) {
  const marker = cell.kind === 'deletion' ? '−' : cell.kind === 'addition' ? '+' : ' ';
  return <div className={`diff-code-cell ${side} ${cell.kind}`}>
    <span className="diff-marker">{marker}</span>
    <span className="diff-line-number">{cell.lineNumber ?? ''}</span>
    <SyncedCode group={side} offset={horizontalOffset} onScroll={onHorizontalScroll}>{cell.kind === 'empty' ? ' ' : changedContent(cell.content, peer?.content, tokens)}</SyncedCode>
  </div>;
}

function renderRow(row: RenderRow, highlighted: WeakMap<DiffCell, ThemedToken[]> | undefined, horizontalOffsets: Record<HorizontalScrollGroup, number>, onHorizontalScroll: (group: HorizontalScrollGroup, event: UIEvent<HTMLElement>) => void): ReactNode {
  if (row.kind === 'hunk') return <div className="diff-hunk-row" title={row.text}><span /><Codicon name="ellipsis" /><span /></div>;
  if (row.kind === 'meta') return <div className="diff-meta-row"><Codicon name="info" /><code>{row.text}</code></div>;
  if (row.kind === 'split') {
    return <div className="diff-split-row">
      <DiffCodeCell side="old" cell={row.oldCell} peer={row.newCell.kind === 'addition' ? row.newCell : undefined} tokens={highlighted?.get(row.oldCell)} horizontalOffset={horizontalOffsets.old} onHorizontalScroll={onHorizontalScroll} />
      <DiffCodeCell side="new" cell={row.newCell} peer={row.oldCell.kind === 'deletion' ? row.oldCell : undefined} tokens={highlighted?.get(row.newCell)} horizontalOffset={horizontalOffsets.new} onHorizontalScroll={onHorizontalScroll} />
    </div>;
  }
  const marker = row.cell.kind === 'deletion' ? '−' : row.cell.kind === 'addition' ? '+' : ' ';
  return <div className={`diff-inline-row ${row.cell.kind}`}>
    <span className="diff-line-number old">{row.oldNumber ?? ''}</span>
    <span className="diff-line-number new">{row.newNumber ?? ''}</span>
    <span className="diff-marker">{marker}</span>
    <SyncedCode group="inline" offset={horizontalOffsets.inline} onScroll={onHorizontalScroll}>{changedContent(row.cell.content, row.peer?.content, highlighted?.get(row.cell))}</SyncedCode>
  </div>;
}

export function UnifiedDiffView({ content, path = '', language = 'text', className = '', splitBreakpoint = 700 }: { content: string; path?: string; language?: string; className?: string; splitBreakpoint?: number }) {
  const { t } = useI18n();
  const [view, setView] = useState<'split' | 'inline'>('split');
  const [theme, setTheme] = useState<BundledTheme>(() => document.documentElement.dataset.theme === 'light' ? 'light-plus' : 'dark-plus');
  const parsed = useMemo(() => parseUnifiedDiff(content, path), [content, path]);
  const rows = useMemo(() => buildRenderRows(parsed, view), [parsed, view]);
  const [highlighted, setHighlighted] = useState<WeakMap<DiffCell, ThemedToken[]>>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const horizontalOffsets = useRef<Record<HorizontalScrollGroup, number>>({ old: 0, new: 0, inline: 0 });
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === 'hunk' || rows[index]?.kind === 'meta' ? 27 : 22,
    overscan: 24,
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setView(entry.contentRect.width < splitBreakpoint ? 'inline' : 'split'));
    observer.observe(element);
    return () => observer.disconnect();
  }, [splitBreakpoint]);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === 'light' ? 'light-plus' : 'dark-plus'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    const pairs = parsed.rows.filter((row): row is Extract<ParsedDiffRow, { kind: 'pair' }> => row.kind === 'pair');
    if (content.length > 1_000_000 || pairs.length > 10_000) { setHighlighted(undefined); return () => { active = false; }; }
    void Promise.all([
      highlightParsedDiffSide(parsed, 'old', language, path, theme),
      highlightParsedDiffSide(parsed, 'new', language, path, theme),
    ]).then(([oldTokens, newTokens]) => {
      if (!active) return;
      const next = new WeakMap<DiffCell, ThemedToken[]>();
      pairs.forEach((row) => {
        next.set(row.oldCell, oldTokens.get(row.oldCell) ?? []);
        next.set(row.newCell, newTokens.get(row.newCell) ?? []);
      });
      setHighlighted(next);
    }).catch(() => { if (active) setHighlighted(undefined); });
    return () => { active = false; };
  }, [content.length, language, parsed, path, theme]);
  useEffect(() => { virtualizer.measure(); }, [view, virtualizer]);
  const syncHorizontalScroll = useCallback((group: HorizontalScrollGroup, event: UIEvent<HTMLElement>) => {
    const source = event.currentTarget;
    const next = source.scrollLeft;
    if (horizontalOffsets.current[group] === next) return;
    horizontalOffsets.current[group] = next;
    scrollRef.current?.querySelectorAll<HTMLElement>(`code[data-diff-scroll-group="${group}"]`).forEach((element) => {
      if (element !== source && element.scrollLeft !== next) element.scrollLeft = next;
    });
  }, []);

  return <section className={`unified-diff ${view} ${className}`} aria-label={t('File differences')}>
    <div ref={scrollRef} className="unified-diff-scroll">
      <div className="unified-diff-virtual" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="unified-diff-virtual-row"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >{renderRow(row, highlighted, horizontalOffsets.current, syncHorizontalScroll)}</div>;
        })}
      </div>
    </div>
  </section>;
}
