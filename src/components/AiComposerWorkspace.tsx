import { DialogSurface } from './DialogSurface';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerApplyResult, ComposerChangeUnit, ComposerCommitGroup, ComposerPreparedSource } from '../ai/viewTypes';
import type { ComposerToHostMsg, HostToComposerMsg } from '../ai/viewTypes';
import { listenAiView, sendAiView } from '../ai/aiStore';
import { IconButton } from './IconButton';
import { WorkspaceHeader } from './WorkspaceHeader';
import { Codicon } from './Codicon';
import { AiGenerationBorder } from './AiGenerationBorder';
import { AiCommitComposerIcon } from './AiCommitComposerIcon';
import { t } from '../ai/i18n';
import { useShiki } from '../utils/useShiki';
import { useEffectiveTheme } from '../theme/useEffectiveTheme';
import { resolveShikiTheme } from '../theme';

type Phase = 'scanning' | 'analyzing' | 'validating' | 'review' | 'applying' | 'completed' | 'error';
type DropPlacement = 'before' | 'after';
type DragSelection = { unitIds: string[]; sourceGroupId: string };

const css = `
  :root[data-theme='light'] .ai-composer-page, :root[data-theme='light2026'] .ai-composer-page {
    --composer-code-background: color-mix(in srgb, var(--vscode-editor-foreground) 7%, var(--vscode-editor-background));
    --composer-code-border: color-mix(in srgb, var(--vscode-editor-foreground) 18%, var(--vscode-editor-background));
    --composer-diff-add-background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 14%, var(--composer-code-background));
    --composer-diff-remove-background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 13%, var(--composer-code-background));
    --composer-hunk-header-background: color-mix(in srgb, var(--vscode-editor-foreground) 3%, var(--composer-code-background));
    --composer-hunk-location-background: color-mix(in srgb, var(--vscode-textLink-foreground, #0969da) 11%, var(--vscode-editor-background));
    --composer-hunk-location-border: color-mix(in srgb, var(--vscode-textLink-foreground, #0969da) 34%, var(--vscode-editor-background));
    --composer-hunk-badge-foreground: var(--versiondock-badge-foreground);
    --composer-hunk-badge-background: var(--versiondock-badge-background);
    --composer-hunk-badge-border: color-mix(in srgb, var(--versiondock-badge-foreground) 26%, transparent);
    --composer-atomic-foreground: color-mix(in srgb, var(--vscode-editorWarning-foreground, #9a6700) 72%, #211400);
    --composer-atomic-background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #9a6700) 24%, var(--vscode-editor-background));
    --composer-atomic-border: color-mix(in srgb, var(--vscode-editorWarning-foreground, #9a6700) 78%, var(--vscode-editor-background));
  }
  :root:not([data-theme='light']):not([data-theme='light2026']) .ai-composer-page {
    --composer-code-background: color-mix(in srgb, var(--vscode-editor-foreground) 9%, var(--vscode-editor-background));
    --composer-code-border: color-mix(in srgb, var(--vscode-editor-foreground) 20%, var(--vscode-editor-background));
    --composer-diff-add-background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 17%, var(--composer-code-background));
    --composer-diff-remove-background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 16%, var(--composer-code-background));
    --composer-hunk-header-background: color-mix(in srgb, var(--vscode-editor-foreground) 5%, var(--composer-code-background));
    --composer-hunk-location-background: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 16%, var(--vscode-editor-background));
    --composer-hunk-location-border: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 42%, var(--vscode-editor-background));
  }
  .ai-composer-page button, .ai-composer-page textarea { font: inherit; }
  .ai-composer-page button:focus-visible, .ai-composer-page textarea:focus-visible { outline: 1px solid var(--versiondock-selection-border); outline-offset: 2px; }
  @keyframes composer-scan { from { transform: translateX(-110%); } to { transform: translateX(410%); } }
  @keyframes composer-pulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
  @keyframes composer-ai-slash-edge { 0% { transform: translate3d(0, 0, 0) skewX(-22deg); opacity: 0; } 22% { opacity: .35; } 48% { opacity: 1; } 100% { transform: translate3d(1550%, 0, 0) skewX(-22deg); opacity: 0; } }
  .composer-status[data-active='true']::after { content: ''; position: absolute; left: 0; bottom: 0; width: 26%; height: 1px; background: linear-gradient(90deg, transparent, #7c5cff, #2f9bff, transparent); animation: composer-scan 1.7s ease-in-out infinite; }
  .composer-group { transition: transform .16s ease, background .16s ease; }
  .composer-group[data-drag='true'] { background: color-mix(in srgb, #7457ff 9%, var(--vscode-editor-background)); }
  .composer-ai { position: relative; isolation: isolate; overflow: hidden; background: linear-gradient(125deg, #7657ff, #2f8fff); color: #fff; border: none; box-shadow: none; transition: filter 140ms ease, transform 140ms ease; }
  .composer-ai > * { position: relative; z-index: 2; }
  .composer-ai::after { content: ''; position: absolute; pointer-events: none; opacity: 0; z-index: 1; top: -55%; left: -28%; width: 10%; height: 210%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.96), transparent); box-shadow: 0 0 5px rgba(222,239,255,.7); }
  .composer-ai:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
  .composer-ai:hover:not(:disabled)::after { animation: composer-ai-slash-edge 880ms cubic-bezier(.22,.7,.22,1) both; }
  .composer-ai:active:not(:disabled) { filter: brightness(.98); transform: translateY(0); }
  .composer-ai:disabled { cursor: default !important; opacity: .5; }
  .composer-icon-action { transition: background-color 120ms ease, transform 120ms ease, opacity 120ms ease; }
  .composer-icon-action:hover:not(:disabled) { --composer-icon-button-background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); transform: translateY(-1px); }
  .composer-icon-action:active:not(:disabled) { --composer-icon-button-background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); transform: translateY(0); }
  .composer-icon-action:disabled { cursor: default !important; opacity: .42; }
  .composer-message-ai { transition: background-color 120ms ease, opacity 120ms ease; }
  .composer-message-ai:hover:not(:disabled) { --composer-message-ai-background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); opacity: 1 !important; }
  .composer-message-ai:active:not(:disabled) { --composer-message-ai-background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); }
  .composer-message-ai:disabled { cursor: not-allowed !important; }
  .composer-add-group { transition: background-color 120ms ease, color 120ms ease, transform 120ms ease, opacity 120ms ease; }
  .composer-add-group:hover:not(:disabled) { --composer-add-group-background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); transform: translateY(-1px); }
  .composer-add-group:active:not(:disabled) { --composer-add-group-background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); transform: translateY(0); }
  .composer-add-group:disabled { cursor: default !important; opacity: .42; }
  .composer-unit:hover { background: var(--vscode-list-hoverBackground); }
  .composer-hunk:hover > div:first-child { background: var(--vscode-list-hoverBackground); }
  .composer-diff-line[data-kind='add'] { color: var(--vscode-gitDecoration-addedResourceForeground); background: var(--composer-diff-add-background, color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 7%, transparent)); }
  .composer-diff-line[data-kind='remove'] { color: var(--vscode-gitDecoration-deletedResourceForeground); background: var(--composer-diff-remove-background, color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 7%, transparent)); }
  @media (prefers-reduced-motion: reduce) {
    .composer-ai,.composer-icon-action,.composer-message-ai,.composer-add-group { transition:none !important; }
    .composer-ai:hover:not(:disabled),.composer-icon-action:hover:not(:disabled),.composer-add-group:hover:not(:disabled) { transform:none; }
    .composer-ai::after { animation:none !important; }
  }
`;

