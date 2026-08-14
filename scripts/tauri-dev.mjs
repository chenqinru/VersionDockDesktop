import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
const platformConfig = `src-tauri/tauri.${platform}.conf.json`;
const npmCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['tauri', 'dev'];

if (existsSync(platformConfig)) args.push('--config', platformConfig);
args.push('--config', 'src-tauri/tauri.dev.conf.json');

const child = spawn(npmCommand, args, { stdio: 'inherit' });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
