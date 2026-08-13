import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
const development = JSON.parse(await readFile(new URL('src-tauri/tauri.dev.conf.json', root), 'utf8'));
const mainWindow = base.app?.windows?.find((window) => window.label === 'main');

if (!mainWindow || mainWindow.decorations !== false) {
  throw new Error('The main Tauri window must keep decorations: false.');
}

if (development.app?.windows) {
  throw new Error('tauri.dev.conf.json must not replace app.windows; keep the borderless window definition in tauri.conf.json.');
}

console.log('Tauri window configuration is borderless and shared by development builds.');
