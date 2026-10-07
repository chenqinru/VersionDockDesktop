import { IconButton } from './IconButton';
import { RepositoryBranchBadge } from './RepositoryBranchBadge';
import React, { useMemo, useState } from 'react';
import { ChangelistGroup, type ChangelistRepoGroup, type ExpansionCommand } from './ChangelistGroup';
import { hasSearchMatch, useChangeSearch } from './changeSearch';
import { BranchMenuPopover } from './StatusBar/BranchMenuPopover';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import type { FileChange, RepositoryStatus, ChangelistEntry } from '../bindings/generated';

interface ChangelistViewProps {
  repos: RepositoryStatus[];
  changelists: Record<string, ChangelistEntry[]>;
  selected: Set<string>;
  setFiles: (repoId: string, paths: string[], value: boolean) => void;
  onFile: (repoId: string, file: FileChange) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus) => void;
  onRepoContext: (event: React.MouseEvent, repo: RepositoryStatus, changelistId?: string) => void;
  onHeaderContextMenu: (event: React.MouseEvent, changelistId: string) => void;
  onEmptyContextMenu: (event: React.MouseEvent) => void;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  openWorkingChanges: (repoId: string) => void;
  onManageRepo?: (repoId: string) => void;
}

export function ChangelistView({
  repos,
  changelists,
  selected,
  setFiles,
  onFile,
  onContext,
  onFolderContext,
  onRepoContext,
  onHeaderContextMenu,
  onEmptyContextMenu,
  viewMode,
  expansion,
  openWorkingChanges,
  onManageRepo,
}: ChangelistViewProps) {
  const { t } = useI18n();
  const loadErrors = useAppStore((state) => state.loadErrors);
  const loadChangelists = useAppStore((state) => state.loadChangelists);
  const [branchMenuAnchor, setBranchMenuAnchor] = useState<DOMRect | undefined>(undefined);
  const singleRepo = repos.length === 1;
  const multiRepo = repos.length > 1;
  const singleRepoStatus = singleRepo ? repos[0] : null;

  const changelistErrors = useMemo(() => {
    const list: Array<{ repoId: string; repoName: string; error: string }> = [];
    for (const repo of repos) {
      const err = loadErrors[`changelists:${repo.meta.id}`];
      if (err) {
        list.push({ repoId: repo.meta.id, repoName: repo.meta.name, error: err });
      }
    }
    return list;
  }, [loadErrors, repos]);

  // 1. Collect all custom changelists across all repositories
  const customLists = useMemo(() => {
    const listMap = new Map<string, { id: string; name: string }>();
    for (const repo of repos) {
      const entries = changelists[repo.meta.id] ?? [];
      for (const entry of entries) {
        if (!listMap.has(entry.id)) {
          listMap.set(entry.id, {
            id: entry.id,
            name: entry.name,
          });
        }
      }
    }
    return Array.from(listMap.values());
  }, [repos, changelists]);

  // 2. Compute file groups for Default Changelist
  const defaultRepoGroups = useMemo<ChangelistRepoGroup[]>(() => {
    const reposInOtherChangelists = new Set<string>();
    for (const cl of customLists) {
      for (const repo of repos) {
        const entries = changelists[repo.meta.id] ?? [];
        const entry = entries.find((e) => e.id === cl.id);
        if (entry && entry.files.some((p) => repo.files.some((f) => f.path === p && f.status !== 'untracked'))) {
          reposInOtherChangelists.add(repo.meta.id);
        }
      }
    }
    for (const repo of repos) {
      if (repo.files.some((f) => f.status === 'untracked') || (loadErrors[`changelists:${repo.meta.id}`] && changelists[repo.meta.id] === undefined)) {
        reposInOtherChangelists.add(repo.meta.id);
      }
    }

    return repos
      .map((repo) => {
        const hasError = Boolean(loadErrors[`changelists:${repo.meta.id}`]);
        const entries = changelists[repo.meta.id];
        if (hasError && entries === undefined) {
          return { repo, files: [] };
        }
        const assigned = new Set((entries ?? []).flatMap((e) => e.files));
        const files = repo.files.filter((f) => !assigned.has(f.path) && f.status !== 'untracked');
        return { repo, files };
      })
      .filter((g) => {
        if (singleRepo) return true;
        if (g.files.length > 0) return true;
        return !reposInOtherChangelists.has(g.repo.meta.id);
      });
  }, [repos, changelists, customLists, singleRepo, loadErrors]);

  // 3. Compute file groups for each custom Changelist
  const customGroups = useMemo(() => {
    return customLists.map((cl) => {
      const repoGroups: ChangelistRepoGroup[] = repos
        .map((repo) => {
          const entries = changelists[repo.meta.id] ?? [];
          const entry = entries.find((e) => e.id === cl.id);
          const assignedFiles = entry ? new Set(entry.files) : new Set<string>();
          const files = repo.files.filter((f) => assignedFiles.has(f.path) && f.status !== 'untracked');
          return { repo, files };
        })
        .filter((g) => g.files.length > 0 || (singleRepo && customLists.length === 1));
      return { ...cl, repoGroups };
    });
  }, [customLists, repos, changelists, singleRepo]);

  // 4. Compute file groups for Unversioned Files
  const unversionedRepoGroups = useMemo<ChangelistRepoGroup[]>(() => {
    return repos
      .map((repo) => {
        const files = repo.files.filter((f) => f.status === 'untracked');
        return { repo, files };
      })
      .filter((g) => g.files.length > 0);
  }, [repos]);

  const totalUnversionedFiles = unversionedRepoGroups.reduce((sum, g) => sum + g.files.length, 0);

  const [repoExpansion, setRepoExpansion] = useState({ sequence: expansion.sequence, expanded: true });
  const search = useChangeSearch();
  const repoExpanded = repos.some(repo => hasSearchMatch(search, repo.meta.id, repo.files)) || (repoExpansion.sequence === expansion.sequence ? repoExpansion.expanded : expansion.expanded);

  return (
    <div
      className="changelists-view-container"
      style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          onEmptyContextMenu(e);
        }
      }}
    >
      {/* Single Repository Header */}
      {singleRepoStatus && (
        <div
          className="repo-heading single-repo-header"
          style={{
            '--repo-color': singleRepoStatus.meta.color,
            background: `color-mix(in srgb, ${singleRepoStatus.meta.color} 14%, var(--versiondock-surface))`,
            height: 26,
            padding: '0 8px 0 6px',
            cursor: 'pointer',
          } as React.CSSProperties}
          onClick={(event) => { if (!(event.target as HTMLElement).closest('button, input, label')) setRepoExpansion({ sequence: expansion.sequence, expanded: !repoExpanded }); }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRepoContext(e, singleRepoStatus);
          }}
        >
          <div className="repo-heading-main" style={{ gap: 6 }}>
            <button type="button" className="repo-heading-toggle" title={singleRepoStatus.meta.name} aria-expanded={repoExpanded} onClick={() => setRepoExpansion({ sequence: expansion.sequence, expanded: !repoExpanded })}>
              <Codicon name={repoExpanded ? 'chevron-down' : 'chevron-right'} />
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: singleRepoStatus.meta.color,
                flexShrink: 0,
              }}
            />
            <strong
              style={{
                fontSize: 11,
                fontWeight: 'bold',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {singleRepoStatus.meta.name}
            </strong>
            </button>
            {singleRepoStatus.meta.isSubmodule && (
              <span className="submodule-badge" title={t('Submodule')}>
                {t('SUB')}
              </span>
            )}
            <button
              type="button"
              className="repo-branch-trigger"
              data-branch-switch-badge=""
              title={t('Switch branch')}
              aria-haspopup="menu"
              aria-expanded={Boolean(branchMenuAnchor)}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setBranchMenuAnchor((cur) => (cur ? undefined : rect));
              }}
            >
              <RepositoryBranchBadge repo={singleRepoStatus} className="branch-chip" />
            </button>
          </div>
          {onManageRepo && <div className="repo-actions"><IconButton type="button" title={t('Git Identity')} onClick={(event) => { event.stopPropagation(); onManageRepo(singleRepoStatus.meta.id); }}><Codicon name="account" /></IconButton></div>}
          {branchMenuAnchor && (
            <BranchMenuPopover
              anchorRect={branchMenuAnchor}
              initialRepoId={singleRepoStatus.meta.id}
              repoOnly
              onClose={() => setBranchMenuAnchor(undefined)}
            />
          )}
        </div>
      )}

      <div hidden={singleRepo && !repoExpanded} style={{ display: singleRepo && !repoExpanded ? 'none' : 'flex', flexDirection: 'column', flex: 1 }}>
      {changelistErrors.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 12px', background: 'var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1))', color: 'var(--vscode-errorForeground, #f48771)', fontSize: 12 }}>
          {changelistErrors.map((item) => (
            <div key={item.repoId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Codicon name="error" />
              <span style={{ flex: 1 }}>{item.repoName}: {item.error}</span>
              <button
                type="button"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textDecoration: 'underline' }}
                onClick={() => void loadChangelists(item.repoId)}
              >
                {t('Retry')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Default Changelist */}
      <ChangelistGroup
        id="default"
        name={t('Default Changelist')}
        isDefault
        repoGroups={defaultRepoGroups}
        multiRepo={multiRepo}
        singleRepo={singleRepo}
        selected={selected}
        setFiles={setFiles}
        onFile={onFile}
        onContext={onContext}
        onFolderContext={onFolderContext}
        onRepoContext={onRepoContext}
        onHeaderContextMenu={onHeaderContextMenu}
        viewMode={viewMode}
        expansion={expansion}
        openWorkingChanges={openWorkingChanges}
      />

      {/* Custom Changelists */}
      {customGroups.map((cl) => (
        <ChangelistGroup
          key={cl.id}
          id={cl.id}
          name={cl.name}
          repoGroups={cl.repoGroups}
          multiRepo={multiRepo}
          singleRepo={singleRepo}
          selected={selected}
          setFiles={setFiles}
          onFile={onFile}
          onContext={onContext}
          onFolderContext={onFolderContext}
          onRepoContext={onRepoContext}
          onHeaderContextMenu={onHeaderContextMenu}
          viewMode={viewMode}
          expansion={expansion}
          openWorkingChanges={openWorkingChanges}
        />
      ))}

      {/* Unversioned Files (Shown only if there are untracked files) */}
      {totalUnversionedFiles > 0 && (
        <ChangelistGroup
          id="unversioned"
          name={t('Unversioned Files')}
          isUnversioned
          repoGroups={unversionedRepoGroups}
          multiRepo={multiRepo}
          singleRepo={singleRepo}
          selected={selected}
          setFiles={setFiles}
          onFile={onFile}
          onContext={onContext}
          onFolderContext={onFolderContext}
          onRepoContext={onRepoContext}
          onHeaderContextMenu={onHeaderContextMenu}
          viewMode={viewMode}
          expansion={expansion}
          openWorkingChanges={openWorkingChanges}
        />
      )}

      {/* Empty space at the bottom to capture right-click for creating new changelist */}
      <div
        style={{ flex: 1, minHeight: 48 }}
        onContextMenu={(e) => {
          e.preventDefault();
          onEmptyContextMenu(e);
        }}
      />
      </div>
    </div>
  );
}
