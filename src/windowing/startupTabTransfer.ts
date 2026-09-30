import type { WindowTabTransfer, WorkspaceDescriptor } from '../bindings/generated';

export function startupTransferTab(): WorkspaceDescriptor | undefined {
  const encoded = new URLSearchParams(window.location.search).get('tabTransfer');
  if (!encoded) return undefined;
  try {
    const transfer = JSON.parse(encoded) as Partial<WindowTabTransfer>;
    if (typeof transfer.tabId !== 'string' || !transfer.tabId
      || typeof transfer.tabName !== 'string'
      || !Array.isArray(transfer.paths) || !transfer.paths.length
      || !transfer.paths.every((path) => typeof path === 'string' && path.length > 0)) return undefined;
    return {
      id: transfer.tabId,
      name: transfer.tabName,
      paths: transfer.paths,
      available: true,
      lastOpenedAt: '',
    };
  } catch {
    return undefined;
  }
}
