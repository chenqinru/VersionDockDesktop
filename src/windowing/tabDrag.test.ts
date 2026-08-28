import { describe, expect, it } from 'vitest';
import { dragPoint, shouldDetachTab, tabDetachDistance, tabSnapInsertionIndex } from './tabDrag';

const source = { x: 100, y: 80, width: 1200, height: 800 };

describe('tab drag geometry', () => {
  it('returns a short drag to the original tab strip', () => {
    expect(tabDetachDistance({ screenX: 420, screenY: 145 }, source)).toBe(27);
    expect(shouldDetachTab({ screenX: 420, screenY: 145 }, source)).toBe(false);
    expect(shouldDetachTab(
      { screenX: 420, screenY: 220 },
      source,
      40,
    )).toBe(false);
  });

  it('detaches after crossing the return threshold in any direction', () => {
    expect(shouldDetachTab({ screenX: 420, screenY: 180 }, source)).toBe(true);
    expect(shouldDetachTab({ screenX: 30, screenY: 100 }, source)).toBe(true);
  });

  it('only exposes an insertion slot around another window title bar', () => {
    expect(tabSnapInsertionIndex({ screenX: 520, screenY: 100 }, source, [150, 330, 510])).toBe(2);
    expect(tabSnapInsertionIndex({ screenX: 520, screenY: 240 }, source, [150, 330, 510])).toBeNull();
  });

  it('keeps the last useful coordinate when dragend reports zeroes', () => {
    expect(dragPoint(
      { screenX: 0, screenY: 0, clientX: 0, clientY: 0 },
      { screenX: -320, screenY: 240 },
    )).toEqual({ screenX: -320, screenY: 240 });
  });
});
