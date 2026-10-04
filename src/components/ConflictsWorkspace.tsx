import { changeStatusColor } from '../theme/changeStatus';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { SpeedSearchIndicator } from './SpeedSearchIndicator';
import { useSpeedSearch } from '../hooks/useSpeedSearch';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { choiceDialog, confirmDialog } from './dialogService';
import type { ConflictFile, RepositoryStatus } from '../bindings/generated';

type TreeNode = TreeDir | TreeFile;
interface TreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  count: number;
  isRepoRoot?: boolean;
  repoColor?: string;
}
interface TreeFile {
  kind: 'file';
  file: ConflictFile;
}

function fileKey(file: ConflictFile): string {
  return `${file.repoId}:${file.path}`;
}

function getConflictTypes(file: ConflictFile): string[] {
  return file.conflictTypes && file.conflictTypes.length > 0
    ? file.conflictTypes
    : [file.conflictType || 'text'];
}

function isTextConflict(file: ConflictFile): boolean {
  return (
    getConflictTypes(file).includes('text') &&
    !getConflictTypes(file).includes('submodule') &&
    !file.binary
  );
}

function hasNonTextConflict(file: ConflictFile): boolean {
  return (
    getConflictTypes(file).some(
      (type) =>
        type === 'property' ||
        type === 'tree' ||
        type === 'obstruction' ||
        type === 'unknown' ||
        type === 'submodule',
    ) || Boolean(file.binary)
  );
}

function conflictTypeLabel(file: ConflictFile, t: (key: string, ...args: any[]) => string): string {
  const types = getConflictTypes(file);
  if (types.includes('submodule')) return t('Submodule conflict');
  if (types.includes('text') && types.includes('property')) return t('Text and property conflict');
  if (types.includes('property')) return t('Property conflict');
  if (types.includes('tree') || types.includes('obstruction')) return t('Tree conflict');
  if (types.includes('unknown')) return t('Unknown conflict');
  if (file.binary) return t('Binary conflict');
  return t('Text conflict');
}

function nonTextConflictWarningText(file: ConflictFile, t: (key: string, ...args: any[]) => string): string {
  const types = getConflictTypes(file);
  if (types.includes('submodule')) {
    return t('Submodule conflict requires a side selection. Choose Accept Current or Accept Incoming.');
  }
  if (file.binary) {
    return t('Binary conflict requires a side selection. Choose Accept Current or Accept Incoming.');
  }
  if (file.kind === 'svn') {
    return t('SVN tree or property conflict requires a side selection. Choose Accept Current or Accept Incoming.');
  }
  return t('Conflict requires a side selection. Choose Accept Current or Accept Incoming.');
}

function nonTextConflictNotificationText(file: ConflictFile, t: (key: string, ...args: any[]) => string): string {
  const types = getConflictTypes(file);
  if (types.includes('submodule')) {
    return t('Submodule conflicts cannot be opened in the text merge editor. Use a conflict action instead.');
  }
  if (file.binary) {
    return t('Binary conflicts cannot be opened in the text merge editor. Use a conflict action instead.');
  }
  if (file.kind === 'svn') {
    return t('SVN property and directory conflicts cannot be opened in the text merge editor. Use a conflict action instead.');
  }
  return t('Non-text conflicts cannot be opened in the text merge editor. Use a conflict action instead.');
}

