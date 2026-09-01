import { useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { buildSidebarModel, sumBranchAheadBehind, type SidebarBranch, type SidebarTag } from './HistoryWorkspace.helpers';
import type { RepositoryStatus } from '../bindings/generated';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { choiceDialog, confirmDialog, promptDialog } from './dialogService';

interface Props {
  repoFilter: Set<string>;
  refFilter: Set<string>;
  onRepoFilter: (repoId: string) => void;
  onRefFilter: (ref: string) => void;
  onCompare: (repoId: string, target: string) => void;
  onCollapse: () => void;
}

type SectionKey = 'local' | `remote:${string}` | 'tags';

export function BranchSidebar({ repoFilter, refFilter, onRepoFilter, onRefFilter, onCompare, onCollapse }: Props) {
  const allRepos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const repos = useMemo(() => allRepos.filter((repo) => !repo.meta.isWorktree), [allRepos]);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const loading = useAppStore((state) => state.historyLoading || state.branchesLoading);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const persistedSections = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsedSections ?? state.bootstrap?.state.branchSidebarCollapsedSections ?? []);
  const sidebarCollapsed = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsed ?? state.bootstrap?.state.branchSidebarCollapsed ?? false);
  const setBranchSidebarState = useAppStore((state) => state.setBranchSidebarState);
  const [filter, setFilter] = useState('');
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set(persistedSections));
  const [context, setContext] = useState<{ x: number; y: number; kind: 'branch' | 'tag'; branch?: SidebarBranch; tag?: SidebarTag }>();
  const branchOperation = useAppStore((state) => state.branchOperation);
  const sync = useAppStore((state) => state.sync);
  const loadBranchWorkingDiff = useAppStore((state) => state.loadBranchWorkingDiff);
  const { t } = useI18n();

  const visibleRepos = repoFilter.size ? repos.filter((repo) => repoFilter.has(repo.meta.id)) : repos;
  const model = useMemo(() => buildSidebarModel(visibleRepos, branchesByRepo, tagsByRepo, filter), [branchesByRepo, filter, tagsByRepo, visibleRepos]);
  const showVcsBadges = repos.some((repo) => repo.meta.kind === 'git') && repos.some((repo) => repo.meta.kind === 'svn');
  const repoColors = useMemo(() => Object.fromEntries(repos.map((repo) => [repo.meta.id, repo.meta.color])), [repos]);
  const toggleSection = (key: SectionKey) => {
    const next = new Set(collapsedSections);
    if (next.has(key)) next.delete(key); else next.add(key);
    setCollapsedSections(next);
    setBranchSidebarState(sidebarCollapsed, [...next]);
  };

  return <aside className="branch-sidebar">
    <div className="branch-sidebar-header">
      <div className="branch-search">
        <Codicon name="filter" />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('Filter branches and tags')} />
        {filter && <button aria-label={t('Clear')} onClick={() => setFilter('')}><Codicon name="close" /></button>}
      </div>
      <button className="branch-sidebar-collapse" title={t('Collapse sidebar')} aria-label={t('Collapse sidebar')} onClick={onCollapse}>
        <Codicon name="layout-sidebar-left" />
      </button>
    </div>

    {loading && <div className="branch-loading" role="status" aria-live="polite">
      <Codicon name="loading codicon-modifier-spin" />
      <span>{t('Loading branches…')}</span>
    </div>}

    {repos.length > 1 && <div className="branch-repo-list">
      {repos.map((repo) => <RepositoryRow
        key={repo.meta.id}
        repo={repo}
        repoColors={repoColors}
        showVcsBadges={showVcsBadges}
        selected={repoFilter.has(repo.meta.id)}
        active={activeItem === `repo:${repo.meta.id}`}
        onClick={() => setActiveItem(`repo:${repo.meta.id}`)}
        onDoubleClick={() => onRepoFilter(repo.meta.id)}
      />)}
    </div>}

    <SidebarSection
      icon="git-branch"
      title={t('Local')}
      count={model.local.length}
      collapsed={collapsedSections.has('local')}
      onToggle={() => toggleSection('local')}
    >
      {model.local.map((branch) => <BranchRow
        key={branch.key}
        branch={branch}
        repoColors={repoColors}
        multiRepo={repos.length > 1}
        showVcsBadges={showVcsBadges}
        selected={refFilter.has(branch.ref)}
        active={activeItem === `branch:${branch.key}`}
        onClick={() => setActiveItem(`branch:${branch.key}`)}
        onDoubleClick={() => onRefFilter(branch.ref)}
        onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, kind: 'branch', branch }); }}
      />)}
    </SidebarSection>

    {model.remotes.map((remote) => {
      const key = `remote:${remote.name}` as const;
      return <SidebarSection
        key={key}
        icon="cloud"
        title={remote.name}
        count={remote.branches.length}
        collapsed={collapsedSections.has(key)}
        onToggle={() => toggleSection(key)}
      >
        {remote.branches.map((branch) => <BranchRow
          key={branch.key}
          branch={branch}
          repoColors={repoColors}
          multiRepo={repos.length > 1}
          showVcsBadges={showVcsBadges}
          selected={refFilter.has(branch.ref)}
          active={activeItem === `branch:${branch.key}`}
          onClick={() => setActiveItem(`branch:${branch.key}`)}
          onDoubleClick={() => onRefFilter(branch.ref)}
          onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, kind: 'branch', branch }); }}
        />)}
      </SidebarSection>;
    })}

    {model.tags.length > 0 && <SidebarSection
      icon="tag"
      title={t('Tags')}
      count={model.tags.length}
      collapsed={collapsedSections.has('tags')}
      onToggle={() => toggleSection('tags')}
    >
      {model.tags.map((tag) => <TagRow
        key={tag.key}
        tag={tag}
        repoColors={repoColors}
        multiRepo={repos.length > 1}
        showVcsBadges={showVcsBadges}
        active={activeItem === `tag:${tag.key}`}
        detached={tag.instances.some(({ repo }) => (branchesByRepo[repo.meta.id] ?? []).some((branch) => branch.detachedTag === tag.name))}
        onClick={() => setActiveItem(`tag:${tag.key}`)}
        onDoubleClick={() => {
          const instance = tag.instances.find(({ repo }) => repo.meta.kind === 'git');
          if (instance) void tagOperation({ type: 'checkout', name: tag.name }, instance.repo.meta.id);
        }}
        onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, kind: 'tag', tag }); }}
      />)}
    </SidebarSection>}
    {context && <ContextMenu x={context.x} y={context.y} items={((): ContextMenuEntry[] => {
      if (context.kind === 'tag') {
        const tag = context.tag!;
        const svn = tag.vcsKind === 'svn';
        const detached = tag.instances.some(({ repo }) => (branchesByRepo[repo.meta.id] ?? []).some((branch) => branch.detachedTag === tag.name));
        return [
          { id: 'tag-checkout', label: t(svn ? 'Switch to "{0}"' : 'Checkout "{0}"', tag.name), icon: 'arrow-right' },
          { separator: true },
          { id: 'tag-merge', label: t(svn ? 'Merge tag into working copy' : 'Merge into current'), icon: 'git-merge' },
          ...(!svn ? [{ id: 'tag-push', label: t('Push to remote...'), icon: 'cloud-upload' } as ContextMenuEntry] : []),
          ...(!detached ? [{ separator: true } as ContextMenuEntry, { id: 'tag-delete', label: t(svn ? 'Delete SVN tag' : 'Delete tag'), icon: 'trash', danger: true } as ContextMenuEntry] : []),
        ];
      }
      const branch = context.branch!;
      const svn = branch.vcsKind === 'svn';
      return [
        { id: 'checkout', label: t(svn ? "Switch to '{0}'" : "Checkout '{0}'", branch.name), icon: 'arrow-right' },
        { separator: true },
        ...(!svn && !branch.current ? [
          { id: 'compare-current', label: t('Compare with Current'), icon: 'git-compare' } as ContextMenuEntry,
          { id: 'diff-working', label: t('Show Diff with Working Tree'), icon: 'diff-multiple' } as ContextMenuEntry,
          { separator: true } as ContextMenuEntry,
        ] : []),
        { id: 'merge', label: t(svn ? 'Merge into working copy' : 'Merge into current'), icon: 'git-merge' },
        ...(!svn ? [{ id: 'rebase', label: t("Rebase onto '{0}'", branch.name), icon: 'repo-forked' } as ContextMenuEntry] : []),
        ...(!branch.remote ? [
          { separator: true } as ContextMenuEntry,
          { id: 'pull', label: t(svn ? 'Update' : 'Pull'), icon: 'cloud-download' } as ContextMenuEntry,
          ...(!svn ? [{ id: 'push', label: t('Push...'), icon: 'cloud-upload' } as ContextMenuEntry] : []),
        ] : []),
        ...(!branch.current && !branch.remote ? [{ separator: true } as ContextMenuEntry, { id: 'delete', label: t(svn ? 'Delete SVN branch' : 'Delete branch'), icon: 'trash', danger: true } as ContextMenuEntry] : []),
      ];
    })()} onSelect={(id) => { void (async () => {
      if (context.kind === 'branch' && context.branch) {
        const branch = context.branch;
        const instance = branch.instances.find((item) => item.branch.current) ?? branch.instances[0];
        if (!instance) return;
        const target = branch.vcsKind === 'svn' ? branch.ref : instance.branch.name;
        if (id === 'checkout') for (const item of branch.instances) await branchOperation({ type: 'checkout', name: branch.vcsKind === 'svn' ? branch.ref : item.branch.name }, item.repoId);
        if (id === 'compare-current') onCompare(instance.repoId, instance.branch.name);
        if (id === 'diff-working') await loadBranchWorkingDiff(instance.repoId, instance.branch.remote ? `refs/remotes/${instance.branch.name}` : `refs/heads/${instance.branch.name}`);
        if (id === 'merge') await branchOperation({ type: 'merge', name: target }, instance.repoId);
        if (id === 'rebase') await branchOperation({ type: 'rebase', name: target }, instance.repoId);
        if (id === 'pull') await sync(
          instance.repoId,
          branch.vcsKind === 'svn' ? 'update' : 'pull',
          true,
          { branch: branch.vcsKind === 'svn' ? branch.ref : instance.branch.name },
        );
        if (id === 'push') await sync(instance.repoId, 'push');
        if (id === 'delete') {
          const mode = await choiceDialog({
            title: t(branch.vcsKind === 'svn' ? 'Delete SVN branch' : 'Delete branch'),
            message: `${branch.name}\n${t('{0} repositories', branch.repoIds.length)}`,
            danger: true,
            choices: branch.vcsKind === 'svn'
              ? [{ id: 'delete', label: t('Delete'), icon: 'trash', danger: true }]
              : [{ id: 'delete', label: t('Delete'), icon: 'trash', danger: true }, { id: 'force', label: t('Force Delete'), icon: 'warning', danger: true }],
          });
          if (mode) for (const item of branch.instances.filter((candidate) => !candidate.branch.current)) await branchOperation({ type: 'delete', name: branch.vcsKind === 'svn' ? branch.ref : item.branch.name, force: mode === 'force' }, item.repoId);
        }
      }
      if (context.kind === 'tag' && context.tag) {
        const tag = context.tag;
        if (id === 'tag-checkout') for (const instance of tag.instances) await tagOperation({ type: 'checkout', name: tag.name }, instance.repo.meta.id);
        if (id === 'tag-merge') { const instance = tag.instances[0]; if (instance) await tagOperation({ type: 'merge', name: tag.name }, instance.repo.meta.id); }
        if (id === 'tag-delete' && await confirmDialog({ title: t('Delete tag?'), message: `${tag.name}\n${t('{0} repositories', tag.repoIds.length)}`, danger: true })) for (const instance of tag.instances) await tagOperation({ type: 'delete', name: tag.name }, instance.repo.meta.id);
        if (id === 'tag-push') { const remote = await promptDialog({ title: t('Push Tag'), message: tag.name, inputLabel: t('Remote'), initialValue: 'origin' }); if (remote) for (const instance of tag.instances.filter((item) => item.repo.meta.kind === 'git')) await tagOperation({ type: 'push', name: tag.name, remote }, instance.repo.meta.id); }
      }
      setContext(undefined);
    })(); }} onClose={() => setContext(undefined)} />}
  </aside>;
}

