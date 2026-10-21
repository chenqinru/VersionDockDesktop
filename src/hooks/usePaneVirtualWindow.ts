import { useEffect, useState, type RefObject } from 'react';

export function usePaneVirtualWindow(
  ref: RefObject<HTMLElement>,
  totalLines: number,
  lineHeight: number = 21,
  threshold: number = 40,
): [number, number] {
  const [range, setRange] = useState<[number, number]>([0, Math.min(totalLines, 60)]);

  useEffect(() => {
    if (totalLines <= threshold) return;
    const element = ref.current;
    const pane = element?.closest<HTMLElement>('.versiondock-merge-pane');
    if (!element || !pane) return;

    let frameId: number | null = null;
    const update = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        if (!ref.current) return;
        const paneRect = pane.getBoundingClientRect();
        const blockRect = ref.current.getBoundingClientRect();
        const relativeTop = blockRect.top - paneRect.top;
        const relativeBottom = blockRect.bottom - paneRect.top;
        if (relativeBottom < -200 || relativeTop > paneRect.height + 200) return;

        const visibleStartPx = Math.max(0, -relativeTop);
        const visibleEndPx = Math.min(blockRect.height, paneRect.height - relativeTop);
        const overscan = 20;
        const start = Math.min(totalLines - 1, Math.max(0, Math.floor(visibleStartPx / lineHeight) - overscan));
        const end = Math.max(start + 1, Math.min(totalLines, Math.ceil(visibleEndPx / lineHeight) + overscan));
        setRange(previous => previous[0] === start && previous[1] === end ? previous : [start, end]);
      });
    };

    update();
    pane.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(pane);
    observer?.observe(element);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      pane.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [ref, totalLines, lineHeight, threshold]);

  if (totalLines <= threshold) return [0, totalLines];
  // Clamp during render so a shortened block never keeps stale padding or an
  // empty slice while waiting for the next scroll/animation frame.
  if (range[0] >= totalLines) return [Math.max(0, totalLines - 60), totalLines];
  if (range[1] <= range[0]) return [0, Math.min(totalLines, 60)];
  return [range[0], Math.min(totalLines, range[1])];
}
