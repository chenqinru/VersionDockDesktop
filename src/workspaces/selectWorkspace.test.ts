import { afterEach, expect, it, vi } from 'vitest';
import { MockBridge } from '../platform/bridge';
import * as dialogs from '../components/dialogService';
import { selectWorkspacePaths } from './selectWorkspace';

afterEach(() => vi.restoreAllMocks());

it('preserves an active dialog when the open shortcut is repeated', async () => {
  const resolve = vi.fn();
  const request: dialogs.DialogRequest = { kind: 'choice', title: 'Open Workspace', message: '', resolve };
  dialogs.publishDialog(request);
  const bridge = new MockBridge(() => undefined);
  const picker = vi.spyOn(bridge, 'selectWorkspaceFolders');
  try {
    expect(await selectWorkspacePaths(bridge, value => value)).toEqual([]);
    expect(dialogs.currentDialog()).toBe(request);
    expect(picker).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  } finally { dialogs.publishDialog(undefined); }
});

it.each(['folders', 'file'])('returns no paths when the %s native picker is canceled', async (kind) => {
  vi.spyOn(dialogs, 'choiceDialog').mockResolvedValue(kind);
  const bridge = new MockBridge(() => undefined);
  vi.spyOn(bridge, 'selectWorkspaceFolders').mockResolvedValue([]);
  vi.spyOn(bridge, 'selectWorkspaceFile').mockResolvedValue(null);
  expect(await selectWorkspacePaths(bridge, value => value)).toEqual([]);
});
