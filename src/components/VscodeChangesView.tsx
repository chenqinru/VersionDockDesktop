import { changeStatus } from '../theme/changeStatus';
import { IconButton } from './IconButton';
import { changeSearchKey, hasSearchMatch, useChangeSearch } from './changeSearch';
import { ChangeSearchText } from './ChangeSearchText';
import { useChangeRowHighlight } from './changeRowHighlight';
import React, { useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { FileIcon } from './FileIcon';
import { branchColor } from './branchColor';
import { BranchRefBadge } from './BranchRefBadge';
import { BranchMenuPopover } from './StatusBar/BranchMenuPopover';
import { useI18n } from '../i18n';
import { buildFileTree, type FileTreeNode } from './fileTree';
import type { FileChange, RepositoryStatus } from '../bindings/generated';
import { StatusMark, type ExpansionCommand } from './ChangelistGroup';
import { hasMixedRepositoryKinds } from './repoLabel';


interface VscodeChangesViewProps {
  repos: RepositoryStatus[];
  selected?: Set<string>;
  setFiles?: (repoId: string, paths: string[], value: boolean) => void;
  onFile: (repoId: string, file: FileChange, staged: boolean) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus, staged: boolean) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus, staged: boolean) => void;
  onRepoContext: (event: React.MouseEvent, repo: RepositoryStatus, staged: boolean) => void;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  openWorkingChanges: (repoId: string, section?: 'staged' | 'unstaged') => void;
  onStage: (repoId: string, paths: string[]) => void;
  onUnstage: (repoId: string, paths: string[]) => void;
  onDiscard: (repoId: string, paths: string[]) => void;
  selectedRepos?: Set<string>;
  onToggleRepoSelection?: (repoId: string) => void;
}

interface VscodeFileRowProps {
  repo: RepositoryStatus;
  file: FileChange;
  depth: number;
  staged: boolean;
  viewMode: 'tree' | 'list';
  onFile: (repoId: string, file: FileChange, staged: boolean) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus, staged: boolean) => void;
  onStage: (repoId: string, paths: string[]) => void;
  onUnstage: (repoId: string, paths: string[]) => void;
  onDiscard: (repoId: string, paths: string[]) => void;
}

