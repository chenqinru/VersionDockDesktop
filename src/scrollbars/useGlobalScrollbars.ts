import { useEffect, useRef } from 'react';
import type { ScrollbarVisibility } from '../bindings/generated';
import { initializeGlobalScrollbars } from './runtime';
import './styles.css';

export function useGlobalScrollbars(visibility: ScrollbarVisibility, modernUi: boolean, language: string) {
  const current = useRef<ReturnType<typeof initializeGlobalScrollbars>>();
  useEffect(() => {
    const runtime = initializeGlobalScrollbars({ visibility: 'system', modernUi: false, language: 'en' });
    current.current = runtime;
    return () => { runtime.dispose(); current.current = undefined; };
  }, []);
  useEffect(() => {
    current.current?.configure({ visibility, modernUi, language });
  }, [visibility, modernUi, language]);
}
