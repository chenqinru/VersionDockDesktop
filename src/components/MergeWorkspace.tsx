import { useCallback, useEffect, useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { isOperationActive, useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import {
  type Resolution,
  type NormalEdits,
  type NonConflictingChangeScope,
  type NonConflictingSelection,
  type NonConflictingSelections,
  toMergeConflictFile,
  getMergeToolbarCounts,
  buildBaseNormalEdits,
  buildNormalEditsForNonConflictingScope,
  buildNonConflictingSelectionsForScope,
  buildNormalEditsForNonConflictingSelections,
  buildContentFromResolutions,
  shouldDeleteResolvedFile,
} from './mergeEngine';
import { ThreeWayLayout } from './ThreeWayLayout';
import { mergeEditorIdentity } from './mergeEditorModel';

export function MergeWorkspace() {
  const { t } = useI18n();
  const merge = useAppStore((state) => state.merge);
  const mergeTarget = useAppStore((state) => state.mergeTarget ?? state.selectedFile);
  const workspaceId = useAppStore((state) => state.snapshot?.workspace.id ?? state.mergeTarget?.workspaceId);
  const setDraft = useAppStore((state) => state.setMergeEditorDraft);
  const setResult = useAppStore((state) => state.setMergeResult);
  const save = useAppStore((state) => state.saveMerge);
  const openConflicts = useAppStore((state) => state.openConflicts);
  const busy = useAppStore((state) =>
    isOperationActive(state.operations, { repositoryId: mergeTarget?.repoId, domain: 'conflict' }),
  );
  const accept = useAppStore((state) => state.acceptConflict);

  const file = useMemo(() => (merge ? toMergeConflictFile(merge) : null), [merge]);
  const storedDraft = useAppStore.getState().mergeEditorDraft;
  const identity = mergeEditorIdentity(workspaceId, mergeTarget?.repoId, merge?.path, merge?.fingerprint);
  const initialDraft = storedDraft?.identity === identity ? storedDraft : undefined;

  const [resolutions, setResolutions] = useState<Record<number, Resolution>>(initialDraft?.resolutions ?? {});
  const [normalEdits, setNormalEdits] = useState<NormalEdits>(initialDraft?.normalEdits ?? {});
  const [nonConflictingSelections, setNonConflictingSelections] = useState<NonConflictingSelections>(initialDraft?.nonConflictingSelections ?? {});
  const [appliedNonConflictingScope, setAppliedNonConflictingScope] = useState<NonConflictingChangeScope | null>(initialDraft?.appliedNonConflictingScope ?? null);
  const [currentConflictIndex, setCurrentConflictIndex] = useState(initialDraft?.currentConflictIndex ?? 0);
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(initialDraft?.syncScrollEnabled ?? true);

  useEffect(() => {
    if (!merge) return;
    setDraft({
      identity, fingerprint: merge.fingerprint, resolutions, normalEdits, nonConflictingSelections,
      appliedNonConflictingScope, currentConflictIndex, syncScrollEnabled,
    });
  }, [merge, identity, resolutions, normalEdits, nonConflictingSelections, appliedNonConflictingScope, currentConflictIndex, syncScrollEnabled, setDraft]);

  // 初始化或切换冲突文件时重置状态
  const [lastIdentity, setLastIdentity] = useState(identity);
  if (merge && identity !== lastIdentity) {
    setLastIdentity(identity);
    const initialRes: Record<number, Resolution> = {};
    merge.conflicts.forEach((c) => {
      initialRes[c.index] = 'unresolved';
    });
    setResolutions(initialDraft?.resolutions ?? initialRes);
    setNormalEdits(initialDraft?.normalEdits ?? {});
    setNonConflictingSelections(initialDraft?.nonConflictingSelections ?? {});
    setAppliedNonConflictingScope(initialDraft?.appliedNonConflictingScope ?? null);
    setCurrentConflictIndex(initialDraft?.currentConflictIndex ?? 0);
  }

  // 工具栏计数统计
  const toolbarCounts = useMemo(() => {
    if (!file) return { changeCount: 0, conflictCount: 0, nonConflictingCount: 0 };
    return getMergeToolbarCounts(file);
  }, [file]);

  // 非冲突更改预计算候选集
  const nonConflictingChoices = useMemo(() => {
    if (!file) return null;
    return {
      base: buildBaseNormalEdits(file),
      left: buildNormalEditsForNonConflictingScope(file, 'left'),
      right: buildNormalEditsForNonConflictingScope(file, 'right'),
      all: buildNormalEditsForNonConflictingScope(file, 'all'),
    };
  }, [file]);

  const nonConflictingSelectionChoices = useMemo(() => {
    if (!file) return null;
    return {
      left: buildNonConflictingSelectionsForScope(file, 'left'),
      right: buildNonConflictingSelectionsForScope(file, 'right'),
      all: buildNonConflictingSelectionsForScope(file, 'all'),
    };
  }, [file]);

  // 同步最终文本到 appStore 以备保存
  useEffect(() => {
    if (file && !file.conflicts.length) return;
    if (file) {
      const content = buildContentFromResolutions(file, resolutions, normalEdits);
      setResult(content);
    }
  }, [file, resolutions, normalEdits, setResult]);

  // 未解决冲突列表
  const unresolvedConflictIndexes = useMemo(() => {
    if (!file) return [];
    return file.conflicts
      .map((c) => c.index)
      .filter((index) => (resolutions[index] ?? 'unresolved') === 'unresolved');
  }, [file, resolutions]);

  const goToPreviousUnresolved = useCallback(() => {
    const prev = [...unresolvedConflictIndexes].reverse().find((index) => index < currentConflictIndex);
    if (prev !== undefined) setCurrentConflictIndex(prev);
  }, [currentConflictIndex, unresolvedConflictIndexes]);

  const goToNextUnresolved = useCallback(() => {
    const next = unresolvedConflictIndexes.find((index) => index > currentConflictIndex);
    if (next !== undefined) setCurrentConflictIndex(next);
  }, [currentConflictIndex, unresolvedConflictIndexes]);

  // 应用非冲突修改 (» 左侧、⇄ 全部、« 右侧)
  const handleApplyNonConflicting = useCallback((scope: NonConflictingChangeScope) => {
    if (!file || !nonConflictingChoices) return;
    const edits = nonConflictingChoices[scope];
    if (!edits) return;

    setNormalEdits(edits);
    setNonConflictingSelections(nonConflictingSelectionChoices?.[scope] ?? {});
    setAppliedNonConflictingScope(scope);
    const content = buildContentFromResolutions(file, resolutions, edits);
    setResult(content);
    if (scope === 'all' && unresolvedConflictIndexes.length > 0) {
      setCurrentConflictIndex(unresolvedConflictIndexes[0]);
    }
  }, [file, nonConflictingChoices, nonConflictingSelectionChoices, resolutions, setResult, unresolvedConflictIndexes]);

  // 取消应用非冲突修改 (⟲ 取消应用)
  const handleCancelNonConflicting = useCallback(() => {
    if (!file || !nonConflictingChoices?.base) return;
    setNormalEdits(nonConflictingChoices.base);
    setNonConflictingSelections({});
    setAppliedNonConflictingScope(null);
    const content = buildContentFromResolutions(file, resolutions, nonConflictingChoices.base);
    setResult(content);
  }, [file, nonConflictingChoices, resolutions, setResult]);

  // 单块非冲突选择/取消
  const handleSelectNonConflicting = useCallback((blockIndex: number, selection: NonConflictingSelection | 'base') => {
    if (!file) return;
    const nextSelections = { ...nonConflictingSelections };
    if (selection === 'base') delete nextSelections[blockIndex];
    else nextSelections[blockIndex] = selection;

    const edits = buildNormalEditsForNonConflictingSelections(file, nextSelections);
    if (edits) {
      setNormalEdits(edits);
      setNonConflictingSelections(nextSelections);
      setAppliedNonConflictingScope(null);
      const content = buildContentFromResolutions(file, resolutions, edits);
      setResult(content);
    }
  }, [file, nonConflictingSelections, resolutions, setResult]);

  // 冲突块解决
  const handleResolveBlock = useCallback((index: number, resolution: Resolution) => {
    setCurrentConflictIndex(index);
    setResolutions((prev) => {
      const next = { ...prev, [index]: resolution };
      if (file) {
        setResult(buildContentFromResolutions(file, next, normalEdits));
      }
      return next;
    });
  }, [file, normalEdits, setResult]);

  // 正常块编辑
  const handleNormalEdit = useCallback((index: number, lines: string[]) => {
    setAppliedNonConflictingScope(null);
    setNormalEdits((prev) => {
      const next = { ...prev, [index]: lines };
      if (file) {
        setResult(buildContentFromResolutions(file, resolutions, next));
      }
      return next;
    });
  }, [file, resolutions, setResult]);

  // 底部全部接受当前/对方
  const acceptAllSide = useCallback((side: 'ours' | 'theirs') => {
    if (!file) return;
    const next: Record<number, Resolution> = {};
    file.conflicts.forEach((c) => {
      next[c.index] = side;
    });
    setResolutions(next);
    setResult(buildContentFromResolutions(file, next, normalEdits));
  }, [file, normalEdits, setResult]);

  // 底部全部重置
  const resetAll = useCallback(() => {
    if (!file) return;
    const initialRes: Record<number, Resolution> = {};
    file.conflicts.forEach((c) => {
      initialRes[c.index] = 'unresolved';
    });
    setResolutions(initialRes);
    const baseEdits = buildBaseNormalEdits(file) ?? {};
    setNormalEdits(baseEdits);
    setNonConflictingSelections({});
    setAppliedNonConflictingScope(null);
    setCurrentConflictIndex(0);
    setResult(buildContentFromResolutions(file, initialRes, baseEdits));
  }, [file, setResult]);

  const handleSaveAndReturn = useCallback(async () => {
    const currentResult = useAppStore.getState().mergeResult;
    const deleteFile = file ? shouldDeleteResolvedFile(file, currentResult, resolutions) : false;
    const ok = await save({ deleteFile });
    if (ok) {
      openConflicts();
    }
  }, [file, resolutions, save, openConflicts]);

  const handleAccept = useCallback(async (choice: 'mine' | 'theirs' | 'working') => {
    const ok = await accept(choice);
    if (ok) {
      openConflicts();
    }
  }, [accept, openConflicts]);

  if (!merge || !file) return null;

  const fileName = merge.path.split('/').pop() ?? merge.path;
  const canApplyNonConflicting = toolbarCounts.nonConflictingCount > 0;
  const canCancelNonConflicting = canApplyNonConflicting && Boolean(nonConflictingChoices?.base);

  return (
    <section
      className="merge-workspace advanced-merge-workspace"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--vscode-editor-background, #1e1e1e)',
        color: 'var(--vscode-foreground, #cccccc)',
        overflow: 'hidden',
      }}
    >
      {/* 顶部文件路径与返回栏 */}
      <div
        className="merge-path-header"
        style={{
          height: 38,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px',
          borderBottom: '1px solid var(--vscode-panel-border, #333333)',
          background: 'var(--vscode-editor-background, #1e1e1e)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          className="diff-back-button"
          onClick={openConflicts}
          title={t('Back to conflicts')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 27,
            padding: '0 8px',
            border: '1px solid var(--vscode-panel-border, var(--versiondock-border))',
            borderRadius: 3,
            background: 'transparent',
            color: 'var(--vscode-foreground)',
            cursor: 'pointer',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          <Codicon name="arrow-left" />
          <span>{t('Back to conflicts')}</span>
        </button>
        <FileIcon name={fileName} />
        <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {merge.path}
        </span>
      </div>

      {/* 二进制冲突提示 */}
      {merge.binary ? (
        <div className="workspace-empty conflict-choice" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          <Codicon name="file-binary" style={{ fontSize: 36 }} />
          <strong>{t('Binary conflict cannot be edited')}</strong>
          <span>{t('Choose which complete version to keep.')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busy} onClick={() => void handleAccept('mine')}>{t('Keep mine')}</button>
            <button disabled={busy} onClick={() => void handleAccept('theirs')}>{t('Keep theirs')}</button>
            <button disabled={busy} onClick={() => void handleAccept('working')}>{t('Keep working')}</button>
          </div>
        </div>
      ) : (
        <>
          {/* 顶部操作与统计工具栏 */}
          <div
            className="merge-editor-toolbar"
            style={{
              height: 34,
              minHeight: 34,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '0 12px',
              borderBottom: '1px solid var(--vscode-panel-border, #333333)',
              background: 'var(--vscode-editor-background, #1e1e1e)',
              fontSize: 12,
              flexShrink: 0,
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, height: '100%', flexShrink: 0 }}>
              <button
                type="button"
                disabled={!unresolvedConflictIndexes.some((index) => index < currentConflictIndex)}
                onClick={goToPreviousUnresolved}
                title={t('Previous Unresolved Conflict')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  boxSizing: 'border-box',
                  border: '1px solid var(--vscode-panel-border, #444444)',
                  borderRadius: 3,
                  background: 'transparent',
                  color: !unresolvedConflictIndexes.some((index) => index < currentConflictIndex) ? 'var(--vscode-disabledForeground, #777777)' : 'var(--vscode-foreground, #cccccc)',
                  padding: 0,
                  cursor: !unresolvedConflictIndexes.some((index) => index < currentConflictIndex) ? 'default' : 'pointer',
                  opacity: !unresolvedConflictIndexes.some((index) => index < currentConflictIndex) ? 0.45 : 1,
                  fontSize: 11,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={!unresolvedConflictIndexes.some((index) => index > currentConflictIndex)}
                onClick={goToNextUnresolved}
                title={t('Next Unresolved Conflict')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  boxSizing: 'border-box',
                  border: '1px solid var(--vscode-panel-border, #444444)',
                  borderRadius: 3,
                  background: 'transparent',
                  color: !unresolvedConflictIndexes.some((index) => index > currentConflictIndex) ? 'var(--vscode-disabledForeground, #777777)' : 'var(--vscode-foreground, #cccccc)',
                  padding: 0,
                  cursor: !unresolvedConflictIndexes.some((index) => index > currentConflictIndex) ? 'default' : 'pointer',
                  opacity: !unresolvedConflictIndexes.some((index) => index > currentConflictIndex) ? 0.45 : 1,
                  fontSize: 11,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ↓
              </button>
              <span style={{ width: 1, height: 16, background: 'var(--vscode-panel-border, #444444)', flexShrink: 0, margin: '0 3px' }} />

              <span style={{ color: 'var(--vscode-descriptionForeground, #999999)', whiteSpace: 'nowrap', fontSize: 12, lineHeight: '22px', display: 'inline-flex', alignItems: 'center' }}>
                {t('Apply non-conflicting changes:')}
              </span>
              {([
                { scope: 'left', label: t('Left'), icon: '»' },
                { scope: 'all', label: t('All'), icon: '⇄' },
                { scope: 'right', label: t('Right'), icon: '«' },
              ] as const).map(({ scope: s, label, icon }) => {
                const active = appliedNonConflictingScope === s;
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={!canApplyNonConflicting}
                    onClick={() => handleApplyNonConflicting(s)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: 22,
                      boxSizing: 'border-box',
                      gap: 4,
                      border: `1px solid ${active ? 'var(--versiondock-selection-border)' : 'var(--vscode-panel-border, #444444)'}`,
                      borderRadius: 3,
                      background: active ? 'var(--vscode-list-activeSelectionBackground, var(--versiondock-selection-background))' : 'transparent',
                      color: !canApplyNonConflicting ? 'var(--vscode-disabledForeground, #777777)' : active ? 'var(--vscode-list-activeSelectionForeground, var(--versiondock-selection-foreground))' : 'var(--vscode-foreground, #cccccc)',
                      padding: '0 8px',
                      fontSize: 12,
                      lineHeight: '20px',
                      cursor: canApplyNonConflicting ? 'pointer' : 'default',
                      opacity: canApplyNonConflicting ? 1 : 0.65,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ color: 'var(--vscode-textLink-foreground, #3794ff)', fontSize: 13, lineHeight: '13px', display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
                    <span>{label}</span>
                  </button>
                );
              })}
              <button
                type="button"
                disabled={!canCancelNonConflicting}
                onClick={handleCancelNonConflicting}
                title={t('Restore non-conflicting changes to Base')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: 22,
                  boxSizing: 'border-box',
                  gap: 4,
                  border: '1px solid var(--vscode-panel-border, #444444)',
                  borderRadius: 3,
                  background: 'transparent',
                  color: !canCancelNonConflicting ? 'var(--vscode-disabledForeground, #777777)' : 'var(--vscode-foreground, #cccccc)',
                  padding: '0 8px',
                  fontSize: 12,
                  lineHeight: '20px',
                  cursor: canCancelNonConflicting ? 'pointer' : 'default',
                  opacity: canCancelNonConflicting ? 1 : 0.65,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                <Codicon name="discard" style={{ color: 'var(--vscode-textLink-foreground, #3794ff)', fontSize: 13, lineHeight: '13px' }} />
                <span>{t('Cancel application')}</span>
              </button>

              <span style={{ width: 1, height: 16, background: 'var(--vscode-panel-border, #444444)', flexShrink: 0, margin: '0 3px' }} />

              <label style={{ display: 'inline-flex', alignItems: 'center', height: 22, gap: 5, whiteSpace: 'nowrap', fontSize: 12, lineHeight: '22px', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={syncScrollEnabled}
                  onChange={(e) => setSyncScrollEnabled(e.target.checked)}
                  style={{ margin: 0, cursor: 'pointer', verticalAlign: 'middle' }}
                />
                <span>{t('Synchronous Scrolling')}</span>
              </label>
            </div>

            <span
              className="merge-toolbar-stats"
              style={{
                color: 'var(--vscode-descriptionForeground, #999999)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontSize: 12,
                lineHeight: '22px',
                marginLeft: 'auto',
                textAlign: 'right',
                flexShrink: 0,
              }}
            >
              {t('{0} changes · {1} conflicts', toolbarCounts.changeCount, toolbarCounts.conflictCount)} · {unresolvedConflictIndexes.length > 0 ? t('{0} conflicts remaining', unresolvedConflictIndexes.length) : t('All conflicts resolved')}
            </span>
          </div>

          {/* 3 列三方连线合并主体 */}
          <ThreeWayLayout
            file={file}
            resolutions={resolutions}
            normalEdits={normalEdits}
            nonConflictingSelections={nonConflictingSelections}
            language={file.language ?? 'plaintext'}
            onResultChange={(content) => setResult(content)}
            onResolveBlock={handleResolveBlock}
            onNormalEdit={handleNormalEdit}
            onSelectNonConflicting={handleSelectNonConflicting}
            currentConflictIndex={currentConflictIndex}
            syncScrollEnabled={syncScrollEnabled}
            onApplyResolved={handleSaveAndReturn}
          />

          {/* 底部操作栏 */}
          <div
            className="merge-footer"
            style={{
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 12px',
              borderTop: '1px solid var(--vscode-panel-border, #333333)',
              background: 'var(--vscode-editor-background, #1e1e1e)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => acceptAllSide('ours')}
                style={{ padding: '6px 14px', borderRadius: 3, border: '1px solid var(--vscode-button-border, transparent)', background: 'var(--vscode-button-secondaryBackground, #3a3d41)', color: 'var(--vscode-button-secondaryForeground, #ffffff)', cursor: 'pointer', fontSize: 12 }}
              >
                {t('Accept Current')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => acceptAllSide('theirs')}
                style={{ padding: '6px 14px', borderRadius: 3, border: '1px solid var(--vscode-button-border, transparent)', background: 'var(--vscode-button-secondaryBackground, #3a3d41)', color: 'var(--vscode-button-secondaryForeground, #ffffff)', cursor: 'pointer', fontSize: 12 }}
              >
                {t('Accept Incoming')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={resetAll}
                style={{ padding: '6px 14px', borderRadius: 3, border: '1px solid var(--vscode-button-border, transparent)', background: 'var(--vscode-button-secondaryBackground, #3a3d41)', color: 'var(--vscode-button-secondaryForeground, #ffffff)', cursor: 'pointer', fontSize: 12 }}
              >
                {t('Reset')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                disabled={busy}
                onClick={openConflicts}
                style={{ padding: '6px 14px', borderRadius: 3, border: '1px solid var(--vscode-button-border, transparent)', background: 'var(--vscode-button-secondaryBackground, #3a3d41)', color: 'var(--vscode-button-secondaryForeground, #ffffff)', cursor: 'pointer', fontSize: 12 }}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                aria-label={t('Save resolution')}
                title={t('Save resolution')}
                disabled={busy || unresolvedConflictIndexes.length > 0}
                onClick={() => void handleSaveAndReturn()}
                style={{
                  padding: '6px 18px',
                  borderRadius: 3,
                  border: '1px solid var(--vscode-button-border, transparent)',
                  background: 'var(--vscode-button-background, #0e639c)',
                  color: 'var(--vscode-button-foreground, #ffffff)',
                  opacity: unresolvedConflictIndexes.length > 0 || busy ? 0.45 : 1,
                  cursor: unresolvedConflictIndexes.length > 0 || busy ? 'default' : 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {t('Apply')}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
