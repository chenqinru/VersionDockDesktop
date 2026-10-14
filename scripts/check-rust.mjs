import { runCommand } from './rust-cache.mjs';

for (const args of [
  ['fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml'],
  ['clippy', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--all-features', '--', '-D', 'warnings'],
  ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'],
]) {
  const code = await runCommand('cargo', args);
  if (code !== 0) { process.exitCode = code; break; }
}
