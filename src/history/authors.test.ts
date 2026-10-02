import { describe, expect, it } from 'vitest';
import { buildHistoryAuthorOptions } from './authors';

describe('history authors', () => {
  it('distinguishes same-name authors and counts unique repository commits across reloads', () => {
    const first = { repoId: 'a', hash: 'same-hash', author: 'Ada', email: 'one@example.test' };
    const second = { repoId: 'b', hash: 'different-hash', author: 'Ada', email: 'two@example.test' };
    const options = buildHistoryAuthorOptions([first, second, first, { ...first, repoId: 'b' }]);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'one@example.test', label: 'Ada', count: 2 }),
      expect.objectContaining({ id: 'two@example.test', label: 'Ada', count: 1 }),
    ]));
  });
});