function VscodeFileRow({
  repo,
  file,
  depth,
  staged,
  viewMode,
  onFile,
  onContext,
  onStage,
  onUnstage,
  onDiscard,
}: VscodeFileRowProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const parts = file.path.split('/');
  const fileName = parts.at(-1) ?? file.path;
  const dirPath = parts.slice(0, -1).join('/');
  const isSvn = repo.meta.kind === 'svn';
  const highlight = useChangeRowHighlight(repo.meta.id, file.path, staged);
  const canAddToSvn = isSvn && !staged && file.status === 'untracked';

  return (
    <div
      data-change-search-key={changeSearchKey(repo.meta.id, file.path, staged)}
      className={`file-item status-${changeStatus(file.status, file.conflicted)} ${highlight}`}
      style={{
        paddingLeft: viewMode === 'tree' ? 14 + depth * 14 : 14,
        display: 'flex',
        alignItems: 'center',
        height: 22,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onFile(repo.meta.id, file, staged)}
      onContextMenu={(e) => onContext(e, file, repo, staged)}
    >
      <FileIcon name={fileName} />
      <span className="file-name" style={{ marginLeft: 6, fontSize: 12 }}>
        <ChangeSearchText text={fileName} />
      </span>
      {viewMode === 'list' && dirPath && (
        <span className="file-dir" style={{ marginLeft: 6, fontSize: 11, opacity: 0.5 }}>
          <ChangeSearchText text={dirPath} />
        </span>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
        {hovered && (
          <div className="file-actions" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {!isSvn && (staged ? (
              <IconButton
                type="button"
                className="file-action-btn"
                title={t('Unstage Changes')}
                onClick={(e) => {
                  e.stopPropagation();
                  onUnstage(repo.meta.id, [file.path]);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                  opacity: 0.8,
                }}
              >
                <Codicon name="remove" style={{ fontSize: 12 }} />
              </IconButton>
            ) : (
              <IconButton
                type="button"
                className="file-action-btn"
                title={t('Stage Changes')}
                onClick={(e) => {
                  e.stopPropagation();
                  onStage(repo.meta.id, [file.path]);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                  opacity: 0.8,
                }}
              >
                <Codicon name="add" style={{ fontSize: 12 }} />
              </IconButton>
            ))}
            {canAddToSvn && (
              <IconButton
                type="button"
                className="file-action-btn"
                title={file.isTruncated ? t('Add directory recursively to SVN') : t('Add to SVN')}
                onClick={(e) => {
                  e.stopPropagation();
                  onStage(repo.meta.id, [file.path]);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                  opacity: 0.8,
                }}
              >
                <Codicon name="add" style={{ fontSize: 12 }} />
              </IconButton>
            )}
            {!staged && !file.isTruncated && (
              <IconButton
                type="button"
                className="file-action-btn"
                title={t('Discard Changes')}
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard(repo.meta.id, [file.path]);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                  opacity: 0.8,
                }}
              >
                <Codicon name="discard" style={{ fontSize: 12 }} />
              </IconButton>
            )}
          </div>
        )}
        <StatusMark file={file} />
      </div>
    </div>
  );
}

function VscodeTreeFolderRow({
  node,
  depth,
  expanded,
  onToggle,
  onFolderContext,
  repo,
  staged,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus, staged: boolean) => void;
  repo: RepositoryStatus;
  staged: boolean;
}) {
  return (
    <div
      className="folder-item"
      style={{
        paddingLeft: 14 + depth * 14,
        display: 'flex',
        alignItems: 'center',
        height: 22,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onClick={onToggle}
      onContextMenu={(e) => onFolderContext(e, node.path, node.files, repo, staged)}
    >
      <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: 11, marginRight: 4 }} />
      <FileIcon name={node.name} folder open={expanded} />
      <span style={{ marginLeft: 6, fontSize: 12 }}><ChangeSearchText text={node.name} /></span>
    </div>
  );
}

function VscodeFolderNode({
  node,
  depth,
  staged,
  repo,
  viewMode,
  expansion,
  onFile,
  onContext,
  onFolderContext,
  onStage,
  onUnstage,
  onDiscard,
}: {
  node: FileTreeNode;
  depth: number;
  staged: boolean;
  repo: RepositoryStatus;
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  onFile: (repoId: string, file: FileChange, staged: boolean) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus, staged: boolean) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus, staged: boolean) => void;
  onStage: (repoId: string, paths: string[]) => void;
  onUnstage: (repoId: string, paths: string[]) => void;
  onDiscard: (repoId: string, paths: string[]) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const search = useChangeSearch();
  const isExpanded = hasSearchMatch(search, repo.meta.id, node.files, staged) || (localExpanded.sequence === expansion.sequence ? localExpanded.expanded : expansion.expanded);

  if (node.file) {
    return (
      <VscodeFileRow
        repo={repo}
        file={node.file}
        depth={depth}
        staged={staged}
        viewMode={viewMode}
        onFile={onFile}
        onContext={onContext}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
      />
    );
  }

  return (
    <>
      <VscodeTreeFolderRow
        node={node}
        depth={depth}
        expanded={isExpanded}
        onToggle={() => setLocalExpanded({ sequence: expansion.sequence, expanded: !isExpanded })}
        onFolderContext={onFolderContext}
        repo={repo}
        staged={staged}
      />
      {isExpanded &&
        node.children.map((child) => (
          <VscodeFolderNode
            key={child.path}
            node={child}
            depth={depth + 1}
            staged={staged}
            repo={repo}
            viewMode={viewMode}
            expansion={expansion}
            onFile={onFile}
            onContext={onContext}
            onFolderContext={onFolderContext}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
          />
        ))}
    </>
  );
}

