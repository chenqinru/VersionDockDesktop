import React from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';
import { App } from './App';
import { BridgeContext } from './platform/context';
import { TauriBridge } from './platform/bridge';
import { useAppStore } from './store/appStore';

const bridge = new TauriBridge();

async function start() {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode><BridgeContext.Provider value={bridge}><App /></BridgeContext.Provider></React.StrictMode>,
  );
  try { await bridge.initialize(); } catch (error) { console.warn('Native event channel unavailable', error); }
  await useAppStore.getState().initialize(bridge);
}

void start().catch((error) => {
  console.error('VersionDock Desktop startup failed', error);
  document.body.dataset.startupError = error instanceof Error ? error.message : String(error);
});

window.addEventListener('beforeunload', () => bridge.dispose());
