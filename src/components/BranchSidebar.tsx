import { useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { buildSidebarModel, type SidebarBranch, type SidebarTag } from './HistoryWorkspace.helpers';
import type { RepositoryStatus } from '../bindings/generated';

interface Props {
  repoFilter: Set<string>;
  refFilter: Set<string>;
  onRepoFilter: (repoId: string) => void;
  onRefFilter: (ref: string) => void;
  onCollapse: () => void;
}

type SectionKey = 'local' | `remote:${string}` | 'tags';

export function BranchSidebar({ repoFilter, refFilter, onRepoFilter, onRefFilter, onCollapse }: Props) {
  const repos = useAppStore((state) => state.snapshot?.repositories ?? []);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const tagsByRepo = useAppStore((state) => state.tagsByRepo);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const persistedSections = useAppStore((state) => state.bootstrap?.state.branchSidebarCollapsedSections ?? []);
  const sidebarCollapsed = useAppStore((state) => state.bootstrap?.state.branchSidebarCollapsed ?? false);
  const setBranchSidebarState = useAppStore((state) => state.setBranchSidebarState);
  const [filter, setFilter] = useState('');
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set(persistedSections));
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
      />)}
    </SidebarSection>}
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

function BranchRow({ branch, repoColors, multiRepo, showVcsBadges, selected, active, onClick, onDoubleClick }: {
  branch: SidebarBranch;
  repoColors: Record<string, string>;
  multiRepo: boolean;
  showVcsBadges: boolean;
  selected: boolean;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const headCount = branch.instances.filter((instance) => instance.branch.current).length;
  const instance = branch.instances.find((item) => item.branch.current) ?? branch.instances[0];
  const ahead = instance?.branch.ahead ?? 0;
  const behind = instance?.branch.behind ?? 0;
  const isPrimary = /^(main|master|prod|develop|dev|release)(?:[/-].*)?$/i.test(branch.name);
  return <div
    className={`branch-ref-row ${branch.current ? 'head' : ''} ${selected ? 'filtered' : ''} ${active ? 'active' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={active}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
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
    {multiRepo && <span className="branch-repo-dots">{branch.repoIds.map((repoId) => <i key={repoId} style={{ background: repoColors[repoId] ?? '#888' }} />)}</span>}
  </div>;
}

function TagRow({ tag, repoColors, multiRepo, showVcsBadges, active, detached, onClick, onDoubleClick }: {
  tag: SidebarTag;
  repoColors: Record<string, string>;
  multiRepo: boolean;
  showVcsBadges: boolean;
  active: boolean;
  detached: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  return <div
    className={`branch-ref-row tag-row ${active ? 'active' : ''} ${detached ? 'head' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={active}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onClick();
    }}
  >
    <Codicon name="tag" />
    <span className="branch-ref-name">{tag.name}</span>
    {showVcsBadges && <VcsBadge kind={tag.vcsKind} />}
    {multiRepo && <span className="branch-repo-dots">{tag.repoIds.map((repoId) => <i key={repoId} style={{ background: repoColors[repoId] ?? '#888' }} />)}</span>}
  </div>;
}

function VcsBadge({ kind }: { kind: 'git' | 'svn' }) {
  return <em className={`branch-vcs-badge ${kind}`}>{kind === 'svn' ? 'SVN' : 'GIT'}</em>;
}
