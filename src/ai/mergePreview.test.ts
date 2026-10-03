import { expect, it } from 'vitest';
import { expandAiResolutionLines, inferAiAcceptedSides } from './mergePreview';
import type { ConflictBlock } from '../components/mergeEngine';
it('preserves expanded shared context around AI marker replacements', () => {
  const marker = { oursLines:['ours'], theirsLines:['theirs'] } as ConflictBlock;
  const effective = { oursLines:['prefix','ours','suffix'], theirsLines:['prefix','theirs','suffix'] } as ConflictBlock;
  expect(expandAiResolutionLines(marker, effective, ['combined'])).toEqual(['prefix','combined','suffix']);
  expect(expandAiResolutionLines(marker, effective, ['ours'])).toEqual(effective.oursLines);
  expect(inferAiAcceptedSides(effective, effective.oursLines)).toEqual(['ours']);
  expect(inferAiAcceptedSides(marker, ['ours','theirs'])).toEqual(['ours','theirs']);
});
