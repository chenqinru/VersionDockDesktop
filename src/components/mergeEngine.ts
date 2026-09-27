import type { ConflictBlock, MergeVersions } from '../bindings/generated';

export type { ConflictBlock };

export interface MergeConflictFile {
  absolutePath: string;
  relativePath: string;
  repoId: string;
  conflicts: ConflictBlock[];
  oursLabel: string;
  theirsLabel: string;
  content: string;
  oursStatus?: 'modified' | 'added' | 'deleted';
  theirsStatus?: 'modified' | 'added' | 'deleted';
  baseContent?: string;
  oursContent?: string;
  theirsContent?: string;
  language?: string;
}

export function toMergeConflictFile(merge: MergeVersions): MergeConflictFile {
  return {
    absolutePath: merge.path,
    relativePath: merge.path,
    repoId: '',
    conflicts: merge.conflicts,
    oursLabel: merge.oursLabel || 'HEAD',
    theirsLabel: merge.theirsLabel || 'origin/main',
    content: merge.markerContent,
    oursStatus: merge.oursStatus as 'modified' | 'added' | 'deleted' | undefined,
    theirsStatus: merge.theirsStatus as 'modified' | 'added' | 'deleted' | undefined,
    baseContent: merge.base,
    oursContent: merge.ours,
    theirsContent: merge.theirs,
    language: merge.language || 'plaintext',
  };
}

export function shouldDeleteResolvedFile(
  file: MergeConflictFile,
  resultContent: string,
  resolutions: Record<number, Resolution>,
): boolean {
  const deletedSide = file.oursStatus === 'deleted' ? 'ours' : file.theirsStatus === 'deleted' ? 'theirs' : undefined;
  if (!deletedSide || resultContent !== '' || file.conflicts.length === 0) return false;
  return file.conflicts.every((_, index) => resolutions[index] === deletedSide);
}

export type CustomResolution = { type: 'custom'; lines: string[]; acceptedSides?: Array<'ours' | 'theirs'>; resolvedByAi?: boolean };
export type Resolution = 'ours' | 'theirs' | 'both' | 'unresolved' | CustomResolution;
export type NormalEdits = Record<number, string[]>;
export type PaneSide = 'left' | 'center' | 'right';
export type NonConflictingChangeScope = 'left' | 'all' | 'right';
export type NonConflictingSelection = 'left' | 'right';
export type NonConflictingSelections = Record<number, NonConflictingSelection>;

export type Segment = NormalSegment | ConflictSegment;
export interface NormalSegment { kind: 'normal'; lines: string[] }
export interface ConflictSegment { kind: 'conflict'; index: number; block: ConflictBlock }

export type MergeBlockState = 'equal' | 'modified_left' | 'modified_right' | 'modified_both' | 'conflict';

export interface SideChange {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

export interface LineMatch {
  baseIndex: number;
  sideIndex: number;
}

export interface ThreeWayBlock {
  state: MergeBlockState;
  baseLines: string[];
  leftLines: string[];
  rightLines: string[];
}

export interface NormalBlockRef {
  blockIndex: number;
  block: ThreeWayBlock;
}

const MAX_STABLE_LCS_CELLS = 1_000_000;
// Exact LCS remains quadratic in time even with linear-space reconstruction.
// Above this budget we conservatively treat the changed middle as one block.
// That can disable the convenience "apply non-conflicting" action for a very
// large divergent file, but it cannot silently apply a wrong merge result.
const MAX_EXACT_DIFF_CELLS = 4_000_000;

export function splitConflictSegments(content: string, file: MergeConflictFile): Segment[] {
  const threeWayBlocks = compatibleThreeWayBlocks(file);
  if (threeWayBlocks) {
    const segments: Segment[] = [];
    let normalLines: string[] = [];
    let hasNormalBlock = false;
    let conflictIndex = 0;

    const flushNormal = () => {
      if (!hasNormalBlock) return;
      segments.push({ kind: 'normal', lines: normalLines });
      normalLines = [];
      hasNormalBlock = false;
    };

    threeWayBlocks.forEach(block => {
      if (block.state !== 'conflict') {
        normalLines.push(...block.baseLines);
        hasNormalBlock = true;
        return;
      }

      flushNormal();
      const parsedBlock = file.conflicts[conflictIndex];
      if (parsedBlock) {
        segments.push({
          kind: 'conflict',
          index: conflictIndex,
          block: {
            ...parsedBlock,
            oursLines: block.leftLines,
            baseLines: block.baseLines,
            theirsLines: block.rightLines,
          },
        });
      }
      conflictIndex += 1;
    });
    flushNormal();
    return segments;
  }

  const lines = content.split('\n');
  const segments: Segment[] = [];
  let normal: string[] = [];
  let i = 0;
  let conflictIndex = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) {
      normal.push(lines[i]);
      i += 1;
      continue;
    }

