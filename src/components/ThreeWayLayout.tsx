import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HighlighterCore, ThemeRegistrationRaw } from 'shiki/core';
import { useShiki } from '../utils/useShiki';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import {
  type ConflictBlock,
  type MergeConflictFile,
  type Resolution,
  type NormalEdits,
  type PaneSide,
  type NonConflictingSelection,
  type NonConflictingSelections,
  type Segment,
  type ConflictSegment,
  type NormalBlockRef,
  splitConflictSegments,
  buildBaseNormalEdits,
  buildNormalEditsForNonConflictingScope,
  buildNormalBlockRefs,
  buildContentFromResolutions,
  lineCount,
  sideResolution,
  acceptedResolutionSides,
  includesResolutionSide,
  addResolutionSide,
  removeResolutionSide,
  changedLineFlags,
  resolveLines,
  isResolvedResolution,
  isCustomResolution,
  isApplicableNonConflictingBlock,
  nonConflictingResultLines,
  linesToEditableValue,
  editableValueToLines,
  type CustomResolution,
} from './mergeEngine';

export interface ThreeWayLayoutProps {
  file: MergeConflictFile;
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  nonConflictingSelections: NonConflictingSelections;
  language: string;
  onResultChange: (content: string) => void;
  onResolveBlock: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
  onSelectNonConflicting: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
  currentConflictIndex: number;
  syncScrollEnabled: boolean;
  readOnly?: boolean;
  aiDraft?: AiMergeDraft | null;
  resultStatusLabel?: string;
  showCompletionNotice?: boolean;
  onApplyResolved?: () => void;
}

export interface AiMergeDraft {
  index: number;
  content: string;
}

export interface WebviewColorThemeData {
  name: string;
  type: 'dark' | 'light';
  fg: string;
  bg: string;
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
  colors: Record<string, string>;
  settings: Array<{ scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }>;
}

function getVersionDockColorTheme(): WebviewColorThemeData | null {
  return null;
}

let currentTranslator = (message: string, ...args: Array<string | number>) =>
  args.reduce<string>((value, arg, index) => value.replaceAll('{' + index + '}', String(arg)), message);

function t(message: string, ...args: Array<string | number>): string {
  return currentTranslator(message, ...args);
}

const CODE_LINE_HEIGHT = 21;
const CONNECTOR_GUTTER_WIDTH = 'clamp(40px, 3vw, 48px)';
const MERGE_SCROLLBAR_STYLES = `
  .versiondock-merge-pane {
    scrollbar-width: none !important;
    -ms-overflow-style: none;
  }
  .versiondock-merge-pane::-webkit-scrollbar {
    width: 0 !important;
    height: 0 !important;
    display: none !important;
    background: transparent !important;
  }
  .versiondock-merge-pane::-webkit-scrollbar-track,
  .versiondock-merge-pane::-webkit-scrollbar-track-piece,
  .versiondock-merge-pane::-webkit-scrollbar-thumb,
  .versiondock-merge-pane::-webkit-scrollbar-corner {
    display: none !important;
    background: transparent !important;
  }
  .versiondock-block-action-button {
    background: transparent !important;
    border-color: transparent !important;
  }
  .versiondock-block-action-button--accept:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent) !important;
    color: var(--vscode-textLink-activeForeground, var(--vscode-foreground)) !important;
    opacity: 1 !important;
  }
  .versiondock-block-action-button--reset {
    border-left-color: color-mix(in srgb, var(--vscode-foreground) 14%, transparent) !important;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground)) !important;
  }
  .versiondock-block-action-button--reset:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent) !important;
    color: var(--vscode-foreground) !important;
    opacity: 1 !important;
  }
  .versiondock-block-action-button:active:not(:disabled) {
    opacity: 0.68 !important;
  }
  .versiondock-block-action-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  @keyframes versiondock-ai-caret-pulse {
    0%, 42% { opacity: 1; box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-focusBorder) 72%, transparent); }
    50%, 92% { opacity: 0.16; box-shadow: none; }
    100% { opacity: 1; }
  }
  @keyframes versiondock-ai-code-glow {
    0%, 100% { background: color-mix(in srgb, var(--vscode-focusBorder) 4%, transparent); }
    50% { background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent); }
  }
  .versiondock-ai-code-caret {
    display: inline-block;
    width: 2px;
    height: 1.08em;
    margin-left: 1px;
    vertical-align: -0.16em;
    border-radius: 1px;
    background: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
    animation: versiondock-ai-caret-pulse 900ms steps(1, end) infinite;
  }
  .versiondock-ai-typing-line {
    animation: versiondock-ai-code-glow 1.5s ease-in-out infinite;
  }
  @keyframes versiondock-merge-complete-enter {
    from { opacity: 0; transform: translate(-50%, -6px) scale(0.98); }
    to { opacity: 1; transform: translate(-50%, 0) scale(1); }
  }
  .versiondock-merge-complete-notice {
    animation: versiondock-merge-complete-enter 180ms ease-out;
  }
  .versiondock-merge-complete-action:hover {
    color: var(--vscode-textLink-activeForeground) !important;
    text-decoration: underline;
  }
  .versiondock-merge-complete-action:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .versiondock-merge-complete-notice { animation: none !important; }
  }
`;

function useSyncedScroll(
  leftRef: React.RefObject<HTMLDivElement>,
  centerRef: React.RefObject<HTMLDivElement>,
  rightRef: React.RefObject<HTMLDivElement>,
  enabled = true,
) {
  const syncingRef = useRef(false);
  const handleScroll = (source: 0 | 1 | 2, event: React.UIEvent<HTMLDivElement>) => {
    if (!enabled || syncingRef.current) return;
    syncingRef.current = true;
    const { scrollTop, scrollLeft } = event.currentTarget;
    const left = leftRef.current;
    const center = centerRef.current;
    const right = rightRef.current;
    if (source !== 0 && left) {
      left.scrollTop = scrollTop;
      left.scrollLeft = scrollLeft;
    }
    if (source !== 1 && center) {
      center.scrollTop = scrollTop;
      center.scrollLeft = scrollLeft;
    }
    if (source !== 2 && right) {
      right.scrollTop = scrollTop;
      right.scrollLeft = scrollLeft;
    }
    syncingRef.current = false;
  };
  return handleScroll;
}

interface ConnectorShape {
  key: string;
  kind: 'conflict' | 'change';
  side: 'left' | 'right';
  index: number;
  changeTone?: ChangeTone;
  fillPath: string;
  outlinePath: string;
  active: boolean;
}

type RibbonDirection = 'ltr' | 'rtl';

// Adapted from git-conflict-resolver's MIT-licensed "Satin Ribbon" renderer.
// Each adjacent pane pair keeps its own direction so the three-pane layout can
// retain the original 70%/30% taper and 45% Bezier control-point geometry.
function connectorBandPath(source: DOMRect, target: DOMRect, root: DOMRect, sourceOuterEdge: number, sourceInnerEdge: number, targetInnerEdge: number, targetOuterEdge: number, direction: RibbonDirection): Pick<ConnectorShape, 'fillPath' | 'outlinePath'> {
  const sourceOuterX = sourceOuterEdge - root.left;
  const sourceX = sourceInnerEdge - root.left;
  const targetX = targetInnerEdge - root.left;
  const targetOuterX = targetOuterEdge - root.left;
  const sourceTop = source.top - root.top;
  const sourceBottom = source.bottom - root.top;
  const targetTop = target.top - root.top;
  const targetBottom = target.bottom - root.top;
  const gutterWidth = targetX - sourceX;
  const taperX = sourceX + gutterWidth * (direction === 'ltr' ? 0.70 : 0.30);
  const curveStartX = direction === 'ltr' ? sourceX : taperX;
  const curveEndX = direction === 'ltr' ? taperX : targetX;
  const controlDistance = Math.max(1, (curveEndX - curveStartX) * 0.45);
  const topPath = direction === 'ltr'
    ? `M ${sourceOuterX} ${sourceTop} L ${sourceX} ${sourceTop} C ${sourceX + controlDistance} ${sourceTop}, ${taperX - controlDistance} ${targetTop}, ${taperX} ${targetTop} L ${targetOuterX} ${targetTop}`
    : `M ${sourceOuterX} ${sourceTop} L ${taperX} ${sourceTop} C ${taperX + controlDistance} ${sourceTop}, ${targetX - controlDistance} ${targetTop}, ${targetX} ${targetTop} L ${targetOuterX} ${targetTop}`;
  const returnPath = direction === 'ltr'
    ? `L ${taperX} ${targetBottom} C ${taperX - controlDistance} ${targetBottom}, ${sourceX + controlDistance} ${sourceBottom}, ${sourceX} ${sourceBottom} L ${sourceOuterX} ${sourceBottom} Z`
    : `L ${targetX} ${targetBottom} C ${targetX - controlDistance} ${targetBottom}, ${taperX + controlDistance} ${sourceBottom}, ${taperX} ${sourceBottom} L ${sourceOuterX} ${sourceBottom} Z`;
  const outlineTopPath = direction === 'ltr'
    ? `M ${sourceX} ${sourceTop} C ${sourceX + controlDistance} ${sourceTop}, ${taperX - controlDistance} ${targetTop}, ${taperX} ${targetTop} L ${targetX} ${targetTop}`
    : `M ${sourceX} ${sourceTop} L ${taperX} ${sourceTop} C ${taperX + controlDistance} ${sourceTop}, ${targetX - controlDistance} ${targetTop}, ${targetX} ${targetTop}`;
  const outlineBottomPath = direction === 'ltr'
    ? `M ${sourceX} ${sourceBottom} C ${sourceX + controlDistance} ${sourceBottom}, ${taperX - controlDistance} ${targetBottom}, ${taperX} ${targetBottom} L ${targetX} ${targetBottom}`
    : `M ${sourceX} ${sourceBottom} L ${taperX} ${sourceBottom} C ${taperX + controlDistance} ${sourceBottom}, ${targetX - controlDistance} ${targetBottom}, ${targetX} ${targetBottom}`;
  return {
    fillPath: `${topPath} L ${targetOuterX} ${targetBottom} ${returnPath}`,
    outlinePath: `${outlineTopPath} ${outlineBottomPath}`,
  };
}

