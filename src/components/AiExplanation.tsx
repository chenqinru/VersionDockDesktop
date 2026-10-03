import Markdown from 'react-markdown';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AiCommit } from '../bindings/generated';
import { aiRequest, explanationKey, useAiStore } from '../ai/aiStore';
import { useI18n } from '../i18n';
import { openExternalLink } from '../services/updater';
import { Codicon } from './Codicon';

export function AiExplanation({ commits, toolbar }: { commits: AiCommit[]; toolbar?: HTMLElement | null }) {
  const { t } = useI18n();
  const key = explanationKey(commits);
  const run = useAiStore(s => s.runs[key]);
  const [displayed, setDisplayed] = useState({ id: '', text: '' });
  const mounts = useRef(new Map<string, number>());
  useEffect(() => {
    const counts = mounts.current;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return () => {
      counts.set(key, (counts.get(key) ?? 1) - 1);
      queueMicrotask(() => { if (counts.get(key) === 0) useAiStore.getState().cancel(key); });
    };
  }, [key]);
  useEffect(() => {
    if (!run || displayed.id === run.id && displayed.text === run.text) return;
    const timer = window.setTimeout(() => setDisplayed(previous => {
      const text = previous.id === run.id ? previous.text : '';
      const remaining = run.text.length - text.length;
      const size = remaining > 600 ? 12 : remaining > 240 ? 6 : remaining > 80 ? 3 : 1;
      const next = run.phase === 'cancelled' ? run.text : run.text.slice(0, text.length + size);
      return previous.id === run.id && previous.text === next ? previous : { id: run.id, text: next };
    }), 12);
    return () => window.clearTimeout(timer);
  }, [run, displayed]);
  const text = displayed.id === run?.id ? displayed.text : '';
  const typing = Boolean(run && !run.error && run.phase !== 'cancelled' && text.length < run.text.length);
  const busy = Boolean(run?.running || typing);
  const state = busy ? 'generating' : run?.error ? 'error' : run?.phase === 'cancelled' ? 'cancelled' : 'complete';
  const phase = text || typing || run?.phase === 'thinking' || run?.phase === 'writing' ? 2 : run?.phase === 'scanning' || run?.phase === 'reading' ? 0 : 1;
  const status = state === 'error' ? t('Explanation failed') : state === 'cancelled' ? t('Explanation stopped')
    : !busy ? t('Explanation complete') : phase === 0 ? t('Reading commit information…')
      : phase === 1 ? t('Analyzing changed files…') : text ? t('AI is writing the explanation…') : t('Organizing the explanation…');
  const generate = () => {
    if (busy) {
      useAiStore.getState().cancel(key);
      if (!run?.running && run) useAiStore.setState(s => ({ runs: { ...s.runs, [key]: { ...run, phase: 'cancelled' } } }));
    }
    else void useAiStore.getState().generate(key, aiRequest('commit-explanation', { commits }));
  };
  const button = <button type="button" className="ai-generate ai-explain-button" data-busy={busy} aria-busy={busy}
    title={t(busy ? 'Stop AI commit explanation' : run ? 'Explain commits again with AI' : 'Explain commit with AI')} onClick={generate}>
    <Codicon name={busy ? 'stop-circle' : 'sparkle-filled'} />
    <span>{t(busy ? 'Stop' : run ? 'Explain again' : 'AI Explain')}</span>
  </button>;
  return <>
    {toolbar ? createPortal(button, toolbar) : button}
    {run && <section className="ai-explanation" data-state={state} aria-label={t('AI Commit Explanation')}>
      <div className="ai-explanation-header">
        <span className="ai-explanation-orb" aria-hidden="true"><Codicon name="sparkle" /></span>
        <div className="ai-explanation-heading"><strong>{t('AI Commit Explanation')}</strong><span role="status" aria-live="polite">{status}</span></div>
        <span className="ai-explanation-live-dot" aria-hidden="true" />
      </div>
      <div className="ai-explanation-stages" aria-hidden="true">{['Read commit', 'Analyze changes', 'Compose explanation'].map((stage, index) =>
        <span key={stage} className={!busy && state === 'complete' || index < phase ? 'done' : busy && index === phase ? 'active' : ''}>{t(stage)}</span>)}</div>
      {!text && !run.error && <div className="ai-explanation-placeholder">{t(state === 'cancelled' ? 'Explanation stopped' : 'AI is preparing the explanation')}
        {busy && <span className="ai-thinking-dots" aria-hidden="true"><i /><i /><i /></span>}
      </div>}
      {text && <div className="ai-output ai-markdown">
        <Markdown components={{ h2: ({ children }) => <h3>{children}</h3>, a: ({ href, children }) => <a href={href} onClick={event => {
          event.preventDefault();
          if (href && /^https?:\/\//i.test(href)) void openExternalLink(href).catch(() => undefined);
        }}>{children}</a> }}>{text}</Markdown>
        {busy && <span className="ai-explanation-cursor" aria-hidden="true" />}
      </div>}
      {run.error && <div role="alert" className="ai-error">{run.error}</div>}
      {!busy && <footer className="ai-explanation-footer">
        <span>{state === 'cancelled' ? t('Partial output was kept') : run.result
          ? `${run.result.provider}${run.result.model ? ` · ${run.result.model}` : ''} · ${(run.result.durationMs / 1000).toFixed(1)}s` : ''}</span>
        {run.result?.inputTruncated && <span className="ai-explanation-warning"><Codicon name="warning" />{t('Some oversized changes were truncated')}</span>}
      </footer>}
    </section>}
  </>;
}
