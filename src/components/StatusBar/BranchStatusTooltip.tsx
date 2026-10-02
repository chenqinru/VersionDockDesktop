import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BranchInfo, RepositoryStatus } from '../../bindings/generated';
import { useI18n } from '../../i18n';
import { Codicon } from '../Codicon';
import { formatRepoOperationLabel, getRepoEffectiveRef, getRepoRefIcon, isMixedRepoWorkspace } from './branchRef';

export function BranchStatusTooltip({ repositories, worktrees, branches, selectedRepoId, anchor, messages }: {
  repositories: RepositoryStatus[]; worktrees: RepositoryStatus[]; branches: Record<string, BranchInfo[] | undefined>;
  selectedRepoId?: string; anchor: DOMRect; messages: string[];
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.left);
  const mixed = isMixedRepoWorkspace(repositories);
  useLayoutEffect(() => {
    if (ref.current) setLeft(Math.max(8, Math.min(anchor.left, window.innerWidth - ref.current.offsetWidth - 8)));
  }, [anchor]);
  return createPortal(<div ref={ref} role="tooltip" id="branch-status-tooltip" className="branch-status-tooltip" style={{ left, bottom: window.innerHeight - anchor.top + 6 }}>
    <strong>VersionDock</strong>{repositories.length > 1 && <span> · {t('{0} repositories', repositories.length)}</span>}
    {messages.map((message) => <p key={message}>{message}</p>)}
    {repositories.length > 0 && <table>
      <thead><tr>{['Repository', 'Branch', 'Sync', 'Changes'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{repositories.map((repo) => {
        const current = branches[repo.meta.id]?.find((b) => b.current);
        const name = mixed ? `${repo.meta.name} (${repo.meta.kind === 'svn' ? 'SVN' : 'Git'})` : repo.meta.name;
        const active = repositories.length > 1 && selectedRepoId === repo.meta.id;
        return <tr key={repo.meta.id}>
          <td>{active ? <strong>{name}</strong> : name}{active && <em> ({t('Current')})</em>}</td>
          <td><Codicon name={getRepoRefIcon(repo, branches)} /> {getRepoEffectiveRef(repo, branches)}<em>{formatRepoOperationLabel(repo.operation, t)}</em></td>
          <td>{repo.meta.kind === 'svn' ? '-' : current && !current.upstream ? <em>({t('no upstream')})</em>
            : <>{repo.behind > 0 && <span>↓{repo.behind} </span>}{repo.ahead > 0 && <span>↑{repo.ahead}</span>}{repo.behind + repo.ahead === 0 && (current ? <Codicon name="check" /> : '-')}</>}</td>
          <td>{repo.conflicts > 0 && <span><Codicon name="git-merge" /> {repo.conflicts} </span>}{repo.files.length > 0 ? `● ${repo.files.length}` : repo.conflicts === 0 && <Codicon name="check" />}</td>
        </tr>;
      })}</tbody>
    </table>}
    {worktrees.length > 0 && <p><strong>{t('Worktrees')}</strong>: {worktrees.map((repo) => `${repo.meta.name} (${getRepoEffectiveRef(repo, branches)})`).join(', ')}</p>}
  </div>, document.body);
}