function MergeConnectorOverlay({ layoutRef, paneRefs, conflicts, resolutions, normalEdits, nonConflictingSelections, activeConflictIndex, aiDraft }: {
  layoutRef: React.RefObject<HTMLDivElement>;
  paneRefs: readonly React.RefObject<HTMLDivElement>[];
  conflicts: ConflictBlock[];
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  nonConflictingSelections: NonConflictingSelections;
  activeConflictIndex: number;
  aiDraft?: AiMergeDraft | null;
}) {
  const [shapes, setShapes] = useState<ConnectorShape[]>([]);
  const [clipBounds, setClipBounds] = useState({ top: 0, height: 0, width: 0 });

  useEffect(() => {
    const layout = layoutRef.current;
    const panes = paneRefs.map(ref => ref.current);
    if (!layout || panes.some(pane => !pane)) return;
    const concretePanes = panes as HTMLDivElement[];

    let frame = 0;
    const renderConnectors = () => {
        const rootRect = layout.getBoundingClientRect();
        const titleAreas = concretePanes
          .map(pane => pane.querySelector('[data-merge-column-title]')?.getBoundingClientRect())
          .filter((rect): rect is DOMRect => Boolean(rect));
        const viewportTop = titleAreas.length > 0 ? Math.max(...titleAreas.map(rect => rect.bottom - rootRect.top)) : 0;
        const viewportBottom = Math.min(...concretePanes.map(pane => pane.getBoundingClientRect().bottom - rootRect.top));
        const paneRects = concretePanes.map(pane => pane.getBoundingClientRect());
        const nextShapes: ConnectorShape[] = [];
        const isVisible = (...bounds: DOMRect[]) => (
          Math.max(...bounds.map(bound => bound.bottom)) > rootRect.top + viewportTop
          && Math.min(...bounds.map(bound => bound.top)) < rootRect.top + viewportBottom
        );

        for (let conflictIndex = 0; conflictIndex < conflicts.length; conflictIndex += 1) {
          const selector = `[data-conflict-index="${conflictIndex}"]`;
          const conflictBounds = (pane: HTMLDivElement): DOMRect | undefined => {
            const block = pane.querySelector<HTMLElement>(selector);
            const anchor = block?.querySelector<HTMLElement>('[data-merge-connector-anchor]');
            return (anchor ?? block)?.getBoundingClientRect();
          };
          const left = conflictBounds(concretePanes[0]);
          const center = conflictBounds(concretePanes[1]);
          const right = conflictBounds(concretePanes[2]);
          if (!left || !center || !right) continue;

          if (!isVisible(left, center, right)) continue;

          nextShapes.push({
            key: `left-${conflictIndex}`,
            kind: 'conflict',
            side: 'left',
            index: conflictIndex,
            active: conflictIndex === activeConflictIndex,
            ...connectorBandPath(left, center, rootRect, paneRects[0].left, paneRects[0].right, paneRects[1].left, paneRects[1].right, 'ltr'),
          });
          nextShapes.push({
            key: `right-${conflictIndex}`,
            kind: 'conflict',
            side: 'right',
            index: conflictIndex,
            active: conflictIndex === activeConflictIndex,
            ...connectorBandPath(center, right, rootRect, paneRects[1].left, paneRects[1].right, paneRects[2].left, paneRects[2].right, 'rtl'),
          });
        }

        const changeIndexes = new Set<number>();
        concretePanes.forEach(pane => {
          pane.querySelectorAll<HTMLElement>('[data-change-block-index]').forEach(node => {
            const index = Number(node.dataset.changeBlockIndex);
            if (Number.isInteger(index)) changeIndexes.add(index);
          });
        });
        const changeBounds = (pane: HTMLDivElement, blockIndex: number): DOMRect | undefined => {
          const nodes = Array.from(pane.querySelectorAll<HTMLElement>(`[data-change-block-index="${blockIndex}"]`));
          if (nodes.length === 0) return undefined;
          const bounds = nodes.map(node => node.getBoundingClientRect());
          const paneRect = pane.getBoundingClientRect();
          const top = Math.min(...bounds.map(bound => bound.top));
          const bottom = Math.max(...bounds.map(bound => bound.bottom));
          return new DOMRect(paneRect.left, top, paneRect.width, Math.max(1, bottom - top));
        };
        const readChangeTone = (pane: HTMLDivElement, blockIndex: number): ChangeTone => {
          const tone = pane.querySelector<HTMLElement>(`[data-change-block-index="${blockIndex}"][data-change-tone]`)?.dataset.changeTone;
          return tone === 'added' || tone === 'deleted' || tone === 'accepted' ? tone : 'modified';
        };

        [...changeIndexes].sort((left, right) => left - right).forEach(blockIndex => {
          const center = changeBounds(concretePanes[1], blockIndex);
          if (!center) return;
          const left = changeBounds(concretePanes[0], blockIndex);
          const right = changeBounds(concretePanes[2], blockIndex);

          if (left && isVisible(left, center)) {
            nextShapes.push({
              key: `change-left-${blockIndex}`,
              kind: 'change',
              side: 'left',
              index: blockIndex,
              changeTone: readChangeTone(concretePanes[0], blockIndex),
              active: false,
              ...connectorBandPath(left, center, rootRect, paneRects[0].left, paneRects[0].right, paneRects[1].left, paneRects[1].right, 'ltr'),
            });
          }
          if (right && isVisible(center, right)) {
            nextShapes.push({
              key: `change-right-${blockIndex}`,
              kind: 'change',
              side: 'right',
              index: blockIndex,
              changeTone: readChangeTone(concretePanes[2], blockIndex),
              active: false,
              ...connectorBandPath(center, right, rootRect, paneRects[1].left, paneRects[1].right, paneRects[2].left, paneRects[2].right, 'rtl'),
            });
          }
        });

        setClipBounds({
          top: viewportTop,
          height: Math.max(0, viewportBottom - viewportTop),
          width: rootRect.width,
        });
        setShapes(nextShapes);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(renderConnectors);
    };

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(layout);
    concretePanes.forEach(pane => {
      pane.addEventListener('scroll', update, { passive: true });
      resizeObserver.observe(pane);
    });
    renderConnectors();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      concretePanes.forEach(pane => pane.removeEventListener('scroll', update));
    };
  }, [activeConflictIndex, aiDraft, conflicts, layoutRef, nonConflictingSelections, normalEdits, paneRefs, resolutions]);

  const clipId = 'versiondock-merge-connector-clip';
  return (
    <svg aria-hidden="true" style={styles.connectorOverlay}>
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y={clipBounds.top} width={clipBounds.width} height={clipBounds.height} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {shapes.map(shape => {
          const selected = shape.kind === 'conflict'
            ? includesResolutionSide(resolutions[shape.index], sideResolution(shape.side))
            : nonConflictingSelections[shape.index] === shape.side;
          const resolution = shape.kind === 'conflict' ? resolutions[shape.index] : undefined;
          const outlinedSelection = selected || (isCustomResolution(resolution) && Boolean((resolution as CustomResolution).resolvedByAi));
          const tone = shape.kind === 'conflict' ? 'conflict' : shape.changeTone ?? 'modified';
          const color = tone === 'accepted' || tone === 'added'
            ? acceptedRibbon
            : tone === 'deleted'
              ? deletedRibbon
              : tone === 'modified'
                ? modifiedRibbon
                : conflictRibbon;
          return (
            <g key={shape.key} style={styles.connectorShape}>
              <path
                d={outlinedSelection ? shape.outlinePath : shape.fillPath}
                fill={outlinedSelection ? 'none' : color}
                stroke={outlinedSelection
                  ? shape.kind === 'conflict' ? conflictBoundaryColor : appliedBoundaryColor(shape.changeTone ?? 'modified')
                  : undefined}
                strokeWidth={outlinedSelection ? 1 : undefined}
                strokeDasharray={outlinedSelection ? '1 2' : undefined}
                strokeLinecap={outlinedSelection ? 'round' : undefined}
                style={styles.connectorPath}
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function BlockActionBar({ side, kind, selected, resettable, disabled, onAccept, onReset }: {
  side: 'left' | 'right';
  kind: 'conflict' | 'change';
  selected: boolean;
  resettable: boolean;
  disabled?: boolean;
  onAccept: () => void;
  onReset: () => void;
}) {
  const acceptLabel = side === 'left' ? t('Accept Current') : t('Accept Incoming');
  const resetLabel = kind === 'conflict' ? t('Reset') : t('Cancel application');
  const directionIcon = <Codicon name={side === 'left' ? 'arrow-right' : 'arrow-left'} style={styles.blockActionDirectionIcon} />;
  const acceptAction = (
    <button
      type="button"
      className="versiondock-block-action-button versiondock-block-action-button--accept"
      style={styles.blockActionButton('accept')}
      onClick={onAccept}
      disabled={disabled}
      title={acceptLabel}
      aria-label={acceptLabel}
    >
      {side === 'left' && directionIcon}
      <span>{acceptLabel}</span>
      {side === 'right' && directionIcon}
    </button>
  );
  const acceptedStatus = (
    <span style={styles.blockActionStatus} title={acceptLabel}>
      <Codicon name="check" style={styles.blockActionStatusIcon} />
      <span>{t('Accepted')}</span>
    </span>
  );
  const resetAction = resettable ? (
    <button
      type="button"
      className="versiondock-block-action-button versiondock-block-action-button--reset"
      style={styles.blockActionButton('reset')}
      onClick={onReset}
      disabled={disabled}
      title={resetLabel}
      aria-label={resetLabel}
    >
      <Codicon name="discard" style={styles.blockActionResetIcon} />
    </button>
  ) : null;

  return (
    <div style={styles.blockActionBar}>
      <span className="versiondock-block-action-segmented" style={styles.blockActionGroup}>
        {selected ? acceptedStatus : acceptAction}
        {resetAction}
      </span>
    </div>
  );
}

export function ThreeWayLayout({ file, language, resolutions, normalEdits, nonConflictingSelections, onResultChange, onResolveBlock, onNormalEdit, onSelectNonConflicting, currentConflictIndex, syncScrollEnabled, readOnly = false, aiDraft, resultStatusLabel, showCompletionNotice = false, onApplyResolved }: ThreeWayLayoutProps) {
  const { t: translate } = useI18n();
  useEffect(() => {
    currentTranslator = translate;
  }, [translate]);
  const layoutRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const paneRefs = useMemo(() => [leftRef, centerRef, rightRef] as const, []);
  const segments = useMemo(() => splitConflictSegments(file.content, file), [file]);
  const normalVersionLines = useMemo(() => ({
    base: buildBaseNormalEdits(file),
    left: buildNormalEditsForNonConflictingScope(file, 'left'),
    right: buildNormalEditsForNonConflictingScope(file, 'right'),
    blocks: buildNormalBlockRefs(file),
  }), [file]);
  const handleScroll = useSyncedScroll(leftRef, centerRef, rightRef, syncScrollEnabled);

  useEffect(() => {
    const container = centerRef.current;
    const active = container?.querySelector(`[data-conflict-index="${currentConflictIndex}"]`) as HTMLElement | null;
    if (!container || !active) return;
    container.scrollTop = Math.max(0, active.offsetTop - 180);
  }, [currentConflictIndex, file]);

  const applyResolution = (index: number, resolution: Resolution) => {
    const segment = segments.find(item => item.kind === 'conflict' && item.index === index) as ConflictSegment | undefined;
    if (!segment) return;
    onResolveBlock(index, resolution);
    onResultChange(buildContentFromResolutions(file, { ...resolutions, [index]: resolution }, normalEdits));
  };

  const applyNormalEdit = (index: number, lines: string[]) => {
    const nextNormalEdits = { ...normalEdits, [index]: lines };
    onNormalEdit(index, lines);
    onResultChange(buildContentFromResolutions(file, resolutions, nextNormalEdits));
  };

  return (
    <div style={styles.container}>
      <style>{MERGE_SCROLLBAR_STYLES}</style>
      <div ref={layoutRef} style={styles.grid}>
        <Column refEl={leftRef} title={`${t('Current')} · ${file.oursLabel}`} side="left" segments={segments} resolutions={resolutions} normalEdits={normalEdits} baseNormalLines={normalVersionLines.base} normalVersionLines={normalVersionLines.left} normalBlockRefs={normalVersionLines.blocks} nonConflictingSelections={nonConflictingSelections} language={language} onScroll={(e) => handleScroll(0, e)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} onSelectNonConflicting={onSelectNonConflicting} readOnly={readOnly} aiDraft={aiDraft} />
        <div style={styles.connectorGutter} />
        <Column refEl={centerRef} title={`${t('Result')} · ${file.relativePath}${resultStatusLabel ? ` · ${resultStatusLabel}` : ''}`} side="center" segments={segments} resolutions={resolutions} normalEdits={normalEdits} baseNormalLines={normalVersionLines.base} normalBlockRefs={normalVersionLines.blocks} nonConflictingSelections={nonConflictingSelections} language={language} onScroll={(e) => handleScroll(1, e)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} onSelectNonConflicting={onSelectNonConflicting} readOnly={readOnly} aiDraft={aiDraft} completionNotice={showCompletionNotice && onApplyResolved ? <MergeCompletionNotice onApply={onApplyResolved} /> : undefined} />
        <div style={styles.connectorGutter} />
        <Column refEl={rightRef} title={`${t('Conflict Incoming')} · ${file.theirsLabel}`} side="right" segments={segments} resolutions={resolutions} normalEdits={normalEdits} baseNormalLines={normalVersionLines.base} normalVersionLines={normalVersionLines.right} normalBlockRefs={normalVersionLines.blocks} nonConflictingSelections={nonConflictingSelections} language={language} onScroll={(e) => handleScroll(2, e)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} onSelectNonConflicting={onSelectNonConflicting} readOnly={readOnly} aiDraft={aiDraft} />
        <MergeConnectorOverlay layoutRef={layoutRef} paneRefs={paneRefs} conflicts={file.conflicts} resolutions={resolutions} normalEdits={normalEdits} nonConflictingSelections={nonConflictingSelections} activeConflictIndex={currentConflictIndex} aiDraft={aiDraft} />
      </div>
    </div>
  );
}

interface VerticalScrollbarMetrics {
  visible: boolean;
  top: number;
  height: number;
  trackHeight: number;
  scrollVal: number;
  scrollMax: number;
}

interface HorizontalScrollbarMetrics {
  visible: boolean;
  left: number;
  width: number;
  trackWidth: number;
  scrollVal: number;
  scrollMax: number;
}

const OVERLAY_SCROLLBAR_HIDE_DELAY_MS = 1_000;
const OVERLAY_SCROLLBAR_FADE_DURATION_MS = 500;

function useTransientScrollbarVisibility() {
  const [active, setActive] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const holdVisible = useCallback(() => {
    clearHideTimer();
    setActive(true);
  }, [clearHideTimer]);

  const showTemporarily = useCallback(() => {
    clearHideTimer();
    setActive(true);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setActive(false);
    }, OVERLAY_SCROLLBAR_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  return { active, holdVisible, showTemporarily };
}

function OverlayVerticalScrollbar({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const [metrics, setMetrics] = useState<VerticalScrollbarMetrics>({ visible: false, top: 0, height: 0, trackHeight: 0, scrollVal: 0, scrollMax: 0 });
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);
  const { active, holdVisible, showTemporarily } = useTransientScrollbarVisibility();

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;

    const update = () => {
      const titleHeight = pane.querySelector<HTMLElement>('[data-merge-column-title]')?.offsetHeight ?? 29;
      const horizontalScrollbarHeight = pane.scrollWidth > pane.clientWidth + 1 ? 10 : 0;
      const trackHeight = Math.max(0, pane.clientHeight - titleHeight - horizontalScrollbarHeight);
      const scrollableHeight = Math.max(0, pane.scrollHeight - pane.clientHeight);
      if (scrollableHeight === 0 || trackHeight === 0) {
        setMetrics({ visible: false, top: 0, height: 0, trackHeight, scrollVal: 0, scrollMax: 0 });
        return;
      }

      const height = Math.min(trackHeight, Math.max(28, trackHeight * (pane.clientHeight / pane.scrollHeight)));
      const travel = Math.max(0, trackHeight - height);
      const top = scrollableHeight > 0 ? (pane.scrollTop / scrollableHeight) * travel : 0;
      setMetrics({ visible: true, top, height, trackHeight, scrollVal: pane.scrollTop, scrollMax: scrollableHeight });
    };

    const handleScroll = () => {
      update();
      if (dragRef.current) holdVisible();
      else showTemporarily();
    };

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(pane);
    const codeArea = pane.querySelector<HTMLElement>('[data-merge-code-area]');
    if (codeArea) resizeObserver.observe(codeArea);
    pane.addEventListener('scroll', handleScroll, { passive: true });
    update();
    return () => {
      resizeObserver.disconnect();
      pane.removeEventListener('scroll', handleScroll);
    };
  }, [holdVisible, scrollRef, showTemporarily]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    if (!pane) return;
    event.preventDefault();
    holdVisible();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: pane.scrollTop };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    const drag = dragRef.current;
    if (!pane || !drag || drag.pointerId !== event.pointerId) return;
    const travel = Math.max(1, metrics.trackHeight - metrics.height);
    const scrollableHeight = Math.max(0, pane.scrollHeight - pane.clientHeight);
    pane.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) / travel) * scrollableHeight;
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    showTemporarily();
  };

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const pane = scrollRef.current;
    if (!pane) return;
    showTemporarily();
    const rect = event.currentTarget.getBoundingClientRect();
    const travel = Math.max(1, metrics.trackHeight - metrics.height);
    const targetTop = Math.max(0, Math.min(travel, event.clientY - rect.top - metrics.height / 2));
    pane.scrollTop = (targetTop / travel) * Math.max(0, pane.scrollHeight - pane.clientHeight);
  };

  if (!metrics.visible) return null;
  return (
    <div style={styles.overlayScrollbarTrack(metrics.trackHeight, active)} onPointerDown={onTrackPointerDown}>
      <div
        role="scrollbar"
        aria-label={t('Vertical scrollbar')}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={metrics.scrollMax}
        aria-valuenow={metrics.scrollVal}
        style={styles.overlayScrollbarThumb(metrics.top, metrics.height)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      />
    </div>
  );
}

function OverlayHorizontalScrollbar({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const [metrics, setMetrics] = useState<HorizontalScrollbarMetrics>({ visible: false, left: 0, width: 0, trackWidth: 0, scrollVal: 0, scrollMax: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);
  const { active, holdVisible, showTemporarily } = useTransientScrollbarVisibility();

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;

    const update = () => {
      const verticalScrollbarWidth = pane.scrollHeight > pane.clientHeight + 1 ? 10 : 0;
      const trackWidth = Math.max(0, pane.clientWidth - verticalScrollbarWidth);
      const scrollableWidth = Math.max(0, pane.scrollWidth - pane.clientWidth);
      if (scrollableWidth === 0 || trackWidth === 0) {
        setMetrics({ visible: false, left: 0, width: 0, trackWidth, scrollVal: 0, scrollMax: 0 });
        return;
      }

      const width = Math.min(trackWidth, Math.max(28, trackWidth * (pane.clientWidth / pane.scrollWidth)));
      const travel = Math.max(0, trackWidth - width);
      const left = scrollableWidth > 0 ? (pane.scrollLeft / scrollableWidth) * travel : 0;
      setMetrics({ visible: true, left, width, trackWidth, scrollVal: pane.scrollLeft, scrollMax: scrollableWidth });
    };

    const handleScroll = () => {
      update();
      if (dragRef.current) holdVisible();
      else showTemporarily();
    };

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(pane);
    const codeArea = pane.querySelector<HTMLElement>('[data-merge-code-area]');
    if (codeArea) resizeObserver.observe(codeArea);
    pane.addEventListener('scroll', handleScroll, { passive: true });
    update();
    return () => {
      resizeObserver.disconnect();
      pane.removeEventListener('scroll', handleScroll);
    };
  }, [holdVisible, scrollRef, showTemporarily]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    if (!pane) return;
    event.preventDefault();
    holdVisible();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: pane.scrollLeft };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    const drag = dragRef.current;
    if (!pane || !drag || drag.pointerId !== event.pointerId) return;
    const travel = Math.max(1, metrics.trackWidth - metrics.width);
    const scrollableWidth = Math.max(0, pane.scrollWidth - pane.clientWidth);
    pane.scrollLeft = drag.startScrollLeft + ((event.clientX - drag.startX) / travel) * scrollableWidth;
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    showTemporarily();
  };

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const pane = scrollRef.current;
    if (!pane) return;
    showTemporarily();
    const rect = event.currentTarget.getBoundingClientRect();
    const travel = Math.max(1, metrics.trackWidth - metrics.width);
    const targetLeft = Math.max(0, Math.min(travel, event.clientX - rect.left - metrics.width / 2));
    pane.scrollLeft = (targetLeft / travel) * Math.max(0, pane.scrollWidth - pane.clientWidth);
  };

  if (!metrics.visible) return null;
  return (
    <div style={styles.overlayHorizontalScrollbarTrack(metrics.trackWidth, active)} onPointerDown={onTrackPointerDown}>
      <div
        role="scrollbar"
        aria-label={t('Horizontal scrollbar')}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={metrics.scrollMax}
        aria-valuenow={metrics.scrollVal}
        style={styles.overlayHorizontalScrollbarThumb(metrics.left, metrics.width)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      />
    </div>
  );
}

