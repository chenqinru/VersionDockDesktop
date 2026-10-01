import { useCallback, useEffect, useRef, useState } from 'react';

// The detail panel keeps its editable search open until Escape, as the plugin does.
export function useFileSearch(scopeSelector: string, onNavigate: (direction: -1 | 1) => void) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const clear = useCallback(() => {
    setQuery('');
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="menu"], [role="dialog"]')) return;
      const panel = document.querySelector(scopeSelector);
      const active = document.activeElement;
      if (!panel || (!panel.matches(':hover') && !panel.contains(active))) return;
      const editable = event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || (event.target instanceof HTMLElement && event.target.isContentEditable);
      const inSearch = event.target === inputRef.current;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (!isOpen) triggerRef.current = active instanceof HTMLElement ? active : null;
        setIsOpen(true);
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || (editable && !inSearch)) return;
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        clear();
      } else if (isOpen && (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        onNavigate(event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1);
      } else if (!editable) {
        // Preserve normal activation of buttons and type-to-search elsewhere in the panel.
        if (event.target instanceof HTMLButtonElement && [' ', 'Enter'].includes(event.key)) return;
        if (event.key === 'Backspace' && isOpen) {
          event.preventDefault();
          setQuery((value) => value.slice(0, -1));
        } else if (event.key.length === 1 && (query || event.key.trim())) {
          event.preventDefault();
          if (!isOpen) triggerRef.current = active instanceof HTMLElement ? active : null;
          setIsOpen(true);
          setQuery((value) => value + event.key);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [clear, isOpen, onNavigate, query, scopeSelector]);

  return { query, setQuery, isOpen, inputRef, clear };
}