    if (normal.length > 0) {
      segments.push({ kind: 'normal', lines: normal });
      normal = [];
    }

    const block = file.conflicts[conflictIndex];
    i += 1;
    while (i < lines.length && !lines[i].startsWith('=======') && !lines[i].startsWith('|||||||')) i += 1;
    while (i < lines.length && !lines[i].startsWith('=======')) i += 1;
    if (i < lines.length && lines[i].startsWith('=======')) i += 1;
    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) i += 1;
    if (i < lines.length && lines[i].startsWith('>>>>>>>')) i += 1;

    if (block) segments.push({ kind: 'conflict', index: conflictIndex, block });
    conflictIndex += 1;
  }

  if (normal.length > 0) segments.push({ kind: 'normal', lines: normal });
  return segments;
}

export function getEffectiveConflictBlocks(file: MergeConflictFile): ConflictBlock[] {
  return splitConflictSegments(file.content, file)
    .filter((segment): segment is ConflictSegment => segment.kind === 'conflict')
    .sort((left, right) => left.index - right.index)
    .map(segment => segment.block);
}

export function linesEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

export function changedLineFlags(baseLines: string[], displayedLines: string[]): boolean[] {
  const matchedLines = new Set(findLineMatches(baseLines, displayedLines).map(match => match.sideIndex));
  return displayedLines.map((_, index) => !matchedLines.has(index));
}

function splitLines(content: string): string[] {
  return content.split('\n');
}

function lcsPrefixLengths(
  left: string[], leftStart: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
): Uint32Array {
  const rightLength = rightEnd - rightStart;
  let previous = new Uint32Array(rightLength + 1);
  let current = new Uint32Array(rightLength + 1);

  for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
    current[0] = 0;
    for (let offset = 1; offset <= rightLength; offset += 1) {
      current[offset] = left[leftIndex] === right[rightStart + offset - 1]
        ? previous[offset - 1] + 1
        : Math.max(previous[offset], current[offset - 1]);
    }
    [previous, current] = [current, previous];
  }

  return previous;
}

function lcsSuffixLengths(
  left: string[], leftStart: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
): Uint32Array {
  const rightLength = rightEnd - rightStart;
  let previous = new Uint32Array(rightLength + 1);
  let current = new Uint32Array(rightLength + 1);

  for (let leftIndex = leftEnd - 1; leftIndex >= leftStart; leftIndex -= 1) {
    current[rightLength] = 0;
    for (let offset = rightLength - 1; offset >= 0; offset -= 1) {
      current[offset] = left[leftIndex] === right[rightStart + offset]
        ? previous[offset + 1] + 1
        : Math.max(previous[offset], current[offset + 1]);
    }
    [previous, current] = [current, previous];
  }

  return previous;
}

