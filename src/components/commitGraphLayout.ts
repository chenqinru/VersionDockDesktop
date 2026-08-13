import type { CommitNode } from '../bindings/generated';

export const COMMIT_ROW_HEIGHT = 28;
export const LANE_WIDTH = 20;
export const DOT_RADIUS = 4;
export const GRAPH_PALETTE = ['#4ec9b0', '#61afef', '#e5c07b', '#c678dd', '#e06c75', '#56b6c2', '#d19a66'];

type Segment = { from: number; to: number; start: 'top' | 'middle'; end: 'middle' | 'bottom'; color: string };

export type GraphCommit = CommitNode & {
  lane: number;
  laneCount: number;
  color: string;
  segments: Segment[];
};

const scoped = (commit: Pick<CommitNode, 'repoId' | 'hash'>, hash = commit.hash) => `${commit.repoId}\0${hash}`;
const laneColor = (lane: number) => GRAPH_PALETTE[lane % GRAPH_PALETTE.length];

export function layoutCommits(commits: CommitNode[]): GraphCommit[] {
  const visible = new Set(commits.map((commit) => scoped(commit)));
  const active: Array<string | null> = [];
  let previousRepoId: string | undefined;

  return commits.map((commit) => {
    if (previousRepoId !== undefined && previousRepoId !== commit.repoId) active.length = 0;
    previousRepoId = commit.repoId;
    const key = scoped(commit);
    let lane = active.indexOf(key);
    const startsHere = lane < 0;
    if (lane < 0) {
      lane = active.findIndex((value) => value === null);
      if (lane < 0) lane = active.length;
      active[lane] = key;
    }

    const before = [...active];
    const parents = commit.parents.map((hash) => scoped(commit, hash)).filter((hash) => visible.has(hash));
    active[lane] = parents[0] ?? null;
    const parentLanes: number[] = [];
    if (parents[0]) parentLanes.push(lane);
    for (const parent of parents.slice(1)) {
      let parentLane = active.indexOf(parent);
      if (parentLane < 0) {
        parentLane = active.findIndex((value, index) => value === null && index !== lane);
        if (parentLane < 0) parentLane = active.length;
        active[parentLane] = parent;
      }
      parentLanes.push(parentLane);
    }

    const segments: Segment[] = [];
    before.forEach((value, index) => {
      if (value && index !== lane) segments.push({ from: index, to: index, start: 'top', end: 'bottom', color: laneColor(index) });
    });
    if (!startsHere) segments.push({ from: lane, to: lane, start: 'top', end: 'middle', color: laneColor(lane) });
    parentLanes.forEach((parentLane) => segments.push({ from: lane, to: parentLane, start: 'middle', end: 'bottom', color: laneColor(parentLane) }));

    while (active.length && active[active.length - 1] === null) active.pop();
    return {
      ...commit,
      lane,
      laneCount: Math.max(lane + 1, before.length, active.length),
      color: commit.refs.some((ref) => ref.includes('HEAD')) ? '#f0c674' : laneColor(lane),
      segments,
    };
  });
}
