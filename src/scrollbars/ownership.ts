export const scrollbarOwners = new WeakMap<Element, HTMLElement>();

/** A portalled scrollbar counts as an interaction inside its scrolling content. */
export function scrollbarContains(container: Element | null | undefined, target: EventTarget | null): boolean {
  if (!container || !(target instanceof Node)) return false;
  if (container.contains(target)) return true;
  const viewport = target instanceof Element ? target.closest('[data-versiondock-scrollbar-viewport]') : null;
  const owner = viewport ? scrollbarOwners.get(viewport) : undefined;
  return Boolean(owner && container.contains(owner));
}