function findLcsSplit(
  left: string[], leftStart: number, leftMid: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
): number {
  const prefix = lcsPrefixLengths(left, leftStart, leftMid, right, rightStart, rightEnd);
  const suffix = lcsSuffixLengths(left, leftMid, leftEnd, right, rightStart, rightEnd);
  let bestOffset = 0;
  let bestScore = -1;

  for (let offset = 0; offset < prefix.length; offset += 1) {
    const score = prefix[offset] + suffix[offset];
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return rightStart + bestOffset;
}

function collectLcsMatches(
  left: string[], leftStart: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
  output: Array<{ leftIndex: number; rightIndex: number }>,
): void {
  if (leftStart >= leftEnd || rightStart >= rightEnd) return;

  if (leftEnd - leftStart === 1) {
    for (let rightIndex = rightStart; rightIndex < rightEnd; rightIndex += 1) {
      if (left[leftStart] === right[rightIndex]) {
        output.push({ leftIndex: leftStart, rightIndex });
        break;
      }
    }
    return;
  }

  if (rightEnd - rightStart === 1) {
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      if (left[leftIndex] === right[rightStart]) {
        output.push({ leftIndex, rightIndex: rightStart });
        break;
      }
    }
    return;
  }

  const leftMid = leftStart + Math.floor((leftEnd - leftStart) / 2);
  const rightMid = findLcsSplit(left, leftStart, leftMid, leftEnd, right, rightStart, rightEnd);
  collectLcsMatches(left, leftStart, leftMid, right, rightStart, rightMid, output);
  collectLcsMatches(left, leftMid, leftEnd, right, rightMid, rightEnd, output);
}

function findStableLineMatches(baseLines: string[], sideLines: string[]): LineMatch[] {
  const columnCount = sideLines.length + 1;
  const table = new Uint32Array((baseLines.length + 1) * columnCount);
  const cell = (baseIndex: number, sideIndex: number) => baseIndex * columnCount + sideIndex;

  for (let baseIndex = baseLines.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let sideIndex = sideLines.length - 1; sideIndex >= 0; sideIndex -= 1) {
      table[cell(baseIndex, sideIndex)] = baseLines[baseIndex] === sideLines[sideIndex]
        ? table[cell(baseIndex + 1, sideIndex + 1)] + 1
        : Math.max(table[cell(baseIndex + 1, sideIndex)], table[cell(baseIndex, sideIndex + 1)]);
    }
  }

  const matches: LineMatch[] = [];
  const preferSkippingSide = sideLines.length >= baseLines.length;
  let baseIndex = 0;
  let sideIndex = 0;
  while (baseIndex < baseLines.length && sideIndex < sideLines.length) {
    if (
      baseLines[baseIndex] === sideLines[sideIndex]
      && table[cell(baseIndex, sideIndex)] === table[cell(baseIndex + 1, sideIndex + 1)] + 1
    ) {
      matches.push({ baseIndex, sideIndex });
      baseIndex += 1;
      sideIndex += 1;
      continue;
    }

    const skipBaseScore = table[cell(baseIndex + 1, sideIndex)];
    const skipSideScore = table[cell(baseIndex, sideIndex + 1)];
    if (skipSideScore > skipBaseScore || (skipSideScore === skipBaseScore && preferSkippingSide)) sideIndex += 1;
    else baseIndex += 1;
  }
  return matches;
}

function findLineMatches(baseLines: string[], sideLines: string[]): LineMatch[] {
  if ((baseLines.length + 1) * (sideLines.length + 1) <= MAX_STABLE_LCS_CELLS) {
    return findStableLineMatches(baseLines, sideLines);
  }

  if (sideLines.length <= baseLines.length) {
    const matches: Array<{ leftIndex: number; rightIndex: number }> = [];
    collectLcsMatches(baseLines, 0, baseLines.length, sideLines, 0, sideLines.length, matches);
    return matches.map(match => ({ baseIndex: match.leftIndex, sideIndex: match.rightIndex }));
  }

  // Hirschberg uses O(length of the right sequence) memory, so swap the
  // sequences when the side is longer and map the coordinates back.
  const matches: Array<{ leftIndex: number; rightIndex: number }> = [];
  collectLcsMatches(sideLines, 0, sideLines.length, baseLines, 0, baseLines.length, matches);
  return matches.map(match => ({ baseIndex: match.rightIndex, sideIndex: match.leftIndex }));
}

