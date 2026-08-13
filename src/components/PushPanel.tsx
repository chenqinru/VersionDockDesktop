import { useEffect, useMemo, useState } from 'react';
import type { RepositoryStatus, UnpushedCommit } from '../bindings/generated';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';
import { Codicon } from './Codicon';
import { branchColor } from './branchColor';

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function CommitRow({ commit }: { commit: UnpushedCommit }) {
  return (
    <div className="push-commit-row">
      <Codicon name="git-commit" />
      <span>
        <strong>{commit.message}</strong>
        <small>{commit.author} · {formatDate(commit.date)}</small>
      </span>
      <code>{commit.shortHash}</code>
      {(commit.filesChanged > 0 || commit.additions > 0 || commit.deletions > 0) && (
        <em><b>+{commit.additions}</b><i>-{commit.deletions}</i></em>
      )}
    </div>
  );
}

function RepoPushSection({ repo, commits, checked, multi, toggle }: { repo: RepositoryStatus; commits: UnpushedCommit[]; checked: boolean; multi: boolean; toggle: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const branch = useAppStore((state) => state.branchesByRepo[repo.meta.id]?.find((item) => item.current));
  const { t } = useI18n();
  const count = repo.ahead || commits.length;
  const hasUpstream = Boolean(branch?.upstream);
  const branchTone = branchColor(repo.branch);
  return (
    <section className="push-repo-section">
      <header style={{ background: `color-mix(in srgb, ${repo.meta.color} 18%, var(--versiondock-surface))` }}>
        {multi && <input aria-label={repo.meta.name} type="checkbox" checked={checked} disabled={count === 0 && hasUpstream} onChange={toggle} />}
        <button onClick={() => setExpanded((value) => !value)}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
          <i style={{ background: repo.meta.color }} />
          <strong>{repo.meta.name}</strong>
          <span className="branch-chip" style={{ color: branchTone, background: `${branchTone}33`, borderColor: `${branchTone}88` }}><Codicon name="git-branch" />{repo.branch}</span>
        </button>
        {count > 0 ? <b className="ahead-badge"><Codicon name="arrow-up" />{count}</b> : !hasUpstream ? <b className="publish-badge"><Codicon name="cloud-upload" />{t('Unpublished')}</b> : null}
      </header>
      {expanded && (
        <div className="push-repo-body">
          {commits.length > 0 ? commits.map((commit) => <CommitRow key={commit.hash} commit={commit} />) : hasUpstream && repo.behind > 0 ? (
            <div className="push-state"><Codicon name="arrow-down" />{t('{0} commits to pull', repo.behind)}</div>
          ) : hasUpstream ? (
            <div className="push-state success"><Codicon name="check" />{t('Up to date')}</div>
          ) : (
            <div className="push-state"><Codicon name="cloud-upload" />{t('Local branch is not published')}</div>
          )}
        </div>
      )}
    </section>
  );
}

export function PushPanel({ repos }: { repos: RepositoryStatus[] }) {
  const unpushed = useAppStore((state) => state.unpushedCommits);
  const branchesByRepo = useAppStore((state) => state.branchesByRepo);
  const load = useAppStore((state) => state.loadUnpushedCommits);
  const sync = useAppStore((state) => state.sync);
  const busy = useAppStore((state) => state.busy);
  const { t } = useI18n();
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => { void load(); }, [load]);
  const pushable = useMemo(() => repos.filter((repo) => repo.ahead > 0 || (unpushed[repo.meta.id]?.length ?? 0) > 0 || !branchesByRepo[repo.meta.id]?.find((item) => item.current)?.upstream), [branchesByRepo, repos, unpushed]);
  const targets = repos.length === 1 ? pushable : pushable.filter((repo) => checked.has(repo.meta.id));
  const doPush = async () => {
    for (const repo of targets) await sync(repo.meta.id, 'push');
    await load();
  };
  const toggle = (repoId: string) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
    return next;
  });

  return (
    <div className="push-panel">
      <div className="push-scroll">
        {!repos.length && <div className="empty-state"><Codicon name="cloud-upload" />{t('No Git repositories')}</div>}
        {repos.map((repo) => <RepoPushSection key={repo.meta.id} repo={repo} commits={unpushed[repo.meta.id] ?? []} checked={checked.has(repo.meta.id)} multi={repos.length > 1} toggle={() => toggle(repo.meta.id)} />)}
      </div>
      <footer>
        {repos.length > 1 && checked.size > 0 && <span>{t('{0} repositories selected', checked.size)}</span>}
        <button disabled={!targets.length || busy} onClick={() => void doPush()}><Codicon name="cloud-upload" />{targets.some((repo) => !branchesByRepo[repo.meta.id]?.find((item) => item.current)?.upstream) ? t('Push & Publish Branch') : t('Push')}</button>
      </footer>
    </div>
  );
}
