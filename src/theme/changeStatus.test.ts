import { describe, expect, it } from 'vitest';
import { changeStatus, changeStatusColor, changeStatusLetter } from './changeStatus';

describe('change status presentation', () => {
  it('distinguishes history copies from explicit working-tree conflicts', () => {
    expect(changeStatus('C100')).toBe('copied');
    expect(changeStatus('C')).toBe('copied');
    expect(changeStatus('added', true)).toBe('conflicted');
    expect(changeStatus('U')).toBe('conflicted');
    expect(changeStatusColor('C100')).not.toBe(changeStatusColor('modified', true));
    expect(changeStatusLetter('modified', true)).toBe('C');
  });

  it('supports named working statuses and scored history statuses consistently', () => {
    expect(changeStatus('R085')).toBe('renamed');
    expect(changeStatus('renamed')).toBe('renamed');
    expect(changeStatusLetter('untracked')).toBe('U');
    expect(changeStatus('??')).toBe('untracked');
    expect(changeStatus('T')).toBe('modified');
    expect(changeStatus('!!')).toBe('ignored');
    expect(changeStatusColor('M')).toBe(changeStatusColor('modified'));
  });

  it('falls back to neutral presentation for unknown statuses', () => {
    expect(changeStatus('')).toBe('unknown');
    expect(changeStatus('new-backend-status')).toBe('unknown');
    expect(changeStatusColor('new-backend-status')).toBe('var(--versiondock-text)');
    expect(changeStatusLetter('')).toBe('?');
  });
});