function SingleRepoHeader({
  expanded,
  onToggle,
  repo,
  onRepoContext,
  showVcsBadge,
}: {
  expanded: boolean;
  onToggle: () => void;
  repo: RepositoryStatus;
  onRepoContext: (event: React.MouseEvent, repo: RepositoryStatus, staged: boolean) => void;
  showVcsBadge?: boolean;
}) {
  const { t } = useI18n();
  const [branchMenuAnchor, setBranchMenuAnchor] = useState<DOMRect | undefined>(undefined);
  const branchClr = branchColor(repo.branch || repo.revision);

  return (
    <div
      className="repo-heading vscode-single-repo-header"
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, input, label')) onToggle(); }}
      style={{
        '--repo-color': repo.meta.color,
        padding: '0 8px 0 14px',
        height: 28,
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))',
        background: 'var(--vscode-sideBarSectionHeader-background, rgba(255, 255, 255, 0.04))',
      } as React.CSSProperties}
      onContextMenu={(e) => onRepoContext(e, repo, false)}
    >
      <div className="repo-heading-main" style={{ gap: 6 }}>
        <button type="button" className="repo-heading-toggle" title={repo.meta.name} aria-expanded={expanded} onClick={onToggle}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
        <i style={{ background: repo.meta.color, width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }} />
        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
          {repo.meta.name}
        </strong>
        </button>
        {repo.meta.isSubmodule && (
          <span className="submodule-badge" title={t('Submodule')}>
            {t('SUB')}
          </span>
        )}
        {showVcsBadge && (
          <span
            className={`vcs-badge ${repo.meta.kind === 'svn' ? 'svn' : 'git'}`}
            title={repo.meta.kind === 'svn' ? t('SVN working copy') : 'Git'}
          >
            {repo.meta.kind === 'svn' ? 'SVN' : 'GIT'}
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
          <BranchRefBadge
            label={repo.branch || repo.revision}
            kind={repo.meta.isWorktree ? 'worktree' : 'branch'}
            color={branchClr}
            className="branch-chip"
          />
        </button>
      </div>
      {branchMenuAnchor && (
        <BranchMenuPopover
          anchorRect={branchMenuAnchor}
          initialRepoId={repo.meta.id}
          repoOnly
          onClose={() => setBranchMenuAnchor(undefined)}
        />
      )}
    </div>
  );
}