function send(message: ComposerToHostMsg): void { sendAiView(message); }
function delay(ms: number): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, ms)); }

type DiffLineKind = 'add' | 'remove' | 'context';

interface DiffDisplayLine {
  raw: string;
  code: string;
  prefix: string;
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
}

function buildDiffDisplayLines(diff: string): DiffDisplayLine[] {
  const rows: DiffDisplayLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;
  for (const raw of diff.split('\n')) {
    const hunk = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      insideHunk = true;
      continue;
    }
    if (!raw
      || /^diff --git /.test(raw)
      || /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|index )/.test(raw)
      || /^--- /.test(raw)
      || /^\+\+\+ /.test(raw)
      || raw === '\\ No newline at end of file') continue;

    const kind: DiffLineKind = raw.startsWith('+') ? 'add' : raw.startsWith('-') ? 'remove' : 'context';
    const prefix = raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ') ? raw[0] : '';
    let oldNumber: number | undefined;
    let newNumber: number | undefined;
    if (insideHunk) {
      if (kind !== 'add') oldNumber = oldLine++;
      if (kind !== 'remove') newNumber = newLine++;
    }
    rows.push({
      raw,
      code: prefix ? raw.slice(1) : raw,
      prefix,
      kind,
      oldLine: oldNumber,
      newLine: newNumber,
    });
  }
  return rows;
}

function DiffBlock({ unit }: { unit: ComposerChangeUnit }) {
  const highlighter = useShiki(unit.language);
  const effectiveTheme = useEffectiveTheme();
  const binary = unit.status === 'binary' || unit.diff.includes('GIT binary patch');
  const rows = useMemo(() => binary ? [] : buildDiffDisplayLines(unit.diff), [binary, unit.diff]);
  const rendered = useMemo(() => {
    if (!highlighter) return rows.map(row => row.code || ' ');
    const supported = new Set(['javascript', 'typescript', 'json', 'css', 'html', 'markdown', 'java', 'xml', 'yaml', 'php', 'python', 'go', 'shell']);
    if (!supported.has(unit.language)) return rows.map(row => row.code || ' ');
    const language = unit.language;
    const theme = resolveShikiTheme(effectiveTheme);
    try {
      const result = highlighter.codeToTokens(rows.map(row => row.code).join('\n'), { lang: language, theme }) as unknown;
      const tokenLines = Array.isArray(result) ? result : (result as {
        tokens?: Array<Array<{ content: string; color?: string; fontStyle?: number }>>;
      }).tokens;
      return rows.map((row, index) => {
        const tokens = tokenLines?.[index] as Array<{ content: string; color?: string }> | undefined;
        if (!tokens?.length) return row.code || ' ';
        return tokens.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>);
      });
    } catch {
      return rows.map(row => row.code || ' ');
    }
  }, [highlighter, rows, unit.language, effectiveTheme]);
  if (binary) return <div style={styles.emptyDiff}>{t('Binary file — no diff available')}</div>;
  if (rows.length === 0) {
    return <div style={styles.emptyDiff}>{unit.oldPath ? `${unit.oldPath} → ${unit.filePath}` : t('No code changes to preview.')}</div>;
  }
  return (
    <pre style={styles.diff} aria-label={t('Diff for {0}', unit.filePath)}>
      {rows.map((row, index) => (
        <div className="composer-diff-line" data-kind={row.kind} key={`${index}-${row.raw}`} style={styles.diffLine}>
          <span style={styles.diffLineNumber} aria-hidden="true">{row.oldLine ?? ''}</span>
          <span style={{ ...styles.diffLineNumber, ...styles.diffNewLineNumber }} aria-hidden="true">{row.newLine ?? ''}</span>
          <span style={styles.diffPrefix}>{row.prefix || ' '}</span>
          <span style={styles.diffCode}>{rendered[index]}</span>
        </div>
      ))}
    </pre>
  );
}

