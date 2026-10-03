import { expect, it } from 'vitest';
import { historyDensityMetrics } from './layoutDensity';

it('adds edge padding without introducing gaps between graph rows', () => {
  for (const mode of ['comfortable', 'compact'] as const) {
    const density = historyDensityMetrics(mode);
    const positions = Array.from({ length: 100 }, (_, index) => density.padding + index * 28);
    expect(positions.every((position, index) => index === 0 || position - positions[index - 1] === 28)).toBe(true);
    expect(positions[0]).toBe(mode === 'comfortable' ? 4 : 0);
    expect(density.stripWidth + density.stripInset + density.labelGap).toBe(mode === 'comfortable' ? 12 : 8);
  }
});
