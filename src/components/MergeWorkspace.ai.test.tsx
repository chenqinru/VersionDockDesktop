import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MergeWorkspace } from './MergeWorkspace';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import { aiWorkspaceChanged } from '../ai/aiStore';
import type { AiResult } from '../bindings/generated';
const setup = (text: string) => {
  useAppStore.setState({
    bridge:new MockBridge(() => ({ text:'', provider:'fixture', model:'fixture', promptSource:'builtin', inputTruncated:false, durationMs:1, fileCount:1, repositoryCount:1, review:null, resolutions:[{ index:0, lines:[text] }], groups:[] } satisfies AiResult)),
    snapshot:{ workspace:{ id:'ai-merge', name:'ai-merge', paths:['/tmp/audit'], lastOpenedAt:'', available:true }, repositories:[], generation:1, tools:{ git:true, svn:true, svnadmin:true } },
    merge:{ path:'file.txt', base:'base', ours:'ours', theirs:'theirs', working:'', markerContent:'<<<<<<< HEAD\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> feature', conflicts:[{ index:0, oursLabel:'HEAD', theirsLabel:'feature', oursLines:['ours'], baseLines:['base'], theirsLines:['theirs'], startLine:0, endLine:6 }], oursLabel:'HEAD', theirsLabel:'feature', language:'text', fingerprint:'fingerprint', binary:false },
    mergeTarget:undefined, mergeEditorDraft:undefined, mergeResult:'', selectedFile:{ repoId:'repo', path:'file.txt', staged:false }, operations:{},
  });
  return render(<MergeWorkspace />);
};
afterEach(() => { cleanup(); aiWorkspaceChanged(undefined); useAppStore.setState({ snapshot:undefined, bridge:undefined, merge:undefined, mergeEditorDraft:undefined, mergeResult:'', selectedFile:undefined, sessions:{} }); });
it('stopping an animated AI preview restores the original draft and keeps saving blocked', async () => {
  setup('replacement '.repeat(100));
  const original = useAppStore.getState().mergeResult;
  const draft = structuredClone(useAppStore.getState().mergeEditorDraft);
  fireEvent.click(screen.getByRole('button', { name:'Resolve 1 conflicts with AI' }));
  screen.getAllByRole('button', { name:'Accept Current' }).forEach(button => expect(button).toBeDisabled());
  await waitFor(() => expect(screen.getByText('AI is writing conflict 1 of 1…')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name:'Stop AI' }));
  await waitFor(() => expect(useAppStore.getState().mergeResult).toBe(original));
  expect(useAppStore.getState().mergeEditorDraft?.resolutions).toEqual(draft?.resolutions);
  expect(screen.getByRole('button', { name:'Save resolution' })).toBeDisabled();
});
it('finishes AI preview with provenance and leaves application to the user', async () => {
  setup('ours');
  fireEvent.click(screen.getByRole('button', { name:'Resolve 1 conflicts with AI' }));
  await waitFor(() => expect(screen.getByText('AI resolved 1 conflicts. Review the result before applying.')).toBeInTheDocument());
  expect(useAppStore.getState().mergeResult).toBe('ours');
  expect(useAppStore.getState().mergeEditorDraft?.resolutions[0]).toEqual({ type:'custom', lines:['ours'], acceptedSides:['ours'], resolvedByAi:true });
  expect(screen.getByRole('button', { name:'Save resolution' })).toBeEnabled();
});
it('restores a cached workspace draft when leaving during AI typing', async () => {
  const view = setup('replacement '.repeat(100));
  const original = structuredClone(useAppStore.getState().mergeEditorDraft!);
  const originalResult = useAppStore.getState().mergeResult;
  fireEvent.click(screen.getByRole('button', { name:'Resolve 1 conflicts with AI' }));
  await waitFor(() => expect(screen.getByText('AI is writing conflict 1 of 1…')).toBeInTheDocument());
  useAppStore.setState({ sessions:{ old:{ mergeEditorDraft:{ ...original, resolutions:{ 0:{ type:'custom', lines:['partial'] } } }, mergeResult:'partial' } as unknown as import('../store/appStore').WorkspaceSessionState }, mergeEditorDraft:undefined });
  view.unmount();
  expect(useAppStore.getState().sessions.old.mergeEditorDraft).toEqual(original);
  expect(useAppStore.getState().sessions.old.mergeResult).toBe(originalResult);
});
