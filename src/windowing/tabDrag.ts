export const TAB_BAR_HEIGHT = 38;
export const TAB_DETACH_THRESHOLD = 56;
export const TAB_SNAP_MARGIN = 40;

export interface ScreenPoint {
  screenX: number;
  screenY: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function dragPoint(
  event: { screenX: number; screenY: number; clientX: number; clientY: number },
  previous?: ScreenPoint,
): ScreenPoint {
  const coordinatesAreFinite = Number.isFinite(event.screenX) && Number.isFinite(event.screenY);
  const browserSentEmptyDragCoordinates = event.screenX === 0
    && event.screenY === 0
    && event.clientX === 0
    && event.clientY === 0
    && previous !== undefined;
  return coordinatesAreFinite && !browserSentEmptyDragCoordinates
    ? { screenX: event.screenX, screenY: event.screenY }
    : previous ?? { screenX: 0, screenY: 0 };
}

export function tabDetachDistance(point: ScreenPoint, source: WindowBounds): number {
  const localX = point.screenX - source.x;
  const localY = point.screenY - source.y;
  const horizontal = localX < 0 ? -localX : localX > source.width ? localX - source.width : 0;
  const vertical = localY < 0 ? -localY : localY > TAB_BAR_HEIGHT ? localY - TAB_BAR_HEIGHT : 0;
  return Math.hypot(horizontal, vertical);
}

export function shouldDetachTab(
  point: ScreenPoint,
  source: WindowBounds,
  travelledDistance = Number.POSITIVE_INFINITY,
): boolean {
  return travelledDistance >= TAB_DETACH_THRESHOLD
    && tabDetachDistance(point, source) >= TAB_DETACH_THRESHOLD;
}

export function tabSnapInsertionIndex(
  point: ScreenPoint,
  target: WindowBounds,
  tabMidpoints: number[],
): number | null {
  if (!Number.isFinite(point.screenX) || !Number.isFinite(point.screenY) || target.width <= 0) return null;
  const inSnapZone = point.screenX >= target.x - TAB_SNAP_MARGIN
    && point.screenX <= target.x + target.width + TAB_SNAP_MARGIN
    && point.screenY >= target.y - TAB_SNAP_MARGIN
    && point.screenY <= target.y + TAB_BAR_HEIGHT + TAB_SNAP_MARGIN;
  if (!inSnapZone) return null;
  const localX = point.screenX - target.x;
  const index = tabMidpoints.findIndex((midpoint) => localX < midpoint);
  return index === -1 ? tabMidpoints.length : index;
}
