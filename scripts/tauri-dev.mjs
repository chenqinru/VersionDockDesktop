import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
const platformConfig = `src-tauri/tauri.${platform}.conf.json`;
const npmCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['tauri', 'dev'];
const rawAppArgs = process.argv.slice(2);
const watchSources = rawAppArgs.includes('--watch');
const appArgs = rawAppArgs.filter((argument) => argument !== '--watch');

if (existsSync(platformConfig)) args.push('--config', platformConfig);
args.push('--config', 'src-tauri/tauri.dev.conf.json');
// VersionDock is commonly used to operate on its own checkout while developing.
// Stash/checkout/reset then changes the source files backing the running app.
// Keep the default self-hosted session stable; opt into traditional hot reload
// with `npm run tauri:dev -- --watch` when source watching is desired.
if (!watchSources) args.push('--no-watch');
if (appArgs.length > 0) args.push('--', '--', ...appArgs);

const child = spawn(npmCommand, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    VERSIONDOCK_STABLE_DEV: watchSources ? '0' : '1',
  },
});
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
