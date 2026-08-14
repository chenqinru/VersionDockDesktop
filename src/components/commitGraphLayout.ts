import type { CommitNode } from '../bindings/generated';
import { commitRefs, isPrimaryBranch, type CommitRef } from '../history/refs';
import { branchColor, branchPaletteIndex, currentPalette, headColor, primaryBranchColor, tagColor } from './branchColor';

export const COMMIT_ROW_HEIGHT = 28;
export const LANE_WIDTH = 20;
export const DOT_RADIUS = 4;

export type GraphSegment = {
  from: number;
  to: number;
  start: 'top' | 'middle';
  end: 'middle' | 'bottom';
  color: string;
};

export type GraphCommit = CommitNode & {
  lane: number;
  laneCount: number;
  color: string;
  segments: GraphSegment[];
};

function scoped(repoId: string, hash: string): string {
  return `${repoId}\0${hash}`;
}

function commitKey(commit: Pick<CommitNode, 'repoId' | 'hash'>): string {
  return scoped(commit.repoId, commit.hash);
}

function parentKey(commit: Pick<CommitNode, 'repoId'>, hash: string): string {
  return scoped(commit.repoId, hash);
}

function refName(ref: CommitRef): string {
  if (ref.isRemote && /^(origin|upstream|gitee|remotes)\//.test(ref.label)) return ref.label.slice(ref.label.indexOf('/') + 1);
  return ref.label;
}

function primaryRef(refs: string[]): CommitRef | null {
  const groups = commitRefs({ refs });
  return groups.find((ref) => ref.isHead && !ref.isRemote && ref.kind !== 'tag')
    ?? groups.find((ref) => ref.kind === 'branch')
    ?? groups.find((ref) => ref.kind === 'remote')
    ?? groups.find((ref) => ref.kind === 'tag')
    ?? groups.find((ref) => ref.isHead)
    ?? null;
}

function hasPrimaryBranchRef(refs: string[]): boolean {
  return commitRefs({ refs }).some((ref) => {
    if (ref.kind === 'tag' || ref.kind === 'svn') return false;
    return isPrimaryBranch(refName(ref));
  });
}

function firstParentChain(startIdx: number, commits: CommitNode[], hashIndex: Map<string, number>): Set<string> {
  const chain = new Set<string>();
  let index = startIdx;
  while (index >= 0 && index < commits.length) {
    const commit = commits[index];
    const key = commitKey(commit);
    if (chain.has(key)) break;
    chain.add(key);
    const parent = commit.parents[0];
    if (!parent) break;
    index = hashIndex.get(parentKey(commit, parent)) ?? -1;
  }
  return chain;
}

interface FirstParentIndex {
  rootOf: Map<string, string>;
  tin: Map<string, number>;
  tout: Map<string, number>;
}

function buildFirstParentIndex(commits: CommitNode[]): FirstParentIndex {
  const visible = new Set(commits.map(commitKey));
  const childrenByParent = new Map<string, string[]>();
  const hasVisibleFirstParent = new Set<string>();

  for (const commit of commits) {
    const firstParent = commit.parents[0];
    const childKey = commitKey(commit);
    const firstParentKey = firstParent ? parentKey(commit, firstParent) : '';
    if (!firstParent || !visible.has(firstParentKey)) continue;
    childrenByParent.set(firstParentKey, [...(childrenByParent.get(firstParentKey) ?? []), childKey]);
    hasVisibleFirstParent.add(childKey);
  }

  const rootOf = new Map<string, string>();
  const tin = new Map<string, number>();
  const tout = new Map<string, number>();
  const state = new Map<string, 0 | 1 | 2>();
  let time = 0;

  const visit = (root: string) => {
    const stack: Array<{ key: string; childIndex: number; entered: boolean }> = [{ key: root, childIndex: 0, entered: false }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const currentState = state.get(frame.key) ?? 0;
      if (!frame.entered) {
        if (currentState === 2) { stack.pop(); continue; }
        if (currentState === 1) {
          tout.set(frame.key, time);
          state.set(frame.key, 2);
          stack.pop();
          continue;
        }
        state.set(frame.key, 1);
        rootOf.set(frame.key, root);
        tin.set(frame.key, time++);
        frame.entered = true;
      }

      const children = childrenByParent.get(frame.key) ?? [];
      let pushed = false;
      while (frame.childIndex < children.length) {
        const child = children[frame.childIndex++];
        if ((state.get(child) ?? 0) !== 0) continue;
        stack.push({ key: child, childIndex: 0, entered: false });
        pushed = true;
        break;
      }
      if (!pushed) {
        tout.set(frame.key, time);
        state.set(frame.key, 2);
        stack.pop();
      }
    }
  };

  for (const commit of commits) {
    const key = commitKey(commit);
    if (!hasVisibleFirstParent.has(key)) visit(key);
  }
  for (const commit of commits) {
    const key = commitKey(commit);
    if ((state.get(key) ?? 0) === 0) visit(key);
  }
  return { rootOf, tin, tout };
}

function firstParentReaches(index: FirstParentIndex, start: string, target: string): boolean {
  if (!index.rootOf.has(start) || index.rootOf.get(start) !== index.rootOf.get(target)) return false;
  const startTin = index.tin.get(start);
  const startTout = index.tout.get(start);
  const targetTin = index.tin.get(target);
  const targetTout = index.tout.get(target);
  if (startTin === undefined || startTout === undefined || targetTin === undefined || targetTout === undefined) return false;
  return targetTin <= startTin && startTout <= targetTout;
}

function paletteDistance(a: number, b: number, size: number): number {
  const distance = Math.abs(a - b);
  return Math.min(distance, size - distance);
}

function pickPaletteIndex(preferred: number, used: Set<number>): number {
  const palette = currentPalette();
  let best = preferred;
  let bestDistance = -1;
  for (let index = 0; index < palette.length; index += 1) {
    const distance = used.size === 0 ? palette.length : Math.min(...[...used].map((value) => paletteDistance(index, value, palette.length)));
    if (distance > bestDistance || (distance === bestDistance && paletteDistance(index, preferred, palette.length) < paletteDistance(best, preferred, palette.length))) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Calculate one repository's graph in isolation.  The visible history is
 * interleaved across repositories, but parent links never cross a repository
 * boundary. Keeping the lane state local prevents a repository that happens
 * to appear above this one from pushing its lanes into the next graph.
 */
function assignRepoLanes(input: CommitNode[]): GraphCommit[] {
  const visibleKeys = new Set(input.map(commitKey));
  const commits = input.map((commit) => ({
    ...commit,
    parents: commit.parents.filter((parent) => visibleKeys.has(parentKey(commit, parent))),
  }));
  const hashIndex = new Map<string, number>();
  commits.forEach((commit, index) => hashIndex.set(commitKey(commit), index));
  const firstParentIndex = buildFirstParentIndex(commits);
  const start = commits.findIndex((commit) => hasPrimaryBranchRef(commit.refs));
  const primaryChain = start >= 0 ? firstParentChain(start, commits, hashIndex) : new Set<string>();

  const laneOf = new Map<string, number>();
  const laneTarget = new Map<number, string>();
  const laneColors = new Map<number, string>();
  const lanePalette = new Map<number, number>();
  const occupied = new Set<number>();
  const output: GraphCommit[] = [];

  const usedPalette = () => new Set([...occupied].map((lane) => lanePalette.get(lane)).filter((index): index is number => index !== undefined && index >= 0));
  const assignLaneColor = (lane: number, ref: CommitRef | null, isHead: boolean) => {
    const palette = currentPalette();
    const primary = ref && ref.kind !== 'tag' && ref.kind !== 'svn' && isPrimaryBranch(refName(ref));
    if (primary) {
      laneColors.set(lane, primaryBranchColor());
      lanePalette.set(lane, -1);
      return;
    }
    if (isHead) {
      laneColors.set(lane, headColor());
      lanePalette.set(lane, -2);
      return;
    }
    if (ref?.kind === 'tag') {
      laneColors.set(lane, tagColor());
      lanePalette.set(lane, -3);
      return;
    }
    const preferred = ref ? branchPaletteIndex(refName(ref)) : lane % palette.length;
    const used = usedPalette();
    const currentPaletteIndex = lanePalette.get(lane);
    if (currentPaletteIndex !== undefined) used.delete(currentPaletteIndex);
    const chosen = pickPaletteIndex(preferred, used);
    lanePalette.set(lane, chosen);
    laneColors.set(lane, palette[chosen]);
  };
  const nextFreeLane = (preferZero = false, keepPrimaryLaneOpen = false) => {
    if (preferZero && !occupied.has(0)) return 0;
    let lane = keepPrimaryLaneOpen && !preferZero && !occupied.has(0) ? 1 : 0;
    while (occupied.has(lane)) lane += 1;
    return lane;
  };
  const reserveLane = (lane: number, target: string) => {
    const previous = laneTarget.get(lane);
    if (previous !== undefined) laneOf.delete(previous);
    laneOf.set(target, lane);
    laneTarget.set(lane, target);
  };
  const clearLane = (lane: number) => {
    const target = laneTarget.get(lane);
    if (target !== undefined) laneOf.delete(target);
    laneTarget.delete(lane);
    occupied.delete(lane);
    laneColors.delete(lane);
    lanePalette.delete(lane);
  };
  const compactLanes = () => {
    const lanes = [...occupied].sort((left, right) => left - right);
    const mapping = new Map<number, number>(lanes.map((lane, index) => [lane, index]));
    if (lanes.every((lane, index) => lane === index)) return mapping;
    const nextTargets = new Map<number, string>();
    const nextColors = new Map<number, string>();
    const nextPalette = new Map<number, number>();
    lanes.forEach((oldLane) => {
      const nextLane = mapping.get(oldLane)!;
      const target = laneTarget.get(oldLane);
      const color = laneColors.get(oldLane);
      const paletteIndex = lanePalette.get(oldLane);
      if (target !== undefined) nextTargets.set(nextLane, target);
      if (color !== undefined) nextColors.set(nextLane, color);
      if (paletteIndex !== undefined) nextPalette.set(nextLane, paletteIndex);
    });
    occupied.clear();
    lanes.forEach((_, index) => occupied.add(index));
    laneTarget.clear(); nextTargets.forEach((target, lane) => laneTarget.set(lane, target));
    laneColors.clear(); nextColors.forEach((color, lane) => laneColors.set(lane, color));
    lanePalette.clear(); nextPalette.forEach((index, lane) => lanePalette.set(lane, index));
    laneOf.clear(); laneTarget.forEach((target, lane) => laneOf.set(target, lane));
    return mapping;
  };

  for (const commit of commits) {
    const key = commitKey(commit);
    let lane: number;
    let isStart: boolean;
    if (laneOf.has(key)) {
      lane = laneOf.get(key)!;
      isStart = false;
      laneOf.delete(key);
      if (laneTarget.get(lane) === key) laneTarget.delete(lane);
    } else {
      const primary = primaryChain.has(key);
      lane = nextFreeLane(primary, primaryChain.size > 0);
      isStart = true;
      occupied.add(lane);
    }

    const ref = primaryRef(commit.refs);
    const isHead = commit.refs.some((value) => value === 'HEAD' || value.startsWith('HEAD -> '));
    if (isStart || ref) assignLaneColor(lane, ref, isHead);
    const dotColor = laneColors.get(lane) ?? branchColor(`lane-${lane}`);
    const entering = new Set(occupied);
    const parentLanes: number[] = [];

    commit.parents.forEach((parent, index) => {
      const target = parentKey(commit, parent);
      if (index === 0) {
        if (laneOf.has(target)) {
          parentLanes.push(laneOf.get(target)!);
          clearLane(lane);
        } else {
          reserveLane(lane, target);
          parentLanes.push(lane);
        }
        return;
      }
      if (laneOf.has(target)) {
        parentLanes.push(laneOf.get(target)!);
        return;
      }
      let reachable: number | null = null;
      for (const [candidateLane, currentTarget] of laneTarget) {
        if (!occupied.has(candidateLane) || !firstParentReaches(firstParentIndex, currentTarget, target)) continue;
        if (reachable === null || candidateLane < reachable) reachable = candidateLane;
      }
      if (reachable !== null) {
        parentLanes.push(reachable);
        return;
      }
      const primary = primaryChain.has(target);
      const newLane = nextFreeLane(primary, primaryChain.size > 0);
      occupied.add(newLane);
      reserveLane(newLane, target);
      parentLanes.push(newLane);
      assignLaneColor(newLane, null, false);
    });

    if (commit.parents.length === 0) clearLane(lane);
    const bottomMap = compactLanes();
    const mapLane = (value: number) => bottomMap.get(value) ?? value;
    const segments: GraphSegment[] = [];
    const firstParentLane = parentLanes.length ? mapLane(parentLanes[0]) : lane;
    segments.push({ from: lane, to: firstParentLane, start: isStart ? 'middle' : 'top', end: parentLanes.length ? 'bottom' : 'middle', color: dotColor });
    parentLanes.slice(1).forEach((parentLane) => segments.push({ from: lane, to: mapLane(parentLane), start: 'middle', end: 'bottom', color: laneColors.get(mapLane(parentLane)) ?? dotColor }));
    for (const from of entering) {
      if (from === lane) continue;
      const to = bottomMap.get(from);
      if (to === undefined) continue;
      segments.push({ from, to, start: 'top', end: 'bottom', color: laneColors.get(to) ?? branchColor(`lane-${to}`) });
    }
    const laneCount = Math.max(lane + 1, ...segments.flatMap((segment) => [segment.from + 1, segment.to + 1]));
    output.push({ ...commit, lane, laneCount, color: dotColor, segments });
  }
  return output;
}

function assignLanes(input: CommitNode[]): GraphCommit[] {
  const commitsByRepo = new Map<string, CommitNode[]>();
  for (const commit of input) {
    const commits = commitsByRepo.get(commit.repoId) ?? [];
    commits.push(commit);
    commitsByRepo.set(commit.repoId, commits);
  }

  const laidOutByKey = new Map<string, GraphCommit>();
  for (const commits of commitsByRepo.values()) {
    for (const commit of assignRepoLanes(commits)) laidOutByKey.set(commitKey(commit), commit);
  }

  return input.map((commit) => laidOutByKey.get(commitKey(commit))!).filter(Boolean);
}

export function layoutCommits(input: CommitNode[]): GraphCommit[] {
  return assignLanes(input);
}
