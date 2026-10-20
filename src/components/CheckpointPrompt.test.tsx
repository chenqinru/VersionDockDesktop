import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MockBridge } from '../platform/bridge';
import { useAppStore } from '../store/appStore';
import type { CheckpointMessage, WorkspaceSnapshot } from '../bindings/generated';
import { CheckpointPrompt } from './CheckpointPrompt';
const original = useAppStore.getState();
afterEach(() => { cleanup(); useAppStore.setState(original, true); vi.restoreAllMocks(); });
function messages(body: string): CheckpointMessage[] { return [{ body, annotations: [], attachments: [], selections: [], raw: null }]; }
function setup() {
  const bridge = new MockBridge(() => []);
  useAppStore.setState({ bridge, snapshot: { workspace: { id: 'ws' } } as WorkspaceSnapshot });
  return bridge;
}
it('shows exact multiline text without treating message contents as HTML', async () => {
  const bridge = setup();
  const message = '修复地图\n\n<script>window.bad = true</script>\n  保留缩进';
  const request = vi.spyOn(bridge, 'request').mockResolvedValue(messages(message));
  const { container } = render(<CheckpointPrompt taskId="task" checkpointId="point" />);
  await waitFor(() => expect(container.querySelector('pre')?.textContent).toBe(message));
  expect(container.querySelector('script')).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledWith({ type: 'checkpoint', payload: { workspace_id: 'ws', action: { type: 'messages', task_id: 'task', checkpoint_id: 'point' } } }, expect.anything());
});
it('cancels the previous request when the selected message changes', async () => {
  const bridge = setup();
  let first!: (message: CheckpointMessage[]) => void;
  let signal: AbortSignal | undefined;
  vi.spyOn(bridge, 'request').mockImplementationOnce((_command, options) => { signal = options?.signal; return new Promise(resolve => { first = resolve; }); }).mockResolvedValue(messages('new message'));
  const view = render(<CheckpointPrompt taskId="task" checkpointId="first" />);
  view.rerender(<CheckpointPrompt taskId="task" checkpointId="second" />);
  expect(signal?.aborted).toBe(true);
  expect(await screen.findByText('new message')).toBeInTheDocument();
  await act(async () => first(messages('old message')));
  expect(screen.queryByText('old message')).not.toBeInTheDocument();
});
it('offers retry on failure and handles missing messages', async () => {
  const bridge = setup();
  vi.spyOn(bridge, 'request').mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue([]);
  render(<CheckpointPrompt taskId="task" checkpointId="point" />);
  expect(await screen.findByText('Read failed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No message was saved for this checkpoint.')).toBeInTheDocument();
});
it('refreshes an expanded message when the same turn receives another prompt', async () => {
  const bridge = setup();
  const request = vi.spyOn(bridge, 'request').mockResolvedValueOnce(messages('Original message')).mockResolvedValue([...messages('Original message'), ...messages('Additional message')]);
  const view = render(<CheckpointPrompt taskId="task" checkpointId="same-turn" revision="first" />);
  expect(await screen.findByText('Original message')).toBeInTheDocument();
  view.rerender(<CheckpointPrompt taskId="task" checkpointId="same-turn" revision="second" />);
  expect(await screen.findByText(/Additional message/)).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps comments visible and collapses references, attachments and raw envelopes', async () => {
  const bridge = setup();
  vi.spyOn(bridge, 'request').mockResolvedValue([{ body: '一起优化', annotations: [{ text: '<script>原文</script>', annotation: '那要怎么优化？' }], attachments: [{ name: '截图.png', path: '/tmp/中文 路径/截图.png', image: true }], selections: ['Selection 1: /tmp/a.ts (line 1)\n引用代码'], raw: '# Response annotations: 原始消息' }]);
  const { container } = render(<CheckpointPrompt taskId="task" checkpointId="point" />);
  expect(await screen.findByText('一起优化')).toBeVisible();
  expect(screen.getByText('那要怎么优化？')).toBeVisible();
  expect(container.querySelectorAll('details')).toHaveLength(4);
  for (const detail of container.querySelectorAll('details')) expect(detail.open).toBe(false);
  expect(container.querySelector('script')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Quoted text'));
  expect(screen.getByText('<script>原文</script>').closest('details')?.open).toBe(true);
  expect(screen.getByText('/tmp/中文 路径/截图.png').closest('details')?.open).toBe(false);
});
