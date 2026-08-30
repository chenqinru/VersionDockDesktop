import React, { useMemo } from 'react';
import { ChangelistGroup, type ChangelistRepoGroup, type ExpansionCommand } from './ChangelistGroup';
import { Codicon } from './Codicon';
import { branchColor } from './branchColor';
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
  const singleRepo = repos.length === 1;
  const multiRepo = repos.length > 1;
  const singleRepoStatus = singleRepo ? repos[0] : null;

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
      if (repo.files.some((f) => f.status === 'untracked')) {
        reposInOtherChangelists.add(repo.meta.id);
      }
    }

    return repos
      .map((repo) => {
        const entries = changelists[repo.meta.id] ?? [];
        const assigned = new Set(entries.flatMap((e) => e.files));
        const files = repo.files.filter((f) => !assigned.has(f.path) && f.status !== 'untracked');
        return { repo, files };
      })
      .filter((g) => {
        if (singleRepo) return true;
        if (g.files.length > 0) return true;
        return !reposInOtherChangelists.has(g.repo.meta.id);
      });
  }, [repos, changelists, customLists, singleRepo]);

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

  const branch = singleRepoStatus ? branchColor(singleRepoStatus.branch || singleRepoStatus.revision) : '';

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
            background: `color-mix(in srgb, ${singleRepoStatus.meta.color} 14%, var(--versiondock-surface))`,
            height: 26,
            padding: '0 8px 0 6px',
            cursor: 'pointer',
          }}
          onClick={() => onManageRepo?.(singleRepoStatus.meta.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRepoContext(e, singleRepoStatus);
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
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
            <span
              className="branch-chip"
              title={singleRepoStatus.branch || singleRepoStatus.revision}
              style={{ color: branch, background: `${branch}33`, borderColor: `${branch}88` }}
            >
              <Codicon name="git-branch" />
              <span className="branch-name">{singleRepoStatus.branch || singleRepoStatus.revision}</span>
            </span>
          </div>
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
  );
}
