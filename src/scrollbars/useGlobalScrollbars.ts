import { useLayoutEffect, useRef } from 'react';
import type { ScrollbarVisibility } from '../bindings/generated';
import { initializeGlobalScrollbars } from './runtime';
import { initializeSmoothScrolling } from '../scrolling/runtime';
import './styles.css';

export function useGlobalScrollbars(visibility: ScrollbarVisibility, modernUi: boolean, language: string, smoothScrolling: boolean, smoothMouseWheelScrolling: boolean) {
  const current = useRef<{ bars: ReturnType<typeof initializeGlobalScrollbars>; scrolling: ReturnType<typeof initializeSmoothScrolling> }>();
  useLayoutEffect(() => {
    const scrolling = initializeSmoothScrolling({ navigation: true, wheel: true });
    const bars = initializeGlobalScrollbars({ visibility: 'system', modernUi: false, language: 'en' }, scrolling.handleWheel);
    current.current = { bars, scrolling };
    return () => { bars.dispose(); scrolling.dispose(); current.current = undefined; };
  }, []);
  useLayoutEffect(() => {
    current.current?.bars.configure({ visibility, modernUi, language });
    current.current?.scrolling.configure({ navigation: smoothScrolling, wheel: smoothMouseWheelScrolling });
  }, [visibility, modernUi, language, smoothScrolling, smoothMouseWheelScrolling]);
}
