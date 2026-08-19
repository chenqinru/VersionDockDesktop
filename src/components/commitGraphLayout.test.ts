import { describe, expect, it } from 'vitest';
import type { CommitNode } from '../bindings/generated';
import { assignLanes, layoutCommits, LONG_EDGE_MIN_ROWS } from './commitGraphLayout';

const commit = (repoId: string, hash: string, parents: string[]): CommitNode => ({
  repoId,
  hash,
  shortHash: hash.slice(0, 7),
  parents,
  author: 'Ada',
  email: 'ada@example.com',
  authorDate: '2026-08-16T10:00:00Z',
  committerDate: '2026-08-16T10:00:00Z',
  message: hash,
  refs: [],
});

const refCommit = (repoId: string, hash: string, parents: string[], refs: string[]): CommitNode => ({
  ...commit(repoId, hash, parents),
  refs,
});

describe('commitGraphLayout', () => {
  it('lays out a single linear commit branch correctly', () => {
    const list = [
      refCommit('repo', 'c3', ['c2'], ['HEAD -> main']),
      commit('repo', 'c2', ['c1']),
      commit('repo', 'c1', []),
    ];
    const laidOut = layoutCommits(list);
    expect(laidOut).toHaveLength(3);
    expect(laidOut[0].lane).toBe(0);
    expect(laidOut[1].lane).toBe(0);
    expect(laidOut[2].lane).toBe(0);

    // Row 0 has fork-out to Row 1
    expect(laidOut[0].graphLines.some((l) => l.type === 'fork-out' && l.fromLane === 0 && l.toLane === 0)).toBe(true);
    // Row 1 has join-in from Row 0 and fork-out to Row 2
    expect(laidOut[1].graphLines.some((l) => l.type === 'join-in' && l.fromLane === 0 && l.toLane === 0)).toBe(true);
    expect(laidOut[1].graphLines.some((l) => l.type === 'fork-out' && l.fromLane === 0 && l.toLane === 0)).toBe(true);
    // Row 2 has join-in from Row 1
    expect(laidOut[2].graphLines.some((l) => l.type === 'join-in' && l.fromLane === 0 && l.toLane === 0)).toBe(true);
  });

  it('allocates multiple lanes for merge commits', () => {
    const list = [
      refCommit('repo', 'merge', ['main-1', 'feat-1'], ['HEAD -> main']),
      refCommit('repo', 'feat-1', ['root'], ['feature/login']),
      commit('repo', 'main-1', ['root']),
      commit('repo', 'root', []),
    ];
    const laidOut = layoutCommits(list);
    expect(laidOut).toHaveLength(4);

    // Merge row connects to both parent lanes
    const forkLines = laidOut[0].graphLines.filter((l) => l.type === 'fork-out');
    expect(forkLines.length).toBe(2);

    // Intermediate row has multiple active elements
    expect(laidOut[1].totalLanes).toBeGreaterThanOrEqual(2);
  });

  it('collapses long edges that span at least 30 rows into arrow endpoints', () => {
    const totalRows = LONG_EDGE_MIN_ROWS + 5; // 35 rows
    const list: CommitNode[] = [];

    // Root commit
    list.push(commit('repo', 'commit-34', []));

    // Linear chain
    for (let i = totalRows - 2; i >= 1; i--) {
      list.unshift(commit('repo', `commit-${i}`, [`commit-${i + 1}`]));
    }

    // Head commit on row 0 has two parents: commit-1 (adjacent) and commit-34 (34 rows away)
    list.unshift(refCommit('repo', 'commit-0', ['commit-1', 'commit-34'], ['HEAD -> main']));

    const laidOut = assignLanes(list);
    expect(laidOut).toHaveLength(totalRows);

    // Row 1 (upper endpoint + 1) should have a collapsed-out line (pointing down)
    const row1Collapsed = laidOut[1].graphLines.filter((l) => l.type === 'collapsed-out');
    expect(row1Collapsed.length).toBeGreaterThanOrEqual(1);

    // Row 33 (lower endpoint - 1) should have a collapsed-in line (pointing up)
    const row33Collapsed = laidOut[33].graphLines.filter((l) => l.type === 'collapsed-in');
    expect(row33Collapsed.length).toBeGreaterThanOrEqual(1);

    // Intermediate rows in the middle should not have crossing edges for the collapsed edge
    const row15Collapsed = laidOut[15].graphLines.filter(
      (l) => l.type === 'collapsed-out' || l.type === 'collapsed-in',
    );
    expect(row15Collapsed).toHaveLength(0);
  });

  it('projects permanent layout from topologyCommits during branch filtering', () => {
    const allCommits = [
      refCommit('repo', 'feat-head', ['root'], ['feature/x']),
      refCommit('repo', 'main-head', ['root'], ['HEAD -> main']),
      commit('repo', 'root', []),
    ];

    // Build visible subset (e.g. filtered to main-head only)
    const filteredCommits = [
      allCommits[1], // main-head
      allCommits[2], // root
    ];

    const laidOut = assignLanes(
      filteredCommits,
      false,
      { repo: 'git' },
      { repo: ['origin'] },
      allCommits,
    );

    expect(laidOut).toHaveLength(2);
    expect(laidOut[0].hash).toBe('main-head');
    expect(laidOut[0].dotColor).toBeDefined();
  });

  it('preserves repoId across multi-repository interleaved commits', () => {
    const list = [
      refCommit('repo-a', 'a-1', ['a-0'], ['HEAD -> main']),
      refCommit('repo-b', 'b-1', ['b-0'], ['HEAD -> main']),
      commit('repo-a', 'a-0', []),
      commit('repo-b', 'b-0', []),
    ];

    const laidOut = assignLanes(list);
    expect(laidOut).toHaveLength(4);

    const aLines = laidOut.flatMap((c) => c.graphLines).filter((l) => l.repoId === 'repo-a');
    const bLines = laidOut.flatMap((c) => c.graphLines).filter((l) => l.repoId === 'repo-b');

    expect(aLines.length).toBeGreaterThan(0);
    expect(bLines.length).toBeGreaterThan(0);
  });
});
