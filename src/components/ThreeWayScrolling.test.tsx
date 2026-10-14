import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreeWayLayout, type ThreeWayLayoutProps } from './ThreeWayLayout';

vi.mock('../utils/useShiki', () => ({ useShiki: () => undefined }));
const props: ThreeWayLayoutProps = {
  file: {
    absolutePath: '/tmp/a.txt', relativePath: 'a.txt', repoId: 'repo', oursLabel: 'HEAD', theirsLabel: 'main',
    content: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main',
    conflicts: [{ index: 0, startLine: 0, endLine: 4, oursLabel: 'HEAD', theirsLabel: 'main', oursLines: ['ours'], baseLines: [], theirsLines: ['theirs'] }],
  },
  language: 'text', resolutions: {}, normalEdits: {}, nonConflictingSelections: {},
  onResultChange: vi.fn(), onResolveBlock: vi.fn(), onNormalEdit: vi.fn(), onSelectNonConflicting: vi.fn(),
  currentConflictIndex: -1, syncScrollEnabled: true,
};
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.versiondockSmoothScrolling;
});

it('does not write matching or subpixel-rounded offsets back to the pane driving smooth navigation', () => {
  const { container } = render(<ThreeWayLayout {...props} />);
  const panes = Array.from(container.querySelectorAll<HTMLElement>('[data-merge-pane]'));
  const center = panes.find(pane => pane.dataset.mergePane === 'center')!;
  let centerTop = 120;
  const top = vi.fn(); const left = vi.fn();
  Object.defineProperties(center, {
    scrollTop: { get: () => centerTop, set: top, configurable: true },
    scrollLeft: { get: () => 40, set: left, configurable: true },
  });
  fireEvent.scroll(center);
  panes.filter(pane => pane !== center).forEach(pane => {
    expect(pane.scrollTop).toBe(120);
    expect(pane.scrollLeft).toBe(40);
    // WebKit may round offsets in peer panels while the source is still moving.
    pane.scrollTop = 119.5;
    pane.scrollLeft = 39.5;
    // The source can advance before the queued peer scroll event is dispatched.
    centerTop = 200;
    fireEvent.scroll(pane);
  });
  expect(top).not.toHaveBeenCalled();
  expect(left).not.toHaveBeenCalled();
  const driver = panes.find(pane => pane !== center)!;
  driver.scrollTop = 300;
  driver.scrollLeft = 80;
  fireEvent.scroll(driver);
  expect(top).toHaveBeenLastCalledWith(300);
  expect(left).toHaveBeenLastCalledWith(80);
});

it('uses the current navigation preference when revealing a conflict', () => {
  const { container, rerender } = render(<ThreeWayLayout {...props} />);
  const center = container.querySelector<HTMLElement>('[data-merge-pane="center"]')!;
  const block = center.querySelector<HTMLElement>('[data-conflict-index="0"]')!;
  Object.defineProperty(block, 'offsetTop', { value: 500 });
  center.scrollTo = vi.fn();
  rerender(<ThreeWayLayout {...props} currentConflictIndex={0} />);
  expect(center.scrollTo).toHaveBeenLastCalledWith({ top: 320, behavior: 'smooth' });
  document.documentElement.dataset.versiondockSmoothScrolling = 'false';
  rerender(<ThreeWayLayout {...props} currentConflictIndex={-1} />);
  rerender(<ThreeWayLayout {...props} currentConflictIndex={0} />);
  expect(center.scrollTo).toHaveBeenLastCalledWith({ top: 320, behavior: 'instant' });
});
