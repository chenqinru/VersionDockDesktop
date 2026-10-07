import { useEffectiveTheme } from '../theme/useEffectiveTheme';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BundledLanguage, BundledTheme, ThemeRegistrationRaw, ThemedToken } from 'shiki/types';
import { resolveHighlightLanguage } from '../utils/highlighter';
import { cachedSyntaxTokens, highlightSyntax } from '../utils/syntaxHighlighting';
import { BridgeContext } from '../platform/context';
import { FileSearchWidget } from './FileSearchWidget';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { ContextMenu } from './ContextMenu';
import { useI18n } from '../i18n';
import { useAppStore, normalizeHistoryRevision } from '../store/appStore';
import { resolveShikiTheme } from '../theme';

type DiffSide = 'old' | 'new';
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
  | { kind: 'fold'; foldId: string; hiddenCount: number }
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
  return resolveHighlightLanguage(requested);
}

export interface DiffSelectionLineRange {
  start: number;
  end: number;
  side?: 'old' | 'new';
}

// eslint-disable-next-line react-refresh/only-export-components
export function extractDiffLineRange(container: HTMLElement, target?: Element | null): DiffSelectionLineRange | undefined {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    if (
      container.contains(range.commonAncestorContainer)
      || container.contains(range.startContainer)
      || container.contains(range.endContainer)
    ) {
      const lineElements = Array.from(container.querySelectorAll<HTMLElement>('.diff-inline-row, .diff-code-cell, [data-line-number]'));
      let detectedSide: 'old' | 'new' | undefined = target?.closest('.diff-code-cell.old, .diff-line-number.old') ? 'old' : target?.closest('.diff-code-cell.new, .diff-line-number.new') ? 'new' : undefined;
      for (const el of detectedSide ? [] : lineElements) {
        if (range.intersectsNode(el)) {
          if (el.dataset.side === 'old' || el.closest('.unified-diff-pane.old') || el.classList.contains('deletion') || el.classList.contains('old')) {
            detectedSide = 'old';
            break;
          } else if (el.dataset.side === 'new' || el.closest('.unified-diff-pane.new') || el.classList.contains('addition') && !el.dataset.historyMapped) {
            detectedSide = 'new';
          }
        }
      }
      const side = detectedSide ?? 'new';

      const lineNumbers: number[] = [];
      const seen = new Set<HTMLElement>();
      for (const el of lineElements) {
        if (seen.has(el)) continue;
        if (range.intersectsNode(el)) {
          seen.add(el);
          let num: number | undefined;
          if (side === 'old') {
            const rawOld = el.dataset.oldLineNumber;
            if (rawOld !== undefined) {
              num = Number(rawOld);
            } else if (el.dataset.side === 'old' || el.classList.contains('old') || el.classList.contains('deletion')) {
              num = Number(el.dataset.lineNumber);
            }
          } else {
            const rawNew = el.dataset.newLineNumber;
            if (rawNew !== undefined) {
              num = Number(rawNew);
            } else if (el.dataset.side === 'new' || el.classList.contains('new') || el.classList.contains('addition')) {
              num = Number(el.dataset.lineNumber);
            }
          }
          if (num !== undefined && !Number.isNaN(num) && num > 0) {
            lineNumbers.push(num);
          }
        }
      }
      if (lineNumbers.length > 0) {
        return {
          start: Math.min(...lineNumbers),
          end: Math.max(...lineNumbers),
          side,
        };
      }
    }
  }

  if (target) {
    const specificNumberEl = target.closest<HTMLElement>('.diff-line-number[data-line-number], [data-side][data-line-number]');
    if (specificNumberEl && container.contains(specificNumberEl)) {
      const num = Number(specificNumberEl.dataset.lineNumber);
      if (!Number.isNaN(num) && num > 0) {
        const side = specificNumberEl.dataset.side === 'old' || specificNumberEl.classList.contains('old') ? 'old' : 'new';
        return { start: num, end: num, side };
      }
    }

    const lineEl = target.closest<HTMLElement>('[data-line-number], .diff-inline-row, .diff-code-cell');
    if (lineEl && container.contains(lineEl)) {
      let side: 'old' | 'new' = 'new';
      if (
        target.closest('.diff-line-number.old')
        || target.closest('.diff-code-cell.old')
        || target.closest('.unified-diff-pane.old')
        || lineEl.dataset.side === 'old'
        || lineEl.classList.contains('deletion')
      ) {
        side = 'old';
      }

      let num: number | undefined;
      if (side === 'old') {
        const rawOld = lineEl.dataset.oldLineNumber;
        num = rawOld !== undefined ? Number(rawOld) : Number(lineEl.dataset.lineNumber);
      } else {
        const rawNew = lineEl.dataset.newLineNumber;
        num = rawNew !== undefined ? Number(rawNew) : Number(lineEl.dataset.lineNumber);
      }

      if (num !== undefined && !Number.isNaN(num) && num > 0) {
        return { start: num, end: num, side };
      }
    }
  }

  return undefined;
}