function MergeCompletionNotice({ onApply }: { onApply: () => void }) {
  return (
    <div className="versiondock-merge-complete-notice" style={styles.completionNotice} role="status" aria-live="polite">
      <Codicon name="check" style={styles.completionNoticeIcon} />
      <div style={styles.completionNoticeContent}>
        <strong style={styles.completionNoticeTitle}>{t('All conflicts resolved')}</strong>
        <button type="button" className="versiondock-merge-complete-action" style={styles.completionNoticeAction} onClick={onApply}>
          {t('Apply changes and complete the merge')}
        </button>
      </div>
    </div>
  );
}

function Column({ refEl, title, side, segments, resolutions, normalEdits, baseNormalLines, normalVersionLines, normalBlockRefs, nonConflictingSelections, language, onScroll, onResolve, onNormalEdit, onSelectNonConflicting, readOnly, aiDraft, completionNotice }: {
  refEl: React.RefObject<HTMLDivElement>;
  title: string;
  side: PaneSide;
  segments: Segment[];
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  baseNormalLines?: NormalEdits | null;
  normalVersionLines?: NormalEdits | null;
  normalBlockRefs?: Record<number, NormalBlockRef[]> | null;
  nonConflictingSelections: NonConflictingSelections;
  language: string;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  onResolve: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
  onSelectNonConflicting: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
  readOnly: boolean;
  aiDraft?: AiMergeDraft | null;
  completionNotice?: React.ReactNode;
}) {
  const segmentStartLines = useMemo(() => {
    const starts: number[] = [];
    let currentLine = 1;
    for (let i = 0; i < segments.length; i++) {
      starts.push(currentLine);
      const seg = segments[i];
      const res = seg.kind === 'conflict' ? resolutions[seg.index] : undefined;
      const nLines = seg.kind === 'normal'
        ? side === 'center' ? normalEdits[i] : normalVersionLines?.[i]
        : undefined;
      currentLine += lineCount(seg, side, res, nLines);
    }
    return starts;
  }, [segments, resolutions, normalEdits, normalVersionLines, side]);

  return (
    <div style={styles.columnFrame}>
      <div ref={refEl} className="versiondock-merge-pane" data-merge-pane={side} style={styles.column} onScroll={onScroll}>
        <div data-merge-column-title style={styles.columnTitle} title={title}>{title}</div>
        <div data-merge-code-area style={styles.codeWrap}>
          {segments.map((segment, index) => {
            const start = segmentStartLines[index];
            const resolution = segment.kind === 'conflict' ? resolutions[segment.index] : undefined;
            const normalLines = segment.kind === 'normal'
              ? side === 'center' ? normalEdits[index] : normalVersionLines?.[index]
              : undefined;
            const displayedNormalLines = segment.kind === 'normal' ? normalLines ?? segment.lines : undefined;
            const changeFlags = displayedNormalLines
              ? changedLineFlags(baseNormalLines?.[index] ?? (segment.kind === 'normal' ? segment.lines : []), displayedNormalLines)
              : undefined;
            const resultAreaVisuals = segment.kind === 'normal' && side === 'center' && normalBlockRefs?.[index]
              ? buildResultChangeAreaVisuals(normalBlockRefs[index], nonConflictingSelections)
              : undefined;
            const displayedChangeFlags = resultAreaVisuals && resultAreaVisuals.flags.length === displayedNormalLines?.length
              ? resultAreaVisuals.flags
              : changeFlags;
            const displayedChangeTones = resultAreaVisuals && resultAreaVisuals.tones.length === displayedNormalLines?.length
              ? resultAreaVisuals.tones
              : undefined;
            const displayedChangeBlockRanges = resultAreaVisuals && resultAreaVisuals.flags.length === displayedNormalLines?.length
              ? resultAreaVisuals.ranges
              : undefined;
            return <SegmentView key={index} segmentIndex={index} segment={segment} side={side} startLine={start} language={language} resolution={resolution} normalLines={normalLines} normalBlocks={normalBlockRefs?.[index]} nonConflictingSelections={nonConflictingSelections} changeFlags={displayedChangeFlags} changeTones={displayedChangeTones} changeBlockRanges={displayedChangeBlockRanges} onResolve={onResolve} onNormalEdit={onNormalEdit} onSelectNonConflicting={onSelectNonConflicting} readOnly={readOnly} aiDraft={aiDraft} />;
          })}
        </div>
      </div>
      {completionNotice}
      <OverlayVerticalScrollbar scrollRef={refEl} />
      <OverlayHorizontalScrollbar scrollRef={refEl} />
    </div>
  );
}

