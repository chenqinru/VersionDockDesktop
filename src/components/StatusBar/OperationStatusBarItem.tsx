import { IconButton } from '../IconButton';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { useBridge } from '../../platform/context';
import { useAppStore } from '../../store/appStore';
import { Codicon } from '../Codicon';

const EXCLUDED_DOMAINS = new Set(['status', 'system', 'identity', 'svnAccount']);

export function OperationStatusBarItem() {
  const bridge = useBridge();
  const { t } = useI18n();
  const operations = useAppStore((state) => state.operations);
  const activeWorkspaceId = useAppStore((state) => state.snapshot?.workspace.id);
  const activeOperations = useMemo(() => Object.values(operations).filter((operation) =>
    ['queued', 'running'].includes(operation.status)
      && !EXCLUDED_DOMAINS.has(operation.context.domain)
      && operation.context.visibility !== 'background'
      && (!activeWorkspaceId || operation.context.workspaceId === null || operation.context.workspaceId === activeWorkspaceId)
  ), [activeWorkspaceId, operations]);

  const [visibleOperationId, setVisibleOperationId] = useState<string>();
  const candidate = activeOperations[0];
  useEffect(() => {
    if (!candidate) return;
    if (activeOperations.some((operation) => operation.operationId === visibleOperationId)) return;
    const timer = window.setTimeout(() => setVisibleOperationId(candidate.operationId), 250);
    return () => window.clearTimeout(timer);
  }, [activeOperations, candidate, visibleOperationId]);
  const operation = activeOperations.find((item) => item.operationId === visibleOperationId);
  if (!operation) return null;

  const label = t(operation.phase);
  const cancellable = operation.cancellable && !operation.operationId.startsWith('client-');
  return (
    <div className="statusbar-operation" role="status" aria-live="polite" title={label}>
      <Codicon name="loading codicon-modifier-spin" />
      <span className="statusbar-operation-label">{label}</span>
      {operation.total !== null && operation.total > 0 && (
        <progress
          className="statusbar-operation-progress"
          aria-label={label}
          value={operation.completed ?? 0}
          max={operation.total}
        />
      )}
      {activeOperations.length > 1 && <b className="statusbar-operation-count">+{activeOperations.length - 1}</b>}
      {cancellable && (
        <IconButton
          type="button"
          className="statusbar-operation-cancel"
          aria-label={t('Cancel')}
          title={t('Cancel')}
          onClick={() => void bridge.cancelOperation(operation.operationId)}
        >
          <Codicon name="close" />
        </IconButton>
      )}
    </div>
  );
}