function buildTree(files: ConflictFile[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [], count: 0 };
  for (const file of files) {
    const repoPath = `repo:${encodeURIComponent(file.repoId)}`;
    let repoNode = root.children.find((item): item is TreeDir => item.kind === 'dir' && item.path === repoPath);
    if (!repoNode) {
      repoNode = {
        kind: 'dir',
        name: file.repoName,
        path: repoPath,
        children: [],
        count: 0,
        isRepoRoot: true,
        repoColor: file.repoColor,
      };
      root.children.push(repoNode);
    }

    const parts = file.path.split('/');
    let node = repoNode;
    node.count += 1;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const dirPath = `${repoPath}/${parts.slice(0, i + 1).join('/')}`;
      let child = node.children.find((item): item is TreeDir => item.kind === 'dir' && item.path === dirPath);
      if (!child) {
        child = { kind: 'dir', name, path: dirPath, children: [], count: 0 };
        node.children.push(child);
      }
      child.count += 1;
      node = child;
    }
    node.children.push({ kind: 'file', file });
  }
  return collapseSingleChildDirs(sortNodes(root.children));
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1;
      const leftName = left.kind === 'dir' ? left.name : left.file.path.split('/').pop() ?? left.file.path;
      const rightName = right.kind === 'dir' ? right.name : right.file.path.split('/').pop() ?? right.file.path;
      return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
    })
    .map((node) => (node.kind === 'dir' ? { ...node, children: sortNodes(node.children) } : node));
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    const collapsedNode = { ...node, children };
    if (collapsedNode.isRepoRoot) return collapsedNode;
    if (children.length === 1 && children[0].kind === 'dir' && !children[0].isRepoRoot) {
      const only = children[0];
      return {
        ...only,
        name: `${node.name}/${only.name}`,
      };
    }
    return collapsedNode;
  });
}

function flattenTree(nodes: TreeNode[], collapsed: Record<string, boolean>): ConflictFile[] {
  const result: ConflictFile[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') result.push(node.file);
    else if (!collapsed[node.path]) result.push(...flattenTree(node.children, collapsed));
  }
  return result;
}

function HighlightedText({ text, query, isActive }: { text: string; query?: string; isActive?: boolean }) {
  if (!query || !query.trim()) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index === -1) return <>{text}</>;
  const before = text.slice(0, index);
  const match = text.slice(index, index + query.length);
  const after = text.slice(index + query.length);
  return (
    <>
      {before}
      <mark className={isActive ? 'speed-search-match active' : 'speed-search-match'} style={{ background: 'var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33))', color: 'inherit', borderRadius: 2 }}>{match}</mark>
      {after}
    </>
  );
}

