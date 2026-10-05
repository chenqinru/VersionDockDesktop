// The overlay is portalled to body, so nested z-index values cannot be compared
// directly. Only the outermost stacking context participates in body ordering.
function createsStackingContext(element: HTMLElement, style: CSSStyleDeclaration): boolean {
  const positioned = style.position && style.position !== 'static';
  const parentDisplay = element.parentElement ? getComputedStyle(element.parentElement).display : '';
  const hasZIndex = style.zIndex !== '' && style.zIndex !== 'auto';
  const set = (value: string) => Boolean(value && value !== 'none');
  return Boolean(
    (hasZIndex && (positioned || /flex|grid/.test(parentDisplay)))
    || /fixed|sticky/.test(style.position)
    || (style.opacity !== '' && Number(style.opacity) < 1)
    || set(style.transform) || set(style.translate) || set(style.rotate) || set(style.scale)
    || set(style.filter) || set(style.backdropFilter) || set(style.perspective)
    || set(style.clipPath) || set(style.maskImage)
    || (style.mixBlendMode && style.mixBlendMode !== 'normal')
    || style.isolation === 'isolate'
    || /paint|layout|strict|content/.test(style.contain)
    || /transform|opacity|filter|perspective|clip-path|mask/.test(style.willChange)
  );
}

export function scrollbarStackingLevel(element: HTMLElement): number {
  const ancestors: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    ancestors.push(node);
  }
  for (const node of ancestors.reverse()) {
    const style = getComputedStyle(node);
    if (createsStackingContext(node, style)) return Math.max(0, Number.parseInt(style.zIndex, 10) || 0) + 1;
  }
  let maximum = 0;
  const visit = (parent: Element) => {
    for (const node of parent.children) {
      if (!(node instanceof HTMLElement)) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (createsStackingContext(node, style)) {
        maximum = Math.max(maximum, Number.parseInt(style.zIndex, 10) || 0);
        // Its descendants are contained, even if their z-index is very large.
      } else visit(node);
    }
  };
  visit(element);
  return maximum + 1;
}
