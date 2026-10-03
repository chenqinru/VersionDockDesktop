import React from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import './historyLog.css';
import './layoutDensity.css';
import { App } from './App';
import { BridgeContext } from './platform/context';
import type { VersionDockBridge } from './platform/bridge';
import { useAppStore } from './store/appStore';

let disposeBridge: () => void = () => undefined;

async function start() {
  const browserDev = import.meta.env.MODE === 'browser';
  const bridge: VersionDockBridge = browserDev
    ? new (await import('./platform/browserDevBridge')).BrowserDevBridge()
    : new (await import('./platform/bridge')).TauriBridge();
  const disposable = bridge as VersionDockBridge & { dispose?: () => void };
  if (typeof disposable.dispose === 'function') disposeBridge = () => disposable.dispose?.();

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode><BridgeContext.Provider value={bridge}><App /></BridgeContext.Provider></React.StrictMode>,
  );
  const initializable = bridge as VersionDockBridge & { initialize?: () => Promise<void> };
  if (typeof initializable.initialize === 'function') {
    try { await initializable.initialize(); } catch (error) { console.warn('Native event channel unavailable', error); }
  }
  await useAppStore.getState().initialize(bridge);
  if (browserDev) {
    const firstCommit = useAppStore.getState().history[0];
    if (firstCommit) await useAppStore.getState().selectCommit(firstCommit);
  }
}

void start().catch((error) => {
  console.error('VersionDock Desktop startup failed', error);
  document.body.dataset.startupError = error instanceof Error ? error.message : String(error);
});

window.addEventListener('beforeunload', () => {
  useAppStore.getState().dispose();
  disposeBridge();
});