function shiftPureDeletionToLaterBoundary(baseLines: string[], change: SideChange): SideChange {
  if (change.lines.length > 0 || change.baseStart >= change.baseEnd) return change;

  let baseStart = change.baseStart;
  let baseEnd = change.baseEnd;
  // Repeated structural lines such as `}` followed by a blank line can make an
  // LCS attach a deletion to the preceding method. Shift equal boundary lines
  // forward so the deleted block keeps its complete trailing structure, which
  // matches JetBrains' merge-view cleanup without changing the resulting text.
  while (baseEnd < baseLines.length && baseLines[baseStart] === baseLines[baseEnd]) {
    baseStart += 1;
    baseEnd += 1;
  }
  return { ...change, baseStart, baseEnd };
}

export function diffLineChanges(baseLines: string[], sideLines: string[]): SideChange[] {
  const baseLength = baseLines.length;
  const sideLength = sideLines.length;
  let prefixLength = 0;
  while (
    prefixLength < baseLength
    && prefixLength < sideLength
    && baseLines[prefixLength] === sideLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < baseLength - prefixLength
    && suffixLength < sideLength - prefixLength
    && baseLines[baseLength - suffixLength - 1] === sideLines[sideLength - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const baseMiddleEnd = baseLength - suffixLength;
  const sideMiddleEnd = sideLength - suffixLength;
  if (prefixLength === baseMiddleEnd && prefixLength === sideMiddleEnd) return [];

  const baseMiddle = baseLines.slice(prefixLength, baseMiddleEnd);
  const sideMiddle = sideLines.slice(prefixLength, sideMiddleEnd);
  if (baseMiddle.length > 0 && sideMiddle.length > Math.floor(MAX_EXACT_DIFF_CELLS / baseMiddle.length)) {
    return [{ baseStart: prefixLength, baseEnd: baseMiddleEnd, lines: sideMiddle }]
      .map(change => shiftPureDeletionToLaterBoundary(baseLines, change));
  }

  const matches = findLineMatches(baseMiddle, sideMiddle);
  const changes: SideChange[] = [];
  let baseCursor = 0;
  let sideCursor = 0;

  for (const match of matches) {
    if (baseCursor < match.baseIndex || sideCursor < match.sideIndex) {
      changes.push({
        baseStart: prefixLength + baseCursor,
        baseEnd: prefixLength + match.baseIndex,
        lines: sideMiddle.slice(sideCursor, match.sideIndex),
      });
    }
    baseCursor = match.baseIndex + 1;
    sideCursor = match.sideIndex + 1;
  }

  if (baseCursor < baseMiddle.length || sideCursor < sideMiddle.length) {
    changes.push({
      baseStart: prefixLength + baseCursor,
      baseEnd: baseMiddleEnd,
      lines: sideMiddle.slice(sideCursor),
    });
  }

  return changes.map(change => shiftPureDeletionToLaterBoundary(baseLines, change));
}

function applyRegionChanges(baseLines: string[], changes: SideChange[], start: number, end: number): string[] {
  const output: string[] = [];
  let cursor = start;

  for (const change of changes) {
    if (change.baseStart > cursor) output.push(...baseLines.slice(cursor, change.baseStart));
    output.push(...change.lines);
    cursor = Math.max(cursor, change.baseEnd);
  }

  if (cursor < end) output.push(...baseLines.slice(cursor, end));
  return output;
}

function createThreeWayBlock(baseLines: string[], leftLines: string[], rightLines: string[]): ThreeWayBlock {
  const leftChanged = !linesEqual(baseLines, leftLines);
  const rightChanged = !linesEqual(baseLines, rightLines);
  let state: MergeBlockState = 'equal';

  if (leftChanged && rightChanged && linesEqual(leftLines, rightLines)) state = 'modified_both';
  else if (leftChanged && !rightChanged) state = 'modified_left';
  else if (!leftChanged && rightChanged) state = 'modified_right';
  else if (leftChanged && rightChanged) state = 'conflict';

  return { state, baseLines, leftLines, rightLines };
}

function parseThreeWayBlocks(file: MergeConflictFile): ThreeWayBlock[] | null {
  // Empty content is a valid side of add/delete conflicts; only an absent
  // version means three-way analysis is unavailable.
  if (file.baseContent === undefined || file.oursContent === undefined || file.theirsContent === undefined) return null;

  const baseLines = splitLines(file.baseContent);
  const leftChanges = diffLineChanges(baseLines, splitLines(file.oursContent));
  const rightChanges = diffLineChanges(baseLines, splitLines(file.theirsContent));
  const blocks: ThreeWayBlock[] = [];

  let baseCursor = 0;
  let leftCursor = 0;
  let rightCursor = 0;

  while (leftCursor < leftChanges.length || rightCursor < rightChanges.length) {
    const nextLeftStart = leftChanges[leftCursor]?.baseStart ?? Number.POSITIVE_INFINITY;
    const nextRightStart = rightChanges[rightCursor]?.baseStart ?? Number.POSITIVE_INFINITY;
    const regionStart = Math.min(nextLeftStart, nextRightStart);

    if (regionStart === Number.POSITIVE_INFINITY) break;
    if (baseCursor < regionStart) {
      const equalLines = baseLines.slice(baseCursor, regionStart);
      blocks.push(createThreeWayBlock(equalLines, equalLines, equalLines));
      baseCursor = regionStart;
    }

    let regionEnd = regionStart;
    let scanLeft = leftCursor;
    let scanRight = rightCursor;
    const leftRegionChanges: SideChange[] = [];
    const rightRegionChanges: SideChange[] = [];
    let expanded = true;

    while (expanded) {
      expanded = false;
      while (scanLeft < leftChanges.length && leftChanges[scanLeft].baseStart <= regionEnd) {
        const change = leftChanges[scanLeft];
        leftRegionChanges.push(change);
        regionEnd = Math.max(regionEnd, change.baseEnd);
        scanLeft += 1;
        expanded = true;
      }
      while (scanRight < rightChanges.length && rightChanges[scanRight].baseStart <= regionEnd) {
        const change = rightChanges[scanRight];
        rightRegionChanges.push(change);
        regionEnd = Math.max(regionEnd, change.baseEnd);
        scanRight += 1;
        expanded = true;
      }
    }

    const baseRegionLines = baseLines.slice(regionStart, regionEnd);
    const leftRegionLines = leftRegionChanges.length > 0
      ? applyRegionChanges(baseLines, leftRegionChanges, regionStart, regionEnd)
      : baseRegionLines;
    const rightRegionLines = rightRegionChanges.length > 0
      ? applyRegionChanges(baseLines, rightRegionChanges, regionStart, regionEnd)
      : baseRegionLines;

    blocks.push(createThreeWayBlock(baseRegionLines, leftRegionLines, rightRegionLines));
    leftCursor = scanLeft;
    rightCursor = scanRight;
    baseCursor = regionEnd;
  }

  if (baseCursor < baseLines.length) {
    const equalLines = baseLines.slice(baseCursor);
    blocks.push(createThreeWayBlock(equalLines, equalLines, equalLines));
  }

  return blocks;
}

export function isApplicableNonConflictingBlock(block: ThreeWayBlock): boolean {
  return block.state === 'modified_left' || block.state === 'modified_right' || block.state === 'modified_both';
}

export function nonConflictingResultLines(block: ThreeWayBlock, selection?: NonConflictingSelection): string[] {
  if (selection === 'left') return block.leftLines;
  if (selection === 'right') return block.rightLines;
  return block.baseLines;
}

export function compatibleThreeWayBlocks(file: MergeConflictFile): ThreeWayBlock[] | null {
  const blocks = parseThreeWayBlocks(file);
  if (!blocks) return null;
  const parsedConflictCount = blocks.filter(block => block.state === 'conflict').length;
  return parsedConflictCount === file.conflicts.length ? blocks : null;
}

function normalSegmentRefs(segments: Segment[]): Array<{ segmentIndex: number; groupIndex: number }> {
  let groupIndex = 0;
  const refs: Array<{ segmentIndex: number; groupIndex: number }> = [];

  segments.forEach((segment, segmentIndex) => {
    if (segment.kind === 'normal') refs.push({ segmentIndex, groupIndex });
    else groupIndex = segment.index + 1;
  });

  return refs;
}

export function getMergeToolbarCounts(file: MergeConflictFile): { changeCount: number; conflictCount: number; nonConflictingCount: number } {
  const conflictCount = file.conflicts.length;
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return { changeCount: 0, conflictCount, nonConflictingCount: 0 };

  const nonConflictingCount = blocks.filter(isApplicableNonConflictingBlock).length;

  return {
    changeCount: nonConflictingCount,
    conflictCount,
    nonConflictingCount,
  };
}

export function buildNonConflictingSelectionsForScope(file: MergeConflictFile, scope: NonConflictingChangeScope): NonConflictingSelections | null {
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return null;

  const selections: NonConflictingSelections = {};
  blocks.forEach((block, blockIndex) => {
    if (block.state === 'modified_left' && scope !== 'right') selections[blockIndex] = 'left';
    else if (block.state === 'modified_right' && scope !== 'left') selections[blockIndex] = 'right';
    else if (block.state === 'modified_both') selections[blockIndex] = scope === 'right' ? 'right' : 'left';
  });
  return selections;
}

export function buildNormalEditsForNonConflictingSelections(file: MergeConflictFile, selections: NonConflictingSelections): NormalEdits | null {
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return null;

  const groups = Array.from({ length: file.conflicts.length + 1 }, () => [] as string[]);
  let groupIndex = 0;

  blocks.forEach((block, blockIndex) => {
    if (block.state === 'conflict') {
      groupIndex += 1;
      return;
    }
    groups[Math.min(groupIndex, groups.length - 1)].push(...nonConflictingResultLines(block, selections[blockIndex]));
  });

  const refs = normalSegmentRefs(splitConflictSegments(file.content, file));
  const representedGroups = new Set(refs.map(ref => ref.groupIndex));
  const hasUnrepresentedContent = groups.some((lines, index) => lines.length > 0 && !representedGroups.has(index));
  if (hasUnrepresentedContent) return null;

  const nextEdits: NormalEdits = {};
  refs.forEach(ref => {
    nextEdits[ref.segmentIndex] = groups[ref.groupIndex] ?? [];
  });

  return nextEdits;
}

export function buildNormalEditsForNonConflictingScope(file: MergeConflictFile, scope: NonConflictingChangeScope): NormalEdits | null {
  const selections = buildNonConflictingSelectionsForScope(file, scope);
  return selections ? buildNormalEditsForNonConflictingSelections(file, selections) : null;
}

export function buildBaseNormalEdits(file: MergeConflictFile): NormalEdits | null {
  return buildNormalEditsForNonConflictingSelections(file, {});
}

export function buildNormalBlockRefs(file: MergeConflictFile): Record<number, NormalBlockRef[]> | null {
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return null;

  const groups = Array.from({ length: file.conflicts.length + 1 }, () => [] as NormalBlockRef[]);
  let groupIndex = 0;
  blocks.forEach((block, blockIndex) => {
    if (block.state === 'conflict') {
      groupIndex += 1;
      return;
    }
    groups[Math.min(groupIndex, groups.length - 1)].push({ blockIndex, block });
  });

  const refs: Record<number, NormalBlockRef[]> = {};
  normalSegmentRefs(splitConflictSegments(file.content, file)).forEach(ref => {
    refs[ref.segmentIndex] = groups[ref.groupIndex] ?? [];
  });
  return refs;
}

export function resolveLines(block: ConflictBlock, resolution: Resolution): string[] {
  if (isCustomResolution(resolution)) return resolution.lines;
  if (resolution === 'ours') return block.oursLines;
  if (resolution === 'theirs') return block.theirsLines;
  if (resolution === 'both') return [...block.oursLines, ...block.theirsLines];
  return block.baseLines;
}

export function isCustomResolution(resolution: Resolution | undefined): resolution is Extract<Resolution, { type: 'custom' }> {
  return typeof resolution === 'object' && resolution?.type === 'custom';
}

export function isResolvedResolution(resolution: Resolution | undefined): resolution is Exclude<Resolution, 'unresolved' | undefined> {
  return Boolean(resolution) && resolution !== 'unresolved';
}

export function editableValueToLines(value: string): string[] {
  return value === '' ? [] : value.split('\n');
}

export function linesToEditableValue(lines: string[]): string {
  return lines.join('\n');
}

function markerLines(block: ConflictBlock): string[] {
  const lines = [`<<<<<<< ${block.oursLabel}`, ...block.oursLines];
  if (block.baseLines.length > 0) lines.push('||||||| base', ...block.baseLines);
  lines.push('=======', ...block.theirsLines, `>>>>>>> ${block.theirsLabel}`);
  return lines;
}

export function buildContentFromResolutions(file: MergeConflictFile, resolutions: Record<number, Resolution>, normalEdits: NormalEdits = {}): string {
  const segments = splitConflictSegments(file.content, file);
  const lines: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind === 'normal') {
      lines.push(...(normalEdits[index] ?? segment.lines));
      continue;
    }
    const resolution = resolutions[segment.index] ?? 'unresolved';
    lines.push(...(resolution === 'unresolved' ? markerLines(segment.block) : resolveLines(segment.block, resolution)));
  }
  return lines.join('\n');
}