function HunkHeader({ unit }: { unit: ComposerChangeUnit }) {
  const match = unit.title.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(?:\s*(.*))?$/);
  const context = match?.[2]?.trim();
  return (
    <div style={styles.hunkHeader} title={unit.title}>
      <Codicon name="grabber" style={styles.hunkGrabber} />
      {match
        ? <span style={styles.hunkLocation}><Codicon name="location" style={styles.hunkLocationIcon} />{t('Changed code near line {0}', match[1])}</span>
        : <span style={styles.hunkTitle}>{unit.title}</span>}
      {context && <code style={styles.hunkContext}>{context}</code>}
      <span style={styles.changeStats}><b style={styles.changeAdded}>+{unit.added}</b><i style={styles.changeRemoved}>-{unit.removed}</i></span>
    </div>
  );
}

function groupUnitsByFile(unitIds: string[], unitMap: ReadonlyMap<string, ComposerChangeUnit>): Array<{ filePath: string; units: ComposerChangeUnit[] }> {
  const files = new Map<string, ComposerChangeUnit[]>();
  for (const unitId of unitIds) {
    const unit = unitMap.get(unitId);
    if (!unit) continue;
    const units = files.get(unit.filePath);
    if (units) units.push(unit);
    else files.set(unit.filePath, [unit]);
  }
  return Array.from(files, ([filePath, units]) => ({ filePath, units }));
}

