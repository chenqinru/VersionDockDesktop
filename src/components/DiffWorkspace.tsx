import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';
import { Codicon } from './Codicon';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';

export function DiffWorkspace() {
  const systemOpen = useAppStore((state) => state.systemOpen);
  const diff = useAppStore((state) => state.diff);
  const back = useAppStore((state) => state.backToHistory);
  const effective = document.documentElement.dataset.theme === 'light' ? 'light-plus' : 'dark-plus';
  const [html, setHtml] = useState('');
  const { t } = useI18n();
  const file = useAppStore((state) => state.selectedFile);
  const externalEditor = useAppStore((state) => state.bootstrap?.state.externalEditor);
  const snapshot = useAppStore((state) => state.snapshot);
  const repo = snapshot?.repositories.find((item) => item.meta.id === file?.repoId);
  useEffect(() => { let active = true; if (diff?.content) void codeToHtml(diff.content, { lang: diff.language, theme: effective }).then((value) => active && setHtml(value)); return () => { active = false; }; }, [diff?.content, diff?.language, effective]);
  if (!diff) return null;
  return <section className="diff-workspace">
    <header><button onClick={back}><Codicon name="arrow-left" />{t('Back to history')}</button><span><Codicon name="diff" />{diff.path}</span><b>{diff.lineCount} {t('Lines')}</b>{repo && file && <>{externalEditor && <button title={t('Open in external editor')} onClick={() => void systemOpen(repo.meta.id, file.path, false, true)}><Codicon name="code" /></button>}<button title={t('Open')} onClick={() => void systemOpen(repo.meta.id, file.path, false)}><Codicon name="go-to-file" /></button><button title={t('Reveal')} onClick={() => void systemOpen(repo.meta.id, file.path, true)}><Codicon name="folder-opened" /></button></>}</header>
    {diff.truncated ? <div className="workspace-empty"><Codicon name="warning" />{t('Diff is too large to display')}</div> : diff.binary ? <div className="workspace-empty"><Codicon name="file-binary" />{t('Binary diff cannot be displayed')}</div> : <div className="code-view" dangerouslySetInnerHTML={{ __html: html }} />}
  </section>;
}
