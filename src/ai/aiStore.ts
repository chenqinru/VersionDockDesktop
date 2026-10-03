import { t } from './i18n';
import { aiErrorText } from './errors';
import { create } from 'zustand';
import type {
  AiRequest,
  AiResult,
  AiComposerSource,
  AiCandidate,
  AiCommit,
  AiApplyResult,
} from '../bindings/generated';
import type { BridgeEvent } from '../platform/bridge';
import { useAppStore, type WorkspaceMode } from '../store/appStore';
import type {
  ComposerToHostMsg,
  CodeReviewToHostMsg,
  HostToComposerMsg,
  HostToCodeReviewMsg,
  CodeReviewFinding,
  CodeReviewReport,
  CodeReviewSeverity,
} from './viewTypes';

type AiRun = { id: string; running: boolean; phase: string; text: string; error?: string; result?: AiResult };
type ComposerInput = { workspaceId: string; repoId: string; paths: string[]; stagedOnly: boolean; hashes: string[] };
const controllers = new Map<string, AbortController>();
let preparation: AbortController | undefined;
let analysisEpoch = 0;
let applying = false;
let returnMode: WorkspaceMode = 'history';
function cancelViewRuns() {
  const store = useAiStore.getState();
  for (const key of controllers.keys()) {
    if (key === 'review' || key === 'composer' || key.startsWith('message:')) store.cancel(key);
  }
}
function rememberReturnMode() {
  const mode = useAppStore.getState().mode;
  const diffReturnMode = useAppStore.getState().diffReturnMode;
  if (mode === 'diff' && (diffReturnMode === 'ai-review' || diffReturnMode === 'ai-composer')) return;
  if (mode !== 'ai-review' && mode !== 'ai-composer') returnMode = mode;
}
const listeners = new Set<(message: HostToComposerMsg | HostToCodeReviewMsg) => void>();
export function listenAiView(listener: (message: HostToComposerMsg | HostToCodeReviewMsg) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const emit = (message: HostToComposerMsg | HostToCodeReviewMsg) => listeners.forEach((listener) => listener(message));
const errorText = aiErrorText;
const bridge = () => {
  const value = useAppStore.getState().bridge;
  if (!value) throw new Error('Bridge unavailable');
  return value;
};
export function aiRequest(task: AiRequest['task'], extra: Partial<AiRequest> = {}): AiRequest {
  return {
    task,
    requestId: crypto.randomUUID(),
    workspaceId: useAppStore.getState().snapshot?.workspace.id ?? '',
    repoId: null,
    path: null,
    sessionId: null,
    ...extra,
  };
}
export const useAiStore = create<{
  runs: Record<string, AiRun>;
  view?: 'review' | 'composer';
  reviewRequest?: AiRequest;
  composerInput?: ComposerInput;
  source?: AiComposerSource;
  generate: (key: string, request: AiRequest, onDelta?: (text: string) => void) => Promise<AiResult | undefined>;
  cancel: (key: string) => void;
  close: () => void;
  openReview: (candidates: AiCandidate[]) => void;
  openComposer: (input: Omit<ComposerInput, 'workspaceId'>) => void;
}>((set, get) => ({
  runs: {},
  generate: async (key, request, onDelta) => {
    get().cancel(key);
    const owner = bridge();
    const control = new AbortController();
    controllers.set(key, control);
    let unsubscribe = () => {};
    let result: AiResult | undefined;
    const active = () =>
      controllers.get(key) === control &&
      !control.signal.aborted &&
      useAppStore.getState().bridge === owner &&
      useAppStore.getState().snapshot?.workspace.id === request.workspaceId;
    set((state) => {
      const runs = { ...state.runs };
      if (Object.keys(runs).length >= 64) {
        const old = Object.keys(runs).find((id) => id !== key && !runs[id].running);
        if (old) delete runs[old];
      }
      return { runs: { ...runs, [key]: { id: request.requestId, running: true, phase: 'scanning', text: '' } } };
    });
    unsubscribe = owner.subscribe((event: BridgeEvent) => {
      if (!active() || !('requestId' in event) || event.requestId !== request.requestId || event.type !== 'aiProgress')
        return;
      set((state) => {
        const old = state.runs[key];
        return { runs: { ...state.runs, [key]: { ...old, phase: event.phase, text: old.text + event.delta } } };
      });
      onDelta?.(get().runs[key].text);
      if (get().view === 'review' && key === 'review')
        emit({
          type: 'CODE_REVIEW_PHASE',
          phase:
            event.phase === 'scanning'
              ? 'scanning'
              : event.phase === 'analyzing'
                ? 'analyzing'
                : event.phase === 'completed'
                  ? 'completed'
                  : 'validating',
          detail: t(
            event.phase === 'scanning'
              ? 'Scan changes'
              : event.phase === 'analyzing'
                ? 'Analyze risks'
                : 'Validate findings',
          ),
          streamCharCount: get().runs[key].text.length,
        });
      if (
        get().view === 'composer' &&
        key === 'composer' &&
        ['scanning', 'analyzing', 'validating', 'repairing'].includes(event.phase)
      )
        emit({
          type: 'COMPOSER_PHASE',
          phase: event.phase === 'repairing' ? 'validating' : (event.phase as 'scanning' | 'analyzing' | 'validating'),
          detail: t(
            event.phase === 'scanning'
              ? 'Preparing AI Commit Composer…'
              : event.phase === 'analyzing'
                ? 'Analyzing changes and proposing commit groups'
                : 'Validating commit plan',
          ),
        });
    });
    try {
      result = await owner.request<AiResult>(
        { type: 'aiGenerate', payload: { request } },
        { signal: control.signal, timeoutMs: 1_860_000, showProgress: false },
      );
      if (!active()) return;
      set((state) => ({
        runs: {
          ...state.runs,
          [key]: { id: request.requestId, running: false, phase: 'completed', text: result!.text, result },
        },
      }));
      onDelta?.(result.text);
      return result;
    } catch (error) {
      if (active())
        set((state) => ({
          runs: {
            ...state.runs,
            [key]: { ...state.runs[key], running: false, phase: 'error', error: errorText(error) },
          },
        }));
    } finally {
      unsubscribe();
      if (controllers.get(key) === control) controllers.delete(key);
    }
  },
  cancel: (key) => {
    controllers.get(key)?.abort();
    controllers.delete(key);
    set((state) =>
      state.runs[key]?.running
        ? { runs: { ...state.runs, [key]: { ...state.runs[key], running: false, phase: 'cancelled' } } }
        : {},
    );
  },
  close: () => {
    if (applying) return;
    preparation?.abort();
    analysisEpoch++;
    cancelViewRuns();
    set({ view: undefined, reviewRequest: undefined, composerInput: undefined, source: undefined });
    useAppStore.getState().setMode(returnMode);
  },
  openReview: (candidates) => {
    if (applying) return;
    preparation?.abort();
    analysisEpoch++;
    rememberReturnMode();
    cancelViewRuns();
    set((state) => ({ runs: { ...state.runs, review: { id: '', running: false, phase: '', text: '' } } }));
    set({ view: 'review', reviewRequest: aiRequest('code-review', { candidates: reviewCandidates(candidates) }) });
    useAppStore.getState().setMode('ai-review');
  },
  openComposer: (input) => {
    if (applying) return;
    preparation?.abort();
    analysisEpoch++;
    rememberReturnMode();
    cancelViewRuns();
    set({
      view: 'composer',
      composerInput: { ...input, workspaceId: useAppStore.getState().snapshot?.workspace.id ?? '' },
      source: undefined,
    });
    useAppStore.getState().setMode('ai-composer');
  },
}));
export function aiWorkspaceChanged(workspaceId?: string) {
  const current = useAiStore.getState();
  const owner = current.view === 'review' ? current.reviewRequest?.workspaceId : current.composerInput?.workspaceId;
  if (workspaceId !== undefined && owner === workspaceId) return;
  preparation?.abort();
  analysisEpoch++;
  for (const key of controllers.keys()) current.cancel(key);
  useAiStore.setState({
    view: undefined,
    reviewRequest: undefined,
    composerInput: undefined,
    source: undefined,
    runs: {},
  });
}
async function review() {
  const s = useAiStore.getState();
  if (!s.reviewRequest) return;
  emit({
    type: 'CODE_REVIEW_PHASE',
    phase: 'scanning',
    detail: t('Scan changes'),
    fileCount: (s.reviewRequest.candidates ?? []).reduce((n, c) => n + c.paths.length, 0),
    repositoryCount: new Set((s.reviewRequest.candidates ?? []).map((c) => c.repoId)).size,
  });
  const request = { ...s.reviewRequest, requestId: crypto.randomUUID() };
  const result = await s.generate('review', request);
  if (useAiStore.getState().view !== 'review' || useAiStore.getState().runs.review?.id !== request.requestId) return;
  if (result?.review) {
    const findings: CodeReviewFinding[] = result.review.findings.map((finding) => ({
      ...finding,
      severity: finding.severity as CodeReviewSeverity,
      repoId: finding.anchor.repoId,
      repoName: finding.anchor.repoName,
      filePath: finding.anchor.filePath,
      source: finding.anchor.staged ? 'staged' : 'working',
      oldLine: finding.anchor.oldLine ?? undefined,
      newLine: finding.anchor.newLine ?? undefined,
    }));
    emit({
      type: 'CODE_REVIEW_RESULT',
      fileCount: result.fileCount,
      repositoryCount: result.repositoryCount,
      report: { ...result.review, findings } as CodeReviewReport,
      provider: result.provider,
      model: result.model,
      promptSource: result.promptSource,
      durationMs: result.durationMs,
      truncated: result.inputTruncated,
    });
  } else if (useAiStore.getState().runs.review?.phase !== 'cancelled')
    emit({ type: 'CODE_REVIEW_ERROR', error: useAiStore.getState().runs.review?.error ?? 'AI review failed' });
}
async function composer() {
  if (applying) return;
  const s = useAiStore.getState();
  const input = s.composerInput;
  if (!input) return;
  preparation?.abort();
  cancelViewRuns();
  const control = new AbortController();
  preparation = control;
  const epoch = ++analysisEpoch;
  const owner = bridge();
  const active = () =>
    !control.signal.aborted &&
    analysisEpoch === epoch &&
    useAiStore.getState().composerInput === input &&
    useAiStore.getState().view === 'composer' &&
    useAppStore.getState().bridge === owner;
  emit({ type: 'COMPOSER_PHASE', phase: 'scanning' });
  try {
    const source = await owner.request<AiComposerSource>(
      {
        type: 'aiComposerPrepare',
        payload: {
          workspace_id: input.workspaceId,
          repo_id: input.repoId,
          paths: input.paths,
          staged_only: input.stagedOnly,
          hashes: input.hashes,
        },
      },
      { signal: control.signal, timeoutMs: 300_000 },
    );
    if (!active()) return;
    useAiStore.setState({ source });
    emit({ type: 'COMPOSER_SOURCE', source });
    const result = await s.generate(
      'composer',
      aiRequest('commit-composer', {
        workspaceId: input.workspaceId,
        repoId: input.repoId,
        sessionId: source.sessionId,
      }),
    );
    if (!active()) return;
    if (result)
      emit({
        type: 'COMPOSER_PLAN',
        groups: result.groups.map((g) => ({ ...g, rationale: g.rationale ?? '' })),
        provider: result.provider,
        model: result.model,
        promptSource: result.promptSource,
      });
    else emit({ type: 'COMPOSER_ERROR', error: useAiStore.getState().runs.composer?.error ?? 'Analysis stopped' });
  } catch (error) {
    if (active()) emit({ type: 'COMPOSER_ERROR', error: errorText(error) });
  } finally {
    if (preparation === control) preparation = undefined;
  }
}
export function sendAiView(message: ComposerToHostMsg | CodeReviewToHostMsg): void {
  const s = useAiStore.getState();
  if (message.type === 'CODE_REVIEW_READY' && s.runs.review?.result?.review) {
    const result = s.runs.review.result;
    emit({
      type: 'CODE_REVIEW_RESULT',
      fileCount: result.fileCount,
      repositoryCount: result.repositoryCount,
      report: {
        ...result.review!,
        findings: result.review!.findings.map((f) => ({
          ...f,
          severity: f.severity as CodeReviewSeverity,
          repoId: f.anchor.repoId,
          repoName: f.anchor.repoName,
          filePath: f.anchor.filePath,
          source: f.anchor.staged ? 'staged' : 'working',
          oldLine: f.anchor.oldLine ?? undefined,
          newLine: f.anchor.newLine ?? undefined,
        })),
      } as CodeReviewReport,
      provider: result.provider,
      model: result.model,
      promptSource: result.promptSource,
      durationMs: result.durationMs,
      truncated: result.inputTruncated,
    });
  } else if (message.type === 'CODE_REVIEW_READY' || message.type === 'CODE_REVIEW_RERUN') void review();
  else if (message.type === 'COMPOSER_READY' || message.type === 'COMPOSER_REANALYZE') void composer();
  else if (message.type === 'CODE_REVIEW_CANCEL') {
    s.cancel('review');
    emit({ type: 'CODE_REVIEW_CANCELLED' });
  } else if (message.type === 'COMPOSER_CANCEL') {
    preparation?.abort();
    analysisEpoch++;
    cancelViewRuns();
    emit({ type: 'COMPOSER_ERROR', error: 'Analysis stopped' });
  } else if (message.type === 'COMPOSER_CLOSE' || message.type === 'CODE_REVIEW_CLOSE') s.close();
  else if (message.type === 'COMPOSER_CANCEL_MESSAGE') s.cancel(`message:${message.requestId}`);
  else if (message.type === 'COMPOSER_GENERATE_MESSAGE') {
    const source = s.source;
    if (!source) return;
    const active = () => useAiStore.getState().source === source && useAiStore.getState().view === 'composer';
    void s
      .generate(
        `message:${message.requestId}`,
        aiRequest('commit-message', { repoId: source.repoId, sessionId: source.sessionId, unitIds: message.unitIds }),
        (text) => {
          if (active()) emit({
            type: 'COMPOSER_MESSAGE_UPDATE',
            requestId: message.requestId,
            groupId: message.groupId,
            message: text,
          });
        },
      )
      .then((result) => {
        if (active()) emit({
          type: 'COMPOSER_MESSAGE_RESULT',
          requestId: message.requestId,
          groupId: message.groupId,
          message: result?.text,
          error: result ? undefined : useAiStore.getState().runs[`message:${message.requestId}`]?.error,
        });
      });
  } else if (message.type === 'COMPOSER_APPLY') {
    const source = s.source;
    const input = s.composerInput;
    if (!source || !input || applying) return;
    applying = true;
    emit({ type: 'COMPOSER_PHASE', phase: 'applying', detail: t('Applying AI commit plan') });
    const owner = bridge();
    const unsubscribe = owner.subscribe((event) => {
      if (
        useAiStore.getState().composerInput !== input ||
        !('operationId' in event) ||
        event.context.workspaceId !== input.workspaceId ||
        event.context.repositoryId !== input.repoId ||
        event.phase !== 'applyingAiCommits'
      )
        return;
      emit({
        type: 'COMPOSER_APPLY_PROGRESS',
        completed: event.completed ?? 0,
        total: event.total ?? message.groups.length,
        message: event.message.split('\n')[0],
      });
    });
    void owner
      .request<AiApplyResult>(
        {
          type: 'aiComposerApply',
          payload: {
            workspace_id: input.workspaceId,
            repo_id: input.repoId,
            session_id: source.sessionId,
            groups: message.groups,
            no_verify: useAppStore.getState().bootstrap?.state.settings?.noVerify ?? false,
          },
        },
        { timeoutMs: 1_800_000, showProgress: true },
      )
      .then(async (result) => {
        if (useAiStore.getState().composerInput === input) emit({ type: 'COMPOSER_APPLY_RESULT', result });
        await useAppStore.getState().refresh();
      })
      .catch((error) => emit({ type: 'COMPOSER_ERROR', error: errorText(error) }))
      .finally(() => {
        unsubscribe();
        applying = false;
      });
  } else if (message.type === 'CODE_REVIEW_OPEN_DIFF') {
    const finding = message.finding;
    const workspaceId = s.reviewRequest?.workspaceId;
    if (!workspaceId) return;
    void bridge()
      .request({ type: 'aiReviewLocate', payload: { workspace_id: workspaceId, anchor: finding.anchor } })
      .then((diff) => {
        if (
          useAiStore.getState().view !== 'review' ||
          useAiStore.getState().reviewRequest !== s.reviewRequest ||
          useAppStore.getState().snapshot?.workspace.id !== workspaceId
        )
          return;
        useAppStore.setState({
          selectedFile: { repoId: finding.repoId, path: finding.filePath, staged: finding.source === 'staged' },
          diff: diff as import('../bindings/generated').DiffDocument,
          diffReveal: { line: finding.newLine ?? finding.oldLine ?? 1, side: finding.newLine ? 'new' : 'old' },
          mode: 'diff',
          diffReturnMode: 'ai-review',
        });
      })
      .catch(() => emit({ type: 'CODE_REVIEW_STALE', finding }));
  }
}

export async function generateHistoricalMessage(
  commits: AiCommit[],
  signal: AbortSignal,
  onMessage: (text: string) => void,
): Promise<string> {
  const request = aiRequest('commit-message', { commits });
  const key = `historical-message:${request.requestId}`;
  const cancel = () => useAiStore.getState().cancel(key);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const result = await useAiStore.getState().generate(key, request, onMessage);
    if (!result) throw new Error(useAiStore.getState().runs[key]?.error ?? 'Generation stopped');
    return result.text;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function reviewCandidates(candidates: AiCandidate[]): AiCandidate[] {
  const repositories = useAppStore.getState().snapshot?.repositories ?? [];
  return candidates.flatMap((candidate) => {
    const repo = repositories.find((r) => r.meta.id === candidate.repoId);
    if (!repo || repo.meta.kind !== 'git' || candidate.stagedOnly) return [candidate];
    const staged = candidate.paths.filter((path) => repo.files.some((f) => f.path === path && f.staged));
    const working = candidate.paths.filter(
      (path) => !repo.files.some((f) => f.path === path) || repo.files.some((f) => f.path === path && f.unstaged),
    );
    return [
      ...(staged.length ? [{ ...candidate, paths: staged, stagedOnly: true }] : []),
      ...(working.length ? [{ ...candidate, paths: working, stagedOnly: false }] : []),
    ];
  });
}

export function explanationKey(commits: AiCommit[]) {
  return `explanation:${useAppStore.getState().snapshot?.workspace.id}:${commits.map(c => `${c.repoId}:${c.hash}`).join(',')}`;
}
export async function openCommitExplanation(commits: import('../bindings/generated').CommitNode[]) {
  if (!commits.length) return;
  const workspace = useAppStore.getState().snapshot?.workspace.id;
  const keys = commits.map(c => `${c.repoId}:${c.hash}`).join(',');
  const selectionKeys = () => useAppStore.getState().selectedCommits.map(c => `${c.repoId}:${c.hash}`).join(',');
  if (selectionKeys() !== keys) {
    if (commits.length !== 1) return;
    await useAppStore.getState().selectCommit(commits[0]);
  }
  if (workspace !== useAppStore.getState().snapshot?.workspace.id || selectionKeys() !== keys) return;
  useAppStore.getState().openCommitDetail();
  const targets = commits.map(c => ({ repoId: c.repoId, hash: c.hash }));
  void useAiStore.getState().generate(explanationKey(targets), aiRequest('commit-explanation', { commits: targets }));
}