function SegmentView({ segmentIndex, segment, side, startLine, language, resolution, normalLines, normalBlocks, nonConflictingSelections, changeFlags, changeTones, changeBlockRanges, onResolve, onNormalEdit, onSelectNonConflicting, readOnly, aiDraft }: {
  segmentIndex: number;
  segment: Segment;
  side: PaneSide;
  startLine: number;
  language: string;
  resolution?: Resolution;
  normalLines?: string[];
  normalBlocks?: NormalBlockRef[];
  nonConflictingSelections: NonConflictingSelections;
  changeFlags?: boolean[];
  changeTones?: ChangeTone[];
  changeBlockRanges?: ChangeBlockRange[];
  onResolve: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
  onSelectNonConflicting: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
  readOnly: boolean;
  aiDraft?: AiMergeDraft | null;
}) {
  if (segment.kind === 'normal') {
    if (side === 'center') {
      const lines = normalLines ?? segment.lines;
      return (
        <EditableCodeBlock
          value={linesToEditableValue(lines)}
          startLine={startLine}
          language={language}
          ariaLabel={t('Result Code')}
          changeFlags={changeFlags}
          changeTones={changeTones}
          changeBlockRanges={changeBlockRanges}
          readOnly={readOnly}
          onChange={value => onNormalEdit(segmentIndex, editableValueToLines(value))}
        />
      );
    }
    if (normalBlocks) {
      return <NormalSideBlocks blocks={normalBlocks} side={side} startLine={startLine} language={language} selections={nonConflictingSelections} onSelect={onSelectNonConflicting} disabled={readOnly} />;
    }
    return <CodeLines lines={normalLines ?? segment.lines} startLine={startLine} language={language} changeFlags={changeFlags} changeTone="modified" />;
  }

  const resolved = isResolvedResolution(resolution);
  const activeAiDraft = side === 'center' && aiDraft?.index === segment.index ? aiDraft : null;

  if (side === 'center') {
    const lines = activeAiDraft
      ? editableValueToLines(activeAiDraft.content)
      : resolved ? resolveLines(segment.block, resolution) : segment.block.baseLines;
    if (lines.length === 0 && !activeAiDraft) {
      return (
        <div
          data-conflict-index={segment.index}
          style={resolved ? styles.emptyAppliedConflictAnchor : styles.emptyBlockAnchor('conflict')}
        />
      );
    }
    return (
      <div data-conflict-index={segment.index} style={activeAiDraft ? styles.aiTypingConflictBlock : resolved ? styles.appliedConflictBlock : styles.conflictBlock}>
        <EditableCodeBlock
          value={linesToEditableValue(lines)}
          startLine={startLine}
          language={language}
          ariaLabel={t('Conflict {0}', segment.index + 1)}
          dim={lines.length === 0 && !activeAiDraft}
          readOnly={readOnly}
          autoFocus={Boolean(activeAiDraft)}
          aiTyping={Boolean(activeAiDraft)}
          onChange={value => onResolve(segment.index, {
            type: 'custom',
            lines: editableValueToLines(value),
            acceptedSides: acceptedResolutionSides(resolution),
          })}
        />
      </div>
    );
  }

  const lines = side === 'left' ? segment.block.oursLines : segment.block.theirsLines;
  const currentSide = sideResolution(side);
  const accepted = includesResolutionSide(resolution, currentSide);
  const resettable = accepted || isCustomResolution(resolution);
  const accept = () => onResolve(segment.index, addResolutionSide(resolution, currentSide));
  const reset = () => onResolve(
    segment.index,
    isCustomResolution(resolution) ? 'unresolved' : removeResolutionSide(resolution, currentSide),
  );

  return (
    <div data-conflict-index={segment.index} style={accepted ? styles.appliedConflictSideBlock : styles.conflictBlock}>
      <BlockActionBar side={side} kind="conflict" selected={accepted} resettable={resettable} disabled={readOnly} onAccept={accept} onReset={reset} />
      <div
        data-merge-connector-anchor
        style={lines.length > 0
          ? accepted ? styles.appliedConflictContentAnchor : styles.connectorContentAnchor
          : accepted ? styles.emptyAppliedConflictAnchor : styles.emptyBlockAnchor('conflict')}
      >
        {lines.length > 0 && <CodeLines lines={lines} startLine={startLine} language={language} />}
      </div>
    </div>
  );
}