export function lineCount(segment: Segment, side: PaneSide, resolution?: Resolution, normalLines?: string[]): number {
  if (segment.kind === 'normal') return (normalLines ?? segment.lines).length;
  if (side === 'left') return segment.block.oursLines.length;
  if (side === 'right') return segment.block.theirsLines.length;
  if (isResolvedResolution(resolution)) return resolveLines(segment.block, resolution).length;
  return segment.block.baseLines.length;
}

export function sideResolution(side: PaneSide): 'ours' | 'theirs' {
  return side === 'left' ? 'ours' : 'theirs';
}

export function acceptedResolutionSides(resolution: Resolution | undefined): Array<'ours' | 'theirs'> {
  if (isCustomResolution(resolution)) return resolution.acceptedSides ?? [];
  if (resolution === 'both') return ['ours', 'theirs'];
  if (resolution === 'ours' || resolution === 'theirs') return [resolution];
  return [];
}

export function includesResolutionSide(resolution: Resolution | undefined, side: 'ours' | 'theirs'): boolean {
  return acceptedResolutionSides(resolution).includes(side);
}

export function addResolutionSide(resolution: Resolution | undefined, side: 'ours' | 'theirs'): Resolution {
  if (resolution === 'both' || resolution === side) return resolution;
  if (resolution === 'ours' || resolution === 'theirs') return 'both';
  return side;
}

export function removeResolutionSide(resolution: Resolution | undefined, side: 'ours' | 'theirs'): Resolution {
  if (resolution === 'both') return side === 'ours' ? 'theirs' : 'ours';
  if (resolution === side) return 'unresolved';
  return resolution ?? 'unresolved';
}