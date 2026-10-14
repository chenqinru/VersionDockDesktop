import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogHost } from './DialogHost';
import { editorDialog, promptDialog, publishDialog } from './dialogService';
import { openCommitMessageEditor } from './commitMessageEditor';
import { createTranslator, I18nContext } from '../i18n';

afterEach(() => {
  publishDialog(undefined);
  cleanup();
});

describe('DialogHost editor', () => {
  it('shows the translated generation placeholder before streaming and keeps streamed content on an empty completion', async () => {
    const t = createTranslator('zh-CN');
    render(<I18nContext.Provider value={{ language: 'zh-CN', preference: 'zhCn', t }}><DialogHost /></I18nContext.Provider>);
    let update!: (message: string) => void;
    let complete!: (message: string) => void;
    await act(async () => { void openCommitMessageEditor({ mode: 'squash', repositoryName: 'repo', t, commits: [{ hash: 'old', shortHash: 'old', fullMessage: 'old subject' }, { hash: 'new', shortHash: 'new', fullMessage: 'new subject' }], submit: async () => true, generate: (_signal, onMessage) => { update = onMessage; return new Promise((resolve) => { complete = resolve; }); } }); });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('压缩 2 个提交');
    expect(screen.getByText('正在压缩的提交')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('使用 AI 生成提交信息'));
    expect(screen.getByText('确认压缩')).toBeDisabled();
    const input = screen.getByRole('textbox', { name: '提交信息' });
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', '正在生成提交信息…');
    expect(screen.getByTitle('停止生成提交信息')).toBeInTheDocument();
    await act(async () => { update('subject\n\n第一行正文\n第二行正文'); });
    expect(input).toHaveValue('subject\n\n第一行正文\n第二行正文');
    await act(async () => { complete(''); });
    expect(input).toHaveValue('subject\n\n第一行正文\n第二行正文');
    expect(input).toHaveAttribute('placeholder', '');
    expect(input).not.toHaveAttribute('readonly');
    expect(screen.getByText('确认压缩')).not.toBeDisabled();
  });

  it('keeps the original message readable while editing and places AI inside the input', async () => {
    render(<DialogHost />);
    const submit = vi.fn().mockResolvedValue(true);
    await act(async () => { void openCommitMessageEditor({ mode: 'edit', repositoryName: 'repo', t: (key) => key, commits: [{ hash: 'abc1234', shortHash: 'abc1234', fullMessage: 'subject\n\noriginal body' }], submit, generate: async () => 'generated' }); });
    const editor = screen.getByRole('textbox', { name: 'Commit message' });
    fireEvent.change(editor, { target: { value: 'changed\n\nnew body' } });
    expect(document.querySelector('.dialog-original-message')).toHaveTextContent('original body');
    expect(document.querySelector('.dialog-original-message')?.textContent).toBe('subject\n\noriginal body');
    expect(screen.getByTitle('Generate commit message with AI').closest('.ai-input-surface')).toContainElement(editor);
    expect(screen.getByRole('dialog').querySelector('header .codicon-edit')).not.toBeNull();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('changed\n\nnew body'));
  });

  it('shows complete squash messages separately from the editable combined draft', async () => {
    render(<DialogHost />);
    await act(async () => { void openCommitMessageEditor({ mode: 'squash', repositoryName: 'repo', t: (key) => key, commits: [{ hash: 'old-full-hash', shortHash: 'old', fullMessage: 'first\n\nfirst body' }, { hash: 'new-full-hash', shortHash: 'new', fullMessage: 'second\n\nsecond body' }], submit: async () => true, generate: async () => '' }); });
    const list = screen.getByRole('region', { name: 'Commits being squashed' });
    expect([...list.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['old', 'new']);
    expect(list.querySelector('code')).toHaveAttribute('title', 'old-full-hash');
    expect([...list.querySelectorAll('.dialog-commit-list span')].map((span) => span.textContent)).toEqual(['first\n\nfirst body', 'second\n\nsecond body']);
    expect(screen.getByRole('textbox')).toHaveValue('first\n\nfirst body\n\nsecond\n\nsecond body');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new combined message' } });
    expect(list).toHaveTextContent('first body');
    expect(screen.getByRole('dialog').querySelector('header .codicon-fold')).not.toBeNull();
    expect(screen.getByText('Confirm Squash')).toBeInTheDocument();
  });

  it('does not submit an empty editor through Cmd/Ctrl+Enter', async () => {
    render(<DialogHost />);
    const submit = vi.fn().mockResolvedValue(true);
    await act(async () => { void editorDialog({ title: 'Edit Commit Message', message: '', inputLabel: 'Commit message', submit }); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' \n ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('uses the shared border during historical message generation and restores the draft when stopped', async () => {
    render(<DialogHost />);
    let abort!: () => void;
    await act(async () => { void editorDialog({
      title: 'Edit Commit Message', message: 'repo', inputLabel: 'Commit message', initialValue: 'original draft', submit: async () => true,
      generate: (signal, onMessage) => new Promise<string>((_resolve, reject) => {
        onMessage('partial output');
        abort = () => reject(new DOMException('Stopped', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    }); });
    fireEvent.click(screen.getByTitle('Generate commit message with AI'));
    const editor = screen.getByRole('textbox');
    expect(editor).toHaveAttribute('readonly');
    expect(editor.closest('.ai-input-surface')?.querySelector('.ai-generation-border')).not.toBeNull();
    expect(editor).toHaveValue('partial output');
    fireEvent.click(screen.getByTitle('Stop generating commit message'));
    await waitFor(() => expect(editor).toHaveValue('original draft'));
    expect(editor).not.toHaveAttribute('readonly');
    expect(editor.closest('.ai-input-surface')?.querySelector('.ai-generation-border')).toBeNull();
  });

  it('keeps a multiline commit message after submit failure and supports Cmd/Ctrl+Enter', async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error('rewrite failed')).mockResolvedValueOnce(true);
    render(<DialogHost />);
    await act(async () => { void editorDialog({
      title: 'Edit Commit Message',
      message: 'repo · abc123',
      inputLabel: 'Commit message',
      initialValue: 'subject\n\nbody',
      items: [{ id: 'abc123', label: 'subject' }],
      submit,
    }); });
    const editor = screen.getByRole('textbox');
    expect(editor).toHaveValue('subject\n\nbody');
    fireEvent.change(editor, { target: { value: 'edited\n\nbody' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await screen.findByText('rewrite failed');
    expect(editor).toHaveValue('edited\n\nbody');
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(submit).toHaveBeenCalledTimes(2);
  });
});


describe('DialogHost identity prompts', () => {
  it('masks passwords and preserves intentional whitespace', async () => {
    render(<DialogHost />);
    let result: string | null = null;
    await act(async () => { void promptDialog({ title: 'Password', message: '', inputType: 'password' }).then((value) => { result = value; }); });
    const input = document.querySelector('input')!;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: ' secret ' } });
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(result).toBe(' secret '));
  });
  it('retains reserved-name validation feedback without dismissing the prompt', async () => {
    render(<DialogHost />);
    await act(async () => { void promptDialog({ title: 'Profile', message: '', validateInput: (value) => value === 'Global' ? 'Reserved name' : undefined }); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Global' } });
    fireEvent.click(screen.getByText('Confirm'));
    expect(screen.getByText('Reserved name')).toHaveTextContent('Reserved name');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('keeps a required empty prompt open when Enter is pressed', async () => {
    render(<DialogHost />);
    await act(async () => { void promptDialog({ title: 'Username', message: '' }); });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

});

 it('waits for asynchronous Git validation and keeps invalid input editable', async () => {
    render(<DialogHost />);
    let validate!: (value: string | undefined) => void;
    const finished = vi.fn();
    const validateInput = vi.fn(() => new Promise<string | undefined>(resolve => { validate = resolve; }));
    await act(async () => { void promptDialog({ title: 'New Tag', message: '', validateInput }).then(finished); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'invalid' } });
    fireEvent.click(screen.getByText('Confirm'));
    expect(screen.getByRole('textbox')).toBeDisabled();
    fireEvent.click(screen.getByText('Confirm'));
    expect(validateInput).toHaveBeenCalledTimes(1);
    await act(async () => { validate('Invalid tag'); });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid tag');
    expect(screen.getByRole('textbox')).not.toBeDisabled();
    expect(finished).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByText('Confirm'));
    await act(async () => { validate(undefined); });
    expect(finished).toHaveBeenCalledWith('v1');
  });


describe('AI branch name input', () => {
  it('keeps the manual name when returning from the task input, and returns generated names for editing', async () => {
    const generate = vi.fn().mockResolvedValue('fix/login-timeout');
    const resolve = vi.fn();
    render(<DialogHost />);
    act(() => publishDialog({kind:'prompt', title:'New Branch', message:'', inputLabel:'Branch name', initialValue:'manual/name', generateBranchName:generate, resolve}));
    fireEvent.click(screen.getByTitle('Generate branch name with AI'));
    fireEvent.change(screen.getByLabelText('Task description'), {target:{value:'修复登录超时'}});
    fireEvent.click(screen.getByTitle('Back'));
    expect(screen.getByLabelText('Branch name')).toHaveValue('manual/name');
    fireEvent.click(screen.getByTitle('Generate branch name with AI'));
    fireEvent.click(screen.getByText('Generate branch name with AI'));
    await waitFor(() => expect(screen.getByLabelText('Branch name')).toHaveValue('fix/login-timeout'));
    expect(generate).toHaveBeenCalledWith('修复登录超时', expect.any(AbortSignal));
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Branch name'), {target:{value:'fix/edited-name'}});
    fireEvent.click(screen.getByText('Confirm'));
    expect(resolve).toHaveBeenCalledWith('fix/edited-name');
  });
  it('restores manual naming on failure and cancels pending generation on close', async () => {
    let signal: AbortSignal | undefined;
    const generate = vi.fn().mockRejectedValueOnce(new Error('provider unavailable')).mockImplementation((_description, current) => {signal=current; return new Promise(() => {});});
    render(<DialogHost />);
    act(() => publishDialog({kind:'prompt', title:'New Branch', message:'', inputLabel:'Branch name', initialValue:'manual/name', generateBranchName:generate, resolve:vi.fn()}));
    fireEvent.click(screen.getByTitle('Generate branch name with AI')); fireEvent.click(screen.getByText('Generate branch name with AI'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('provider unavailable'));
    expect(screen.getByLabelText('Branch name')).toHaveValue('manual/name');
    fireEvent.click(screen.getByTitle('Generate branch name with AI')); fireEvent.click(screen.getByText('Generate branch name with AI'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(signal?.aborted).toBe(true);
  });
});


it('allows generating a branch name from changes with both inputs empty', async () => {
  const generate = vi.fn().mockResolvedValue('feat/current-changes');
  render(<DialogHost />);
  act(() => publishDialog({kind:'prompt', title:'New Branch', message:'', inputLabel:'Branch name', generateBranchName:generate, resolve:vi.fn()}));
  fireEvent.click(screen.getByTitle('Generate branch name with AI'));
  expect(screen.getByText('Generate branch name with AI')).not.toBeDisabled();
  fireEvent.click(screen.getByText('Generate branch name with AI'));
  await waitFor(() => expect(screen.getByLabelText('Branch name')).toHaveValue('feat/current-changes'));
  expect(generate).toHaveBeenCalledWith('', expect.any(AbortSignal));
});
