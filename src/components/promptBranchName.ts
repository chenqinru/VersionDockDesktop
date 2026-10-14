import { promptDialog, type DialogRequest } from './dialogService';
import { sanitizeBranchName } from '../history/branchProtection';
import { useAppStore } from '../store/appStore';
import { aiRequest } from '../ai/aiStore';
import { aiErrorText } from '../ai/errors';
import { t } from '../ai/i18n';
import type { AiResult } from '../bindings/generated';

export async function promptBranchName(repoIds: string[], options: Omit<DialogRequest, 'kind' | 'resolve'>): Promise<string | null> {
  const state = useAppStore.getState();
  const owner = state.bridge;
  const wid = state.snapshot?.workspace.id;
  const tab = state.activeTabId;
  const ids = [...new Set(repoIds)];
  if (!owner || !wid || !ids.length || !ids.every(id => state.snapshot?.repositories.some(r => r.meta.id === id && r.meta.kind === 'git'))) return promptDialog(options);
  const ensureOwner = () => {
    if (useAppStore.getState().bridge !== owner || useAppStore.getState().snapshot?.workspace.id !== wid || useAppStore.getState().activeTabId !== tab || !ids.every(id => useAppStore.getState().snapshot?.repositories.some(r => r.meta.id === id))) throw new Error(t('Repository context changed. Reopen the branch dialog.'));
  };
  const name = await promptDialog({
    ...options,
    validateInput: async input => {
      ensureOwner();
      const local = await options.validateInput?.(input);
      if (local) return local;
      try {
        for (const id of ids) await owner.request({ type: 'validateBranchName', payload: {workspace_id:wid, repo_id:id, name:sanitizeBranchName(input.trim())} }, {showProgress:false});
        ensureOwner();
      } catch (error) { return aiErrorText(error); }
    },
    generateBranchName: state.bootstrap?.capabilities.ai ? async (description, signal) => {
      ensureOwner();
      const control = new AbortController();
      const abort = () => control.abort();
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) control.abort();
      const unsubscribe = useAppStore.subscribe(next => { if (next.bridge !== owner || next.snapshot?.workspace.id !== wid || next.activeTabId !== tab || !ids.every(id => next.snapshot?.repositories.some(r => r.meta.id === id))) control.abort(); });
      try {
        const result = await owner.request<AiResult>({type:'aiGenerate', payload:{request:aiRequest('branch-name', {workspaceId:wid, candidates:ids.map(repoId => ({repoId, paths:[], stagedOnly:false})), userPrompt:description})}}, {signal:control.signal, showProgress:false, timeoutMs:1_860_000});
        ensureOwner();
        return result.text;
      } catch (error) { throw new Error(aiErrorText(error)); }
      finally { unsubscribe(); signal.removeEventListener('abort', abort); }
    } : undefined,
  });
  if (name === null) return null;
  ensureOwner();
  return sanitizeBranchName(name.trim());
}
