import { useLayoutEffect, useState } from 'react';

/** The list's origin in its shared scroll container, independent of offsetParent. */
export function useVirtualScrollMargin(element: HTMLElement | null, scrollElement: HTMLElement | null, enabled: boolean): number {
  const [margin, setMargin] = useState(0);

  // Measure after every commit: rendering rows can change positioned ancestors
  // (e.g. comfortable density's :has(.file-row)), and siblings can move the list.
  useLayoutEffect(() => {
    if (!enabled || !element || !scrollElement) return;
    const update = () => {
      // Preserve the last visible origin while a retained tab is display:none.
      if (!scrollElement.offsetHeight) return;
      setMargin(element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
        - scrollElement.clientTop + scrollElement.scrollTop);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(scrollElement);
    // A preceding group can expand/collapse without rerendering this list.
    for (const child of scrollElement.children) observer.observe(child);
    return () => observer.disconnect();
  });

  return margin;
}
