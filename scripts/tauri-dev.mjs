import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
const platformConfig = `src-tauri/tauri.${platform}.conf.json`;
const npmCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['tauri', 'dev'];
const rawAppArgs = process.argv.slice(2);
const stableSession = rawAppArgs.includes('--stable');
// Accept the former --watch switch as a no-op for existing launch commands.
const appArgs = rawAppArgs.filter((argument) => argument !== '--stable' && argument !== '--watch');

if (existsSync(platformConfig)) args.push('--config', platformConfig);
args.push('--config', 'src-tauri/tauri.dev.conf.json');
// When VersionDock operates on its own checkout, stash/checkout/reset can change
// the running app's source files. Opt into a stable session for that workflow.
if (stableSession) args.push('--no-watch');
if (appArgs.length > 0) args.push('--', '--', ...appArgs);

const child = spawn(npmCommand, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    // Avoid LLVM anonymous-symbol link failures in cached macOS debug objects.
    // This only changes Rust code generation; Vite HMR and the Tauri watcher stay on.
    ...(platform === 'macos' ? { CARGO_INCREMENTAL: '0' } : {}),
    VERSIONDOCK_STABLE_DEV: stableSession ? '1' : '0',
  },
});
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
