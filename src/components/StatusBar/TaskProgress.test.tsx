import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, createTranslator } from '../../i18n';
import { createOperationRequestEvent } from '../../platform/bridge';
import { configureTaskProgress, resetTaskProgress, useTaskProgressStore } from '../../progress/taskProgressStore';
import { useAppStore } from '../../store/appStore';
import { OperationStatusBarItem } from './OperationStatusBarItem';

const original = useAppStore.getState();
function renderItem(language: 'en' | 'zh-CN' = 'en') {
  return render(<I18nContext.Provider value={{ language, preference: language === 'en' ? 'en' : 'zhCn', t: createTranslator(language) }}><OperationStatusBarItem /></I18nContext.Provider>);
}
function start(id = 'push', workspaceId = 'current', total: number | null = null) {
  const event = createOperationRequestEvent({ type: 'sync', payload: { workspace_id: workspaceId, repo_id: 'repo', action: 'push', remote: null, branch: null } }, {}, id);
  const store = useTaskProgressStore.getState();
  store.requested(event, { workspaceName: workspaceId === 'current' ? 'Project' : 'Other Project', repoName: 'Very long repository name' });
  store.operation({ operationId: id, context: event.context, status: 'running', phase: 'pushing', message: 'Pushing repository changes', startedAt: '', cancellable: true, completed: total === null ? null : 2, total, error: null });
  return event;
}
const delay = (ms = 250) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers(); configureTaskProgress(async () => true);
  useAppStore.setState({ snapshot: { workspace: { id: 'current', name: 'Project', paths: ['/tmp/project'], available: true, lastOpenedAt: '' }, repositories: [], generation: 1, tools: { git: true, svn: true, svnadmin: true } } });
});
afterEach(() => { cleanup(); resetTaskProgress(); useAppStore.setState(original); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('task progress entry and details', () => {
  it('appears once after 250 ms even while native phases update every 50 ms', () => {
    renderItem(); let event!: ReturnType<typeof start>;
    act(() => { event = start(); });
    for (let i = 0; i < 4; i++) { delay(50); act(() => useTaskProgressStore.getState().operation({ operationId: 'push', context: event.context, status: 'running', phase: 'pushing', message: `phase ${i}`, startedAt: '', cancellable: true, completed: null, total: null, error: null })); }
    expect(screen.queryByRole('button', { name: 'Task progress' })).toBeNull();
    delay(50); expect(screen.getByRole('button', { name: 'Task progress' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('uses actual totals, shows a terminal result for 2 seconds and does not flash later fast tasks', () => {
    renderItem(); act(() => start('batch', 'current', 5)); delay();
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
    act(() => useTaskProgressStore.getState().settled({ type: 'operation-settled', progressEvent: true, requestId: 'batch' }));
    expect(screen.getByText('Completed')).toBeInTheDocument(); delay(2000);
    expect(screen.queryByRole('button', { name: 'Task progress' })).toBeNull();
    act(() => start('fast')); delay(50);
    act(() => useTaskProgressStore.getState().settled({ type: 'operation-settled', progressEvent: true, requestId: 'fast' })); delay(250);
    expect(screen.queryByRole('button', { name: 'Task progress' })).toBeNull();
  });

  it('prioritizes the current project and allows viewing other tasks without switching projects', () => {
    renderItem(); act(() => { start('other', 'other'); start('current'); }); delay();
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    expect(screen.getByRole('dialog').parentElement).toBe(document.body);
    expect(screen.queryByText('Other Project · Very long repository name')).toBeNull();
    fireEvent.keyDown(screen.getByRole('tab', { name: /Current Project/ }), { key: 'ArrowRight' });
    expect(screen.getByText('Other Project · Very long repository name')).toBeInTheDocument();
    expect(useAppStore.getState().snapshot?.workspace.id).toBe('current');
  });

  it('shows an other-project summary when all tasks belong elsewhere', () => {
    renderItem(); act(() => start('other', 'other')); delay();
    expect(screen.getByText('Other projects · 1 tasks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    expect(screen.getByRole('tab', { name: /All Projects/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Other Project · Very long repository name')).toBeInTheDocument();
  });

  it('retains session results in an open panel without leaving a completed footer forever', () => {
    renderItem(); act(() => start()); delay();
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    act(() => useTaskProgressStore.getState().settled({ type: 'operation-settled', progressEvent: true, requestId: 'push' })); delay(3000);
    expect(screen.getByRole('dialog')).toHaveTextContent('Completed');
    expect(screen.queryByRole('button', { name: 'Task progress' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(useTaskProgressStore.getState().tasks).toEqual({});
  });

  it('clears closed session results even while the footer still shows the two-second terminal state', () => {
    renderItem(); act(() => start()); delay();
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    act(() => useTaskProgressStore.getState().settled({ type: 'operation-settled', progressEvent: true, requestId: 'push' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Task progress' })).toHaveTextContent('Completed');
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('No tasks in progress');
  });
  it('retains tasks that start and finish between renders while the panel is open', () => {
    renderItem(); act(() => start()); delay();
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    act(() => { start('fast'); useTaskProgressStore.getState().settled({ type: 'operation-settled', progressEvent: true, requestId: 'fast' }); });
    expect(screen.getByRole('dialog')).toHaveTextContent('Completed');
  });
  it('hands off to the next active task without a second appearance delay and follows project switches', () => {
    renderItem(); act(() => { start('current'); start('other', 'other', 5); }); delay();
    expect(screen.queryByText('2/5')).toBeNull();
    act(() => useTaskProgressStore.getState().settled({ type: 'operation-settled', progressEvent: true, requestId: 'current' }));
    expect(screen.getByRole('button', { name: 'Task progress' })).toHaveTextContent('Other projects');
    act(() => useAppStore.setState({ snapshot: { ...useAppStore.getState().snapshot!, workspace: { ...useAppStore.getState().snapshot!.workspace, id: 'other' } } }));
    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('closes on outside pointer events and retains focus on the clicked external control', () => {
    renderItem(); act(() => start()); delay();
    fireEvent.click(screen.getByRole('button', { name: 'Task progress' }));
    const external = document.createElement('button'); document.body.append(external); external.focus();
    fireEvent.pointerDown(external);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(external).toHaveFocus(); external.remove();
  });
  it('shows translated aggregate child details and cancellation controls', () => {
    const cancel = vi.fn(async () => true); configureTaskProgress(cancel);
    renderItem('zh-CN');
    let id = ''; act(() => { id = useTaskProgressStore.getState().beginGroup('Update Project', 'current', 'Project', [{ id: 'repo', name: 'Repo A' }, { id: 'next', name: 'Repo B' }]); }); delay();
    fireEvent.click(screen.getByRole('button', { name: '任务进度' }));
    fireEvent.click(screen.getByRole('button', { name: /仓库/ }));
    expect(screen.getByText('Repo B')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    expect(useTaskProgressStore.getState().isStopped(id)).toBe(true);
    expect(screen.getByText('正在等待操作结束并恢复本地修改。')).toBeInTheDocument();
  });

  it('returns focus to the entry on close and exposes native progress semantics', () => {
    renderItem(); act(() => start()); delay();
    const entry = screen.getByRole('button', { name: 'Task progress' });
    fireEvent.click(entry); expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' }); expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(entry).toHaveFocus();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Processing');
  });
});
