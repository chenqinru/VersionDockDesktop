import { useMemo, useState } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useAppStore } from '../store/appStore';

export function BranchComparePanel({ repoId, close }: { repoId: string; close: () => void }) {
  const branches = useAppStore((state) => state.branches);
  const comparison = useAppStore((state) => state.comparison);
  const compare = useAppStore((state) => state.compareBranches);
  const busy = useAppStore((state) => state.busy);
  const current = branches.find((branch) => branch.current)?.name ?? branches[0]?.name ?? '';
  const fallback = branches.find((branch) => branch.name !== current)?.name ?? current;
  const [base, setBase] = useState(current);
  const [target, setTarget] = useState(fallback);
  const names = useMemo(() => [...new Set(branches.map((branch) => branch.name))], [branches]);
  const { t } = useI18n();
  return <section className="compare-workspace">
    <header>
      <button onClick={close}><Codicon name="arrow-left" />{t('Back to history')}</button>
      <strong>{t('Branch Compare')}</strong>
      <span />
      <label>{t('Base')}<select value={base} onChange={(event) => setBase(event.target.value)}>{names.map((name) => <option key={name}>{name}</option>)}</select></label>
      <Codicon name="arrow-right" />
      <label>{t('Target')}<select value={target} onChange={(event) => setTarget(event.target.value)}>{names.map((name) => <option key={name}>{name}</option>)}</select></label>
      <button className="primary" disabled={busy || !base || !target || base === target} onClick={() => void compare(repoId, base, target)}><Codicon name="compare-changes" />{t('Compare')}</button>
    </header>
    {!comparison ? <div className="empty-state"><Codicon name="compare-changes" />{t('Select two branches to compare')}</div> : <div className="compare-columns">
      <CompareCommits title={t('Only in {0}', comparison.base)} commits={comparison.baseCommits} />
      <CompareCommits title={t('Only in {0}', comparison.target)} commits={comparison.targetCommits} />
      <section className="compare-files"><h3>{t('Changed files')} <b>{comparison.files.length}</b></h3>{comparison.files.length === 0 ? <div className="compare-empty">{t('No changed files')}</div> : comparison.files.map((file) => <div key={`${file.status}:${file.path}`}><Codicon name="file" /><span>{file.path}</span>{file.added !== null && <b className="added">+{file.added}</b>}{file.removed !== null && <b className="removed">−{file.removed}</b>}<em>{file.status}</em></div>)}</section>
    </div>}
  </section>;
}

function CompareCommits({ title, commits }: { title: string; commits: import('../bindings/generated').CommitNode[] }) {
  const { t } = useI18n();
  return <section className="compare-commits"><h3>{title} <b>{commits.length}</b></h3>{commits.length === 0 ? <div className="compare-empty">{t('No unique commits')}</div> : commits.map((commit) => <article key={commit.hash}><Codicon name="git-commit" /><span><strong>{commit.message}</strong><small>{commit.shortHash} · {commit.author}</small></span></article>)}</section>;
}