function VscodeRepoSection({
  repo,
  staged,
  files,
  viewMode,
  expansion,
  onFile,
  onContext,
  onFolderContext,
  onRepoContext,
  openWorkingChanges,
  onStage,
  onUnstage,
  onDiscard,
  singleRepo,
  repoSelected,
  onToggleRepoSelection,
  showVcsBadge,
}: {
  repo: RepositoryStatus;
  staged: boolean;
  files: FileChange[];
  viewMode: 'tree' | 'list';
  expansion: ExpansionCommand;
  onFile: (repoId: string, file: FileChange, staged: boolean) => void;
  onContext: (event: React.MouseEvent, file: FileChange, repo: RepositoryStatus, staged: boolean) => void;
  onFolderContext: (event: React.MouseEvent, folderPath: string, files: FileChange[], repo: RepositoryStatus, staged: boolean) => void;
  onRepoContext: (event: React.MouseEvent, repo: RepositoryStatus, staged: boolean) => void;
  openWorkingChanges: (repoId: string, section?: 'staged' | 'unstaged') => void;
  onStage: (repoId: string, paths: string[]) => void;
  onUnstage: (repoId: string, paths: string[]) => void;
  onDiscard: (repoId: string, paths: string[]) => void;
  singleRepo?: boolean;
  repoSelected?: boolean;
  onToggleRepoSelection?: () => void;
  showVcsBadge?: boolean;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [localExpanded, setLocalExpanded] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const [branchMenuAnchor, setBranchMenuAnchor] = useState<DOMRect | undefined>(undefined);
  const search = useChangeSearch();
  const expanded = hasSearchMatch(search, repo.meta.id, files, staged) || (localExpanded.sequence === expansion.sequence ? localExpanded.expanded : expansion.expanded);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const branchClr = branchColor(repo.branch || repo.revision);
  const isSvn = repo.meta.kind === 'svn';

  const canAddToSvn = isSvn && !staged && files.some((f) => f.status === 'untracked' && !f.isTruncated);

  const renderFiles = () => (
    <div className="repo-files" style={singleRepo ? { paddingLeft: 0 } : undefined}>
      {viewMode === 'tree'
        ? tree.map((child) => (
            <VscodeFolderNode
              key={child.path}
              node={child}
              depth={0}
              staged={staged}
              repo={repo}
              viewMode={viewMode}
              expansion={expansion}
              onFile={onFile}
              onContext={onContext}
              onFolderContext={onFolderContext}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))
        : files.map((file) => (
            <VscodeFileRow
              key={file.path}
              repo={repo}
              file={file}
              depth={0}
              staged={staged}
              viewMode={viewMode}
              onFile={onFile}
              onContext={onContext}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))}
    </div>
  );

  if (singleRepo) {
    return (
      <div className="repo-sub-group" style={{ margin: 0 }}>
        {renderFiles()}
      </div>
    );
  }

  return (
    <div className="repo-sub-group" style={{ margin: 0 }}>
      <div
        className="repo-heading"
        style={{
          '--repo-color': repo.meta.color,
          paddingLeft: 14,
        } as React.CSSProperties}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(event) => { if (!(event.target as HTMLElement).closest('button, input, label')) setLocalExpanded({ sequence: expansion.sequence, expanded: !expanded }); }}
        onContextMenu={(e) => onRepoContext(e, repo, staged)}
      >
        {(staged || repo.meta.kind === 'svn') && onToggleRepoSelection && (
          <input
            type="checkbox"
            checked={files.length === 0 ? false : (repoSelected ?? true)}
            disabled={files.length === 0}
            title={files.length === 0 ? undefined : t('Include this repository in the commit')}
            onChange={(e) => {
              if (files.length > 0) {
                e.stopPropagation();
                onToggleRepoSelection();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              margin: '0 6px 0 0',
              flexShrink: 0,
              cursor: files.length === 0 ? 'default' : 'pointer',
            }}
          />
        )}
        <div className="repo-heading-main">
          <button
            type="button"
            className="repo-heading-toggle"
            title={repo.meta.name}
            aria-expanded={expanded}
            onClick={() => setLocalExpanded({ sequence: expansion.sequence, expanded: !expanded })}
          >
            <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
            <i style={{ background: repo.meta.color }} />
            <strong>{repo.meta.name}</strong>
          </button>
          {repo.meta.isSubmodule && (
            <span className="submodule-badge" title={t('Submodule')}>
              {t('SUB')}
            </span>
          )}
          {showVcsBadge && (
            <span
              className={`vcs-badge ${repo.meta.kind === 'svn' ? 'svn' : 'git'}`}
              title={repo.meta.kind === 'svn' ? t('SVN working copy') : 'Git'}
            >
              {repo.meta.kind === 'svn' ? 'SVN' : 'GIT'}
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
            <BranchRefBadge
              label={repo.branch || repo.revision}
              kind={repo.meta.isWorktree ? 'worktree' : 'branch'}
              color={branchClr}
              className="branch-chip"
            />
          </button>
        </div>
        {branchMenuAnchor && (
          <BranchMenuPopover
            anchorRect={branchMenuAnchor}
            initialRepoId={repo.meta.id}
            repoOnly
            onClose={() => setBranchMenuAnchor(undefined)}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', flexShrink: 0 }}>
          {hovered && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <IconButton
                type="button"
                title={staged ? t('Open Staged Changes') : t('Open Changes')}
                onClick={(e) => {
                  e.stopPropagation();
                  openWorkingChanges(repo.meta.id, staged ? 'staged' : 'unstaged');
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                }}
              >
                <Codicon name="diff-multiple" />
              </IconButton>
              {!isSvn && (staged ? (
                <IconButton
                  type="button"
                  title={t('Unstage all in repository')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnstage(repo.meta.id, files.map((f) => f.path));
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'inherit',
                  }}
                >
                  <Codicon name="remove" />
                </IconButton>
              ) : (
                <IconButton
                  type="button"
                  title={t('Stage all in repository')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStage(repo.meta.id, files.map((f) => f.path));
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'inherit',
                  }}
                >
                  <Codicon name="add" />
                </IconButton>
              ))}
              {canAddToSvn && (
                <IconButton
                  type="button"
                  title={t('Add to SVN')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStage(repo.meta.id, files.filter((f) => f.status === 'untracked' && !f.isTruncated).map((f) => f.path));
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'inherit',
                  }}
                >
                  <Codicon name="add" />
                </IconButton>
              )}
              {!staged && (
                <IconButton
                  type="button"
                  title={t('Rollback All')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDiscard(repo.meta.id, files.map((f) => f.path));
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'inherit',
                  }}
                >
                  <Codicon name="discard" />
                </IconButton>
              )}
            </div>
          )}
          <span className="count-badge">{files.length}</span>
        </div>
      </div>
      {expanded && renderFiles()}
    </div>
  );
}

