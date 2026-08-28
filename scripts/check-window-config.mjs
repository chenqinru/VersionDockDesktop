import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const base = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
const development = JSON.parse(await readFile(new URL('src-tauri/tauri.dev.conf.json', root), 'utf8'));
const windows = JSON.parse(await readFile(new URL('src-tauri/tauri.windows.conf.json', root), 'utf8'));
const macos = JSON.parse(await readFile(new URL('src-tauri/tauri.macos.conf.json', root), 'utf8'));
const linux = JSON.parse(await readFile(new URL('src-tauri/tauri.linux.conf.json', root), 'utf8'));
const mainWindow = base.app?.windows?.find((window) => window.label === 'main');
const windowsMain = windows.app?.windows?.find((window) => window.label === 'main');
const macosMain = macos.app?.windows?.find((window) => window.label === 'main');
const linuxMain = linux.app?.windows?.find((window) => window.label === 'main');

if (!mainWindow || mainWindow.decorations !== true) {
  throw new Error('The base Tauri main window must keep native decorations enabled.');
}

if (!windowsMain || windowsMain.decorations !== true) {
  throw new Error('The Windows Tauri main window must keep native decorations enabled.');
}

if (!macosMain || macosMain.decorations !== true || macosMain.titleBarStyle !== 'Overlay' || macosMain.hiddenTitle !== true || !macosMain.trafficLightPosition) {
  throw new Error('The macOS Tauri main window must use the native overlay title bar.');
}

if (!linuxMain || linuxMain.decorations !== false) {
  throw new Error('The Linux Tauri main window must be borderless for custom controls.');
}

if (development.app?.windows) {
  throw new Error('tauri.dev.conf.json must not replace app.windows; keep platform window definitions in the platform config files.');
}

if ('productName' in development) {
  throw new Error('Development builds must inherit the release product name instead of overriding it.');
}

if (!development.identifier || development.identifier === base.identifier) {
  throw new Error('Development builds must keep a separate application identifier.');
}

if (base.bundle?.icon?.[0] !== 'icons/128x128@2x.png') {
  throw new Error('The highest-resolution PNG must remain the default native window and About icon.');
}

console.log('Tauri window configuration uses macOS overlay, Windows overlay plugin, and Linux custom controls.');
