import type { ConflictBlock, MergeVersions } from '../bindings/generated';

export type MergeResolution = 'unresolved' | 'ours' | 'theirs' | 'both' | { type: 'custom'; lines: string[] };
export type NonConflictScope = 'base' | 'left' | 'right' | 'all';
type SideChange = { baseStart: number; baseEnd: number; lines: string[] };
type ThreeWayBlock = { state: 'equal' | 'left' | 'right' | 'both' | 'conflict'; base: string[]; left: string[]; right: string[] };

const lines = (value: string) => value === '' ? [] : value.split('\n');
const equal = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index]);

function changes(base: string[], side: string[]): SideChange[] {
  const rows = base.length + 1, columns = side.length + 1;
  if (rows * columns > 2_000_000) return equal(base, side) ? [] : [{ baseStart: 0, baseEnd: base.length, lines: side }];
  const table = new Uint32Array(rows * columns);
  const at = (row: number, column: number) => row * columns + column;
  for (let row = base.length - 1; row >= 0; row -= 1) for (let column = side.length - 1; column >= 0; column -= 1) {
    table[at(row, column)] = base[row] === side[column] ? table[at(row + 1, column + 1)] + 1 : Math.max(table[at(row + 1, column)], table[at(row, column + 1)]);
  }
  const result: SideChange[] = [];
  let baseCursor = 0, sideCursor = 0, changeBase = -1, changeSide = -1;
  const flush = () => { if (changeBase >= 0) result.push({ baseStart: changeBase, baseEnd: baseCursor, lines: side.slice(changeSide, sideCursor) }); changeBase = changeSide = -1; };
  while (baseCursor < base.length || sideCursor < side.length) {
    if (baseCursor < base.length && sideCursor < side.length && base[baseCursor] === side[sideCursor]) { flush(); baseCursor += 1; sideCursor += 1; continue; }
    if (changeBase < 0) { changeBase = baseCursor; changeSide = sideCursor; }
    const skipBase = baseCursor < base.length ? table[at(baseCursor + 1, sideCursor)] : -1;
    const skipSide = sideCursor < side.length ? table[at(baseCursor, sideCursor + 1)] : -1;
    if (sideCursor < side.length && skipSide >= skipBase) sideCursor += 1; else baseCursor += 1;
  }
  flush();
  return result;
}

function apply(base: string[], values: SideChange[], start: number, end: number): string[] {
  const output: string[] = []; let cursor = start;
  for (const value of values) { if (value.baseStart > cursor) output.push(...base.slice(cursor, value.baseStart)); output.push(...value.lines); cursor = Math.max(cursor, value.baseEnd); }
  if (cursor < end) output.push(...base.slice(cursor, end));
  return output;
}

function block(base: string[], left: string[], right: string[]): ThreeWayBlock {
  const leftChanged = !equal(base, left), rightChanged = !equal(base, right);
  const state = leftChanged && rightChanged ? equal(left, right) ? 'both' : 'conflict' : leftChanged ? 'left' : rightChanged ? 'right' : 'equal';
  return { state, base, left, right };
}

export function analyzeThreeWay(merge: MergeVersions): ThreeWayBlock[] | null {
  const base = lines(merge.base), left = changes(base, lines(merge.ours)), right = changes(base, lines(merge.theirs));
  const result: ThreeWayBlock[] = []; let cursor = 0, li = 0, ri = 0;
  while (li < left.length || ri < right.length) {
    const start = Math.min(left[li]?.baseStart ?? Infinity, right[ri]?.baseStart ?? Infinity);
    if (!Number.isFinite(start)) break;
    if (cursor < start) { const same = base.slice(cursor, start); result.push(block(same, same, same)); }
    let end = start, nextLeft = li, nextRight = ri, expanded = true;
    const leftRegion: SideChange[] = [], rightRegion: SideChange[] = [];
    while (expanded) {
      expanded = false;
      while (nextLeft < left.length && left[nextLeft].baseStart <= end) { const value = left[nextLeft++]; leftRegion.push(value); end = Math.max(end, value.baseEnd); expanded = true; }
      while (nextRight < right.length && right[nextRight].baseStart <= end) { const value = right[nextRight++]; rightRegion.push(value); end = Math.max(end, value.baseEnd); expanded = true; }
    }
    const baseRegion = base.slice(start, end);
    result.push(block(baseRegion, leftRegion.length ? apply(base, leftRegion, start, end) : baseRegion, rightRegion.length ? apply(base, rightRegion, start, end) : baseRegion));
    cursor = end; li = nextLeft; ri = nextRight;
  }
  if (cursor < base.length) { const same = base.slice(cursor); result.push(block(same, same, same)); }
  return result.filter((value) => value.state === 'conflict').length === merge.conflicts.length ? result : null;
}

function resolvedLines(block: ConflictBlock, resolution: MergeResolution): string[] {
  if (resolution === 'ours') return block.oursLines;
  if (resolution === 'theirs') return block.theirsLines;
  if (resolution === 'both') return [...block.oursLines, ...block.theirsLines];
  if (typeof resolution === 'object') return resolution.lines;
  const value = [`<<<<<<< ${block.oursLabel}`, ...block.oursLines];
  if (block.baseLines.length) value.push('||||||| BASE', ...block.baseLines);
  value.push('=======', ...block.theirsLines, `>>>>>>> ${block.theirsLabel}`);
  return value;
}

function fallbackContent(merge: MergeVersions, resolutions: Record<number, MergeResolution>): string {
  const source = merge.markerContent.split('\n'); const output: string[] = []; let cursor = 0;
  for (const conflict of merge.conflicts) { output.push(...source.slice(cursor, conflict.startLine), ...resolvedLines(conflict, resolutions[conflict.index] ?? 'unresolved')); cursor = conflict.endLine + 1; }
  output.push(...source.slice(cursor));
  return output.join('\n');
}

export function buildMergeContent(merge: MergeVersions, resolutions: Record<number, MergeResolution>, scope: NonConflictScope): string {
  const analyzed = analyzeThreeWay(merge);
  if (!analyzed) return fallbackContent(merge, resolutions);
  const output: string[] = []; let conflictIndex = 0;
  for (const value of analyzed) {
    if (value.state === 'conflict') output.push(...resolvedLines(merge.conflicts[conflictIndex], resolutions[conflictIndex++] ?? 'unresolved'));
    else if (scope === 'left' && (value.state === 'left' || value.state === 'both')) output.push(...value.left);
    else if (scope === 'right' && (value.state === 'right' || value.state === 'both')) output.push(...value.right);
    else if (scope === 'all' && value.state !== 'equal') output.push(...(value.state === 'right' ? value.right : value.left));
    else output.push(...value.base);
  }
  return output.join('\n');
}

export function mergeCounts(merge: MergeVersions) {
  const analyzed = analyzeThreeWay(merge);
  return { compatible: Boolean(analyzed), conflicts: merge.conflicts.length, nonConflicting: analyzed?.filter((value) => value.state === 'left' || value.state === 'right' || value.state === 'both').length ?? 0 };
}