type ChangeTone = 'modified' | 'added' | 'deleted' | 'accepted';

interface ChangeBlockRange {
  blockIndex: number;
  startLine: number;
  lineCount: number;
  tone: ChangeTone;
  applied: boolean;
}

function buildResultChangeAreaVisuals(blocks: NormalBlockRef[], selections: NonConflictingSelections): { flags: boolean[]; tones: ChangeTone[]; ranges: ChangeBlockRange[] } {
  const flags: boolean[] = [];
  const tones: ChangeTone[] = [];
  const ranges: ChangeBlockRange[] = [];
  let lineCursor = 0;
  blocks.forEach(({ block, blockIndex }) => {
    const resultLines = nonConflictingResultLines(block, selections[blockIndex]);
    const applicable = isApplicableNonConflictingBlock(block);
    const selected = Boolean(selections[blockIndex]);
    const insertion = block.baseLines.length === 0 && (block.leftLines.length > 0 || block.rightLines.length > 0);
    const deletion = block.baseLines.length > 0 && (
      (block.state === 'modified_left' && block.leftLines.length === 0)
      || (block.state === 'modified_right' && block.rightLines.length === 0)
      || (block.state === 'modified_both' && block.leftLines.length === 0 && block.rightLines.length === 0)
    );
    const tone: ChangeTone = insertion ? 'added' : deletion ? 'deleted' : 'modified';
    if (applicable) ranges.push({ blockIndex, startLine: lineCursor, lineCount: resultLines.length, tone, applied: selected });
    resultLines.forEach(() => {
      flags.push(applicable && !selected);
      tones.push(tone);
    });
    lineCursor += resultLines.length;
  });
  return { flags, tones, ranges };
}

