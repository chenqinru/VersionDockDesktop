import { useEffect } from 'react';
import type { AiCandidate } from '../bindings/generated';
import { aiRequest, useAiStore } from '../ai/aiStore';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { AiCommitComposerIcon } from './AiCommitComposerIcon';

export function AiCommitActions({ candidates, busy }: { candidates: AiCandidate[]; busy: boolean }) {
  const { t } = useI18n();
  const run = useAiStore((s) => s.runs['commit-message']);
  const unavailable = busy || !candidates.some((c) => c.paths.length);
  return (
    <>
      <IconButton
        title={t('Review selected changes with AI')}
        disabled={unavailable || run?.running}
        onClick={() => useAiStore.getState().openReview(candidates)}
      >
        <Codicon name="search-sparkle" />
      </IconButton>
      <IconButton
        title={t(
          candidates.length !== 1
            ? 'Split commits requires changes from one repository'
            : 'Split selected changes into meaningful commits with AI',
        )}
        disabled={unavailable || candidates.length !== 1 || run?.running}
        onClick={() => {
          const c = candidates[0];
          useAiStore
            .getState()
            .openComposer({ repoId: c.repoId, paths: c.paths, stagedOnly: c.stagedOnly, hashes: [] });
        }}
      >
        <AiCommitComposerIcon />
      </IconButton>

    </>
  );
}

export function AiCommitGenerator({ candidates, busy }: { candidates: AiCandidate[]; busy: boolean }) {
  const { t } = useI18n();
  const run = useAiStore((s) => s.runs['commit-message']);
  useEffect(() => () => useAiStore.getState().cancel('commit-message'), []);
  const generate = async () => {
    const ai = useAiStore.getState();
    if (run?.running) {
      ai.cancel('commit-message');
      return;
    }
    const state = useAppStore.getState();
    const draft = state.commitMessage;
    const workspace = state.snapshot?.workspace.id;
    state.setCommitMessage('');
    const request = aiRequest('commit-message', { candidates, userPrompt: draft });
    const result = await ai.generate('commit-message', request, (text) => {
      if (useAppStore.getState().snapshot?.workspace.id === workspace) useAppStore.getState().setCommitMessage(text);
    });
    if (
      !result &&
      useAiStore.getState().runs['commit-message']?.id === request.requestId &&
      useAppStore.getState().snapshot?.workspace.id === workspace
    )
      useAppStore.getState().setCommitMessage(draft);
  };
  const unavailable = busy || !candidates.some((c) => c.paths.length);
  return (
    <IconButton
      className="ai-commit-generator"
      title={t(run?.running ? 'Stop generating' : 'Generate commit message with AI')}
      disabled={unavailable && !run?.running}
      onClick={() => void generate()}
    >
      <Codicon name={run?.running ? 'stop-circle' : 'sparkle'} />
    </IconButton>
  );
}
