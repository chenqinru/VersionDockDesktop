/** Only explicit navigation animates; restoration, syncing and log following stay immediate. */
export function navigationScrollBehavior(): ScrollBehavior {
  return document.documentElement.dataset.versiondockSmoothScrolling !== 'false'
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant';
}

export function scrollToPosition(element: HTMLElement, position: ScrollToOptions) {
  if (element.scrollTo) element.scrollTo({ ...position, behavior: navigationScrollBehavior() });
  else {
    if (position.top !== undefined) element.scrollTop = position.top;
    if (position.left !== undefined) element.scrollLeft = position.left;
  }
}