export function VscodeChangesView({
  repos,
  onFile,
  onContext,
  onFolderContext,
  onRepoContext,
  viewMode,
  expansion,
  openWorkingChanges,
  onStage,
  onUnstage,
  onDiscard,
  selectedRepos,
  onToggleRepoSelection,
}: VscodeChangesViewProps) {
  const { t } = useI18n();
  const [stagedExpanded, setStagedExpanded] = useState(true);
  const [unstagedExpanded, setUnstagedExpanded] = useState(true);
  const [stagedHovered, setStagedHovered] = useState(false);
  const [unstagedHovered, setUnstagedHovered] = useState(false);

  const search = useChangeSearch();

  const stagedRepos = useMemo(() => {
    return repos
      .map((r) => {
        const files = r.files.filter((f) => f.staged);
        return { repo: r, files };
      })
      .filter((g) => g.files.length > 0);
  }, [repos]);

  const unstagedRepos = useMemo(() => {
    return repos
      .map((r) => {
        const files = r.files.filter(
          (f) => f.unstaged || f.status === 'untracked' || r.meta.kind === 'svn',
        );
        return { repo: r, files };
      })
      .filter((g) => g.files.length > 0);
  }, [repos]);

  const totalStaged = stagedRepos.reduce((sum, g) => sum + g.files.length, 0);
  const totalUnstaged = unstagedRepos.reduce((sum, g) => sum + g.files.length, 0);
  const gitRepos = repos.filter((r) => r.meta.kind === 'git');
  const allReposAreSvn = repos.length > 0 && gitRepos.length === 0;
  const showStagedSection = !allReposAreSvn || totalStaged > 0;
  const showVcsBadges = hasMixedRepositoryKinds(repos);
  const hasSvnUntracked = unstagedRepos.some((g) => g.repo.meta.kind === 'svn' && g.files.some((f) => f.status === 'untracked' && !f.isTruncated));
  const canStageAll = allReposAreSvn ? hasSvnUntracked : totalUnstaged > 0;
  const stageAllTitle = allReposAreSvn ? t('Add to SVN') : t('Stage All');
  const [repoExpansion, setRepoExpansion] = useState({ sequence: expansion.sequence, expanded: true });
  const repoExpanded = repos.some(repo => hasSearchMatch(search, repo.meta.id, repo.files, true) || hasSearchMatch(search, repo.meta.id, repo.files, false)) || (repoExpansion.sequence === expansion.sequence ? repoExpansion.expanded : expansion.expanded);
  const showStaged = stagedExpanded || stagedRepos.some(group => hasSearchMatch(search, group.repo.meta.id, group.files, true));
  const showUnstaged = unstagedExpanded || unstagedRepos.some(group => hasSearchMatch(search, group.repo.meta.id, group.files, false));
  const isSingleRepo = repos.length === 1;
  const singleRepo = isSingleRepo ? repos[0] : undefined;

  const handleUnstageAll = () => {
    for (const g of stagedRepos) {
      if (g.repo.meta.kind === 'git') {
        onUnstage(g.repo.meta.id, g.files.map((f) => f.path));
      }
    }
  };

  const handleStageAll = () => {
    for (const g of unstagedRepos) {
      if (g.repo.meta.kind === 'git') {
        onStage(g.repo.meta.id, g.files.map((f) => f.path));
      } else if (g.repo.meta.kind === 'svn') {
        const untracked = g.files.filter((f) => f.status === 'untracked' && !f.isTruncated);
        if (untracked.length > 0) {
          onStage(g.repo.meta.id, untracked.map((f) => f.path));
        }
      }
    }
  };

  const handleRollbackAll = () => {
    for (const g of unstagedRepos) {
      const paths = g.files.map((f) => f.path);
      if (paths.length > 0) {
        onDiscard(g.repo.meta.id, paths);
      }
    }
  };

  return (
    <div className="vscode-changes-view" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* ── Single Repo Header ── */}
      {isSingleRepo && singleRepo && (
        <SingleRepoHeader
          expanded={repoExpanded}
          onToggle={() => setRepoExpansion({ sequence: expansion.sequence, expanded: !repoExpanded })}
          repo={singleRepo}
          onRepoContext={onRepoContext}
          showVcsBadge={showVcsBadges}
        />
      )}

      <div hidden={isSingleRepo && !repoExpanded} style={{ display: isSingleRepo && !repoExpanded ? 'none' : 'contents' }}>
      {/* ── Staged Changes Section ── */}
      {showStagedSection && (
        <div className="vscode-section" style={{ borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))' }}>
          <div
            className="vscode-section-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 24,
              padding: '0 8px',
              background: 'var(--vscode-sideBarSectionHeader-background, rgba(255, 255, 255, 0.04))',
              cursor: 'pointer',
              userSelect: 'none',
            }}
            onMouseEnter={() => setStagedHovered(true)}
            onMouseLeave={() => setStagedHovered(false)}
            onClick={() => setStagedExpanded(!stagedExpanded)}
          >
            <Codicon name={showStaged ? 'chevron-down' : 'chevron-right'} style={{ fontSize: 11, marginRight: 6 }} />
            <Codicon name="git-commit" style={{ fontSize: 13, marginRight: 6, opacity: 0.8 }} />
            <span style={{ fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('Staged Changes')}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
              {stagedHovered && isSingleRepo && singleRepo && totalStaged > 0 && (
                <IconButton
                  type="button"
                  title={t('Open Staged Changes')}
                  onClick={(e) => {
                    e.stopPropagation();
                    openWorkingChanges(singleRepo.meta.id, 'staged');
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'inherit',
                  }}
                >
                  <Codicon name="diff-multiple" />
                </IconButton>
              )}
              {stagedHovered && totalStaged > 0 && (
                <IconButton
                  type="button"
                  title={t('Unstage All')}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUnstageAll();
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'inherit',
                  }}
                >
                  <Codicon name="remove" />
                </IconButton>
              )}
              <span className="count-badge">{totalStaged}</span>
            </div>
          </div>
          {showStaged && (
            <div className="vscode-section-body">
              {stagedRepos.length === 0 ? (
                <div style={{ padding: '6px 16px', fontSize: 12, opacity: 0.5 }}>{t('No staged changes')}</div>
              ) : (
                stagedRepos.map((g) => (
                  <VscodeRepoSection
                    key={g.repo.meta.id}
                    repo={g.repo}
                    staged={true}
                    files={g.files}
                    viewMode={viewMode}
                    expansion={expansion}
                    onFile={onFile}
                    onContext={onContext}
                    onFolderContext={onFolderContext}
                    onRepoContext={onRepoContext}
                    openWorkingChanges={openWorkingChanges}
                    onStage={onStage}
                    onUnstage={onUnstage}
                    onDiscard={onDiscard}
                    singleRepo={isSingleRepo}
                    repoSelected={selectedRepos ? selectedRepos.has(g.repo.meta.id) : true}
                    onToggleRepoSelection={onToggleRepoSelection ? () => onToggleRepoSelection(g.repo.meta.id) : undefined}
                    showVcsBadge={showVcsBadges}
                  />
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Changes Section ── */}
      <div className="vscode-section" style={{ borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))' }}>
        <div
          className="vscode-section-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 24,
            padding: '0 8px',
            background: 'var(--vscode-sideBarSectionHeader-background, rgba(255, 255, 255, 0.04))',
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onMouseEnter={() => setUnstagedHovered(true)}
          onMouseLeave={() => setUnstagedHovered(false)}
          onClick={() => setUnstagedExpanded(!unstagedExpanded)}
        >
          <Codicon name={showUnstaged ? 'chevron-down' : 'chevron-right'} style={{ fontSize: 11, marginRight: 6 }} />
          <Codicon name="git-pull-request" style={{ fontSize: 13, marginRight: 6, opacity: 0.8 }} />
          <span style={{ fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('Changes')}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            {unstagedHovered && isSingleRepo && singleRepo && totalUnstaged > 0 && (
              <IconButton
                type="button"
                title={t('Open Changes')}
                onClick={(e) => {
                  e.stopPropagation();
                  openWorkingChanges(singleRepo.meta.id, 'unstaged');
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                }}
              >
                <Codicon name="diff-multiple" />
              </IconButton>
            )}
            {unstagedHovered && totalUnstaged > 0 && (
              <IconButton
                type="button"
                title={t('Rollback All')}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRollbackAll();
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                }}
              >
                <Codicon name="discard" />
              </IconButton>
            )}
            {unstagedHovered && canStageAll && (
              <IconButton
                type="button"
                title={stageAllTitle}
                onClick={(e) => {
                  e.stopPropagation();
                  handleStageAll();
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'inherit',
                }}
              >
                <Codicon name="add" />
              </IconButton>
            )}
            <span className="count-badge">{totalUnstaged}</span>
          </div>
        </div>
        {showUnstaged && (
          <div className="vscode-section-body">
            {unstagedRepos.length === 0 ? (
              <div style={{ padding: '6px 16px', fontSize: 12, opacity: 0.5 }}>{t('No changes')}</div>
            ) : (
              unstagedRepos.map((g) => (
                <VscodeRepoSection
                  key={g.repo.meta.id}
                  repo={g.repo}
                  staged={false}
                  files={g.files}
                  viewMode={viewMode}
                  expansion={expansion}
                  onFile={onFile}
                  onContext={onContext}
                  onFolderContext={onFolderContext}
                  onRepoContext={onRepoContext}
                  openWorkingChanges={openWorkingChanges}
                  onStage={onStage}
                  onUnstage={onUnstage}
                  onDiscard={onDiscard}
                  singleRepo={isSingleRepo}
                  repoSelected={selectedRepos ? selectedRepos.has(g.repo.meta.id) : true}
                  onToggleRepoSelection={onToggleRepoSelection ? () => onToggleRepoSelection(g.repo.meta.id) : undefined}
                  showVcsBadge={showVcsBadges}
                />
              ))
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
