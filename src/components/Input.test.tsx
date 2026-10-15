import { createRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from './Input';
import { Textarea } from './Textarea';
import { FormField } from './FormField';
import { SearchInput } from './SearchInput';

afterEach(cleanup);

describe('输入组件原生行为', () => {
  it('保留受控输入、ref、密码和原生属性', () => {
    const ref = createRef<HTMLInputElement>();
    function Example() {
      const [value, setValue] = useState('initial');
      return <Input ref={ref} type="password" name="token" autoComplete="off" size={12} value={value} onChange={event => setValue(event.target.value)} aria-label="Token" />;
    }
    render(<Example />);
    const input = screen.getByLabelText('Token');
    expect(ref.current).toBe(input);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('name', 'token');
    expect(input).toHaveAttribute('size', '12');
    fireEvent.change(input, { target: { value: 'changed' } });
    expect(input).toHaveValue('changed');
    ref.current?.focus();
    ref.current?.setSelectionRange(1, 3);
    expect(input).toHaveFocus();
    expect(ref.current?.selectionStart).toBe(1);
  });

  it('完整透传中文输入法和按键事件，业务决定提交时机', () => {
    const events: string[] = [];
    render(<Input aria-label="Query" onCompositionStart={() => events.push('start')} onCompositionEnd={event => events.push(event.currentTarget.value)} onKeyDown={event => events.push(event.nativeEvent.isComposing ? 'composing' : event.key)} />);
    const input = screen.getByLabelText('Query');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中文' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(events).toEqual(['start', 'composing', '中文', 'Enter']);
  });

  it('关联说明与错误，解除错误时保留输入值和稳定 id', () => {
    const field = (error?: string) => <><small id="external">External hint</small><FormField label="Name" description="Description" error={error} required><Input defaultValue="draft" aria-describedby="external" /></FormField></>;
    const { rerender } = render(field('Invalid name'));
    const input = screen.getByRole('textbox', { name: 'Name' });
    const id = input.id;
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('External hint Description Invalid name');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid name');
    rerender(field());
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input);
    expect(input.id).toBe(id);
    expect(input).toHaveValue('draft');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('External hint Description');
  });

  it('保留显式 id、只读与多行选择，同时继承 fieldset 禁用', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<><FormField id="notes" label="Notes"><Textarea ref={ref} id="notes" rows={5} defaultValue="first\nsecond" readOnly /></FormField><fieldset disabled><Input aria-label="Locked" defaultValue="locked" /></fieldset></>);
    const notes = screen.getByLabelText('Notes');
    expect(ref.current).toBe(notes);
    expect(notes).toHaveAttribute('rows', '5');
    expect(notes).toHaveAttribute('readonly');
    ref.current?.setSelectionRange(0, 5);
    expect(ref.current?.selectionEnd).toBe(5);
    expect(screen.getByLabelText('Locked')).toBeDisabled();
  });
});

describe('搜索框清空与焦点', () => {
  it('调用业务清空回调并恢复焦点，不伪造 change 事件', () => {
    const ref = createRef<HTMLInputElement>();
    const change = vi.fn();
    const clear = vi.fn();
    render(<SearchInput ref={ref} aria-label="Search" value="query" onChange={change} onClear={clear} clearLabel="Clear" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clear).toHaveBeenCalledOnce();
    expect(change).not.toHaveBeenCalled();
    expect(ref.current).toBe(screen.getByLabelText('Search'));
    expect(ref.current).toHaveFocus();
  });

  it('空值和只读时隐藏清空，禁用时阻止清空', () => {
    const clear = vi.fn();
    const { rerender } = render(<SearchInput aria-label="Search" value="" onChange={() => {}} onClear={clear} clearLabel="Clear" />);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    rerender(<SearchInput aria-label="Search" value="query" readOnly onClear={clear} clearLabel="Clear" />);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    rerender(<SearchInput aria-label="Search" value="query" disabled onChange={() => {}} onClear={clear} clearLabel="Clear" />);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clear).not.toHaveBeenCalled();
  });
});
