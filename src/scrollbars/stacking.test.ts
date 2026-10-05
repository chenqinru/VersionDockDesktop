import { afterEach, describe, expect, it } from 'vitest';
import { scrollbarStackingLevel } from './stacking';

afterEach(() => document.body.replaceChildren());

function fixture() {
  const pane = document.createElement('section');
  const scroller = document.createElement('div');
  const row = document.createElement('div');
  pane.append(scroller); scroller.append(row); document.body.append(pane);
  return { pane, scroller, row };
}

describe('overlay scrollbar stacking', () => {
  it('covers positioned descendants and sticky diff line numbers', () => {
    const { scroller, row } = fixture();
    row.style.position = 'sticky'; row.style.zIndex = '2';
    expect(scrollbarStackingLevel(scroller)).toBe(3);
    row.style.position = 'static';
    expect(scrollbarStackingLevel(scroller)).toBe(1);
  });

  it('ignores high z-index descendants inside a transformed virtual row', () => {
    const { scroller, row } = fixture();
    row.style.transform = 'translateY(28px)';
    const cell = document.createElement('div');
    cell.style.position = 'relative'; cell.style.zIndex = '1000'; row.append(cell);
    expect(scrollbarStackingLevel(scroller)).toBe(1);
  });

  it('uses the outer stacking context instead of the maximum ancestor index', () => {
    const { pane, scroller, row } = fixture();
    pane.style.position = 'relative'; pane.style.zIndex = '5';
    scroller.style.position = 'relative'; scroller.style.zIndex = '100';
    row.style.position = 'relative'; row.style.zIndex = '200';
    expect(scrollbarStackingLevel(scroller)).toBe(6);
    pane.style.zIndex = 'auto'; pane.style.isolation = 'isolate';
    expect(scrollbarStackingLevel(scroller)).toBe(1);
  });

  it('keeps modal content above its outer modal layer', () => {
    const { pane, scroller } = fixture();
    pane.style.position = 'fixed'; pane.style.zIndex = '10000';
    expect(scrollbarStackingLevel(scroller)).toBe(10001);
  });
});
