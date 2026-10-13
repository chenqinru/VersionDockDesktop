import { afterEach, expect, it, vi } from 'vitest';
import type { CommitNode, HistoryPage } from '../bindings/generated';
import { authorAvatarKey, authorAvatarRemoteScope, peekAuthorAvatar } from '../avatars/authorAvatarResolver';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from './appStore';
import { DEFAULT_SETTINGS } from '../settings/defaults';

const initial = useAppStore.getState();
afterEach(() => {
  useAppStore.getState().dispose();
  useAppStore.setState(initial, true);
  window.dispatchEvent(new Event('versiondock-avatar-cache-clear'));
});
const commit: CommitNode = {repoId:'repo',hash:'a',shortHash:'a',parents:[],author:'huguoliang',email:'915860729@qq.com',authorDate:'',committerDate:'',message:'Commit',refs:[]};
const page: HistoryPage = {commits:[commit],hasMore:false,avatars:{'email:915860729@qq.com':'data:image/png;base64,cached'}};
function setup(history: () => HistoryPage | Promise<HistoryPage>, online = true) {
  const request = vi.fn(command => command.type === 'history' ? history() : []);
  const bridge = new MockBridge(request);
  const repository = {meta:{id:'repo',name:'Repository',rootPath:'/tmp/repo',kind:'git',color:'',depth:0,isWorktree:false,isSubmodule:false},branch:'main',files:[],conflicts:0,ahead:0,behind:0,operation:null};
  useAppStore.setState({ bridge, bootstrap:{state:{settings:{...DEFAULT_SETTINGS,onlineAvatarsEnabled:online,gravatarEnabled:false,avatarCrossPlatformFallback:false}}} as never, snapshot:{workspace:{id:'workspace'},repositories:[repository]} as never, allRepositories:[repository] as never, mode:'changes',historyScope:{repoIds:null,revisionsByRepo:{}}, remotes:{},branchesByRepo:{} });
  return { request, key: authorAvatarKey({bridge,workspaceId:'workspace',repoId:'repo',remoteScope:authorAvatarRemoteScope('main'),gravatar:false,crossPlatformFallback:false},commit.email,commit.author) };
}
it('hydrates author cache from a history page before exposing the commits', async () => {
  const {key} = setup(() => page);
  await useAppStore.getState().loadHistory(true, true);
  expect(useAppStore.getState().history).toEqual([commit]);
  expect(peekAuthorAvatar(key)).toContain('cached');
});
it.each(['clear', 'switch'] as const)('discards stale page avatar cache after %s', async action => {
  let resolve!: (page: HistoryPage) => void;
  const pending = new Promise<HistoryPage>(done => {resolve=done;});
  const {key,request} = setup(() => pending);
  const loading = useAppStore.getState().loadHistory(true, true);
  await vi.waitFor(() => expect(request).toHaveBeenCalled());
  if (action === 'clear') window.dispatchEvent(new Event('versiondock-avatar-cache-clear'));
  else useAppStore.setState({snapshot:{workspace:{id:'other'},repositories:[]} as never});
  resolve(page); await loading;
  expect(peekAuthorAvatar(key)).toBeNull();
});
it('does not hydrate remote avatars when online avatars are disabled', async () => {
  const {key} = setup(() => page, false);
  await useAppStore.getState().loadHistory(true, true);
  expect(peekAuthorAvatar(key)).toBeNull();
});
