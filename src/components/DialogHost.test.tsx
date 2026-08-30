import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogHost } from './DialogHost';
import { editorDialog, publishDialog } from './dialogService';

afterEach(() => {
  publishDialog(undefined);
  cleanup();
});

describe('DialogHost editor', () => {
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