export function AiComposerWorkspace() {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [phaseDetail, setPhaseDetail] = useState(t('Preparing AI Commit Composer…'));
  const [source, setSource] = useState<ComposerPreparedSource>();
  const [typing, setTyping] = useState(false);
  const [groups, setGroups] = useState<ComposerCommitGroup[]>([]);
  const [provider, setProvider] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragSelection, setDragSelection] = useState<DragSelection>();
  const [dragTarget, setDragTarget] = useState<string>();
  const [fileDropTarget, setFileDropTarget] = useState<{ key: string; placement: DropPlacement }>();
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, message: '' });
  const [result, setResult] = useState<ComposerApplyResult>();
  const [messageGeneration, setMessageGeneration] = useState<{ requestId: string; groupId: string }>();
  const [messageErrors, setMessageErrors] = useState<Record<string, string>>({});
  const typingRun = useRef(0);
  const messageGenerationRef = useRef<{ requestId: string; groupId: string }>();
  const messageRequestSequence = useRef(0);

  async function typePlan(nextGroups: ComposerCommitGroup[]) {
    const run = ++typingRun.current;
    setTyping(true); setPhase('review'); setPhaseDetail(t('Review and refine the proposed commits'));
    const max = Math.max(0, ...nextGroups.map(g => g.message.length));
    const step = Math.max(1, Math.ceil(max / 180));
    for (let length = step; length <= max + step; length += step) {
      if (typingRun.current !== run) return;
      setGroups(nextGroups.map(g => ({ ...g, message: g.message.slice(0, length) })));
      await delay(8);
    }
    setTyping(false);
  }

  useEffect(() => {
    const typingController = typingRun;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const listener = (data: HostToComposerMsg | import('../ai/viewTypes').HostToCodeReviewMsg) => {
      const message = data as HostToComposerMsg;
      if (message.type === 'COMPOSER_PHASE') {
        setPhase(message.phase);
        setPhaseDetail(message.detail ?? '');
        setError('');
      } else if (message.type === 'COMPOSER_SOURCE') {
        setSource(message.source);
        setGroups([]);
        setResult(undefined);
      } else if (message.type === 'COMPOSER_PLAN') {
        messageGenerationRef.current = undefined;
        setMessageGeneration(undefined);
        setMessageErrors({});
        setProvider([message.provider, message.model].filter(Boolean).join(' · '));
        void typePlan(message.groups);
      } else if (message.type === 'COMPOSER_MESSAGE_UPDATE') {
        const active = messageGenerationRef.current;
        if (!active || active.requestId !== message.requestId || active.groupId !== message.groupId) return;
        setGroups(current => current.map(group => group.id === message.groupId ? { ...group, message: message.message } : group));
      } else if (message.type === 'COMPOSER_MESSAGE_RESULT') {
        const active = messageGenerationRef.current;
        if (!active || active.requestId !== message.requestId || active.groupId !== message.groupId) return;
        if (message.message !== undefined) {
          setGroups(current => current.map(group => group.id === message.groupId ? { ...group, message: message.message! } : group));
        }
        setMessageErrors(current => ({ ...current, [message.groupId]: message.error ?? '' }));
        messageGenerationRef.current = undefined;
        setMessageGeneration(undefined);
      } else if (message.type === 'COMPOSER_ERROR') {
        typingRun.current++;
        setError(message.error);
        setTyping(false);
        setPhase('error');
      } else if (message.type === 'COMPOSER_APPLY_PROGRESS') {
        setProgress({ completed: message.completed, total: message.total, message: message.message });
      } else if (message.type === 'COMPOSER_APPLY_RESULT') {
        setResult(message.result);
        setPhase('completed');
        setConfirming(false);
      }
    };
    const unsubscribe = listenAiView(listener);
    send({ type: 'COMPOSER_READY' });
    return () => { typingController.current++; send({ type: 'COMPOSER_CANCEL' }); unsubscribe(); style.remove(); };
  }, []);

  const unitMap = useMemo(() => new Map(source?.units.map(unit => [unit.id, unit]) ?? []), [source]);
  const assigned = useMemo(() => groups.flatMap(group => group.unitIds), [groups]);
  const valid = !typing && !messageGeneration && !!source && groups.length > 0
    && groups.every(group => group.message.trim() && group.unitIds.length)
    && assigned.length === source.units.length
    && new Set(assigned).size === source.units.length
    && assigned.every(id => unitMap.has(id));
  const busy = phase === 'scanning' || phase === 'analyzing' || phase === 'validating' || phase === 'applying';

  function updateGroup(id: string, update: (group: ComposerCommitGroup) => ComposerCommitGroup) {
    setGroups(current => current.map(group => group.id === id ? update(group) : group));
  }

  function clearDragState() {
    setDragSelection(undefined);
    setDragTarget(undefined);
    setFileDropTarget(undefined);
  }

  function moveUnits(selection: DragSelection, targetGroupId: string, anchorUnitIds: string[] = [], placement: DropPlacement = 'after') {
    if (typing || phase === 'applying' || messageGeneration) return;
    if (selection.sourceGroupId === targetGroupId) {
      clearDragState();
      return;
    }
    const { unitIds } = selection;
    const moving = new Set(unitIds);
    setGroups(current => current.map(group => {
      const remaining = group.unitIds.filter(id => !moving.has(id));
      if (group.id !== targetGroupId) return { ...group, unitIds: remaining };
      const anchorIndexes = anchorUnitIds
        .map(unitId => remaining.indexOf(unitId))
        .filter(index => index >= 0);
      const insertionIndex = anchorIndexes.length === 0
        ? remaining.length
        : placement === 'before'
          ? Math.min(...anchorIndexes)
          : Math.max(...anchorIndexes) + 1;
      const nextUnitIds = [...remaining];
      nextUnitIds.splice(insertionIndex, 0, ...unitIds);
      return { ...group, unitIds: nextUnitIds };
    }));
    clearDragState();
  }

  function reorder(groupIndex: number, direction: -1 | 1) {
    if (typing || messageGenerationRef.current || phase === 'applying') return;
    const target = groupIndex + direction;
    if (target < 0 || target >= groups.length) return;
    setGroups(current => {
      const next = [...current];
      [next[groupIndex], next[target]] = [next[target], next[groupIndex]];
      return next;
    });
  }

  function mergePrevious(groupIndex: number) {
    if (typing || messageGenerationRef.current || phase === 'applying') return;
    if (groupIndex <= 0) return;
    setGroups(current => {
      const previous = current[groupIndex - 1];
      const group = current[groupIndex];
      return current.filter((_, index) => index !== groupIndex).map((item, index) => index === groupIndex - 1
        ? { ...previous, unitIds: [...previous.unitIds, ...group.unitIds] }
        : item);
    });
  }

  function addGroup() {
    setGroups(current => [...current, { id: `manual-${crypto.randomUUID()}`, message: '', rationale: t('Manually added commit group'), unitIds: [] }]);
  }

  function deleteGroup(groupId: string) {
    if (typing || messageGenerationRef.current || phase === 'applying') return;
    setGroups(current => {
      if (current.length <= 1) return current;
      const groupIndex = current.findIndex(group => group.id === groupId);
      if (groupIndex < 0) return current;
      const removed = current[groupIndex];
      const recipient = current[groupIndex > 0 ? groupIndex - 1 : groupIndex + 1];
      return current
        .filter(group => group.id !== groupId)
        .map(group => group.id === recipient.id
          ? {
            ...group,
            unitIds: Array.from(new Set(groupIndex > 0
              ? [...group.unitIds, ...removed.unitIds]
              : [...removed.unitIds, ...group.unitIds])),
          }
          : group);
    });
    setExpanded(current => new Set(Array.from(current).filter(key => !key.startsWith(`${groupId}:`))));
    setMessageErrors(current => {
      const next = { ...current };
      delete next[groupId];
      return next;
    });
  }

  function retry() {
    setTyping(false);
    stopMessageGeneration();
    typingRun.current++;
    setError('');
    setGroups([]);
    setPhase('analyzing');
    send({ type: 'COMPOSER_REANALYZE' });
  }

  function stopMessageGeneration() {
    const active = messageGenerationRef.current;
    if (!active) return;
    send({ type: 'COMPOSER_CANCEL_MESSAGE', requestId: active.requestId });
    messageGenerationRef.current = undefined;
    setMessageGeneration(undefined);
  }

  function toggleMessageGeneration(group: ComposerCommitGroup) {
    const active = messageGenerationRef.current;
    if (active?.groupId === group.id) {
      stopMessageGeneration();
      return;
    }
    if (group.unitIds.length === 0 || phase === 'applying') return;
    if (active) send({ type: 'COMPOSER_CANCEL_MESSAGE', requestId: active.requestId });
    typingRun.current++;
    const request = { requestId: `composer-message-${crypto.randomUUID()}-${++messageRequestSequence.current}`, groupId: group.id };
    messageGenerationRef.current = request;
    setMessageGeneration(request);
    setMessageErrors(current => ({ ...current, [group.id]: '' }));
    updateGroup(group.id, value => ({ ...value, message: '' }));
    send({ type: 'COMPOSER_GENERATE_MESSAGE', ...request, unitIds: group.unitIds });
  }

  const header = (
    <WorkspaceHeader backLabel={t('Back')} backDisabled={phase === 'applying'} onBack={() => send({ type: 'COMPOSER_CLOSE' })} actions={
      source && <div className="workspace-page-metrics"><span>{source.units.length} {t('changes')}</span><span>{groups.length || '—'} {t('commits')}</span></div>
    }>
      <div className="workspace-page-heading">
        <AiCommitComposerIcon size={14} />
        <strong>{t('AI Commit Composer')}</strong>
        {source && <span className="workspace-page-meta" title={`${source.repoName} · ${source.branch} · ${t(source.sourceLabel)}`}>{source.repoName} · {source.branch} · {t(source.sourceLabel)}</span>}
      </div>
    </WorkspaceHeader>
  );

  if (phase === 'completed' && result) {
    return (
      <main className="ai-composer-page" style={styles.page}>
        {header}
        <div style={styles.completed}>
          <div style={styles.completedMark}><Codicon name="check" /></div>
          <h1 style={styles.completedTitle}>{t('Commit composition completed')}</h1>
          <p style={styles.completedCopy}>{source?.mode === 'history'
            ? t('{0} commits were reorganized successfully.', result.commitCount)
            : t('{0} commits were created successfully.', result.commitCount)}</p>
          {result.commitHashes.length > 0 && <div style={styles.hashList}>{result.commitHashes.map((commitHash, index) => <code key={commitHash}>{index + 1}. {commitHash.slice(0, 12)}</code>)}</div>}
          {source?.mode !== 'history' && result.recoveryCommand && <div style={styles.recovery}><span>{t('Recovery command')}</span><code>{result.recoveryCommand}</code></div>}
          <button className="composer-ai" style={styles.primaryButton} onClick={() => send({ type: 'COMPOSER_CLOSE' })}><span>{t('Done')}</span></button>
        </div>
      </main>
    );
  }

  return (
    <main className="ai-composer-page" style={styles.page}>
      {header}

      <div className="composer-status" data-active={busy} style={styles.status}>
        <Codicon name={phase === 'error' ? 'error' : busy ? 'loading codicon-modifier-spin' : 'sparkle'} style={{ color: phase === 'error' ? 'var(--vscode-errorForeground)' : '#6f73ff' }} />
        <span>{error || phaseDetail || (phase === 'review' ? t('Review and refine the proposed commits') : '')}</span>
        {provider && <span style={styles.provider}>{provider}</span>}
        {phase === 'applying' && progress.total > 0 && <span style={styles.progress}>{progress.completed}/{progress.total} · {progress.message}</span>}
      </div>

      <section style={styles.workspace}>
        {busy && phase !== 'applying' && <div style={styles.centerState}><div style={styles.orbit}><Codicon name="sparkle-filled" /></div><strong>{phaseDetail}</strong><span>{t('The repository will not be changed until you confirm the plan.')}</span></div>}
        {phase === 'error' && <div style={styles.centerState}><Codicon name="warning" style={{ fontSize: 30, color: 'var(--vscode-errorForeground)' }} /><strong>{t('Composer could not finish')}</strong><span>{error}</span><button style={styles.secondaryButton} onClick={retry}>{t('Analyze again')}</button></div>}
        {(phase === 'review' || phase === 'applying') && source && (
          <div style={styles.timeline}>
            <div style={styles.rail} />
            {groups.map((group, groupIndex) => (
              <article
                className="composer-group"
                data-drag={dragTarget === group.id}
                key={group.id}
                style={styles.group}
                onDragOver={event => { event.preventDefault(); setDragTarget(group.id); }}
                onDragLeave={() => { setDragTarget(undefined); setFileDropTarget(undefined); }}
                onDrop={event => { event.preventDefault(); if (dragSelection) moveUnits(dragSelection, group.id); }}
              >
                <div style={styles.node}>{groupIndex + 1}</div>
                <div style={styles.groupHeader}>
                  <div><div style={styles.eyebrow}>{t('Commit {0}', groupIndex + 1)}</div><div style={styles.rationale}>{group.rationale || t('Manual grouping')}</div></div>
                  <div style={styles.iconActions}>
                    <IconButton className="composer-icon-action" style={styles.iconButton} disabled={groupIndex === 0 || !!messageGeneration || typing || phase === 'applying'} title={t('Move up')} onClick={() => reorder(groupIndex, -1)}><Codicon name="arrow-up" /></IconButton>
                    <IconButton className="composer-icon-action" style={styles.iconButton} disabled={groupIndex === groups.length - 1 || !!messageGeneration || typing || phase === 'applying'} title={t('Move down')} onClick={() => reorder(groupIndex, 1)}><Codicon name="arrow-down" /></IconButton>
                    <IconButton className="composer-icon-action" style={styles.iconButton} disabled={groupIndex === 0 || !!messageGeneration || typing || phase === 'applying'} title={t('Merge with previous commit')} onClick={() => mergePrevious(groupIndex)}><Codicon name="combine" /></IconButton>
                    <IconButton className="composer-icon-action" style={{ ...styles.iconButton, color: 'var(--vscode-errorForeground)' }} disabled={groups.length <= 1 || !!messageGeneration || typing || phase === 'applying'} title={t('Delete commit group')} onClick={() => deleteGroup(group.id)}><Codicon name="trash" /></IconButton>
                  </div>
                </div>
                <div className="ai-input-surface" style={styles.messageWrap}>
                  <AiGenerationBorder active={messageGeneration?.groupId === group.id} radius={5} />
                  <textarea
                    className={`composer-message${messageGeneration?.groupId === group.id ? ' ai-input-generating' : ''}`}
                    data-generating={messageGeneration?.groupId === group.id}
                    style={styles.message}
                    value={group.message}
                    readOnly={typing || messageGeneration?.groupId === group.id}
                    disabled={typing || phase === 'applying'}
                    placeholder={messageGeneration?.groupId === group.id ? t('Generating commit message…') : undefined}
                    rows={Math.max(3, group.message.split('\n').length + 1)}
                    spellCheck={false}
                    aria-label={t('Commit message for group {0}', groupIndex + 1)}
                    onChange={event => updateGroup(group.id, value => ({ ...value, message: event.target.value }))}
                  />
                  <IconButton
                    className="composer-message-ai"
                    style={{ ...styles.messageAiButton, opacity: group.unitIds.length === 0 ? 0.35 : 1, cursor: group.unitIds.length === 0 ? 'not-allowed' : 'pointer' }}
                    disabled={group.unitIds.length === 0 || typing || phase === 'applying'}
                    title={messageGeneration?.groupId === group.id ? t('Stop generating commit message') : t('Generate commit message with AI')}
                    onClick={() => toggleMessageGeneration(group)}
                  >
                    <Codicon name={messageGeneration?.groupId === group.id ? 'stop-circle' : 'sparkle'} style={{ fontSize: 16 }} />
                  </IconButton>
                </div>
                {messageErrors[group.id] && <div style={styles.messageError}>{messageErrors[group.id]}</div>}
                <div style={styles.units}>
                  {groupUnitsByFile(group.unitIds, unitMap).map(file => {
                    const fileKey = `${group.id}:${file.filePath}`;
                    const isExpanded = expanded.has(fileKey);
                    const added = file.units.reduce((sum, unit) => sum + unit.added, 0);
                    const removed = file.units.reduce((sum, unit) => sum + unit.removed, 0);
                    const atomic = file.units.every(unit => unit.atomic);
                    return (
                      <div
                        className="composer-unit"
                        key={fileKey}
                        draggable={!typing && !messageGeneration && phase !== 'applying'}
                        onDragStart={() => setDragSelection({ unitIds: file.units.map(unit => unit.id), sourceGroupId: group.id })}
                        onDragEnd={clearDragState}
                        style={styles.unit}
                      >
                        <button
                          style={{
                            ...styles.unitMain,
                            ...(fileDropTarget?.key === fileKey
                              ? fileDropTarget.placement === 'before' ? styles.dropBefore : styles.dropAfter
                              : {}),
                          }}
                          onDragOver={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            const rect = event.currentTarget.getBoundingClientRect();
                            const placement: DropPlacement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                            setDragTarget(group.id);
                            setFileDropTarget({ key: fileKey, placement });
                          }}
                          onDragLeave={event => {
                            event.stopPropagation();
                            setFileDropTarget(undefined);
                          }}
                          onDrop={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!dragSelection) return;
                            const rect = event.currentTarget.getBoundingClientRect();
                            const placement: DropPlacement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                            moveUnits(dragSelection, group.id, file.units.map(unit => unit.id), placement);
                          }}
                          onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(fileKey)) next.delete(fileKey); else next.add(fileKey); return next; })}
                        >
                          <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
                          <Codicon name={atomic ? 'file-binary' : 'diff'} style={{ color: atomic ? 'var(--vscode-descriptionForeground)' : '#7182ff' }} />
                          <span style={styles.filePath}>{file.filePath}</span>
                          {atomic && <span style={styles.atomic}>{t('atomic')}</span>}
                          {file.units.length > 1 && <span style={styles.hunkCount}>{t('{0} hunks', file.units.length)}</span>}
                          <span style={styles.changeStats}><b style={styles.changeAdded}>+{added}</b><i style={styles.changeRemoved}>-{removed}</i></span>
                        </button>
                        {isExpanded && (file.units.length === 1
                          ? <DiffBlock unit={file.units[0]} />
                          : <div style={styles.hunks}>{file.units.map(unit => (
                            <div
                              className="composer-hunk"
                              key={unit.id}
                              draggable={!typing && !messageGeneration && phase !== 'applying'}
                              onDragStart={event => { event.stopPropagation(); setDragSelection({ unitIds: [unit.id], sourceGroupId: group.id }); }}
                              onDragEnd={event => { event.stopPropagation(); clearDragState(); }}
                              style={styles.hunk}
                            >
                              <HunkHeader unit={unit} />
                              <DiffBlock unit={unit} />
                            </div>
                          ))}</div>)}
                      </div>
                    );
                  })}
                  {group.unitIds.length === 0 && <div style={styles.dropHint}>{t('Drag changes here')}</div>}
                </div>
              </article>
            ))}
            <button className="composer-add-group" style={styles.addGroup} disabled={typing || !!messageGeneration || phase === 'applying'} onClick={addGroup}><Codicon name="add" /> {t('Add commit group')}</button>
          </div>
        )}
      </section>

      <footer style={styles.footer}>
        <div style={styles.footerHint}>{source && t('Every change must belong to exactly one commit.')}</div>
        <div style={styles.footerActions}>
          <button style={styles.secondaryButton} disabled={busy || typing} onClick={retry}><Codicon name="refresh" /> {t('Analyze again')}</button>
          <button
            style={styles.secondaryButton}
            disabled={typing || phase === 'applying'}
            onClick={() => {
              if (busy) {
                typingRun.current++;
                setError(t('Cancelled'));
                setTyping(false);
        setPhase('error');
                send({ type: 'COMPOSER_CANCEL' });
              } else {
                send({ type: 'COMPOSER_CLOSE' });
              }
            }}
          >
            {busy ? t('Stop') : t('Cancel')}
          </button>
          <button className="composer-ai" style={styles.primaryButton} disabled={!valid || phase !== 'review'} onClick={() => setConfirming(true)}><Codicon name="git-commit" /><span>{source?.mode === 'history' ? t('Reorganize into {0} commits', groups.length) : t('Create {0} commits', groups.length)}</span></button>
        </div>
      </footer>

      {confirming && <DialogSurface className="composer-confirm-dialog" onClose={() => setConfirming(false)} aria-labelledby="composer-confirm-title">
        <header><span className="composer-confirm-icon"><AiCommitComposerIcon size={19} /></span><strong id="composer-confirm-title">{t('Apply this commit plan?')}</strong><IconButton title={t('Close')} onClick={() => setConfirming(false)}><Codicon name="close" /></IconButton></header>
        <p>{source?.mode === 'history' ? t('VersionDock will create a recovery reference before updating the branch.') : source?.vcsKind === 'svn' ? t('SVN groups are committed sequentially and cannot be rolled back atomically.') : t('VersionDock will create a recovery reference before updating the branch.')}</p>
        <footer><button onClick={() => setConfirming(false)}>{t('Keep reviewing')}</button><button className="primary" onClick={() => { setConfirming(false); send({ type: 'COMPOSER_APPLY', groups }); }}>{t(source?.mode === 'history' ? 'Confirm and reorganize commits' : 'Confirm and create commits')}</button></footer>
      </DialogSurface>}

    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  status: { position: 'relative', flexShrink: 0, minHeight: 35, display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px', borderBottom: '1px solid var(--vscode-panel-border)', background: 'color-mix(in srgb,#6d63ff 5%,var(--vscode-editor-background))', overflow: 'hidden' },
  provider: { marginLeft: 'auto', color: 'var(--vscode-descriptionForeground)', fontSize: 11 }, progress: { color: 'var(--vscode-descriptionForeground)', fontSize: 11 },
  workspace: { flex: 1, overflow: 'auto', minHeight: 0 }, centerState: { height: '100%', minHeight: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, textAlign: 'center', color: 'var(--vscode-descriptionForeground)', padding: 30 },
  orbit: { width: 52, height: 52, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 22, color: '#7567ff', border: '1px solid color-mix(in srgb,#7567ff 35%,transparent)', animation: 'composer-pulse 1.5s ease-in-out infinite' },
  timeline: { position: 'relative', maxWidth: 1050, margin: '0 auto', padding: '28px 36px 80px 72px' }, rail: { position: 'absolute', left: 48, top: 28, bottom: 66, width: 1, background: 'linear-gradient(#7657ff,#347fff 72%,transparent)' },
  group: { position: 'relative', padding: '0 0 30px 0' }, node: { position: 'absolute', left: -43, top: 1, width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', background: 'linear-gradient(135deg,#7657ff,#2f8fff)', fontSize: 11, fontWeight: 700 },
  groupHeader: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 8 }, eyebrow: { textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 10, color: '#7a78ff', fontWeight: 700 }, rationale: { marginTop: 3, fontSize: 12, color: 'var(--vscode-descriptionForeground)' }, iconActions: { display: 'flex', gap: 2 },
  iconButton: { width: 27, height: 27, display: 'grid', placeItems: 'center', border: 'none', background: 'var(--composer-icon-button-background, transparent)', color: 'var(--vscode-icon-foreground)', cursor: 'pointer', borderRadius: 4 },
  messageWrap: { position: 'relative', isolation: 'isolate' },
  message: { width: '100%', minHeight: 76, resize: 'vertical', border: '1px solid var(--vscode-input-border,var(--vscode-panel-border))', borderRadius: 5, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', padding: '10px 40px 10px 12px', fontFamily: 'var(--vscode-editor-font-family)', lineHeight: 1.5 },
  messageAiButton: { position: 'absolute', top: 7, right: 7, zIndex: 2, display: 'grid', placeItems: 'center', width: 25, height: 25, padding: 0, border: 'none', borderRadius: 4, background: 'var(--composer-message-ai-background, transparent)', color: 'var(--vscode-foreground)', boxShadow: 'none' },
  messageError: { marginTop: 5, color: 'var(--vscode-errorForeground)', fontSize: 11, whiteSpace: 'pre-wrap' },
  units: { marginTop: 9, borderTop: '1px solid var(--vscode-panel-border)' }, unit: { borderBottom: '1px solid var(--vscode-panel-border)' }, unitMain: { width: '100%', minHeight: 35, display: 'flex', alignItems: 'center', gap: 7, padding: '5px 7px', border: 'none', background: 'transparent', color: 'var(--vscode-foreground)', cursor: 'pointer', textAlign: 'left' },
  dropBefore: { boxShadow: 'inset 0 2px var(--vscode-focusBorder)' },
  dropAfter: { boxShadow: 'inset 0 -2px var(--vscode-focusBorder)' },
  filePath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  hunkCount: { flexShrink: 0, padding: '2px 7px', borderRadius: 4, color: 'var(--composer-hunk-badge-foreground, var(--versiondock-badge-foreground))', background: 'var(--composer-hunk-badge-background, var(--versiondock-badge-background))', border: '1px solid var(--composer-hunk-badge-border, color-mix(in srgb, var(--versiondock-badge-foreground) 26%, transparent))', fontSize: 10, lineHeight: 1.25, fontWeight: 700, whiteSpace: 'nowrap' },
  changeStats: { marginLeft: 'auto', display: 'flex', gap: 7, fontSize: 11, fontFamily: 'var(--vscode-editor-font-family)' },
  changeAdded: { color: 'var(--vscode-gitDecoration-addedResourceForeground)', fontStyle: 'normal', fontWeight: 700 },
  changeRemoved: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)', fontStyle: 'normal', fontWeight: 700 },
  atomic: { flexShrink: 0, padding: '2px 7px', borderRadius: 4, color: 'var(--composer-atomic-foreground, var(--versiondock-badge-foreground))', background: 'var(--composer-atomic-background, color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 76%, var(--versiondock-badge-background)))', border: '1px solid var(--composer-atomic-border, color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 78%, transparent))', fontSize: 10, lineHeight: 1.25, fontWeight: 700, whiteSpace: 'nowrap' },
  hunks: { borderTop: '1px solid var(--composer-code-border, var(--vscode-panel-border))', background: 'var(--composer-code-background, color-mix(in srgb, var(--vscode-textCodeBlock-background) 78%, transparent))' },
  hunk: { borderBottom: '1px solid var(--vscode-panel-border)' },
  hunkHeader: { minHeight: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px 5px 27px', color: 'var(--vscode-foreground)', background: 'var(--composer-hunk-header-background, transparent)', fontFamily: 'var(--vscode-font-family)', fontSize: 11, cursor: 'grab' },
  hunkGrabber: { flexShrink: 0, color: 'var(--vscode-descriptionForeground)' },
  hunkTitle: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  hunkLocation: { flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 7px', borderRadius: 4, color: 'var(--vscode-textLink-foreground)', background: 'var(--composer-hunk-location-background, transparent)', border: '1px solid var(--composer-hunk-location-border, var(--vscode-panel-border))', fontWeight: 600, whiteSpace: 'nowrap' },
  hunkLocationIcon: { fontSize: 11 },
  hunkContext: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--vscode-descriptionForeground)', fontFamily: 'var(--vscode-editor-font-family)', fontSize: 10 },
  diff: { margin: 0, padding: '8px 0 12px', maxHeight: 280, overflow: 'auto', background: 'var(--composer-code-background, var(--vscode-textCodeBlock-background))', boxShadow: 'inset 0 1px var(--composer-code-border, var(--vscode-panel-border)), inset 0 -1px var(--composer-code-border, var(--vscode-panel-border))', fontFamily: 'var(--vscode-editor-font-family)', fontSize: 11, lineHeight: 1.55 },
  diffLine: { width: 'max-content', minWidth: '100%', display: 'grid', gridTemplateColumns: '42px 42px 18px max-content', whiteSpace: 'pre' },
  diffLineNumber: { padding: '0 7px 0 4px', textAlign: 'right', color: 'var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground))', borderRight: '1px solid color-mix(in srgb, var(--composer-code-border, var(--vscode-panel-border)) 58%, transparent)', userSelect: 'none' },
  diffNewLineNumber: { marginRight: 3 },
  diffPrefix: { display: 'block', textAlign: 'center', userSelect: 'none' },
  diffCode: { display: 'block', paddingRight: 12 },
  emptyDiff: { padding: '12px 38px', color: 'var(--vscode-descriptionForeground)', background: 'var(--composer-code-background, var(--vscode-textCodeBlock-background))', fontSize: 11 },
  dropHint: { marginTop: 8, padding: 14, textAlign: 'center', border: '1px dashed var(--vscode-panel-border)', color: 'var(--vscode-descriptionForeground)' }, addGroup: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: -7, padding: '6px 9px', border: 'none', borderRadius: 4, background: 'var(--composer-add-group-background, transparent)', color: 'var(--vscode-textLink-foreground)', cursor: 'pointer' },
  footer: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16, padding: '11px 18px', borderTop: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-sideBar-background,var(--vscode-editor-background))' }, footerHint: { color: 'var(--vscode-descriptionForeground)', fontSize: 11 }, footerActions: { marginLeft: 'auto', display: 'flex', gap: 8 },
  secondaryButton: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 4, border: '1px solid var(--vscode-button-border,var(--vscode-panel-border))', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', cursor: 'pointer' }, primaryButton: { minHeight: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '6px 14px', borderRadius: 6, boxSizing: 'border-box', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },

  completed: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 30, textAlign: 'center' }, completedMark: { width: 58, height: 58, flexShrink: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', color: '#fff', background: 'linear-gradient(135deg,#7657ff,#2f8fff)', fontSize: 24 }, completedTitle: { margin: '8px 0 0', fontSize: 22 }, completedCopy: { margin: 0, color: 'var(--vscode-descriptionForeground)' }, hashList: { display: 'flex', flexDirection: 'column', gap: 5, padding: 12, color: 'var(--vscode-descriptionForeground)' }, recovery: { width: 'min(680px,100%)', display: 'flex', flexDirection: 'column', gap: 7, margin: '8px 0', padding: 13, textAlign: 'left', border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-textCodeBlock-background)' },
};

