import { useEffect, useRef, useState } from 'react';

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

export function useSpeedSearch(
  scopeKey: string,
  enabled = true,
  scopeSelector = '.commit-panel',
  onNavigate?: (direction: -1 | 1) => void,
) {
  const [query, setQuery] = useState('');
  const clearTimer = useRef<ReturnType<typeof setTimeout>>();
  const onNavigateRef = useRef(onNavigate);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setQuery(''));
    return () => cancelAnimationFrame(frame);
  }, [scopeKey]);

  useEffect(() => {
    if (!enabled) {
      const frame = requestAnimationFrame(() => setQuery(''));
      return () => cancelAnimationFrame(frame);
    }
    const resetTimer = () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setQuery(''), 4_000);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      const panel = scopeSelector ? document.querySelector(scopeSelector) : null;
      const activeElement = document.activeElement;
      if (panel && !panel.matches(':hover') && !(activeElement instanceof Node && panel.contains(activeElement))) return;
      if (event.key === 'Escape') {
        setQuery('');
        return;
      }
      if (event.key === 'Backspace') {
        setQuery((value) => value.slice(0, -1));
        resetTimer();
        event.preventDefault();
        return;
      }
      if (query && (event.key === 'ArrowDown' || (event.key === 'Enter' && !event.shiftKey))) {
        onNavigateRef.current?.(1);
        resetTimer();
        event.preventDefault();
        return;
      }
      if (query && (event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey))) {
        onNavigateRef.current?.(-1);
        resetTimer();
        event.preventDefault();
        return;
      }
      if (event.key.length !== 1 || (/\s/.test(event.key) && !query)) return;
      setQuery((value) => `${value}${event.key}`);
      resetTimer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, [enabled, query, scopeSelector]);

  return { query, clear: () => setQuery(''), isOpen: Boolean(query.trim()) };
}