export function ConflictsWorkspace() {
  const { t } = useI18n();
  const conflicts = useAppStore((state) => state.conflicts);
  const loadError = useAppStore((state) => state.loadErrors['conflicts:all']);
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const openMerge = useAppStore((state) => state.openMerge);
  const resolveConflict = useAppStore((state) => state.resolveConflict);
  const backToHistory = useAppStore((state) => state.backToHistory);
  const continueRepositoryOperation = useAppStore((state) => state.continueRepositoryOperation);
  const abortRepositoryOperation = useAppStore((state) => state.abortRepositoryOperation);

  const [groupByDir, setGroupByDir] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);

  const savedCollapsedBeforeSearchRef = useRef<Record<string, boolean> | null>(null);
  const activeMatchIndexRef = useRef<number>(0);
  const matchedFilesRef = useRef<ConflictFile[]>([]);
  const treeScrollerRef = useRef<HTMLDivElement>(null);

  const handleSpeedSearchNavigate = useCallback((direction: -1 | 1) => {
    const matches = matchedFilesRef.current;
    if (matches.length === 0) return;
    const nextIndex = (activeMatchIndexRef.current + direction + matches.length) % matches.length;
    activeMatchIndexRef.current = nextIndex;
    const item = matches[nextIndex];
    const key = fileKey(item);
    setSelectedKeys([key]);
    setLastSelectedKey(key);
    requestAnimationFrame(() => {
      const row = treeScrollerRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, []);

  const speedSearch = useSpeedSearch('conflicts', true, '.conflicts-table-wrap', handleSpeedSearchNavigate);

  const speedNeedle = speedSearch.query.trim().toLowerCase();
  const matchedFiles = useMemo(() => {
    if (!speedNeedle) return [];
    return conflicts.filter((f) => {
      const fileName = f.path === '.' ? t('Repository root') : (f.path.split('/').pop() ?? f.path);
      return fileName.toLowerCase().includes(speedNeedle) || f.path.toLowerCase().includes(speedNeedle);
    });
  }, [conflicts, speedNeedle, t]);

  useEffect(() => {
    matchedFilesRef.current = matchedFiles;
  }, [matchedFiles]);

  useEffect(() => {
    if (!speedSearch.isOpen) {
      if (savedCollapsedBeforeSearchRef.current) {
        setCollapsed(savedCollapsedBeforeSearchRef.current);
        savedCollapsedBeforeSearchRef.current = null;
      }
      return;
    }

    if (matchedFiles.length === 0) return;

    setCollapsed((prev) => {
      if (!savedCollapsedBeforeSearchRef.current) {
        savedCollapsedBeforeSearchRef.current = { ...prev };
      }
      const nextCollapsed = { ...prev };
      for (const f of matchedFiles) {
        const repoPath = `repo:${encodeURIComponent(f.repoId)}`;
        nextCollapsed[repoPath] = false;
        const parts = f.path.split('/');
        for (let i = 0; i < parts.length - 1; i++) {
          const dirPath = `${repoPath}/${parts.slice(0, i + 1).join('/')}`;
          nextCollapsed[dirPath] = false;
        }
      }
      return nextCollapsed;
    });

    activeMatchIndexRef.current = 0;
    const firstMatch = matchedFiles[0];
    const key = fileKey(firstMatch);
    setSelectedKeys([key]);
    setLastSelectedKey(key);

    requestAnimationFrame(() => {
      const row = treeScrollerRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [speedSearch.isOpen, speedNeedle, matchedFiles]);

  const tree = useMemo(() => buildTree(conflicts), [conflicts]);
  const conflictRepoCount = useMemo(() => new Set(conflicts.map((file) => file.repoId)).size, [conflicts]);
  const conflictRepoSummary = conflictRepoCount === 1
    ? t('{0} repository', conflictRepoCount)
    : t('{0} repositories', conflictRepoCount);
  const conflictItemSummary = t('{0} files are in conflict', conflicts.length);
  const conflictCountSummary = conflictRepoCount > 0
    ? `${conflictRepoSummary} · ${conflictItemSummary}`
    : conflictItemSummary;

  const activeOperationRepos = useMemo(
    () => repos.filter((repo) => repo.meta.kind === 'git' && Boolean(repo.operation)),
    [repos],
  );
  const continueTargets = useMemo(
    () => activeOperationRepos.filter((repo) => repo.conflicts === 0 && !repo.files.some((f) => f.conflicted)),
    [activeOperationRepos],
  );
  const continueStates = useMemo(() => new Set(continueTargets.map((r) => r.operation)), [continueTargets]);
  const continueLabel = useMemo(() => {
    if (continueTargets.length > 1) {
      if (continueStates.size > 1) return t('Continue Operation — Select repository');
      if (continueStates.has('merge')) return t('Commit Merge — Select repository');
      if (continueStates.has('rebase')) return t('Continue Rebase — Select repository');
      if (continueStates.has('cherry-pick')) return t('Continue Cherry-pick — Select repository');
      return t('Continue Revert — Select repository');
    }
    const op = continueTargets[0]?.operation;
    if (op === 'rebase') return t('Continue Rebase');
    if (op === 'cherry-pick') return t('Continue Cherry-pick');
    if (op === 'revert') return t('Continue Revert');
    return t('Commit Merge');
  }, [continueTargets, continueStates, t]);

  const continueDetail = useMemo(() => {
    if (continueTargets.length > 1) {
      return t('All conflicts resolved. Select repository to continue operation.');
    }
    const op = continueTargets[0]?.operation;
    if (op === 'rebase') return t('All conflicts resolved. Continue rebase to apply next commits.');
    if (op === 'cherry-pick') return t('All conflicts resolved. Continue cherry-pick.');
    if (op === 'revert') return t('All conflicts resolved. Continue revert.');
    return t('All conflicts resolved. Complete merge commit.');
  }, [continueTargets, t]);

  const abortTargets = activeOperationRepos;
  const abortStates = useMemo(() => new Set(abortTargets.map((r) => r.operation)), [abortTargets]);
  const abortLabel = useMemo(() => {
    if (abortTargets.length > 1) {
      if (abortStates.size > 1) return t('Abort Merge/Rebase — Select repository');
      if (abortStates.has('merge')) return t('Abort Merge — Select repository');
      if (abortStates.has('rebase')) return t('Abort Rebase — Select repository');
      if (abortStates.has('cherry-pick')) return t('Abort Cherry-pick — Select repository');
      return t('Abort Revert — Select repository');
    }
    const op = abortTargets[0]?.operation;
    if (op === 'rebase') return t('Abort Rebase');
    if (op === 'cherry-pick') return t('Abort Cherry-pick');
    if (op === 'revert') return t('Abort Revert');
    return t('Abort Merge');
  }, [abortTargets, abortStates, t]);

  const abortDetail = useMemo(() => {
    if (abortTargets.length > 1) {
      return t('Select the repository whose {0} should be aborted', t('merge/rebase'));
      if (abortStates.has('merge')) return t('Select the repository whose merge should be aborted');
      if (abortStates.has('rebase')) return t('Select the repository whose rebase should be aborted');
      if (abortStates.has('cherry-pick')) return t('Select the repository whose cherry-pick should be aborted');
      return t('Select the repository whose revert should be aborted');
    }
    const op = abortTargets[0]?.operation;
    if (op === 'rebase') return t('Rebase in progress — abort and restore previous state');
    if (op === 'cherry-pick') return t('Cherry-pick in progress — abort and restore previous state');
    if (op === 'revert') return t('Revert in progress — abort and restore previous state');
    return t('Merge in progress — abort and restore previous state');
  }, [abortTargets, abortStates, t]);

  const activeOperationRepo = activeOperationRepos[0];
  const operationLabel = activeOperationRepo?.operation
    ? activeOperationRepo.operation === 'merge'
      ? t('Merge in progress')
      : activeOperationRepo.operation === 'rebase'
      ? t('Rebase in progress')
      : activeOperationRepo.operation === 'cherry-pick'
      ? t('Cherry-pick in progress')
      : t('Revert in progress')
    : t('Conflicts detected');

  const visibleFiles = useMemo(() => {
    if (!groupByDir) {
      return [...conflicts].sort((left, right) => {
        const leftName = left.path.split('/').pop() ?? left.path;
        const rightName = right.path.split('/').pop() ?? right.path;
        return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
      });
    }
    return flattenTree(tree, collapsed);
  }, [collapsed, conflicts, groupByDir, tree]);

  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectedFiles = useMemo(
    () => conflicts.filter((file) => selectedKeySet.has(fileKey(file))),
    [conflicts, selectedKeySet],
  );
  const hasSelection = selectedFiles.length > 0;
  const canMergeSelected = selectedFiles.length === 1 && isTextConflict(selectedFiles[0]);
  const addNotification = useAppStore((state) => state.addNotification);

  const selectFile = useCallback((file: ConflictFile, event: React.MouseEvent) => {
    const key = fileKey(file);
    if (event.shiftKey && lastSelectedKey) {
      const start = visibleFiles.findIndex((item) => fileKey(item) === lastSelectedKey);
      const end = visibleFiles.findIndex((item) => fileKey(item) === key);
      if (start >= 0 && end >= 0) {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        setSelectedKeys(visibleFiles.slice(min, max + 1).map(fileKey));
      } else {
        setSelectedKeys([key]);
      }
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
    } else {
      setSelectedKeys([key]);
    }
    setLastSelectedKey(key);
  }, [lastSelectedKey, visibleFiles]);

  const openMergeEditor = useCallback((file: ConflictFile) => {
    if (!isTextConflict(file)) {
      addNotification({
        type: 'info',
        title: file.repoName,
        message: { raw: nonTextConflictNotificationText(file, t) },
      });
      return;
    }
    void openMerge(file);
  }, [openMerge, addNotification, t]);

  const accept = useCallback(async (side: 'mine' | 'theirs') => {
    if (!hasSelection) return;
    for (const file of selectedFiles) {
      const ok = await resolveConflict(file, side);
      if (!ok) {
        break;
      }
    }
  }, [hasSelection, resolveConflict, selectedFiles]);

  const handleContinueClick = useCallback(async () => {
    let target: RepositoryStatus | undefined = continueTargets[0];
    if (continueTargets.length > 1) {
      const choiceId = await choiceDialog({
        title: continueLabel,
        message: continueDetail,
        choices: continueTargets.map((r) => ({
          id: r.meta.id,
          label: r.meta.name,
          description: r.operation ?? undefined,
          icon: 'git-merge',
        })),
      });
      if (!choiceId) return;
      target = continueTargets.find((r) => r.meta.id === choiceId);
    }
    if (!target || !target.operation) return;
    const ok = await continueRepositoryOperation(target.meta.id, target.operation);
    if (ok) {
      backToHistory();
    }
  }, [continueTargets, continueLabel, continueDetail, continueRepositoryOperation, backToHistory]);

  const handleAbortClick = useCallback(async () => {
    let target: RepositoryStatus | undefined = abortTargets[0];
    if (abortTargets.length > 1) {
      const choiceId = await choiceDialog({
        title: abortLabel,
        message: abortDetail,
        choices: abortTargets.map((r) => ({
          id: r.meta.id,
          label: r.meta.name,
          description: r.operation ?? undefined,
          icon: 'git-branch',
        })),
      });
      if (!choiceId) return;
      target = abortTargets.find((r) => r.meta.id === choiceId);
    }
    if (!target || !target.operation) return;

    const confirmTitle = t('Abort {0}?', target.operation);
    const confirmMessage = target.operation === 'merge'
      ? t('VersionDock [{0}]: Abort merge? This will restore the repository to its pre-merge state.', target.meta.name)
      : t('VersionDock [{0}]: Abort {1}? This will restore the repository to its previous state.', target.meta.name, target.operation);

    const yes = await confirmDialog({
      title: confirmTitle,
      message: confirmMessage,
      danger: true,
      confirmLabel: target.operation === 'rebase'
        ? t('Abort Rebase')
        : target.operation === 'cherry-pick'
          ? t('Abort Cherry-pick')
          : target.operation === 'revert'
            ? t('Abort Revert')
            : t('Abort Merge'),
    });
    if (yes) {
      const ok = await abortRepositoryOperation(target.meta.id, target.operation);
      if (ok) {
        backToHistory();
      }
    }
  }, [abortTargets, abortLabel, abortDetail, abortRepositoryOperation, backToHistory, t]);

  return (
    <div className="conflicts-workspace-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)', overflow: 'hidden' }}>
      <style>{`
        .versiondock-conflicts-dir-row:hover,
        .versiondock-conflicts-file-row[data-selected="false"]:hover {
          background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08)) !important;
        }
      `}</style>

      {/* 顶部页面标签与返回栏 */}
      <div
        className="conflicts-path-header"
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
          onClick={backToHistory}
          title={t('Back to history')}
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
          <span>{t('Back to history')}</span>
        </button>
        <Codicon name="warning" style={{ color: 'var(--vscode-editorWarning-foreground, #cca700)' }} />
        <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('Conflicts')}
        </span>
      </div>

      {/* 标题及描述区 */}
      <div className="conflicts-header" style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, lineHeight: '24px', fontWeight: 600 }}>{t('Conflicts')}</h2>
        <div style={{ marginTop: 4, fontSize: 13, fontWeight: 600, color: 'var(--vscode-descriptionForeground)' }}>{operationLabel}</div>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>{conflictCountSummary}</div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={groupByDir}
            onChange={(e) => setGroupByDir(e.currentTarget.checked)}
            style={{ margin: 0 }}
          />
          {t('Group by directory')}
        </label>
      </div>

      {loadError && (
        <div
          style={{
            padding: '6px 12px',
            color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-editorError-foreground, #f14c4c))',
            background: 'var(--vscode-inputValidation-errorBackground, var(--vscode-editorError-background, rgba(241, 76, 76, 0.12)))',
            borderBottom: '1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-editorError-foreground, #f14c4c))',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {loadError}
        </div>
      )}

      {selectedFiles.length === 1 && !isTextConflict(selectedFiles[0]) && (
        <div
          style={{
            padding: '6px 12px',
            color: 'var(--vscode-inputValidation-warningForeground, var(--vscode-editorWarning-foreground, #cca700))',
            background: 'var(--vscode-inputValidation-warningBackground, var(--vscode-editorWarning-background, rgba(204, 167, 0, 0.12)))',
            borderBottom: '1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground, #cca700))',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {nonTextConflictWarningText(selectedFiles[0], t)}
        </div>
      )}

      {/* 主体内容 */}
      {loadError && conflicts.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--vscode-descriptionForeground)' }}>
          <Codicon name="error" style={{ fontSize: 32, color: 'var(--vscode-errorForeground, #f14c4c)' }} />
          <span>{t('Failed to load conflicts')}</span>
        </div>
      ) : conflicts.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--vscode-descriptionForeground)', padding: 24, textAlign: 'center' }}>
          <Codicon name="pass" style={{ fontSize: 36, color: 'var(--vscode-testing-iconPassed, #73c991)' }} />
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--vscode-foreground)' }}>
            {t('All conflicts resolved')}
          </div>
          {continueTargets.length > 0 ? (
            <>
              <div style={{ maxWidth: 460, fontSize: 13, lineHeight: '18px', color: 'var(--vscode-descriptionForeground)' }}>
                {continueDetail}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                <button
                  type="button"
                  className="conflicts-continue-btn"
                  onClick={() => void handleContinueClick()}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 30,
                    padding: '0 14px',
                    borderRadius: 3,
                    border: 'none',
                    background: 'var(--vscode-button-background, #0078d4)',
                    color: 'var(--vscode-button-foreground, #ffffff)',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  <Codicon name="play" />
                  <span>{continueLabel}</span>
                </button>
                {abortTargets.length > 0 && (
                  <button
                    type="button"
                    className="conflicts-abort-btn"
                    onClick={() => void handleAbortClick()}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      height: 30,
                      padding: '0 12px',
                      borderRadius: 3,
                      border: '1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border, #454545))',
                      background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
                      color: 'var(--vscode-button-secondaryForeground, #ffffff)',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    <Codicon name="close" />
                    <span>{abortLabel}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={backToHistory}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 30,
                    padding: '0 12px',
                    borderRadius: 3,
                    border: '1px solid var(--vscode-panel-border, #333)',
                    background: 'transparent',
                    color: 'var(--vscode-foreground)',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  <Codicon name="arrow-left" />
                  <span>{t('Back to history')}</span>
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={backToHistory}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                padding: '0 14px',
                borderRadius: 3,
                border: '1px solid var(--vscode-panel-border, #333)',
                background: 'transparent',
                color: 'var(--vscode-foreground)',
                cursor: 'pointer',
                fontSize: 13,
                marginTop: 4,
              }}
            >
              <Codicon name="arrow-left" />
              <span>{t('Back to history')}</span>
            </button>
          )}
        </div>
      ) : (
        <div className="conflicts-body" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div className="conflicts-table-wrap" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <SpeedSearchIndicator query={speedSearch.query} onClear={speedSearch.clear} />
            <div className="conflicts-table-header" style={{ minHeight: 28, display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--vscode-panel-border)', padding: '4px 10px 4px 12px', fontSize: 12, fontWeight: 600, color: 'var(--vscode-descriptionForeground)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>{t('Name')}</span>
              <span style={{ width: 86, textAlign: 'center', flexShrink: 0 }}>{t('Current')}</span>
              <span style={{ width: 86, textAlign: 'center', flexShrink: 0 }}>{t('Conflict Incoming')}</span>
            </div>
            <div ref={treeScrollerRef} className="conflicts-tree-scroller" style={{ flex: 1, overflow: 'auto', paddingTop: 2 }}>
              {groupByDir
                ? tree.map((node) => (
                    <TreeRowItem
                      key={node.kind === 'dir' ? node.path : fileKey(node.file)}
                      node={node}
                      depth={0}
                      collapsed={collapsed}
                      selectedKeys={selectedKeySet}
                      onToggle={(path) => setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))}
                      onSelect={selectFile}
                      onOpen={openMergeEditor}
                      speedSearchQuery={speedSearch.query}
                    />
                  ))
                : visibleFiles.map((file) => (
                    <FileRowItem
                      key={fileKey(file)}
                      file={file}
                      depth={0}
                      selected={selectedKeySet.has(fileKey(file))}
                      onSelect={selectFile}
                      onOpen={openMergeEditor}
                      speedSearchQuery={speedSearch.query}
                    />
                  ))}
            </div>
          </div>
          {/* 右侧动作按钮栏 */}
          <div className="conflicts-actions-column" style={{ width: 132, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderLeft: '1px solid var(--vscode-panel-border)' }}>
            <button
              type="button"
              disabled={!hasSelection}
              onClick={() => void accept('mine')}
              style={{
                padding: '5px 10px',
                border: '1px solid var(--vscode-button-border, transparent)',
                borderRadius: 3,
                background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
                color: 'var(--vscode-button-secondaryForeground, #ffffff)',
                opacity: !hasSelection ? 0.45 : 1,
                cursor: !hasSelection ? 'default' : 'pointer',
                fontSize: 12,
              }}
            >
              {t('Accept Current')}
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              onClick={() => void accept('theirs')}
              style={{
                padding: '5px 10px',
                border: '1px solid var(--vscode-button-border, transparent)',
                borderRadius: 3,
                background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
                color: 'var(--vscode-button-secondaryForeground, #ffffff)',
                opacity: !hasSelection ? 0.45 : 1,
                cursor: !hasSelection ? 'default' : 'pointer',
                fontSize: 12,
              }}
            >
              {t('Accept Incoming')}
            </button>
            <button
              type="button"
              disabled={!canMergeSelected}
              onClick={() => selectedFiles[0] && openMergeEditor(selectedFiles[0])}
              style={{
                padding: '5px 10px',
                border: '1px solid var(--vscode-button-border, transparent)',
                borderRadius: 3,
                background: canMergeSelected ? 'var(--vscode-button-background, #0e639c)' : 'var(--vscode-button-secondaryBackground, #3a3d41)',
                color: canMergeSelected ? 'var(--vscode-button-foreground, #ffffff)' : 'var(--vscode-button-secondaryForeground, #ffffff)',
                opacity: !canMergeSelected ? 0.45 : 1,
                cursor: !canMergeSelected ? 'default' : 'pointer',
                fontSize: 12,
              }}
            >
              {t('Merge')}...
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TreeRowItem({
  node,
  depth,
  collapsed,
  selectedKeys,
  onToggle,
  onSelect,
  onOpen,
  speedSearchQuery,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  selectedKeys: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (file: ConflictFile, event: React.MouseEvent) => void;
  onOpen: (file: ConflictFile) => void;
  speedSearchQuery?: string;
}) {
  if (node.kind === 'file') {
    return (
      <FileRowItem
        file={node.file}
        depth={depth}
        selected={selectedKeys.has(fileKey(node.file))}
        onSelect={onSelect}
        onOpen={onOpen}
        speedSearchQuery={speedSearchQuery}
      />
    );
  }
  const open = !collapsed[node.path];
  return (
    <div>
      <div
        className="conflicts-dir-row versiondock-conflicts-dir-row"
        style={{
          minHeight: node.isRepoRoot ? 24 : 22,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: node.isRepoRoot ? '3px 10px 3px 0' : '2px 10px 2px 0',
          paddingLeft: 6 + depth * 16,
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: 13,
          color: 'var(--vscode-foreground)',
          minWidth: 0,
          overflow: 'hidden',
        }}
        onClick={() => onToggle(node.path)}
        title={node.name}
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={{ width: 14, height: 14, fontSize: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} />
        {node.isRepoRoot ? (
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: node.repoColor || 'var(--vscode-foreground)', flexShrink: 0 }} />
        ) : (
          <FileIcon name={node.name} folder open={open} />
        )}
        <span
          style={{
            flex: 1,
            fontSize: node.isRepoRoot ? 11 : 13,
            lineHeight: node.isRepoRoot ? '16px' : 'normal',
            fontWeight: node.isRepoRoot ? 700 : 600,
            textTransform: node.isRepoRoot ? 'uppercase' : 'none',
            letterSpacing: node.isRepoRoot ? '0.04em' : 'normal',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          <HighlightedText text={node.isRepoRoot ? node.name.toUpperCase() : node.name} query={speedSearchQuery} />
        </span>
        <span
          style={{
            marginLeft: 'auto',
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 9,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--versiondock-badge-background, var(--vscode-badge-background, #0e639c))',
            color: 'var(--versiondock-badge-foreground, #ffffff)',
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '18px',
            flexShrink: 0,
          }}
        >
          {node.count}
        </span>
      </div>
      {open &&
        node.children.map((child) => (
          <TreeRowItem
            key={child.kind === 'dir' ? child.path : fileKey(child.file)}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            selectedKeys={selectedKeys}
            onToggle={onToggle}
            onSelect={onSelect}
            onOpen={onOpen}
            speedSearchQuery={speedSearchQuery}
          />
        ))}
    </div>
  );
}

function FileRowItem({
  file,
  depth,
  selected,
  onSelect,
  onOpen,
  speedSearchQuery,
}: {
  file: ConflictFile;
  depth: number;
  selected: boolean;
  onSelect: (file: ConflictFile, event: React.MouseEvent) => void;
  onOpen: (file: ConflictFile) => void;
  speedSearchQuery?: string;
}) {
  const { t } = useI18n();
  const fileName = file.path === '.' ? t('Repository root') : file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
  const displayDir = dir ? `${file.repoName}/${dir}` : file.repoName;

  return (
    <div
      className="conflicts-file-row versiondock-conflicts-file-row"
      data-key={fileKey(file)}
      data-selected={selected ? 'true' : 'false'}
      style={{
        minHeight: 22,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 10px 2px 0',
        paddingLeft: 6 + depth * 16,
        cursor: 'pointer',
        background: selected ? 'var(--vscode-list-activeSelectionBackground, var(--versiondock-selection-background))' : 'transparent',
        color: selected ? 'var(--vscode-list-activeSelectionForeground, var(--versiondock-selection-foreground))' : 'var(--vscode-foreground)',
        fontSize: 13,
        userSelect: 'none',
      }}
      onClick={(e) => onSelect(file, e)}
      onDoubleClick={() => onOpen(file)}
      title={`${file.repoName}/${file.path}`}
    >
      <span style={{ width: 14, height: 14, flexShrink: 0 }} />
      <FileIcon name={fileName} />
      <span style={{ color: changeStatusColor('conflicted'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 }}>
        <HighlightedText text={fileName} query={speedSearchQuery} />
      </span>
      {hasNonTextConflict(file) && (
        <span
          style={{
            color: 'var(--vscode-descriptionForeground)',
            fontSize: 11,
            whiteSpace: 'nowrap',
            flexShrink: 0,
            padding: '0 4px',
          }}
        >
          {conflictTypeLabel(file, t)}
        </span>
      )}
      {depth === 0 && (
        <span style={{ marginLeft: 8, color: 'var(--vscode-descriptionForeground)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: '45%' }}>
          <HighlightedText text={displayDir} query={speedSearchQuery} />
        </span>
      )}
      <StatusCell status={file.currentStatus} first />
      <StatusCell status={file.incomingStatus} />
    </div>
  );
}

function StatusCell({ status, first }: { status?: string | null; first?: boolean }) {
  const { t } = useI18n();
  const label = status === 'added' ? t('Conflict Added') : status === 'deleted' ? t('Conflict Deleted') : t('Conflict Modified');
  const color = changeStatusColor(status ?? 'conflicted');

  return (
    <span
      style={{
        marginLeft: first ? 'auto' : 0,
        width: 86,
        textAlign: 'center',
        color,
        fontSize: 11,
        fontWeight: 600,
        padding: '0 4px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}
