import { describe, expect, it } from 'vitest';
import type { MergeVersions } from '../bindings/generated';
import { analyzeThreeWay, buildMergeContent, mergeCounts } from './mergeEditorModel';

const merge = (overrides: Partial<MergeVersions> = {}): MergeVersions => ({
  path: 'file.txt', base: 'before\nbase\nafter', ours: 'before\nours\nafter', theirs: 'before\ntheirs\nafter',
  working: 'before\n<<<<<<< HEAD\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> feature\nafter',
  markerContent: 'before\n<<<<<<< HEAD\nours\n||||||| BASE\nbase\n=======\ntheirs\n>>>>>>> feature\nafter',
  conflicts: [{ index: 0, oursLabel: 'HEAD', theirsLabel: 'feature', oursLines: ['ours'], baseLines: ['base'], theirsLines: ['theirs'], startLine: 1, endLine: 7 }],
  oursLabel: 'HEAD', theirsLabel: 'feature', language: 'text', fingerprint: 'fingerprint', binary: false, ...overrides,
});

describe('merge editor model', () => {
  it('resolves a conflict with ours, theirs, both, and custom content', () => {
    const value = merge();
    expect(buildMergeContent(value, { 0: 'ours' }, 'base')).toBe('before\nours\nafter');
    expect(buildMergeContent(value, { 0: 'theirs' }, 'base')).toBe('before\ntheirs\nafter');
    expect(buildMergeContent(value, { 0: 'both' }, 'base')).toBe('before\nours\ntheirs\nafter');
    expect(buildMergeContent(value, { 0: { type: 'custom', lines: ['combined'] } }, 'base')).toBe('before\ncombined\nafter');
  });

  it('keeps unresolved markers and reports compatible conflict counts', () => {
    const value = merge();
    expect(buildMergeContent(value, { 0: 'unresolved' }, 'base')).toContain('<<<<<<< HEAD');
    expect(analyzeThreeWay(value)?.filter((block) => block.state === 'conflict')).toHaveLength(1);
    expect(mergeCounts(value)).toEqual({ compatible: true, conflicts: 1, nonConflicting: 0 });
  });

  it('applies left and right non-conflicting changes independently', () => {
    const value = merge({ base: 'one\ntwo\nthree\nfour\nfive', ours: 'ONE\ntwo\nthree\nfour\nours-five', theirs: 'one\ntwo\nTHREE\nfour\ntheirs-five', conflicts: [{ index: 0, oursLabel: 'HEAD', theirsLabel: 'feature', oursLines: ['ours-five'], baseLines: ['five'], theirsLines: ['theirs-five'], startLine: 0, endLine: 6 }], markerContent: '<<<<<<< HEAD\nours-five\n||||||| BASE\nfive\n=======\ntheirs-five\n>>>>>>> feature' });
    expect(buildMergeContent(value, { 0: 'ours' }, 'left')).toContain('ONE\ntwo\nthree\nfour\nours-five');
    expect(buildMergeContent(value, { 0: 'theirs' }, 'right')).toContain('one\ntwo\nTHREE\nfour\ntheirs-five');
    expect(mergeCounts(value).nonConflicting).toBe(2);
  });
});
