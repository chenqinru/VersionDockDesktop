import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from './appStore';
import type { RepositoryStatus, WorkspaceSnapshot, WorktreeEntry } from '../bindings/generated';
const initial = useAppStore.getState();
const repo: RepositoryStatus = {meta:{id:'r', name:'R', rootPath:'/tmp/r', kind:'git', color:'', parentRepoId:null, depth:0, isWorktree:false, isSubmodule:false}, branch:'main', revision:'a', ahead:0, behind:0, files:[], conflicts:0, operation:null};
const snapshot: WorkspaceSnapshot = {workspace:{id:'w', name:'W', paths:['/tmp/r'], available:true, lastOpenedAt:''}, generation:1, repositories:[repo], tools:{git:true, svn:true, svnadmin:true}};
const entry = (branch: string): WorktreeEntry => ({path:'/tmp/linked', head:'a', branch, main:false, bare:false, detached:false, locked:false, lockReason:null, prunable:false});
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks(); });
describe('worktree request lifecycle', () => {
  it('keeps the latest list when an older read finishes later', async () => {
    let old: (value: WorktreeEntry[]) => void = () => {};
    let count = 0;
    const bridge = new MockBridge(() => ++count === 1 ? new Promise<WorktreeEntry[]>(resolve => {old=resolve;}) : [entry('fresh')]);
    useAppStore.setState({bridge, snapshot, worktrees:{}, loadErrors:{}});
    const first = useAppStore.getState().loadWorktrees('r');
    await useAppStore.getState().loadWorktrees('r');
    old([entry('stale')]); await first;
    expect(useAppStore.getState().worktrees.r[0].branch).toBe('fresh');
  });
  it('preserves an error from a newer read when an earlier read succeeds', async () => {
    let old: (value: WorktreeEntry[]) => void = () => {};
    let count = 0;
    const bridge = new MockBridge(() => ++count === 1 ? new Promise<WorktreeEntry[]>(resolve => {old=resolve;}) : Promise.reject(new Error('cannot read worktrees')));
    useAppStore.setState({bridge, snapshot, worktrees:{}, loadErrors:{}});
    const first = useAppStore.getState().loadWorktrees('r');
    await useAppStore.getState().loadWorktrees('r');
    old([entry('stale')]); await first;
    expect(useAppStore.getState().loadErrors['worktrees:r']).toBe('cannot read worktrees');
  });
  it('deduplicates writes until completion and clears repository busy state on failure', async () => {
    let reject: (value: Error) => void = () => {};
    const requests: string[] = [];
    const bridge = new MockBridge(command => {requests.push(command.type); return new Promise((_resolve, fail) => {reject=fail;});});
    useAppStore.setState({bridge, snapshot, worktreeBusy:{}, operations:{}, notifications:[]});
    const first = useAppStore.getState().worktreeOperation('r', {type:'prune'});
    await useAppStore.getState().worktreeOperation('r', {type:'prune'});
    expect(requests).toEqual(['worktreeOperation']);
    expect(useAppStore.getState().worktreeBusy['w:r']).toBe(true);
    reject(new Error('worktree failure')); await first;
    expect(useAppStore.getState().worktreeBusy['w:r']).toBeUndefined();
    expect(useAppStore.getState().notifications.at(-1)?.type).toBe('error');
  });
  it('keeps unsaved merge edits when force removal is requested', async () => {
    const requests: string[] = [];
    const bridge = new MockBridge(command => {requests.push(command.type); return true;});
    const linked = {...repo, meta:{...repo.meta, id:'linked', rootPath:'/tmp/linked', isWorktree:true}};
    useAppStore.setState({bridge, snapshot:{...snapshot, repositories:[repo, linked]}, worktreeBusy:{}, notifications:[], mergeTarget:{repoId:'linked', path:'app.ts', workspaceId:'w'}, mergeEditorDraft:{identity:'draft', fingerprint:'f', resolutions:{}, normalEdits:{0:['unsaved content']}, nonConflictingSelections:{}, appliedNonConflictingScope:null, currentConflictIndex:0, syncScrollEnabled:false}});
    await useAppStore.getState().worktreeOperation('r', {type:'remove', path:'/tmp/linked', force:true});
    expect(requests).toEqual([]);
    expect(useAppStore.getState().mergeEditorDraft?.normalEdits[0]).toEqual(['unsaved content']);
    expect(useAppStore.getState().notifications.at(-1)?.type).toBe('error');
  });

});