function NormalSideBlocks({ blocks, side, startLine, language, selections, onSelect, disabled }: {
  blocks: NormalBlockRef[];
  side: 'left' | 'right';
  startLine: number;
  language: string;
  selections: NonConflictingSelections;
  onSelect: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
  disabled?: boolean;
}) {
  const blockStartLines = useMemo(() => {
    const starts: number[] = [];
    let currentLine = startLine;
    for (let i = 0; i < blocks.length; i++) {
      starts.push(currentLine);
      const lines = side === 'left' ? blocks[i].block.leftLines : blocks[i].block.rightLines;
      currentLine += lines.length;
    }
    return starts;
  }, [blocks, side, startLine]);

  return (
    <>
      {blocks.map(({ block, blockIndex }, bIdx) => {
        const lines = side === 'left' ? block.leftLines : block.rightLines;
        const flags = changedLineFlags(block.baseLines, lines);
        const changedOnSide = side === 'left'
          ? block.state === 'modified_left' || block.state === 'modified_both'
          : block.state === 'modified_right' || block.state === 'modified_both';
        const changeTone: ChangeTone = block.baseLines.length === 0 && lines.length > 0
          ? 'added'
          : block.baseLines.length > 0 && lines.length === 0
            ? 'deleted'
            : 'modified';
        const applied = selections[blockIndex] === side;
        const blockStartLine = blockStartLines[bIdx];
        if (lines.length === 0 && !changedOnSide) return null;
        return (
          <div
            key={blockIndex}
            style={styles.normalChangeBlock}
          >
            {changedOnSide && (
              <BlockActionBar
                side={side}
                kind="change"
                selected={applied}
                resettable={applied}
                disabled={disabled}
                onAccept={() => onSelect(blockIndex, side)}
                onReset={() => onSelect(blockIndex, 'base')}
              />
            )}
            {changedOnSide ? (
              <div
                data-change-block-index={blockIndex}
                data-change-tone={changeTone}
                style={lines.length > 0
                  ? styles.connectorContentAnchor
                  : styles.emptyChangeConnectorAnchor(changeTone, applied)}
              >
                {lines.length > 0 && (
                  <>
                    {applied && <span aria-hidden="true" style={styles.appliedChangeMarker(changeTone)} />}
                    <CodeLines
                      lines={lines}
                      startLine={blockStartLine}
                      language={language}
                      changeFlags={applied ? undefined : flags}
                      changeTone={changeTone}
                    />
                  </>
                )}
              </div>
            ) : lines.length > 0 ? (
              <CodeLines lines={lines} startLine={blockStartLine} language={language} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function usePaneVirtualWindow(
  ref: React.RefObject<HTMLElement>,
  totalLines: number,
  lineHeight: number = CODE_LINE_HEIGHT,
  threshold: number = 40,
): [number, number] {
  const [range, setRange] = useState<[number, number]>([0, Math.min(totalLines, 60)]);

  useEffect(() => {
    if (totalLines <= threshold) {
      return;
    }

    const el = ref.current;
    if (!el) return;
    const pane = el.closest<HTMLElement>('.versiondock-merge-pane');
    if (!pane) return;

    let frameId: number | null = null;
    const update = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        if (!ref.current || !pane) return;
        const paneRect = pane.getBoundingClientRect();
        const blockRect = ref.current.getBoundingClientRect();
        const relativeTop = blockRect.top - paneRect.top;
        const relativeBottom = blockRect.bottom - paneRect.top;

        if (relativeBottom < -200 || relativeTop > paneRect.height + 200) {
          return;
        }

        const visibleStartPx = Math.max(0, -relativeTop);
        const visibleEndPx = Math.min(blockRect.height, paneRect.height - relativeTop);

        const overscan = 20;
        const start = Math.max(0, Math.floor(visibleStartPx / lineHeight) - overscan);
        const end = Math.min(totalLines, Math.ceil(visibleEndPx / lineHeight) + overscan);

        setRange(prev => (prev[0] === start && prev[1] === end ? prev : [start, end]));
      });
    };

    update();
    pane.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      pane.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [ref, totalLines, lineHeight, threshold]);

  return totalLines <= threshold ? [0, totalLines] : range;
}

function CodeLines({ lines, startLine, language, dim, changeFlags, changeTone }: {
  lines: string[];
  startLine: number;
  language: string;
  dim?: boolean;
  changeFlags?: boolean[];
  changeTone?: ChangeTone;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlighter = useShiki();
  const colorTheme = getVersionDockColorTheme();
  const displayedLines = useMemo(() => lines.length > 0 ? lines : [''], [lines]);

  const [startIdx, endIdx] = usePaneVirtualWindow(containerRef, displayedLines.length);

  const visibleLines = useMemo(() => {
    return displayedLines.slice(startIdx, endIdx);
  }, [displayedLines, startIdx, endIdx]);

  const renderedLines = useMemo(() => {
    return renderShikiLines(highlighter, visibleLines, language, colorTheme);
  }, [colorTheme, highlighter, language, visibleLines]);

  const topPad = startIdx * CODE_LINE_HEIGHT;
  const bottomPad = (displayedLines.length - endIdx) * CODE_LINE_HEIGHT;

  return (
    <div ref={containerRef} style={{ paddingTop: topPad ? `${topPad}px` : undefined, paddingBottom: bottomPad ? `${bottomPad}px` : undefined }}>
      {visibleLines.map((line, offset) => {
        const index = startIdx + offset;
        const changed = Boolean(changeFlags?.[index]);
        return (
          <div key={index} style={styles.codeLine(
            dim,
            changed ? changeTone : undefined,
          )}>
            <span style={styles.lineNo}>{startLine + index}</span>
            <span style={styles.codeText}>{renderedLines[offset] ?? (line || ' ')}</span>
          </div>
        );
      })}
    </div>
  );
}

function EditableCodeBlock({ value, startLine, language, ariaLabel, dim, changeFlags, changeTones, changeBlockRanges, readOnly = false, autoFocus = false, aiTyping = false, onChange }: {
  value: string;
  startLine: number;
  language: string;
  ariaLabel?: string;
  dim?: boolean;
  changeFlags?: boolean[];
  changeTones?: ChangeTone[];
  changeBlockRanges?: ChangeBlockRange[];
  readOnly?: boolean;
  autoFocus?: boolean;
  aiTyping?: boolean;
  onChange: (value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlighter = useShiki();
  const colorTheme = getVersionDockColorTheme();
  const lines = useMemo(() => {
    const split = value.split('\n');
    return split.length > 0 ? split : [''];
  }, [value]);

  const lineTotal = Math.max(lines.length, 1);
  const [startIdx, endIdx] = usePaneVirtualWindow(containerRef, lineTotal);

  const visibleLines = useMemo(() => {
    return lines.slice(startIdx, endIdx);
  }, [lines, startIdx, endIdx]);

  const renderedLines = useMemo(() => {
    return renderShikiLines(highlighter, visibleLines, language, colorTheme);
  }, [colorTheme, highlighter, language, visibleLines]);

  const topPad = startIdx * CODE_LINE_HEIGHT;
  const bottomPad = (lineTotal - endIdx) * CODE_LINE_HEIGHT;
  const contentWidth = `${Math.max(24, ...lines.map(line => line.length + 1))}ch`;

  useEffect(() => {
    if (!autoFocus) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(value.length, value.length);
    const pane = textarea.closest<HTMLElement>('[data-merge-pane="center"]');
    const conflictBlock = textarea.closest<HTMLElement>('[data-conflict-index]');
    if (pane && conflictBlock) {
      const targetTop = conflictBlock.offsetTop - Math.max(72, pane.clientHeight * 0.42);
      pane.scrollTop = Math.max(0, targetTop);
    }
  }, [autoFocus, value]);

  return (
    <div ref={containerRef} style={styles.editableBlock(dim, aiTyping)}>
      <div style={{ ...styles.editableLineNumbers, paddingTop: topPad ? `${topPad}px` : undefined, paddingBottom: bottomPad ? `${bottomPad}px` : undefined }}>
        {visibleLines.map((_, offset) => {
          const index = startIdx + offset;
          const line = startLine + index;
          return (
            <span key={line} style={styles.editableLineNo(
              changeFlags?.[index] ? changeTones?.[index] : undefined,
            )}>{line}</span>
          );
        })}
      </div>
      <div style={styles.editableTextWrap(lineTotal, contentWidth)}>
        {changeBlockRanges?.map(range => (
          <span
            key={range.blockIndex}
            data-change-block-index={range.blockIndex}
            data-change-tone={range.tone}
            data-change-applied={range.applied || undefined}
            style={styles.changeBlockMarker(range.startLine, range.lineCount, range.tone, range.applied)}
          />
        ))}
        <div aria-hidden="true" style={{ ...styles.editableHighlight, paddingTop: topPad ? `${topPad}px` : undefined, paddingBottom: bottomPad ? `${bottomPad}px` : undefined }}>
          {visibleLines.map((line, offset) => {
            const index = startIdx + offset;
            return (
              <div key={index} className={aiTyping && index === lineTotal - 1 ? 'versiondock-ai-typing-line' : undefined} style={styles.editableHighlightLine(
                changeFlags?.[index] ? changeTones?.[index] : undefined,
              )}>
                {renderedLines[offset] ?? (line || ' ')}
                {aiTyping && index === lineTotal - 1 && <span className="versiondock-ai-code-caret" />}
              </div>
            );
          })}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          aria-label={ariaLabel}
          onChange={event => onChange(event.currentTarget.value)}
          readOnly={readOnly}
          rows={lineTotal}
          wrap="off"
          spellCheck={false}
          style={styles.resultTextarea(lineTotal, aiTyping)}
        />
      </div>
    </div>
  );
}

type SupportedShikiLanguage =
  | 'javascript' | 'typescript' | 'json' | 'css' | 'html' | 'markdown' | 'java'
  | 'xml' | 'yaml' | 'php' | 'python' | 'go' | 'shellscript' | 'text';

interface ShikiToken {
  content: string;
  color?: string;
  fontStyle?: string;
}

const loadedCustomThemes = new WeakMap<HighlighterCore, Set<string>>();

function ensureShikiTheme(highlighter: HighlighterCore, theme: ThemeRegistrationRaw): void {
  if (!theme.name) {
    highlighter.loadThemeSync(theme);
    return;
  }
  let loaded = loadedCustomThemes.get(highlighter);
  if (!loaded) {
    loaded = new Set();
    loadedCustomThemes.set(highlighter, loaded);
  }
  if (loaded.has(theme.name)) return;
  highlighter.loadThemeSync(theme);
  loaded.add(theme.name);
}

function renderShikiLines(
  highlighter: HighlighterCore | null,
  lines: string[],
  language: string,
  colorTheme: WebviewColorThemeData | null,
): React.ReactNode[] {
  if (!highlighter) return lines.map(line => line || ' ');

  const theme = getShikiTheme(colorTheme);
  if (typeof theme !== 'string') ensureShikiTheme(highlighter, theme);

  try {
    // Tokenizing a segment in one pass is both faster and more accurate for
    // multiline constructs than invoking Shiki independently for every line.
    const tokenize = highlighter.codeToTokens as unknown as (
      code: string,
      options: { lang: SupportedShikiLanguage; theme: string | ThemeRegistrationRaw },
    ) => unknown;
    const result = tokenize(lines.join('\n') || ' ', {
      lang: normalizeShikiLang(language),
      theme,
    });
    const tokenLines = Array.isArray(result)
      ? result
      : ((result as { tokens?: ShikiToken[][] }).tokens ?? []);
    return lines.map((line, lineIndex) => {
      const tokens: ShikiToken[] = tokenLines[lineIndex] ?? [];
      if (tokens.length === 0) return line || ' ';
      return tokens.map((token, tokenIndex) => (
        <span key={tokenIndex} style={{ color: token.color, fontStyle: token.fontStyle }}>{token.content}</span>
      ));
    });
  } catch {
    return lines.map(line => line || ' ');
  }
}

function getShikiTheme(colorTheme: WebviewColorThemeData | null): 'github-light' | 'github-dark' | ThemeRegistrationRaw {
  if (colorTheme) {
    return {
      name: colorTheme.name,
      type: colorTheme.type,
      fg: colorTheme.fg,
      bg: colorTheme.bg,
      colors: colorTheme.colors,
      settings: colorTheme.settings,
    };
  }
  return document.body.classList.contains('vscode-light') ? 'github-light' : 'github-dark';
}

function normalizeShikiLang(language: string): SupportedShikiLanguage {
  const lang = language.toLowerCase();
  if (lang === 'typescriptreact' || lang === 'tsx') return 'typescript';
  if (lang === 'javascriptreact' || lang === 'jsx') return 'javascript';
  if (lang === 'plaintext') return 'text';
  if (lang === 'shell' || lang === 'bash' || lang === 'zsh') return 'shellscript';
  if (lang === 'typescript') return 'typescript';
  if (lang === 'javascript') return 'javascript';
  if (lang === 'json') return 'json';
  if (lang === 'java') return 'java';
  if (lang === 'css') return 'css';
  if (lang === 'html') return 'html';
  if (lang === 'markdown') return 'markdown';
  if (lang === 'php') return 'php';
  if (lang === 'python') return 'python';
  if (lang === 'go') return 'go';
  if (lang === 'xml') return 'xml';
  if (lang === 'yaml') return 'yaml';
  return 'typescript';
}

// Use VS Code's semantic diff/merge colors directly. Themes are responsible
// for choosing suitable light, dark, and high-contrast values; keeping the
// same token for code blocks and ribbons also prevents the connector gutter
// from visually fading the change color a second time.
const conflictBg = 'var(--vscode-diffEditor-removedTextBackground, color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 22%, transparent))';
const conflictRibbon = conflictBg;
const modifiedBg = 'var(--vscode-merge-incomingContentBackground, color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 22%, transparent))';
const modifiedRibbon = modifiedBg;
const deletedBg = 'color-mix(in srgb, var(--vscode-editor-foreground) 18%, var(--vscode-editor-background))';
const deletedRibbon = deletedBg;
const acceptedBg = 'var(--vscode-diffEditor-insertedTextBackground, color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #73c991) 24%, transparent))';
const acceptedRibbon = acceptedBg;
const addedBg = acceptedBg;
const conflictBoundaryColor = 'var(--vscode-editorOverviewRuler-deletedForeground, var(--vscode-editorError-foreground, #f14c4c))';

function appliedBoundaryColor(tone: ChangeTone): string {
  if (tone === 'added' || tone === 'accepted') {
    return 'var(--vscode-editorOverviewRuler-addedForeground, var(--vscode-editorGutter-addedBackground, #73c991))';
  }
  if (tone === 'deleted') {
    return 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground, #8c8c8c))';
  }
  return 'var(--vscode-editorInfo-foreground, #3794ff)';
}

function changeLineVisual(tone?: ChangeTone): React.CSSProperties {
  if (!tone) return {};
  const background = tone === 'accepted'
    ? acceptedBg
    : tone === 'added'
      ? addedBg
      : tone === 'deleted'
        ? deletedBg
        : modifiedBg;
  return { background };
}

const styles = {
  container: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0 },
  grid: { position: 'relative' as const, display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${CONNECTOR_GUTTER_WIDTH} minmax(0, 1fr) ${CONNECTOR_GUTTER_WIDTH} minmax(0, 1fr)`, flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--vscode-editor-background)' },
  columnFrame: { position: 'relative' as const, zIndex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--vscode-editor-background)' },
  column: { position: 'relative' as const, width: '100%', height: '100%', overflowX: 'auto' as const, overflowY: 'auto' as const, scrollbarGutter: 'auto', minWidth: 0, background: 'var(--vscode-editor-background)' },
  overlayScrollbarTrack: (height: number, active: boolean): React.CSSProperties => ({ position: 'absolute', top: 29, right: 0, zIndex: 9, width: 10, height, background: 'transparent', touchAction: 'none', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none', transition: `opacity ${OVERLAY_SCROLLBAR_FADE_DURATION_MS}ms ease-out` }),
  overlayScrollbarThumb: (top: number, height: number): React.CSSProperties => ({
    position: 'absolute',
    top,
    right: 2,
    width: 6,
    height,
    borderRadius: 6,
    background: 'var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4))',
    cursor: 'default',
    touchAction: 'none',
  }),
  overlayHorizontalScrollbarTrack: (width: number, active: boolean): React.CSSProperties => ({
    position: 'absolute',
    left: 0,
    bottom: 0,
    zIndex: 9,
    width,
    height: 10,
    background: 'transparent',
    touchAction: 'none',
    opacity: active ? 1 : 0,
    pointerEvents: active ? 'auto' : 'none',
    transition: `opacity ${OVERLAY_SCROLLBAR_FADE_DURATION_MS}ms ease-out`,
  }),
  overlayHorizontalScrollbarThumb: (left: number, width: number): React.CSSProperties => ({
    position: 'absolute',
    left,
    bottom: 2,
    width,
    height: 6,
    borderRadius: 6,
    background: 'var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4))',
    cursor: 'default',
    touchAction: 'none',
  }),
  connectorGutter: {
    position: 'relative' as const,
    zIndex: 0,
    minWidth: 0,
    background: 'var(--vscode-editor-background)',
    borderLeft: '1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
    borderRight: '1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
    pointerEvents: 'none' as const,
  },
  connectorOverlay: { position: 'absolute' as const, inset: 0, zIndex: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' as const },
  connectorShape: { transition: 'opacity 120ms ease' },
  connectorPath: { mixBlendMode: 'normal' as const, transition: 'fill 160ms ease, stroke 160ms ease, opacity 160ms ease' },
  completionNotice: {
    position: 'absolute',
    top: 42,
    left: '50%',
    zIndex: 12,
    maxWidth: 'calc(100% - 32px)',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '9px 12px',
    border: '1px solid color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground)) 48%, var(--vscode-panel-border))',
    borderRadius: 5,
    background: 'color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground)) 18%, var(--vscode-editor-background))',
    boxShadow: '0 4px 14px color-mix(in srgb, var(--vscode-widget-shadow, #000) 38%, transparent)',
    transform: 'translateX(-50%)',
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  completionNoticeIcon: { marginTop: 1, flexShrink: 0, fontSize: 15, color: 'var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground))' },
  completionNoticeContent: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } as React.CSSProperties,
  completionNoticeTitle: { fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap' as const },
  completionNoticeAction: {
    width: 'fit-content',
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-textLink-foreground)',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 12,
    lineHeight: '16px',
    cursor: 'pointer',
  } as React.CSSProperties,
  blockActionBar: {
    position: 'sticky',
    top: 29,
    zIndex: 4,
    width: '100%',
    height: CODE_LINE_HEIGHT,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    padding: '1px 0',
    background: 'var(--vscode-editor-background)',
    userSelect: 'none',
  } as React.CSSProperties,
  blockActionGroup: {
    position: 'sticky' as const,
    left: 6,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0,
    width: 'max-content',
    height: 19,
    overflow: 'hidden',
    borderRadius: 5,
    background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
  },
  blockActionButton: (kind: 'accept' | 'reset'): React.CSSProperties => ({
    minWidth: kind === 'accept' ? 0 : 21,
    height: 19,
    padding: kind === 'accept' ? '0 6px' : 0,
    border: '1px solid transparent',
    borderRadius: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '17px',
    whiteSpace: 'nowrap',
    color: kind === 'accept'
      ? 'var(--vscode-foreground)'
      : 'var(--vscode-descriptionForeground, var(--vscode-foreground))',
    cursor: 'pointer',
    transition: 'background-color 80ms ease, color 80ms ease, opacity 80ms ease',
  }),
  blockActionStatus: {
    height: 19,
    padding: '0 6px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    color: 'var(--vscode-foreground)',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '19px',
    whiteSpace: 'nowrap' as const,
  },
  blockActionDirectionIcon: { fontSize: 11, lineHeight: '11px', pointerEvents: 'none' as const },
  blockActionStatusIcon: { color: 'var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-foreground)))', fontSize: 11, lineHeight: '11px', pointerEvents: 'none' as const },
  blockActionResetIcon: { fontSize: 13, lineHeight: '13px', pointerEvents: 'none' as const },
  columnTitle: {
    position: 'sticky' as const,
    top: 0,
    left: 0,
    zIndex: 6,
    width: '100%',
    height: 29,
    boxSizing: 'border-box' as const,
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--vscode-descriptionForeground)',
    background: 'var(--vscode-editor-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const,
  },
  codeWrap: { width: 'max-content', minWidth: '100%', paddingTop: 4, paddingBottom: 32 },
  conflictBlock: {
    position: 'relative',
    minHeight: CODE_LINE_HEIGHT,
    background: conflictBg,
  } as React.CSSProperties,
  appliedConflictBlock: {
    position: 'relative',
    minHeight: CODE_LINE_HEIGHT,
    borderTop: `1px dotted ${conflictBoundaryColor}`,
    borderBottom: `1px dotted ${conflictBoundaryColor}`,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  aiTypingConflictBlock: {
    position: 'relative',
    minHeight: CODE_LINE_HEIGHT,
    background: 'color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--vscode-editor-background))',
    boxShadow: 'inset 2px 0 0 var(--vscode-focusBorder)',
  } as React.CSSProperties,
  appliedConflictSideBlock: {
    position: 'relative',
    minHeight: CODE_LINE_HEIGHT,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  emptyAppliedConflictAnchor: {
    position: 'relative',
    width: '100%',
    height: 2,
    minHeight: 2,
    borderTop: `2px dotted ${conflictBoundaryColor}`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
  } as React.CSSProperties,
  emptyBlockAnchor: (tone: 'conflict' | ChangeTone): React.CSSProperties => ({
    position: 'relative',
    width: '100%',
    height: 2,
    minHeight: 2,
    background: tone === 'conflict' ? conflictBg : changeLineVisual(tone).background,
    pointerEvents: 'none',
  }),
  connectorContentAnchor: {
    position: 'relative' as const,
    width: '100%',
  },
  appliedConflictContentAnchor: {
    position: 'relative',
    width: '100%',
    borderTop: `1px dotted ${conflictBoundaryColor}`,
    borderBottom: `1px dotted ${conflictBoundaryColor}`,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  emptyChangeConnectorAnchor: (tone: ChangeTone, applied: boolean): React.CSSProperties => ({
    position: 'relative',
    width: '100%',
    height: 2,
    minHeight: 2,
    boxSizing: 'border-box',
    background: applied ? undefined : changeLineVisual(tone).background,
    borderTop: applied ? `2px dotted ${appliedBoundaryColor(tone)}` : undefined,
    pointerEvents: 'none',
  }),
  normalChangeBlock: { position: 'relative' as const },
  appliedChangeMarker: (tone: ChangeTone): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    zIndex: 2,
    borderTop: `1px dotted ${appliedBoundaryColor(tone)}`,
    borderBottom: `1px dotted ${appliedBoundaryColor(tone)}`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
  }),
  codeLine: (dim?: boolean, changeTone?: ChangeTone): React.CSSProperties => ({ position: 'relative', display: 'flex', minHeight: 21, lineHeight: '21px', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 'var(--vscode-editor-font-size, 13px)', opacity: dim ? 0.45 : 1, ...changeLineVisual(changeTone) }),
  lineNo: { width: 44, paddingRight: 12, textAlign: 'right' as const, color: 'var(--vscode-editorLineNumber-foreground, #6e7681)', userSelect: 'none' as const, flexShrink: 0 },
  codeText: { whiteSpace: 'pre', paddingRight: 16, flexShrink: 0 },
  editableBlock: (dim?: boolean, aiTyping?: boolean): React.CSSProperties => ({
    display: 'flex',
    width: 'max-content',
    minWidth: '100%',
    minHeight: CODE_LINE_HEIGHT,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    opacity: dim ? 0.45 : 1,
    background: aiTyping ? 'color-mix(in srgb, var(--vscode-focusBorder) 4%, transparent)' : undefined,
  }),
  editableLineNumbers: {
    width: 44,
    flexShrink: 0,
    userSelect: 'none' as const,
  },
  editableLineNo: (changeTone?: ChangeTone): React.CSSProperties => ({
    display: 'block',
    height: CODE_LINE_HEIGHT,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    paddingRight: 12,
    textAlign: 'right' as const,
    color: 'var(--vscode-editorLineNumber-foreground, #6e7681)',
    ...changeLineVisual(changeTone),
  }),
  editableTextWrap: (lineTotal: number, contentWidth: string): React.CSSProperties => ({
    position: 'relative',
    flex: 1,
    width: '100%',
    minWidth: contentWidth,
    height: lineTotal * CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
  }),
  changeBlockMarker: (startLine: number, lineCount: number, tone: ChangeTone, applied: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: startLine * CODE_LINE_HEIGHT - (lineCount === 0 ? 1 : 0),
    left: applied || lineCount === 0 ? -44 : 0,
    right: 0,
    height: lineCount === 0 ? 2 : lineCount * CODE_LINE_HEIGHT,
    zIndex: applied ? 2 : undefined,
    background: !applied && lineCount === 0 ? changeLineVisual(tone).background : undefined,
    borderTop: applied ? `${lineCount === 0 ? 2 : 1}px dotted ${appliedBoundaryColor(tone)}` : undefined,
    borderBottom: applied && lineCount > 0 ? `1px dotted ${appliedBoundaryColor(tone)}` : undefined,
    boxSizing: 'border-box',
    pointerEvents: 'none',
  }),
  editableHighlight: {
    position: 'absolute',
    inset: 0,
    margin: 0,
    padding: '0 16px 0 0',
    overflow: 'hidden',
    pointerEvents: 'none' as const,
    whiteSpace: 'pre' as const,
    color: 'var(--vscode-editor-foreground, var(--vscode-foreground))',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    lineHeight: `${CODE_LINE_HEIGHT}px`,
  } as React.CSSProperties,
  editableHighlightLine: (changeTone?: ChangeTone): React.CSSProperties => ({
    width: 'calc(100% + 16px)',
    height: CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    ...changeLineVisual(changeTone),
  }),
  resultTextarea: (lineTotal: number, aiTyping?: boolean): React.CSSProperties => ({
    position: 'relative',
    display: 'block',
    width: '100%',
    height: lineTotal * CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
    padding: '0 16px 0 0',
    border: 'none',
    outline: 'none',
    resize: 'none' as const,
    overflow: 'hidden',
    background: 'transparent',
    color: 'transparent',
    caretColor: aiTyping ? 'transparent' : 'var(--vscode-editor-foreground, var(--vscode-foreground))',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    whiteSpace: 'pre' as const,
  }),
};
