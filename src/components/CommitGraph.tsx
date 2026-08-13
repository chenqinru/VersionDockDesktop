import { useMemo } from 'react';
import { COMMIT_ROW_HEIGHT, DOT_RADIUS, LANE_WIDTH, type GraphCommit } from './commitGraphLayout';

function curve(fromX: number, fromY: number, toX: number, toY: number) {
  const middle = (fromY + toY) / 2;
  return `M ${fromX} ${fromY} C ${fromX} ${middle}, ${toX} ${middle}, ${toX} ${toY}`;
}

export function CommitGraph({ commit, selected }: { commit: GraphCommit; selected: boolean }) {
  const width = Math.max(24, commit.laneCount * LANE_WIDTH + 4);
  const middle = COMMIT_ROW_HEIGHT / 2;
  const dotX = commit.lane * LANE_WIDTH + LANE_WIDTH / 2;
  const paths = useMemo(() => commit.segments.map((segment) => {
    const fromX = segment.from * LANE_WIDTH + LANE_WIDTH / 2;
    const toX = segment.to * LANE_WIDTH + LANE_WIDTH / 2;
    const fromY = segment.start === 'top' ? 0 : middle;
    const toY = segment.end === 'middle' ? middle : COMMIT_ROW_HEIGHT;
    return { ...segment, path: curve(fromX, fromY, toX, toY) };
  }), [commit.segments, middle]);

  return <svg className="commit-graph" width={width} height={COMMIT_ROW_HEIGHT} aria-hidden="true">
    {paths.map((path, index) => <path key={index} d={path.path} fill="none" stroke={path.color} strokeWidth="1.5" />)}
    <circle cx={dotX} cy={middle} r={commit.parents.length > 1 ? DOT_RADIUS + 3 : DOT_RADIUS + 2} fill="var(--vscode-editor-background)" />
    {commit.parents.length > 1 && <circle cx={dotX} cy={middle} r={DOT_RADIUS + 2} fill="none" stroke={commit.color} strokeWidth="1.3" opacity=".7" />}
    <circle cx={dotX} cy={middle} r={selected ? DOT_RADIUS + 1 : DOT_RADIUS} fill={selected ? '#fff' : commit.color} stroke={selected ? commit.color : 'var(--vscode-editor-background)'} strokeWidth={selected ? 2 : 1} />
  </svg>;
}
