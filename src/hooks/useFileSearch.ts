import { useCallback, useEffect, useRef, useState } from 'react';

interface FileSearchOptions { enabled?: boolean; scopeKey?: string; restartOnFind?: boolean }

// Editable file lookup shared by changes, sidebar details and standalone details.
export function useFileSearch(scopeSelector: string, onNavigate: (direction: -1 | 1) => void, { enabled = true, scopeKey, restartOnFind = false }: FileSearchOptions = {}) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const scopeRef = useRef({ scopeKey, enabled });

  const clear = useCallback(() => {
    setQuery('');
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (scopeRef.current.scopeKey === scopeKey && scopeRef.current.enabled === enabled) return;
    scopeRef.current = { scopeKey, enabled };
    const frame = requestAnimationFrame(() => { setQuery(''); setIsOpen(false); });
    return () => cancelAnimationFrame(frame);
  }, [scopeKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const handleKey = (event: KeyboardEvent) => {
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      const findShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === 'f' || event.code === 'KeyF');
      if (!findShortcut && (event.defaultPrevented || event.isComposing)) return;
      const panel = document.querySelector(scopeSelector);
      const active = document.activeElement;
      if (!panel || (!panel.matches(':hover') && !panel.contains(active))) return;
      // Focus in another pane takes precedence over the pointer's hover position.
      if (active instanceof HTMLElement && active.closest('.commit-panel, .commit-detail') && !panel.contains(active)) return;
      const editable = event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement
        || (event.target instanceof HTMLElement && event.target.isContentEditable);
      const inSearch = event.target === inputRef.current;
      if (findShortcut) {
        event.preventDefault();
        event.stopPropagation();
        if (!isOpen) triggerRef.current = active instanceof HTMLElement ? active : null;
        setIsOpen(true);
        if (restartOnFind) setQuery('');
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || (editable && !inSearch)) return;
      if (event.target instanceof HTMLButtonElement && [' ', 'Enter'].includes(event.key)) return;
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        clear();
      } else if (isOpen && (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1);
      } else if (!editable) {
        // Preserve normal activation of buttons and type-to-search elsewhere in the panel.
        if (event.key === 'Backspace' && isOpen) {
          event.preventDefault();
          setQuery((value) => value.slice(0, -1));
        } else if (event.key.length === 1 && event.key !== ' ') {
          event.preventDefault();
          if (!isOpen) triggerRef.current = active instanceof HTMLElement ? active : null;
          setIsOpen(true);
          setQuery(event.key);
          requestAnimationFrame(() => { const input = inputRef.current; if (input) input.setSelectionRange(input.value.length, input.value.length); });
        }
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [clear, enabled, isOpen, onNavigate, query, restartOnFind, scopeSelector]);

  return { query, setQuery, isOpen, inputRef, clear };
}
