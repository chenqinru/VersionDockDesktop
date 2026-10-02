export interface BranchMenuPosition { left: number; top: number; centerY: number; maxHeight: number }
export const BRANCH_MENU_WIDTH = 360;

export function positionBranchSubmenu(item: DOMRect, parent: DOMRect | null, viewportWidth: number, viewportHeight: number, preferLeft = true): BranchMenuPosition {
  const width = Math.min(BRANCH_MENU_WIDTH, viewportWidth - 16);
  const rect = parent ?? item;
  const maxHeight = Math.max(0, Math.min(440, viewportHeight - 40));
  const centerY = item.top + item.height / 2;
  // Continue towards available space and flip before crossing the viewport.
  const candidate = rect.left - width - 4;
  const canRight = rect.right + width + 4 <= viewportWidth - 8;
  const left = preferLeft && candidate >= 8 ? candidate : canRight ? rect.right + 4 : candidate >= 8 ? candidate : Math.max(8, viewportWidth - width - 8);
  return { left: Math.max(8, Math.min(left, viewportWidth - width - 8)), top: Math.max(10, Math.min(centerY - 130, viewportHeight - 30 - Math.min(maxHeight, 260))), centerY, maxHeight };
}