// eslint-disable-next-line react-refresh/only-export-components
export async function highlightDiffLines(lines: string[], language: string, path: string, theme: BundledTheme | ThemeRegistrationRaw, signal?: AbortSignal): Promise<ThemedToken[][]> {
  const resolved = resolveDiffHighlightLanguage(language, path, lines);
  if (!resolved) return lines.map(() => []);
  return highlightSyntax(lines.join('\n'), resolved, theme, signal);
}

// eslint-disable-next-line react-refresh/only-export-components
export function cachedDiffLines(lines: string[], language: string, path: string, theme: BundledTheme | ThemeRegistrationRaw): ThemedToken[][] | undefined {
  const resolved = resolveDiffHighlightLanguage(language, path, lines);
  return resolved ? cachedSyntaxTokens(lines.join('\n'), resolved, theme) : undefined;
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
export async function highlightParsedDiffSide(parsed: ParsedUnifiedDiff, side: DiffSide, language: string, path: string, theme: BundledTheme | ThemeRegistrationRaw, options?: { signal?: AbortSignal; onGroup?: (cells: DiffCell[], tokens: ThemedToken[][]) => void; onError?: (error: unknown) => void }): Promise<WeakMap<DiffCell, ThemedToken[]>> {
  const groups = diffCellGroups(parsed, side);
  const highlighted = new WeakMap<DiffCell, ThemedToken[]>();
  // Each side advances one hunk at a time. The shared worker interleaves both
  // sides instead of queueing every old-side hunk ahead of the new-side viewport.
  for (const cells of groups) {
    if (options?.signal?.aborted) break;
    try {
      const tokens = await highlightDiffLines(cells.map((cell) => cell.content || ' '), language, path, theme, options?.signal);
      if (options?.signal?.aborted) break;
      cells.forEach((cell, index) => highlighted.set(cell, tokens[index] ?? []));
      options?.onGroup?.(cells, tokens);
    } catch (error) {
      if (!options?.signal?.aborted) options?.onError?.(error);
    }
  }
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
  let inProperties = false;
  let hunkCount = 0;
  const rows: ParsedDiffRow[] = [];
  const deleted: DiffCell[] = [];
  const added: DiffCell[] = [];

  for (const line of lines) {
    if (isFileBoundary(line)) inProperties = false;
    if (line.startsWith('Property changes on:')) { flushChanges(rows, deleted, added); inHunk = false; inProperties = true; }
    if (inProperties) { if (line && !/^_{3,}$/.test(line)) rows.push({ kind: 'meta', text: line }); continue; }
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
        || /^(?:new|deleted) file mode /.test(line)
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

type FoldExpansion = { top: number; bottom: number; all?: boolean };

function buildRenderRows(
  parsed: ParsedUnifiedDiff,
  view: 'split' | 'inline',
  collapsed: boolean,
  expandedFolds: Record<string, FoldExpansion>,
): RenderRow[] {
  const rows: RenderRow[] = [];
  let foldIndex = 0;
  const pushPair = (row: Extract<ParsedDiffRow, { kind: 'pair' }>) => {
    if (view === 'split') rows.push({ kind: 'split', oldCell: row.oldCell, newCell: row.newCell });
    else if (row.oldCell.kind === 'context' && row.newCell.kind === 'context') {
      rows.push({ kind: 'inline', side: 'both', oldNumber: row.oldCell.lineNumber, newNumber: row.newCell.lineNumber, cell: row.oldCell });
    } else {
      if (row.oldCell.kind !== 'empty') rows.push({ kind: 'inline', side: 'old', oldNumber: row.oldCell.lineNumber, newNumber: null, cell: row.oldCell, peer: row.newCell.kind === 'addition' ? row.newCell : undefined });
      if (row.newCell.kind !== 'empty') rows.push({ kind: 'inline', side: 'new', oldNumber: null, newNumber: row.newCell.lineNumber, cell: row.newCell, peer: row.oldCell.kind === 'deletion' ? row.oldCell : undefined });
    }
  };
  let group: Extract<ParsedDiffRow, { kind: 'pair' }>[] = [];
  const flush = () => {
    if (!group.length) return;
    const keep = group.map(() => !collapsed);
    if (collapsed) {
      const changed = group.map((row) => row.oldCell.kind === 'deletion' || row.newCell.kind === 'addition');
      if (changed.some(Boolean)) {
        changed.forEach((value, index) => { if (value) for (let i = Math.max(0, index - 3); i <= Math.min(group.length - 1, index + 3); i += 1) keep[i] = true; });
      } else group.forEach((_, index) => { keep[index] = group.length <= 10 || index < 3 || index >= group.length - 3; });
    }
    for (let i = 0; i < group.length;) {
      if (keep[i]) { pushPair(group[i]); i += 1; continue; }
      const start = i;
      while (i < group.length && !keep[i]) i += 1;
      const count = i - start;
      const foldId = `fold-${foldIndex++}-${group[start].oldCell.lineNumber}`;
      const expansion = expandedFolds[foldId] ?? { top: 0, bottom: 0 };
      const top = expansion.all ? count : Math.min(count, expansion.top);
      const bottom = Math.min(count - top, expansion.bottom);
      for (let j = start; j < start + top; j += 1) pushPair(group[j]);
      if (count > top + bottom) rows.push({ kind: 'fold', foldId, hiddenCount: count - top - bottom });
      for (let j = i - bottom; j < i; j += 1) pushPair(group[j]);
    }
    group = [];
  };
  for (const row of parsed.rows) {
    if (row.kind === 'pair') group.push(row);
    else { flush(); if (row.kind === 'meta') rows.push(row); }
  }
  flush();
  return rows;
}

function changedRange(content: string, peer?: string): [number, number] | undefined {
  if (peer === undefined || content === peer) return undefined;
  let prefix = 0;
  while (prefix < content.length && prefix < peer.length && content[prefix] === peer[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < content.length - prefix && suffix < peer.length - prefix && content[content.length - 1 - suffix] === peer[peer.length - 1 - suffix]) suffix += 1;
  if (content.slice(0, prefix).trim() === '') {
    prefix = 0;
  }
  return [prefix, content.length - suffix];
}

interface SearchHighlight { start: number; end: number; current: boolean }

function changedContent(content: string, peer?: string, tokens?: ThemedToken[], search: SearchHighlight[] = []): ReactNode {
  if (search.length) {
    const range = changedRange(content, peer);
    const points = new Set([0, content.length]);
    search.forEach((match) => { points.add(match.start); points.add(match.end); });
    if (range) { points.add(range[0]); points.add(range[1]); }
    let offset = 0;
    const colors = (tokens ?? []).map((token) => { const start = offset; offset += token.content.length; points.add(offset); return { start, end: offset, color: token.color }; });
    const boundaries = [...points].sort((a, b) => a - b);
    let tokenIndex = 0;
    return boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1];
      while (tokenIndex < colors.length - 1 && colors[tokenIndex].end <= start) tokenIndex += 1;
      const match = search.find((match) => match.start <= start && match.end >= end);
      const piece = content.slice(start, end);
      const changed = range && range[0] <= start && range[1] >= end;
      return <span key={start} style={{ color: colors[tokenIndex]?.color }}>{match ? <mark className={`diff-search-match ${match.current ? 'current' : ''}`}>{piece}</mark> : changed ? <mark>{piece}</mark> : piece}</span>;
    });
  }
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

function DiffCodeCell({ cell, peer, side, tokens, search }: { cell: DiffCell; peer?: DiffCell; side: DiffSide; tokens?: ThemedToken[]; search?: SearchHighlight[] }) {
  const marker = cell.kind === 'deletion' ? '−' : cell.kind === 'addition' ? '+' : ' ';
  return <div className={`diff-code-cell ${side} ${cell.kind}`} data-line-number={cell.lineNumber ?? undefined} data-side={side} data-history-mapped={peer?.kind === 'deletion' ? 'true' : undefined}>
    <span className="diff-marker">{marker}</span>
    <span className="diff-line-number">{cell.lineNumber ?? ''}</span>
    <code>{cell.kind === 'empty' ? ' ' : changedContent(cell.content, peer?.content, tokens, search)}</code>
  </div>;
}

function DiffFoldRow({
  foldId,
  hiddenCount,
  onExpand,
}: {
  foldId: string;
  hiddenCount: number;
  onExpand: (foldId: string, action: 'all' | 'top' | 'bottom') => void;
}) {
  const { t } = useI18n();
  return <div className="diff-fold-row" role="region" aria-label={t('+{0} more lines', hiddenCount)}>
    <div className="diff-fold-line" />
    <div className="diff-fold-controls">
      <button
        type="button"
        className="diff-fold-badge"
        title={t('Expand differences')}
        onClick={() => onExpand(foldId, 'all')}
      >
        <span>{t('+{0} more lines', hiddenCount)}</span>
      </button>
      <div className="diff-fold-actions">
        <button
          type="button"
          className="diff-fold-action-btn"
          title={t('Expand 10 lines above')}
          onClick={() => onExpand(foldId, 'top')}
        >
          +10
        </button>
        <button
          type="button"
          className="diff-fold-action-btn"
          title={t('Expand 10 lines below')}
          onClick={() => onExpand(foldId, 'bottom')}
        >
          +10
        </button>
      </div>
    </div>
  </div>;
}

function renderRow(
  row: RenderRow,
  highlighted: WeakMap<DiffCell, ThemedToken[]> | undefined,
  onExpandFold: (foldId: string, action: 'all' | 'top' | 'bottom') => void,
  search?: WeakMap<DiffCell, SearchHighlight[]>,
): ReactNode {
  if (row.kind === 'hunk') return null;
  if (row.kind === 'meta') return <div className="diff-meta-row"><Codicon name="info" /><code>{row.text}</code></div>;
  if (row.kind === 'fold') return <DiffFoldRow foldId={row.foldId} hiddenCount={row.hiddenCount} onExpand={onExpandFold} />;
  if (row.kind === 'split') {
    return <div className="diff-split-row">
      <DiffCodeCell side="old" cell={row.oldCell} peer={row.newCell.kind === 'addition' ? row.newCell : undefined} tokens={highlighted?.get(row.oldCell)} search={search?.get(row.oldCell)} />
      <DiffCodeCell side="new" cell={row.newCell} peer={row.oldCell.kind === 'deletion' ? row.oldCell : undefined} tokens={highlighted?.get(row.newCell)} search={search?.get(row.newCell)} />
    </div>;
  }
  const marker = row.cell.kind === 'deletion' ? '−' : row.cell.kind === 'addition' ? '+' : ' ';
  const lineNumber = row.newNumber ?? row.oldNumber;
  return <div className={`diff-inline-row ${row.cell.kind}`} data-line-number={lineNumber ?? undefined} data-new-line-number={row.newNumber ?? undefined} data-old-line-number={row.oldNumber ?? undefined} data-history-mapped={row.peer?.kind === 'deletion' ? 'true' : undefined}>
    <span className="diff-line-number old" data-side="old" data-line-number={row.oldNumber ?? undefined}>{row.oldNumber ?? ''}</span>
    <span className="diff-line-number new" data-side="new" data-line-number={row.newNumber ?? undefined}>{row.newNumber ?? ''}</span>
    <span className="diff-marker">{marker}</span>
    <code>{changedContent(row.cell.content, row.peer?.content, highlighted?.get(row.cell), search?.get(row.cell))}</code>
  </div>;
}

export interface UnifiedDiffViewProps {
  content: string;
  reveal?: { line: number; side: DiffSide };
  path?: string;
  oldPath?: string;
  language?: string;
  className?: string;
  splitBreakpoint?: number;
  repoId?: string;
  oldRevision?: string;
  newRevision?: string;
  onShowSelectionHistory?: (range: DiffSelectionLineRange, revision?: string, path?: string) => void;
}

export function UnifiedDiffView({
  content,
  path = '',
  oldPath,
  language = 'text',
  className = '',
  splitBreakpoint = 700,
  repoId,
  oldRevision,
  newRevision,
  onShowSelectionHistory,
  reveal,
}: UnifiedDiffViewProps) {
  const { t } = useI18n();
  const bridge = useContext(BridgeContext);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const [historyError, setHistoryError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousCollapsed = useRef(true);
  const searchTrigger = useRef<HTMLElement | null>(null);
  const historyRequest = useRef(0);
  const contextSelection = useRef<string>();
  const [manualView, setManualView] = useState<'split' | 'inline'>();
  const [autoView, setAutoView] = useState<'split' | 'inline'>('split');
  const view = manualView ?? autoView;
  const theme = resolveShikiTheme(useEffectiveTheme());
  const [collapsed, setCollapsed] = useState<boolean>(true);
  const [expandedFolds, setExpandedFolds] = useState<Record<string, FoldExpansion>>({});
  const parsed = useMemo(() => parseUnifiedDiff(content, path), [content, path]);
  const rows = useMemo(() => buildRenderRows(parsed, view, searchQuery ? false : collapsed, expandedFolds), [parsed, view, searchQuery, collapsed, expandedFolds]);
  const searchRows = useMemo(() => buildRenderRows(parsed, view, false, {}), [parsed, view]);
  const searchMatches = useMemo(() => {
    const matches: { cell: DiffCell; side: DiffSide; start: number; end: number; rowIndex: number }[] = [];
    const query = searchQuery.toLocaleLowerCase();
    if (!query) return matches;
    searchRows.forEach((row, rowIndex) => {
      const cells = row.kind === 'split' ? [{ cell: row.oldCell, side: 'old' as const }, { cell: row.newCell, side: 'new' as const }]
        : row.kind === 'inline' ? [{ cell: row.cell, side: row.side === 'old' || row.side === 'both' ? 'old' as const : 'new' as const }] : [];
      cells.forEach(({ cell, side }) => {
        const text = cell.content.toLocaleLowerCase();
        for (let index = text.indexOf(query); index >= 0; index = text.indexOf(query, index + query.length)) matches.push({ cell, side, start: index, end: index + query.length, rowIndex });
      });
    });
    return matches;
  }, [searchQuery, searchRows]);
  const selectedSearchIndex = searchMatches.length ? searchIndex % searchMatches.length : 0;
  const searchHighlights = useMemo(() => {
    const values = new WeakMap<DiffCell, SearchHighlight[]>();
    searchMatches.forEach((match, index) => values.set(match.cell, [...values.get(match.cell) ?? [], { start: match.start, end: match.end, current: index === selectedSearchIndex }]));
    return values;
  }, [searchMatches, selectedSearchIndex]);
  const cachedTokens = useMemo(() => {
    const tokens = new WeakMap<DiffCell, ThemedToken[]>();
    if (content.length > 1_000_000 || parsed.rows.filter((row) => row.kind === 'pair').length > 10_000) return tokens;
    for (const side of ['old', 'new'] as const) for (const cells of diffCellGroups(parsed, side)) {
      const cached = cachedDiffLines(cells.map((cell) => cell.content || ' '), language, path, theme);
      cells.forEach((cell, index) => { if (cached?.[index]) tokens.set(cell, cached[index]); });
    }
    return tokens;
  }, [content.length, parsed, language, path, theme]);
  const [highlighted, setHighlighted] = useState<{ parsed: ParsedUnifiedDiff; theme: typeof theme; language: string; tokens: WeakMap<DiffCell, ThemedToken[]> }>();
  const renderedTokens = highlighted?.parsed === parsed && highlighted.theme === theme && highlighted.language === language ? highlighted.tokens : cachedTokens;
  const containerRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const horizontalOffset = useRef(0);
  const splitContentWidth = useMemo(() => {
    const columns = (text: string) => Array.from(text.replace(/\t/g, '    ')).reduce((width, character) => width + (character.codePointAt(0)! > 255 ? 2 : 1), 0);
    const longest = parsed.rows.reduce((width, row) => row.kind === 'pair' ? Math.max(width, columns(row.oldCell.content), columns(row.newCell.content)) : width, 0);
    return `calc(${longest}ch + 66px)`;
  }, [parsed]);
  const syncHorizontalScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const source = event.currentTarget;
    horizontalOffset.current = source.scrollLeft;
    const peer = source.parentElement?.querySelector<HTMLElement>(source.classList.contains('old') ? '.unified-diff-pane.new' : '.unified-diff-pane.old');
    if (!peer || Math.abs(peer.scrollLeft - source.scrollLeft) < 1) return;
    peer.scrollLeft = source.scrollLeft;
  }, []);
  const [activeChangeIndex, setActiveChangeIndex] = useState<number>(-1);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    lineRange?: DiffSelectionLineRange;
    selectionText?: string;
    isWorkingTreeAddition?: boolean;
  }>();

  const handleContextMenu = (event: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const target = event.target as Element;
    if (target.closest('.diff-toolbar') || target.closest('button')) return;

    event.preventDefault();
    event.stopPropagation();

    const selection = window.getSelection();
    const codeRow = target.closest<HTMLElement>('.diff-code-cell, .diff-inline-row, .diff-meta-row');
    const selectionText = (contextSelection.current ?? selection?.toString()) || (codeRow?.classList.contains('empty') ? '' : codeRow?.querySelector('code')?.textContent) || '';
    contextSelection.current = undefined;
    const lineRange = extractDiffLineRange(container, target);
    const isWorkingTree = !newRevision || newRevision === 'WORKTREE' || newRevision === 'WORKING' || newRevision === 'INDEX';
    let isWorkingTreeAddition = false;
    if (isWorkingTree && lineRange?.side !== 'old') {
      const cellEl = target.closest<HTMLElement>('.diff-code-cell, .diff-inline-row');
      if (cellEl && (cellEl.classList.contains('addition') && !cellEl.dataset.historyMapped)) {
        isWorkingTreeAddition = true;
      } else if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const lineElements = Array.from(container.querySelectorAll<HTMLElement>('.diff-inline-row, .diff-code-cell'));
        const selectedEls = lineElements.filter((el) => selection.getRangeAt(0).intersectsNode(el));
        if (selectedEls.length > 0 && selectedEls.every((el) => el.classList.contains('addition') && !el.dataset.historyMapped)) {
          isWorkingTreeAddition = true;
        }
      }
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      lineRange,
      selectionText,
      isWorkingTreeAddition,
    });
  };

  const handleSelectContextMenu = async (id: string) => {
    if (id === 'copy') {
      const text = contextMenu?.selectionText || '';
      if (text) {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
      }
    } else if (id === 'selection-history' && contextMenu?.lineRange && !contextMenu.isWorkingTreeAddition) {
      const isOld = contextMenu.lineRange.side === 'old';
      const rawRevision = isOld
        ? (oldRevision ?? (newRevision ? `${newRevision}~1` : undefined))
        : newRevision;
      let selectedRevision = normalizeHistoryRevision(rawRevision);
      const effectiveOldPath = oldPath || (parsed.oldLabel && parsed.oldLabel !== '/dev/null' ? parsed.oldLabel : path);
      let selectedPath = (isOld && effectiveOldPath) ? effectiveOldPath : path;
      let lineRange = contextMenu.lineRange;
      if (bridge && repoId && workspaceId && ['INDEX', 'WORKTREE', 'WORKING', 'BASE'].includes(rawRevision ?? 'WORKTREE')) {
        setContextMenu(undefined); setHistoryError('');
        const request = ++historyRequest.current;
        try {
          const result = await bridge.request<import('../bindings/generated').DiffLineHistoryTarget | null>({ type: 'diffLineHistoryTarget', payload: { workspace_id: workspaceId, repo_id: repoId, relative_path: selectedPath, source_revision: rawRevision ?? 'WORKTREE', line_range: { start: lineRange.start, end: lineRange.end } } }, { showProgress: false });
          if (request !== historyRequest.current || useAppStore.getState().snapshot?.workspace.id !== workspaceId) return;
          if (!result) { setHistoryError(t('Uncommitted additions have no history')); return; }
          selectedPath = result.path; selectedRevision = result.revision; lineRange = { ...result.lineRange, side: lineRange.side };
        } catch (error) { if (request === historyRequest.current) setHistoryError(String(error)); return; }
      }
      if (onShowSelectionHistory) onShowSelectionHistory(lineRange, selectedRevision, selectedPath);
      else if (repoId && selectedPath) void useAppStore.getState().openHistoryForLineRange(repoId, selectedPath, lineRange, selectedRevision);
    }
    setContextMenu(undefined);
  };

  const handleExpandFold = useCallback((foldId: string, action: 'all' | 'top' | 'bottom') => {
    setExpandedFolds((prev) => {
      const current = prev[foldId] || { top: 0, bottom: 0 };
      if (action === 'all') {
        return { ...prev, [foldId]: { ...current, all: true } };
      }
      if (action === 'top') {
        return { ...prev, [foldId]: { ...current, top: current.top + 10 } };
      }
      if (action === 'bottom') {
        return { ...prev, [foldId]: { ...current, bottom: current.bottom + 10 } };
      }
      return prev;
    });
  }, []);

  const changeRanges = useMemo(() => {
    const ranges: { startIndex: number; endIndex: number }[] = [];
    let inChange = false;
    let start = -1;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const isChanged = (row?.kind === 'split' && (row.oldCell.kind === 'deletion' || row.newCell.kind === 'addition'))
        || (row?.kind === 'inline' && (row.cell.kind === 'deletion' || row.cell.kind === 'addition'));
      if (isChanged) {
        if (!inChange) {
          inChange = true;
          start = i;
        }
      } else if (inChange) {
        ranges.push({ startIndex: start, endIndex: i - 1 });
        inChange = false;
      }
    }
    if (inChange) {
      ranges.push({ startIndex: start, endIndex: rows.length - 1 });
    }
    return ranges;
  }, [rows]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === 'fold' ? 28 : rows[index]?.kind === 'meta' ? 27 : 20,
    overscan: 24,
    observeElementRect: (instance, cb) => {
      const element = instance.scrollElement;
      if (!element) return;
      cb({
        width: element.offsetWidth || 1000,
        height: element.offsetHeight || 800,
      });
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        cb({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
  });

  const openSearch = useCallback(() => {
    searchTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousCollapsed.current = collapsed;
    setSearchOpen(true);
    queueMicrotask(() => { searchInput.current?.focus(); searchInput.current?.select(); });
  }, [collapsed]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false); setSearchQuery(''); setSearchIndex(0);
    setCollapsed(previousCollapsed.current);
    searchTrigger.current?.focus();
  }, []);
  const navigateSearch = useCallback((direction: -1 | 1) => {
    if (!searchMatches.length) return;
    setSearchIndex((index) => (index + direction + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);
  useEffect(() => {
    if (!searchQuery || !searchMatches.length) return;
    const match = searchMatches[selectedSearchIndex];
    virtualizer.scrollToIndex(match.rowIndex, { align: 'center' });
    const pane = scrollRef.current?.querySelector<HTMLElement>(`.unified-diff-pane.${match.side}`);
    const horizontal = pane ?? scrollRef.current;
    if (horizontal) {
      const left = Math.max(0, match.start * 8 - horizontal.clientWidth / 2);
      horizontal.scrollLeft = left;
      horizontalOffset.current = horizontal.scrollLeft;
      if (pane) scrollRef.current?.querySelectorAll<HTMLElement>('.unified-diff-pane').forEach((peer) => { peer.scrollLeft = left; });
    }
  }, [searchMatches, selectedSearchIndex, searchQuery, virtualizer]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container || event.defaultPrevented || event.isComposing || document.querySelector('[role="menu"]')) return;
      if (!container.contains(document.activeElement) && !container.matches(':hover')) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); }
      else if (searchOpen && event.key === 'Escape') { event.preventDefault(); closeSearch(); }
      else if (searchOpen && (event.target === searchInput.current && event.key === 'Enter' || event.key === 'F3')) { event.preventDefault(); navigateSearch(event.shiftKey ? -1 : 1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [closeSearch, navigateSearch, openSearch, searchOpen]);
  useEffect(() => {
    if (!reveal) return;
    const index = rows.findIndex((row) => row.kind === 'split' ? row[reveal.side === 'old' ? 'oldCell' : 'newCell'].lineNumber === reveal.line : row.kind === 'inline' && (reveal.side === 'old' ? row.oldNumber : row.newNumber) === reveal.line);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
  }, [reveal, rows, virtualizer]);
  const goToChange = useCallback((index: number) => {
    if (!changeRanges.length) return;
    const target = ((index % changeRanges.length) + changeRanges.length) % changeRanges.length;
    setActiveChangeIndex(target);
    const range = changeRanges[target];
    if (range) {
      virtualizer.scrollToIndex(range.startIndex, { align: 'center', behavior: 'smooth' });
    }
  }, [changeRanges, virtualizer]);

  const goToPrev = useCallback(() => {
    goToChange(activeChangeIndex <= 0 ? changeRanges.length - 1 : activeChangeIndex - 1);
  }, [activeChangeIndex, changeRanges.length, goToChange]);

  const goToNext = useCallback(() => {
    goToChange(activeChangeIndex >= changeRanges.length - 1 ? 0 : activeChangeIndex + 1);
  }, [activeChangeIndex, changeRanges.length, goToChange]);

  useEffect(() => {
    setActiveChangeIndex(-1);
    horizontalOffset.current = 0;
    scrollRef.current?.querySelectorAll<HTMLElement>('.unified-diff-pane').forEach((pane) => { pane.scrollLeft = 0; });
    historyRequest.current += 1; setExpandedFolds({}); setSearchQuery(''); setSearchIndex(0); setHistoryError('');
  }, [content, path, repoId, oldRevision, newRevision]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setAutoView(entry.contentRect.width < splitBreakpoint ? 'inline' : 'split'));
    observer.observe(element);
    return () => observer.disconnect();
  }, [splitBreakpoint]);

  useEffect(() => {
    const controller = new AbortController();
    const pairs = parsed.rows.filter((row): row is Extract<ParsedDiffRow, { kind: 'pair' }> => row.kind === 'pair');
    if (content.length > 1_000_000 || pairs.length > 10_000) return;
    let frame: number | undefined;
    const additions = new Map<DiffCell, ThemedToken[]>();
    const publish = () => {
      frame = undefined;
      if (controller.signal.aborted) return;
      const tokens = new WeakMap<DiffCell, ThemedToken[]>();
      pairs.forEach((row) => {
        for (const cell of [row.oldCell, row.newCell]) {
          const value = additions.get(cell) ?? cachedTokens.get(cell);
          if (value) tokens.set(cell, value);
        }
      });
      setHighlighted({ parsed, theme, language, tokens });
    };
    let logged = false;
    const onError = (error: unknown) => {
      if (logged) return;
      logged = true;
      // The log records metadata only, never file contents or tokens.
      const details = JSON.stringify({ path, language, reason: error instanceof Error ? error.message : 'UnknownError' });
      if (bridge) void bridge.pushClientLog('warn', 'ui', 'Syntax highlighting failed', details).catch(() => undefined);
      else console.warn('Syntax highlighting failed', details);
    };
    for (const side of ['old', 'new'] as const) {
      void highlightParsedDiffSide(parsed, side, language, path, theme, {
        signal: controller.signal,
        onError,
        onGroup: (cells, tokens) => {
          cells.forEach((cell, index) => additions.set(cell, tokens[index] ?? []));
          if (frame === undefined) frame = requestAnimationFrame(publish);
        },
      });
    }
    return () => {
      controller.abort();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [content.length, language, parsed, path, theme, bridge, cachedTokens]);
  useEffect(() => {
    virtualizer.measure();
    if (view === 'split') {
      const left = horizontalOffset.current;
      scrollRef.current?.querySelectorAll<HTMLElement>('.unified-diff-pane').forEach((pane) => { pane.scrollLeft = left; });
    }
  }, [view, virtualizer]);
  useEffect(() => () => { historyRequest.current += 1; }, []);

  return <section ref={containerRef} tabIndex={-1} className={`unified-diff ${view} ${className}`} aria-label={t('File differences')} onContextMenu={handleContextMenu} onMouseDownCapture={(event) => {
    if (event.button !== 2) return;
    const selection = window.getSelection();
    // WebKit may select the clicked word before contextmenu. Keep only the
    // user's existing selection so an unselected line still copies in full.
    contextSelection.current = selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode) ? selection.toString() : '';
  }}>
    <div className="diff-toolbar">
      <div className="diff-toolbar-left">
        <button
          type="button"
          className="diff-toolbar-btn"
          title={view === 'split' ? t('Inline view') : t('Split view')}
          onClick={() => setManualView(view === 'split' ? 'inline' : 'split')}
        >
          <Codicon name={view === 'split' ? 'list-flat' : 'split-horizontal'} />
          <span>{view === 'split' ? t('Inline view') : t('Split view')}</span>
        </button>
        <button
          type="button"
          className={`diff-toolbar-btn ${!collapsed ? 'active' : ''}`}
          title={collapsed ? t('Expand differences') : t('Collapse differences')}
          onClick={() => {
            setCollapsed((prev) => !prev);
            setExpandedFolds({});
          }}
        >
          <Codicon name={collapsed ? 'unfold' : 'fold'} />
          <span>{collapsed ? t('Expand differences') : t('Collapse differences')}</span>
        </button>
      </div>
      <div className="diff-toolbar-right">
        <IconButton title={t('Find in file')} aria-label={t('Find in file')} onClick={openSearch}><Codicon name="search" /></IconButton>
        {changeRanges.length > 0 ? (
          <span className="diff-change-count">
            {activeChangeIndex >= 0 ? `${activeChangeIndex + 1} / ${changeRanges.length}` : `${changeRanges.length} ${t('changes')}`}
          </span>
        ) : (
          <span className="diff-change-count">{t(parsed.rows.some((row) => row.kind === 'meta') ? 'Metadata changes' : 'No changes')}</span>
        )}
        <button
          type="button"
          className="diff-toolbar-btn"
          disabled={changeRanges.length === 0}
          title={t('Previous change')}
          aria-label={t('Previous change')}
          onClick={goToPrev}
        >
          <Codicon name="arrow-up" />
          <span>{t('Previous change')}</span>
        </button>
        <button
          type="button"
          className="diff-toolbar-btn"
          disabled={changeRanges.length === 0}
          title={t('Next change')}
          aria-label={t('Next change')}
          onClick={goToNext}
        >
          <Codicon name="arrow-down" />
          <span>{t('Next change')}</span>
        </button>
      </div>
    </div>
    <FileSearchWidget placeholder={t('Find in file')} query={searchQuery} isOpen={searchOpen} inputRef={searchInput} onChange={(query) => { setSearchQuery(query); setSearchIndex(0); }} onClose={closeSearch} count={{ current: searchMatches.length ? selectedSearchIndex + 1 : 0, total: searchMatches.length }} onNavigate={navigateSearch} />
    {historyError && <div className="diff-history-error" role="alert">{historyError}</div>}
    <div ref={scrollRef} className="unified-diff-scroll">
      <div className="unified-diff-virtual" style={{ height: virtualizer.getTotalSize() }}>
        {view === 'split' ? (
          <div className="unified-diff-split-container">
            <div className="unified-diff-pane old" onScroll={syncHorizontalScroll}>
              <div aria-hidden="true" style={{ width: splitContentWidth, minWidth: '100%', height: 1, pointerEvents: 'none', fontSize: 'calc(12px * var(--versiondock-ui-font-scale, 1))' }} />
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (row.kind === 'meta') return null;
                if (row.kind === 'fold') {
                  return <div
                    key={`old-${virtualRow.key}`}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="unified-diff-virtual-row"
                    style={{ transform: `translateY(${virtualRow.start}px)`, height: 28 }}
                  />;
                }
                if (row.kind !== 'split') return null;
                const peerRow = rows[virtualRow.index];
                return <div
                  key={`old-${virtualRow.key}`}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="unified-diff-virtual-row"
                  style={{ transform: `translateY(${virtualRow.start}px)`, width: splitContentWidth, fontSize: 'calc(12px * var(--versiondock-ui-font-scale, 1))' }}
                >
                  <DiffCodeCell
                    side="old"
                    cell={row.oldCell}
                    peer={peerRow.kind === 'split' && peerRow.newCell.kind === 'addition' ? peerRow.newCell : undefined}
                    tokens={renderedTokens.get(row.oldCell)} search={searchHighlights.get(row.oldCell)}
                  />
                </div>;
              })}
            </div>
            <div className="unified-diff-pane new" onScroll={syncHorizontalScroll}>
              <div aria-hidden="true" style={{ width: splitContentWidth, minWidth: '100%', height: 1, pointerEvents: 'none', fontSize: 'calc(12px * var(--versiondock-ui-font-scale, 1))' }} />
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (row.kind === 'meta') return null;
                if (row.kind === 'fold') {
                  return <div
                    key={`new-${virtualRow.key}`}
                    data-index={virtualRow.index}
                    className="unified-diff-virtual-row"
                    style={{ transform: `translateY(${virtualRow.start}px)`, height: 28 }}
                  />;
                }
                if (row.kind !== 'split') return null;
                const peerRow = rows[virtualRow.index];
                return <div
                  key={`new-${virtualRow.key}`}
                  data-index={virtualRow.index}
                  className="unified-diff-virtual-row"
                  style={{ transform: `translateY(${virtualRow.start}px)`, width: splitContentWidth, fontSize: 'calc(12px * var(--versiondock-ui-font-scale, 1))' }}
                >
                  <DiffCodeCell
                    side="new"
                    cell={row.newCell}
                    peer={peerRow.kind === 'split' && peerRow.oldCell.kind === 'deletion' ? peerRow.oldCell : undefined}
                    tokens={renderedTokens.get(row.newCell)} search={searchHighlights.get(row.newCell)}
                  />
                </div>;
              })}
            </div>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (row.kind === 'meta') return <div key={`meta-${virtualRow.key}`} ref={virtualizer.measureElement} data-index={virtualRow.index} className="unified-diff-virtual-row split-center-meta-overlay" style={{ transform: `translateY(${virtualRow.start}px)` }}>{renderRow(row, renderedTokens, handleExpandFold, searchHighlights)}</div>;
              if (row.kind !== 'fold') return null;
              return <div
                key={`center-fold-${virtualRow.key}`}
                className="unified-diff-virtual-row split-center-fold-overlay"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <DiffFoldRow foldId={row.foldId} hiddenCount={row.hiddenCount} onExpand={handleExpandFold} />
              </div>;
            })}
          </div>
        ) : (
          virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="unified-diff-virtual-row"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >{renderRow(row, renderedTokens, handleExpandFold, searchHighlights)}</div>;
          })
        )}
      </div>
    </div>
    {contextMenu && (
      <ContextMenu
        preserveSelection
        x={contextMenu.x}
        y={contextMenu.y}
        items={[
          { id: 'copy', label: t('Copy'), icon: 'copy', disabled: !contextMenu.selectionText },
          ...(contextMenu.lineRange && (onShowSelectionHistory || (repoId && (path || oldPath || (parsed.oldLabel && parsed.oldLabel !== '/dev/null'))))
            ? [{
                id: 'selection-history',
                label: t('Show Selection History'),
                icon: 'history',
                disabled: contextMenu.isWorkingTreeAddition,
                disabledReason: contextMenu.isWorkingTreeAddition ? t('Uncommitted additions have no history') : undefined,
              } as const]
            : []),
        ]}
        onSelect={(id) => { void handleSelectContextMenu(id); }}
        onClose={() => setContextMenu(undefined)}
      />
    )}
  </section>;
}
