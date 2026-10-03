import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogHost } from './DialogHost';
import { editorDialog, promptDialog, publishDialog } from './dialogService';

afterEach(() => {
  publishDialog(undefined);
  cleanup();
});

describe('DialogHost editor', () => {
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
    fireEvent.click(screen.getByTitle('Stop generating'));
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
