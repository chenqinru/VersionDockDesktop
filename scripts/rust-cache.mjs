import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const gib = 1024 ** 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid cache guard owner.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

async function acquireGate(directory) {
  const gate = path.join(directory, 'gate');
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      mkdirSync(gate);
      try { writeFileSync(path.join(gate, 'owner.json'), JSON.stringify({ pid: process.pid })); }
      catch (error) { rmSync(gate, { recursive: true, force: true }); throw error; }
      return () => rmSync(gate, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(path.join(gate, 'owner.json'), 'utf8'));
        if (!isAlive(owner.pid)) {
          // Do not race other starters by removing a gate whose owner has died.
          throw new Error(`Rust cache guard owner ${owner.pid} exited unexpectedly. With all managed tasks stopped, remove ${gate} and retry.`);
        }
      } catch (ownerError) {
        if (ownerError.code !== 'ENOENT' && !(ownerError instanceof SyntaxError)) throw ownerError;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Rust cache guard.');
      await sleep(100);
    }
  }
}

function hasActiveLease(directory) {
  let active = false;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const leasePath = path.join(directory, name);
    try {
      const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
      if (isAlive(lease.pid)) active = true;
      else rmSync(leasePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return active;
}

export function directoryBytes(directory) {
  const seen = new Set();
  function visit(entry) {
    const info = lstatSync(entry);
    if (info.isSymbolicLink()) return 0;
    const key = `${info.dev}:${info.ino}`;
    if (process.platform !== 'win32' && seen.has(key)) return 0;
    seen.add(key);
    const bytes = process.platform === 'win32' ? info.size : info.blocks * 512;
    return info.isDirectory()
      ? bytes + readdirSync(entry).reduce((total, name) => total + visit(path.join(entry, name)), 0)
      : bytes;
  }
  return existsSync(directory) ? visit(directory) : 0;
}

function rustProcessesRunning() {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'tasklist' : 'ps', windows ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return true; // Uncertain state: do not delete.
  return result.stdout.split(/\r?\n/).some((line) => {
    const name = windows ? line.match(/^"([^"]+)"/)?.[1]?.replace(/\.exe$/i, '') : path.basename(line.trim());
    return /^(cargo(?:-.+)?|rustc|rustdoc|rustup|clippy-driver)$/i.test(name ?? '');
  });
}

function checkCache({ root, env, dryRun, log }) {
  const limit = Number(env.VERSIONDOCK_RUST_CACHE_LIMIT_GIB ?? 30);
  if (!Number.isFinite(limit) || limit < 0) throw new Error('VERSIONDOCK_RUST_CACHE_LIMIT_GIB must be a non-negative number.');
  if (limit === 0) { log('[rust-cache] Automatic cleanup disabled.'); return; }
  const target = path.join(root, 'src-tauri', 'target');
  const debug = path.join(target, 'debug');
  if (!existsSync(debug)) { log('[rust-cache] No local debug artifacts to clean.'); return; }
  if (realpathSync(debug) !== path.join(realpathSync(root), 'src-tauri', 'target', 'debug')) {
    log('[rust-cache] Skipping a symlinked build directory.'); return;
  }
  const size = directoryBytes(debug);
  log(`[rust-cache] Local debug artifacts: ${(size / gib).toFixed(2)} GiB; limit: ${limit} GiB.`);
  if (size <= limit * gib || dryRun) return;
  const manifest = path.join(root, 'src-tauri', 'Cargo.toml');
  const metadata = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--offline', '--locked', '--manifest-path', manifest], { cwd: root, env, encoding: 'utf8' });
  if (metadata.error || metadata.status !== 0) throw new Error(`Cannot verify the Cargo target directory: ${metadata.error?.message ?? metadata.stderr}`);
  const config = JSON.parse(metadata.stdout);
  if (path.resolve(config.target_directory) !== target || path.resolve(config.build_directory ?? config.target_directory) !== target) {
    log('[rust-cache] Skipping a custom or shared Cargo target/build directory.'); return;
  }
  if (rustProcessesRunning()) { log('[rust-cache] Cargo/Rust is running, or process inspection failed; cleanup skipped.'); return; }
  log('[rust-cache] Limit exceeded; cleaning the dev profile before starting this task.');
  // Without --target, Cargo cleans the native debug directory we measured.
  const result = spawnSync('cargo', ['clean', '--offline', '--locked', '--manifest-path', manifest, '--target-dir', target, '--profile', 'dev'], { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Cargo cleanup failed: ${result.error?.message ?? result.status}`);
}

// The gate makes cleanup + lease registration atomic between managed commands.
// Leases remain alive for the entire build/test/dev session, including watchers.
export async function withRustCache(task, { root = projectRoot, env = process.env, dryRun = false, clean = true, log = console.log } = {}) {
  if (env.CI && env.CI !== 'false') return task();
  const directory = path.join(root, 'src-tauri', '.rust-cache-guard');
  mkdirSync(directory, { recursive: true });
  const release = await acquireGate(directory);
  const lease = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  try {
    if (hasActiveLease(directory)) log('[rust-cache] Another managed Rust task is active; cleanup skipped.');
    else if (clean) checkCache({ root, env, dryRun, log });
    writeFileSync(lease, JSON.stringify({ pid: process.pid }));
  } finally { release(); }
  try { return await task(); }
  finally { rmSync(lease, { force: true }); }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command === 'node' ? process.execPath : command, args, { stdio: 'inherit', ...options });
    const forward = (signal) => { child.kill(signal); };
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    function removeHandlers() { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); }
    child.once('error', (error) => { removeHandlers(); reject(error); });
    child.once('exit', (code, signal) => { removeHandlers(); resolve(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const flags = separator < 0 ? args : args.slice(0, separator);
  if (flags.some((flag) => !['--dry-run', '--no-clean'].includes(flag))) throw new Error('Usage: rust-cache.mjs [--dry-run] [--no-clean] [-- command args...]');
  const command = separator < 0 ? [] : args.slice(separator + 1);
  if (separator >= 0 && !command.length) throw new Error('Missing command after --.');
  try {
    process.exitCode = await withRustCache(() => command.length ? runCommand(command[0], command.slice(1), { cwd: projectRoot }) : 0, { dryRun: flags.includes('--dry-run'), clean: !flags.includes('--no-clean') });
  } catch (error) { console.error(`[rust-cache] ${error.message}`); process.exitCode = 1; }
}
