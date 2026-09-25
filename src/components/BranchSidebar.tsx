import { useDeferredValue, useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { buildSidebarModel, sumBranchAheadBehind, type BranchInstance, type SidebarBranch, type SidebarTag } from './HistoryWorkspace.helpers';
import type { RepositoryStatus } from '../bindings/generated';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { choiceDialog, confirmDialog } from './dialogService';
import { isBranchProtected } from '../history/branchProtection';
import { branchRevisionRef } from '../history/refs';
import { ProviderPanel } from './ProviderPanel';

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
  const loading = useAppStore((state) => state.branchesLoading);
  const tagOperation = useAppStore((state) => state.tagOperation);
  const persistedSections = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsedSections ?? state.bootstrap?.state.branchSidebarCollapsedSections ?? []);
  const sidebarCollapsed = useAppStore((state) => state.bootstrap?.state.layout?.branchSidebarCollapsed ?? state.bootstrap?.state.branchSidebarCollapsed ?? false);
  const setBranchSidebarState = useAppStore((state) => state.setBranchSidebarState);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [publishRepoId, setPublishRepoId] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    const initial = new Set(persistedSections);
    const tagCount = Object.values(tagsByRepo).reduce((count, tags) => count + tags.length, 0);
    const detachedOnTag = Object.values(branchesByRepo).some((branches) => branches.some((branch) => Boolean(branch.detachedTag)));
    if (tagCount > 25 && !detachedOnTag) initial.add('tags');
    return initial;
  });
  const [context, setContext] = useState<{ x: number; y: number; kind: 'branch' | 'tag'; branch?: SidebarBranch; tag?: SidebarTag }>();
  const branchOperation = useAppStore((state) => state.branchOperation);
  const sync = useAppStore((state) => state.sync);
  const loadBranchWorkingDiff = useAppStore((state) => state.loadBranchWorkingDiff);
  const { t } = useI18n();

  const model = useMemo(() => buildSidebarModel(repos, branchesByRepo, tagsByRepo, deferredFilter), [branchesByRepo, deferredFilter, tagsByRepo, repos]);
  const showVcsBadges = repos.some((repo) => repo.meta.kind === 'git') && repos.some((repo) => repo.meta.kind === 'svn');
  const repoColors = useMemo(() => Object.fromEntries(repos.map((repo) => [repo.meta.id, repo.meta.color])), [repos]);
  const toggleSection = (key: SectionKey) => {
    const next = new Set(collapsedSections);
    if (next.has(key)) next.delete(key); else next.add(key);
    setCollapsedSections(next);
    setBranchSidebarState(sidebarCollapsed, [...next]);
  };

  const pickTargetInstance = async (targetBranch: SidebarBranch, actionTitle: string): Promise<BranchInstance | null> => {
    if (targetBranch.instances.length <= 1) return targetBranch.instances[0] ?? null;
    const choice = await choiceDialog({
      title: actionTitle,
      message: t('Choose a repository for "{0}"', targetBranch.name),
      choices: targetBranch.instances.map((item) => ({
        id: item.repoId,
        label: item.repo.meta.name,
        description: item.branch.current ? t('Current HEAD') : item.branch.remote ? t('Remote branch') : undefined,
        icon: 'repo',
      })),
    });
    if (!choice) return null;
    return targetBranch.instances.find((item) => item.repoId === choice) ?? null;
  };

  const pickRemote = async (repoId: string, title: string): Promise<string | null> => {
    await useAppStore.getState().loadRemotes(repoId);
    const repoRemotes = useAppStore.getState().remotes[repoId] ?? [];
    const names = repoRemotes.map((r) => r.name);
    if (names.length === 0) return null;
    if (names.length === 1) return names[0];
    return await choiceDialog({
      title,
      message: t('Select a remote repository:'),
      choices: names.map((name) => ({ id: name, label: name, icon: 'cloud-upload' })),
    });
  };

  const pickTargetTagInstance = async (targetTag: SidebarTag, title: string) => {
    const gitInstances = targetTag.instances.filter((item) => item.repo.meta.kind === 'git');
    if (gitInstances.length === 0) return null;
    if (gitInstances.length === 1) return gitInstances[0];
    const choice = await choiceDialog({
      title,
      message: `${targetTag.name}\n${t('{0} repositories', gitInstances.length)}`,
      choices: gitInstances.map((item) => ({
        id: item.repo.meta.id,
        label: item.repo.meta.name,
        description: item.repo.meta.rootPath,
        icon: 'repo',
      })),
    });
    if (!choice) return null;
    return gitInstances.find((item) => item.repo.meta.id === choice) ?? null;
  };

  return <aside className="branch-sidebar">
    <div className="branch-sidebar-sticky-header">
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
    </div>

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
        selected={refFilter.has(tag.ref)}
        active={activeItem === `tag:${tag.key}`}
        detached={tag.instances.some(({ repo }) => (branchesByRepo[repo.meta.id] ?? []).some((branch) => branch.detachedTag === tag.name))}
        onClick={() => setActiveItem(`tag:${tag.key}`)}
        onDoubleClick={() => onRefFilter(tag.ref)}
        onContextMenu={(event) => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, kind: 'tag', tag }); }}
      />)}
    </SidebarSection>}
    {context && <ContextMenu x={context.x} y={context.y} items={((): ContextMenuEntry[] => {
      if (context.kind === 'tag') {
        const tag = context.tag!;
        const svn = tag.vcsKind === 'svn';
        const allDetached = tag.instances.every(({ repo }) => (branchesByRepo[repo.meta.id] ?? []).some((branch) => branch.detachedTag === tag.name));
        return [
          { id: 'tag-checkout', label: t(svn ? 'Switch to "{0}"' : 'Checkout "{0}"', tag.name), icon: 'arrow-right' },
          { separator: true },
          { id: 'tag-merge', label: t(svn ? 'Merge tag into working copy' : 'Merge into current'), icon: 'git-merge' },
          ...(!svn ? [{ id: 'tag-push', label: t('Push to remote...'), icon: 'cloud-upload' } as ContextMenuEntry] : []),
          ...(!allDetached ? [{ separator: true } as ContextMenuEntry, { id: 'tag-delete', label: t(svn ? 'Delete SVN tag' : 'Delete tag'), icon: 'trash', danger: true } as ContextMenuEntry] : []),
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
        const defaultInstance = branch.instances.find((item) => item.branch.current) ?? branch.instances[0];
        if (!defaultInstance) return;
        if (id === 'checkout') for (const item of branch.instances) await branchOperation({ type: 'checkout', name: branch.vcsKind === 'svn' ? branch.ref : item.branch.name }, item.repoId);
        const getBranchRef = (inst: BranchInstance) => {
          if (branch.vcsKind === 'svn') return branch.ref;
          return inst.branch.remote ? `refs/remotes/${inst.branch.name}` : inst.branch.name;
        };
        if (id === 'compare-current') {
          const inst = branch.instances.length > 1 ? await pickTargetInstance(branch, t('Compare with Current')) : defaultInstance;
          if (inst) onCompare(inst.repoId, getBranchRef(inst));
        }
        if (id === 'diff-working') {
          const inst = branch.instances.length > 1 ? await pickTargetInstance(branch, t('Compare with Working Directory')) : defaultInstance;
          if (inst) void loadBranchWorkingDiff(inst.repoId, inst.branch.remote ? `refs/remotes/${inst.branch.name}` : `refs/heads/${inst.branch.name}`);
        }
        if (id === 'merge') {
          const inst = branch.instances.length > 1 ? await pickTargetInstance(branch, t(branch.vcsKind === 'svn' ? 'Merge into working copy' : 'Merge into current')) : defaultInstance;
          if (inst) await branchOperation({ type: 'merge', name: getBranchRef(inst) }, inst.repoId);
        }
        if (id === 'rebase') {
          const inst = branch.instances.length > 1 ? await pickTargetInstance(branch, t("Rebase onto '{0}'", branch.name)) : defaultInstance;
          if (inst) await branchOperation({ type: 'rebase', name: getBranchRef(inst) }, inst.repoId);
        }
        if (id === 'pull') {
          const inst = branch.instances.length > 1 ? await pickTargetInstance(branch, t(branch.vcsKind === 'svn' ? 'Update' : 'Pull')) : defaultInstance;
          if (!inst) return;
          if (branch.vcsKind === 'svn') {
            await sync(inst.repoId, 'update', true, { branch: branch.ref });
          } else {
            let action: 'pull' | 'pullRebase' = 'pull';
            if (inst.branch.current) {
              const currentSettings = useAppStore.getState().bootstrap?.state.settings;
              const updateMethod = currentSettings?.updateProjectMethod ?? 'rebase';
              if (updateMethod === 'prompt') {
                const selected = await choiceDialog({
                  title: t('Update Project — Strategy'),
                  message: t('Choose how incoming Git changes are integrated.'),
                  choices: [
                    { id: 'rebase', label: t('Rebase the current branch on top of incoming changes'), icon: 'repo-forked' },
                    { id: 'merge', label: t('Merge incoming changes into the current branch'), icon: 'git-merge' },
                  ],
                });
                if (!selected) {
                  setContext(undefined);
                  return;
                }
                action = selected === 'rebase' ? 'pullRebase' : 'pull';
              } else {
                action = updateMethod === 'rebase' ? 'pullRebase' : 'pull';
              }
            }
            await sync(inst.repoId, action, true, { branch: inst.branch.name });
          }
        }
        if (id === 'push') {
          const inst = branch.instances.length > 1 ? await pickTargetInstance(branch, t('Push Branch')) : defaultInstance;
          if (!inst) return;
          await useAppStore.getState().loadRemotes(inst.repoId);
          const repoRemotes = useAppStore.getState().remotes[inst.repoId] ?? [];
          if (repoRemotes.length === 0) {
            const confirmed = await confirmDialog({
              title: t('Publish Repository'),
              message: t('VersionDock [{0}]: No remotes configured. Would you like to publish this repository?', inst.repo.meta.name),
              confirmLabel: t('Publish...'),
            });
            if (confirmed) {
              setPublishRepoId(inst.repoId);
            }
            setContext(undefined);
            return;
          }
          const remote = await pickRemote(inst.repoId, t('Push — Select remote'));
          if (repoRemotes.length > 1 && !remote) return;
          await sync(inst.repoId, 'push', true, { remote: remote ?? undefined, branch: inst.branch.name });
        }
        if (id === 'delete') {
          if (branch.vcsKind === 'git' && isBranchProtected(branch.name)) {
            await confirmDialog({
              title: t('Protected branch'),
              message: t('VersionDock: Protected branch "{0}" cannot be deleted.', branch.name),
              confirmLabel: t('OK'),
            });
            setContext(undefined);
            return;
          }
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
        if (id === 'tag-merge') {
          for (const instance of tag.instances) {
            await tagOperation({ type: 'merge', name: tag.name }, instance.repo.meta.id);
          }
        }
        if (id === 'tag-delete') {
          const checkedOutRepos = tag.instances.filter(({ repo }) =>
            (branchesByRepo[repo.meta.id] ?? []).some((branch) => branch.detachedTag === tag.name)
          );
          const eligibleInstances = tag.instances.filter(({ repo }) =>
            !(branchesByRepo[repo.meta.id] ?? []).some((branch) => branch.detachedTag === tag.name)
          );
          if (eligibleInstances.length === 0) {
            const singleName = tag.instances.length === 1 ? tag.instances[0].repo.meta.name : undefined;
            await confirmDialog({
              title: t('Cannot delete tag'),
              message: singleName
                ? t('VersionDock [{0}]: Cannot delete tag "{1}" — HEAD is detached on it.', singleName, tag.name)
                : t('VersionDock: Cannot delete tag "{0}" — HEAD is detached on it in all target repositories.', tag.name),
              confirmLabel: t('OK'),
            });
            setContext(undefined);
            return;
          }

          if (tag.vcsKind === 'svn') {
            const confirmed = await confirmDialog({
              title: t('Delete tag?'),
              message: `${tag.name}\n${t('{0} repositories', eligibleInstances.length)}`,
              danger: true,
            });
            if (confirmed) {
              for (const instance of eligibleInstances) {
                await tagOperation({ type: 'delete', name: tag.name }, instance.repo.meta.id);
              }
            }
          } else {
            const skippedMsg = checkedOutRepos.length > 0
              ? ` (${t('skipped in: {0} — HEAD detached on this tag', checkedOutRepos.map((i) => i.repo.meta.name).join(', '))})`
              : '';
            const choice = await choiceDialog({
              title: t('Delete tag?'),
              message: `${tag.name}${skippedMsg}\n${t('{0} repositories', eligibleInstances.length)}`,
              danger: true,
              choices: [
                { id: 'local', label: t('Delete Local'), icon: 'trash', danger: true },
                { id: 'remote', label: t('Delete on Remote'), icon: 'cloud', danger: true },
                { id: 'both', label: t('Delete Local and Remote'), icon: 'warning', danger: true },
              ],
            });
            if (!choice) {
              setContext(undefined);
              return;
            }

            if (choice === 'local') {
              for (const instance of eligibleInstances) {
                await tagOperation({ type: 'delete', name: tag.name }, instance.repo.meta.id);
              }
            } else if (choice === 'remote') {
              for (const instance of eligibleInstances) {
                const remote = await pickRemote(instance.repo.meta.id, t('Delete "{0}" from remote', tag.name));
                if (remote) {
                  await tagOperation({ type: 'delete', name: tag.name, remote }, instance.repo.meta.id);
                }
              }
            } else if (choice === 'both') {
              for (const instance of eligibleInstances) {
                const deletedLocal = await tagOperation({ type: 'delete', name: tag.name }, instance.repo.meta.id);
                if (!deletedLocal) continue;
                const remote = await pickRemote(instance.repo.meta.id, t('Delete "{0}" from remote', tag.name));
                if (remote) {
                  await tagOperation({ type: 'delete', name: tag.name, remote }, instance.repo.meta.id);
                }
              }
            }
          }
        }
        if (id === 'tag-push') {
          const inst = await pickTargetTagInstance(tag, t('Push Tag'));
          if (!inst) return;
          const targetRepoId = inst.repo.meta.id;
          await useAppStore.getState().loadRemotes(targetRepoId);
          const currentRemotes = useAppStore.getState().remotes[targetRepoId] ?? [];
          if (currentRemotes.length === 0) {
            useAppStore.getState().addNotification({
              type: 'warning',
              title: t('Push Tag'),
              message: { key: 'VersionDock [{0}]: No remotes configured.', args: [inst.repo.meta.name] },
              workspaceId: useAppStore.getState().snapshot?.workspace.id,
            });
            return;
          }
          const remote = currentRemotes.length === 1
            ? currentRemotes[0].name
            : await choiceDialog({
                title: t('Push tag "{0}" — Select remote', tag.name),
                message: t('Select a remote repository:'),
                choices: currentRemotes.map((r) => ({ id: r.name, label: r.name, icon: 'cloud-upload' })),
              });
          if (remote) {
            await tagOperation({ type: 'push', name: tag.name, remote }, targetRepoId);
          }
        }
      }
      setContext(undefined);
    })(); }} onClose={() => setContext(undefined)} />}
    {publishRepoId && (
      <ProviderPanel
        mode="publish"
        repoId={publishRepoId}
        close={() => {
          setPublishRepoId(null);
          void useAppStore.getState().loadRemotes(publishRepoId);
          void useAppStore.getState().refresh(true);
        }}
      />
    )}
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
  const { t } = useI18n();
  return <div
    className={`branch-repo-row ${selected ? 'selected' : ''} ${active ? 'active' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={selected}
    title={t('Double-click to filter commits by repository: {0}', repo.meta.name)}
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
    {repo.meta.isSubmodule && <em className="branch-submodule-badge" title={t('Submodule')}>{t('SUB')}</em>}
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
  const { t } = useI18n();
  const headCount = branch.instances.filter((instance) => instance.branch.current).length;
  const { ahead, behind } = sumBranchAheadBehind(branch);
  const isPrimary = ['main', 'master', 'trunk', 'develop', 'dev', 'release'].includes(branch.name.toLowerCase());
  return <div
    className={`branch-ref-row ${branch.current ? 'head' : ''} ${selected ? 'filtered' : ''} ${active ? 'active' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={active}
    title={`${branch.name}\n${branch.vcsKind === 'svn' ? t('Double-click to filter by this branch · Right-click for SVN actions') : t('Double-click to filter by this branch · Right-click for Git actions')}`}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    onContextMenu={onContextMenu}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onDoubleClick();
    }}
  >
    <Codicon
      name={isPrimary ? 'star-full' : branch.remote ? 'cloud' : 'git-branch'}
      title={branch.current ? (multiRepo ? t('Current HEAD in {0} of {1} repositories', headCount, branch.repoIds.length) : t('Current HEAD')) : isPrimary ? t('Primary branch') : undefined}
    />
    <span className="branch-ref-name">{branch.name}</span>
    {showVcsBadges && <VcsBadge kind={branch.vcsKind} />}
    {branch.current && (
      <em
        className="branch-head-badge"
        title={multiRepo ? t('Current HEAD in {0} of {1} repositories', headCount, branch.repoIds.length) : t('current branch')}
      >
        {multiRepo && headCount > 0 && headCount < branch.repoIds.length ? `HEAD ${headCount}/${branch.repoIds.length}` : 'HEAD'}
      </em>
    )}
    {(ahead > 0 || behind > 0) && <span className="branch-ahead-behind">{ahead > 0 && <b className="ahead">↑{ahead}</b>}{behind > 0 && <b className="behind">↓{behind}</b>}</span>}
    {multiRepo && <span className="branch-repo-dots">{branch.repoIds.map((repoId) => <i key={repoId} style={{ background: repoColors[repoId] ?? 'var(--versiondock-muted)' }} />)}</span>}
  </div>;
}

function TagRow({ tag, repoColors, multiRepo, showVcsBadges, selected, active, detached, onClick, onDoubleClick, onContextMenu }: {
  tag: SidebarTag;
  repoColors: Record<string, string>;
  multiRepo: boolean;
  showVcsBadges: boolean;
  selected: boolean;
  active: boolean;
  detached: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { t } = useI18n();
  return <div
    className={`branch-ref-row tag-row ${selected ? 'filtered' : ''} ${active ? 'active' : ''} ${detached ? 'head' : ''}`}
    role="button"
    tabIndex={0}
    aria-pressed={active}
    title={`${t('Tag: {0}', tag.name)}${detached ? ` (${t('current')})` : ''}\n${t('Right-click for actions')}`}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    onContextMenu={onContextMenu}
    onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onDoubleClick();
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