function RepositoryRow({ repo, showVcsBadges, selected, active, onClick, onDoubleClick }: {
  repo: RepositoryStatus;
  repoColors: Record<string, string>;
  showVcsBadges: boolean;
  selected: boolean;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  return <div
    className={`branch-repo-row ${selected ? 'selected' : ''} ${active ? 'active' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={selected}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onDoubleClick();
    }}
  >
    <i style={{ background: repo.meta.color }} />
    <span>{repo.meta.name}</span>
    {showVcsBadges && <VcsBadge kind={repo.meta.kind} />}
  </div>;
}

function SidebarSection({ icon, title, count, collapsed, onToggle, children }: {
  icon: string;
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return <section className="branch-section">
    <div className="branch-section-title">
      <button className="branch-section-toggle" onClick={onToggle} aria-expanded={!collapsed}>
        <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} />
        <Codicon name={icon} />
        <strong>{title}</strong>
        <b>{count}</b>
      </button>
    </div>
    {!collapsed && children}
  </section>;
}

function BranchRow({ branch, repoColors, multiRepo, showVcsBadges, selected, active, onClick, onDoubleClick, onContextMenu }: {
  branch: SidebarBranch;
  repoColors: Record<string, string>;
  multiRepo: boolean;
  showVcsBadges: boolean;
  selected: boolean;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const headCount = branch.instances.filter((instance) => instance.branch.current).length;
  const { ahead, behind } = sumBranchAheadBehind(branch);
  const isPrimary = ['main', 'master', 'trunk', 'develop', 'dev', 'release'].includes(branch.name.toLowerCase());
  return <div
    className={`branch-ref-row ${branch.current ? 'head' : ''} ${selected ? 'filtered' : ''} ${active ? 'active' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={active}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    onContextMenu={onContextMenu}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onDoubleClick();
    }}
  >
    <Codicon name={isPrimary ? 'star-full' : branch.remote ? 'cloud' : 'git-branch'} />
    <span className="branch-ref-name">{branch.name}</span>
    {showVcsBadges && <VcsBadge kind={branch.vcsKind} />}
    {branch.current && <em className="branch-head-badge">{multiRepo && headCount > 0 && headCount < branch.repoIds.length ? `HEAD ${headCount}/${branch.repoIds.length}` : 'HEAD'}</em>}
    {(ahead > 0 || behind > 0) && <span className="branch-ahead-behind">{ahead > 0 && <b className="ahead">↑{ahead}</b>}{behind > 0 && <b className="behind">↓{behind}</b>}</span>}
    {multiRepo && <span className="branch-repo-dots">{branch.repoIds.map((repoId) => <i key={repoId} style={{ background: repoColors[repoId] ?? 'var(--versiondock-muted)' }} />)}</span>}
  </div>;
}

function TagRow({ tag, repoColors, multiRepo, showVcsBadges, active, detached, onClick, onDoubleClick, onContextMenu }: {
  tag: SidebarTag;
  repoColors: Record<string, string>;
  multiRepo: boolean;
  showVcsBadges: boolean;
  active: boolean;
  detached: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  return <div
    className={`branch-ref-row tag-row ${active ? 'active' : ''} ${detached ? 'head' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={active}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    onContextMenu={onContextMenu}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onClick();
    }}
  >
    <Codicon name="tag" />
    <span className="branch-ref-name">{tag.name}</span>
    {showVcsBadges && <VcsBadge kind={tag.vcsKind} />}
    {multiRepo && <span className="branch-repo-dots">{tag.repoIds.map((repoId) => <i key={repoId} style={{ background: repoColors[repoId] ?? 'var(--versiondock-muted)' }} />)}</span>}
  </div>;
}

function VcsBadge({ kind }: { kind: 'git' | 'svn' }) {
  return <em className={`branch-vcs-badge ${kind}`}>{kind === 'svn' ? 'SVN' : 'GIT'}</em>;
}
