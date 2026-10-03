import { diffLineChanges, type MergeConflictFile } from '../components/mergeEngine';

function codeLinesEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function trimBoundaryBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

function codeLinesEqualIgnoringBoundaryBlanks(left: string[], right: string[]): boolean {
  return codeLinesEqual(trimBoundaryBlankLines(left), trimBoundaryBlankLines(right));
}

function normalizeCodeForComparison(lines: string[]): string {
  return trimBoundaryBlankLines(lines).join('\n').replace(/\s+/g, ' ').trim();
}

function comparableCodeLines(lines: string[]): string[] {
  return lines
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(line => line.length > 0);
}

function sideSpecificCodeLines(sideLines: string[], otherSideLines: string[]): string[] {
  const comparableSide = comparableCodeLines(sideLines);
  const comparableOtherSide = comparableCodeLines(otherSideLines);
  return diffLineChanges(comparableOtherSide, comparableSide).flatMap(change => change.lines);
}

function containsLinesInOrder(lines: string[], expectedLines: string[]): boolean {
  if (expectedLines.length === 0) return false;
  const comparableLines = comparableCodeLines(lines);
  let expectedIndex = 0;
  for (const line of comparableLines) {
    if (line !== expectedLines[expectedIndex]) continue;
    expectedIndex += 1;
    if (expectedIndex === expectedLines.length) return true;
  }
  return false;
}

function findLineSlice(lines: string[], slice: string[]): { start: number; end: number } | null {
  const candidate = trimBoundaryBlankLines(slice);
  if (candidate.length === 0 || candidate.length > lines.length) return null;
  for (let start = 0; start <= lines.length - candidate.length; start += 1) {
    if (candidate.every((line, index) => line === lines[start + index])) {
      return { start, end: start + candidate.length };
    }
  }
  return null;
}

export function expandAiResolutionLines(
  markerConflict: MergeConflictFile['conflicts'][number],
  effectiveConflict: MergeConflictFile['conflicts'][number],
  resolvedLines: string[],
): string[] {
  const matchesMarkerOurs = codeLinesEqualIgnoringBoundaryBlanks(resolvedLines, markerConflict.oursLines);
  const matchesMarkerTheirs = codeLinesEqualIgnoringBoundaryBlanks(resolvedLines, markerConflict.theirsLines);
  if (matchesMarkerOurs && matchesMarkerTheirs) {
    return codeLinesEqual(effectiveConflict.oursLines, effectiveConflict.theirsLines)
      ? [...effectiveConflict.oursLines]
      : [...resolvedLines];
  }
  if (matchesMarkerOurs) return [...effectiveConflict.oursLines];
  if (matchesMarkerTheirs) return [...effectiveConflict.theirsLines];

  const oursSlice = findLineSlice(effectiveConflict.oursLines, markerConflict.oursLines);
  const theirsSlice = findLineSlice(effectiveConflict.theirsLines, markerConflict.theirsLines);
  if (oursSlice && !theirsSlice) {
    return [
      ...effectiveConflict.oursLines.slice(0, oursSlice.start),
      ...resolvedLines,
      ...effectiveConflict.oursLines.slice(oursSlice.end),
    ];
  }
  if (!oursSlice && theirsSlice) {
    return [
      ...effectiveConflict.theirsLines.slice(0, theirsSlice.start),
      ...resolvedLines,
      ...effectiveConflict.theirsLines.slice(theirsSlice.end),
    ];
  }
  if (!oursSlice || !theirsSlice) return [...resolvedLines];

  const oursPrefix = effectiveConflict.oursLines.slice(0, oursSlice.start);
  const theirsPrefix = effectiveConflict.theirsLines.slice(0, theirsSlice.start);
  const oursSuffix = effectiveConflict.oursLines.slice(oursSlice.end);
  const theirsSuffix = effectiveConflict.theirsLines.slice(theirsSlice.end);
  if (!codeLinesEqual(oursPrefix, theirsPrefix) || !codeLinesEqual(oursSuffix, theirsSuffix)) return [...resolvedLines];
  return [...oursPrefix, ...resolvedLines, ...oursSuffix];
}

export function inferAiAcceptedSides(
  conflict: MergeConflictFile['conflicts'][number],
  resolvedLines: string[],
): Array<'ours' | 'theirs'> {
  const resolvedCode = normalizeCodeForComparison(resolvedLines);
  const matchesOurs = resolvedCode === normalizeCodeForComparison(conflict.oursLines);
  const matchesTheirs = resolvedCode === normalizeCodeForComparison(conflict.theirsLines);
  if (matchesOurs && matchesTheirs) return ['ours', 'theirs'];
  if (matchesOurs) return ['ours'];
  if (matchesTheirs) return ['theirs'];

  const keepsOurs = containsLinesInOrder(
    resolvedLines,
    sideSpecificCodeLines(conflict.oursLines, conflict.theirsLines),
  );
  const keepsTheirs = containsLinesInOrder(
    resolvedLines,
    sideSpecificCodeLines(conflict.theirsLines, conflict.oursLines),
  );
  if (keepsOurs && keepsTheirs) return ['ours', 'theirs'];
  if (keepsOurs) return ['ours'];
  if (keepsTheirs) return ['theirs'];
  return [];
}


export function normalEditsEqual(left: Record<number, string[]> | null, right: Record<number, string[]> | null) {
  if (!left || !right) return left === right;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => codeLinesEqual(left[Number(key)] ?? [], right[Number(key)] ?? []));
}
export function previewDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const stop = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
    signal.addEventListener('abort', stop, { once: true });
  });
}
