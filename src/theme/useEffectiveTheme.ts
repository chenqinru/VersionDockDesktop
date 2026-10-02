import { useSyncExternalStore } from 'react';
import type { EffectiveTheme } from './index';
import { themeChoices } from './catalog';

export function getEffectiveTheme(): EffectiveTheme {
  const value = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
  const choice = themeChoices.find((theme) => theme.id === value);
  return choice && choice.id !== 'system' ? choice.id : 'dark2026';
}

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => listeners.forEach((notify) => notify()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { observer?.disconnect(); observer = undefined; }
  };
}
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(subscribe, getEffectiveTheme, () => 'dark2026');
}
