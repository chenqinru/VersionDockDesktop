import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { directoryBytes, runCommand, withRustCache } from './rust-cache.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'versiondock-rust-cache-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rust = path.join(root, 'src-tauri');
  mkdirSync(path.join(rust, 'src'), { recursive: true });
  writeFileSync(path.join(rust, 'Cargo.toml'), '[package]\nname = "cache_fixture"\nversion = "0.1.0"\nedition = "2021"\n');
  writeFileSync(path.join(rust, 'src', 'main.rs'), 'fn main() {}\n');
  const debug = path.join(rust, 'target', 'debug');
  const release = path.join(rust, 'target', 'release');
  mkdirSync(debug, { recursive: true });
  mkdirSync(release);
  writeFileSync(path.join(rust, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  writeFileSync(path.join(debug, 'cached'), Buffer.alloc(64 * 1024, 1));
  writeFileSync(path.join(release, 'package'), 'preserve release');
  const messages = [];
  const env = { ...process.env, CI: '', VERSIONDOCK_RUST_CACHE_LIMIT_GIB: '0.000001' };
  delete env.CARGO_TARGET_DIR;
  delete env.CARGO_BUILD_BUILD_DIR;
  delete env.CARGO_BUILD_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET;
  return { root, rust, debug, release, messages, options: { root, env, log: (message) => messages.push(message) } };
}

test('over-limit cleanup uses real Cargo, preserves release/source, then starts the task', async (t) => {
  const f = fixture(t);
  await withRustCache(() => {
    assert.equal(existsSync(f.debug), false);
    assert.equal(readFileSync(path.join(f.release, 'package'), 'utf8'), 'preserve release');
    assert.equal(readFileSync(path.join(f.rust, 'src', 'main.rs'), 'utf8'), 'fn main() {}\n');
  }, f.options);
  assert.ok(f.messages.some((message) => message.includes('cleaning the dev profile')));
});

test('below-limit and dry-run checks preserve the cache', async (t) => {
  const f = fixture(t);
  await withRustCache(() => {}, { ...f.options, env: { ...f.options.env, VERSIONDOCK_RUST_CACHE_LIMIT_GIB: '30' } });
  await withRustCache(() => {}, { ...f.options, dryRun: true });
  assert.ok(existsSync(path.join(f.debug, 'cached')));
});

test('a configured target cannot redirect cleanup to architecture-specific or release artifacts', async (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, '.cargo'));
  writeFileSync(path.join(f.root, '.cargo', 'config.toml'), '[build]\ntarget = "x86_64-unknown-linux-gnu"\n');
  const architecture = path.join(f.rust, 'target', 'x86_64-unknown-linux-gnu', 'debug');
  mkdirSync(architecture, { recursive: true });
  writeFileSync(path.join(architecture, 'preserve'), 'keep');
  await withRustCache(() => {}, f.options);
  assert.equal(existsSync(f.debug), false);
  assert.equal(readFileSync(path.join(architecture, 'preserve'), 'utf8'), 'keep');
  assert.equal(readFileSync(path.join(f.release, 'package'), 'utf8'), 'preserve release');
});

test('Cargo rejects an unmarked directory and the original command does not start', async (t) => {
  const f = fixture(t);
  rmSync(path.join(f.rust, 'target', 'CACHEDIR.TAG'));
  await assert.rejects(withRustCache(() => assert.fail('must not run'), f.options), /Cargo cleanup failed/);
  assert.ok(existsSync(path.join(f.debug, 'cached')));
});

test('another managed task protects cache for its entire lifetime, including nested commands', async (t) => {
  const f = fixture(t);
  let releaseTask;
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const first = withRustCache(async () => {
    markReady();
    await new Promise((resolve) => { releaseTask = resolve; });
  }, { ...f.options, clean: false });
  await ready;
  try {
    await withRustCache(() => {}, f.options);
    assert.ok(existsSync(path.join(f.debug, 'cached')));
    assert.ok(f.messages.some((message) => message.includes('Another managed Rust task')));
  } finally { releaseTask(); await first; }
  await withRustCache(() => {}, f.options);
  assert.equal(existsSync(f.debug), false);
});

test('a lease held by a separate process prevents cleanup until that process exits', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const moduleUrl = new URL('./rust-cache.mjs', import.meta.url).href;
  const marker = path.join(f.root, 'ready');
  const stop = path.join(f.root, 'stop');
  const script = path.join(f.root, 'managed-task.mjs');
  writeFileSync(script, `import { existsSync, writeFileSync } from 'node:fs';
import { withRustCache } from ${JSON.stringify(moduleUrl)};
await withRustCache(async () => {
  writeFileSync(${JSON.stringify(marker)}, 'ready');
  while (!existsSync(${JSON.stringify(stop)})) await new Promise(resolve => setTimeout(resolve, 25));
}, { root: ${JSON.stringify(f.root)}, clean: false });`);
  const child = spawn(process.execPath, [script], { env: f.options.env, stdio: 'ignore' });
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Managed child did not become ready.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await withRustCache(() => {}, f.options);
    assert.ok(existsSync(path.join(f.debug, 'cached')));
    writeFileSync(stop, 'stop');
    assert.equal(await completed, 0);
    await withRustCache(() => {}, f.options);
    assert.equal(existsSync(f.debug), false);
  } finally {
    if (child.exitCode === null) { child.kill(); await completed; }
  }
});

test('custom/shared target directories are never automatically cleaned', async (t) => {
  const f = fixture(t);
  const shared = path.join(f.root, 'shared');
  mkdirSync(shared);
  writeFileSync(path.join(shared, 'preserve'), 'keep');
  await withRustCache(() => {}, { ...f.options, env: { ...f.options.env, CARGO_TARGET_DIR: shared } });
  assert.ok(existsSync(path.join(f.debug, 'cached')));
  assert.equal(readFileSync(path.join(shared, 'preserve'), 'utf8'), 'keep');
  assert.ok(f.messages.some((message) => message.includes('custom or shared')));
});

test('a symbolic debug directory is not cleaned', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'preserve'), 'keep');
  rmSync(f.debug, { recursive: true });
  symlinkSync(outside, f.debug);
  await withRustCache(() => {}, f.options);
  assert.equal(readFileSync(path.join(outside, 'preserve'), 'utf8'), 'keep');
  assert.ok(f.messages.some((message) => message.includes('symlinked')));
});

test('file counting ignores symbolic links and duplicate hard links', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const before = directoryBytes(f.debug);
  linkSync(path.join(f.debug, 'cached'), path.join(f.debug, 'hard-link'));
  symlinkSync(f.release, path.join(f.debug, 'symbolic-link'));
  assert.ok(directoryBytes(f.debug) - before < 4096);
});

test('invalid limits fail before the task or cleanup; zero and CI disable cleanup', async (t) => {
  const f = fixture(t);
  for (const value of ['NaN', '-1', 'Infinity']) {
    await assert.rejects(withRustCache(() => assert.fail('must not run'), { ...f.options, env: { ...f.options.env, VERSIONDOCK_RUST_CACHE_LIMIT_GIB: value } }), /non-negative/);
  }
  await withRustCache(() => {}, { ...f.options, env: { ...f.options.env, VERSIONDOCK_RUST_CACHE_LIMIT_GIB: '0' } });
  await withRustCache(() => {}, { ...f.options, env: { ...f.options.env, CI: 'true' } });
  assert.ok(existsSync(path.join(f.debug, 'cached')));
});

test('a stale task lease is reclaimed, but an interrupted maintenance gate fails safely', async (t) => {
  const f = fixture(t);
  const guard = path.join(f.rust, '.rust-cache-guard');
  mkdirSync(guard);
  writeFileSync(path.join(guard, 'stale.json'), JSON.stringify({ pid: 2147483647 }));
  await withRustCache(() => {}, { ...f.options, dryRun: true });
  assert.equal(existsSync(path.join(guard, 'stale.json')), false);
  mkdirSync(path.join(guard, 'gate'));
  writeFileSync(path.join(guard, 'gate', 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  await assert.rejects(withRustCache(() => assert.fail('must not run'), f.options), /exited unexpectedly/);
  assert.ok(existsSync(path.join(f.debug, 'cached')));
});

test('a failed task releases its lease and command exit codes are propagated', async (t) => {
  const f = fixture(t);
  await assert.rejects(withRustCache(() => { throw new Error('task failure'); }, { ...f.options, clean: false }), /task failure/);
  assert.equal(await runCommand('node', ['-e', 'process.exit(7)']), 7);
  await withRustCache(() => {}, f.options);
  assert.equal(existsSync(f.debug), false);
});

test('an unmanaged Cargo build prevents cleanup of its output', { timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.rust, 'build.rs'), 'fn main() { std::fs::write("started", "yes").unwrap(); std::thread::sleep(std::time::Duration::from_secs(4)); }');
  const child = spawn('cargo', ['build', '--offline'], { cwd: f.rust, env: f.options.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(path.join(f.rust, 'started'))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Cargo build did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await withRustCache(() => {}, f.options);
    assert.ok(existsSync(path.join(f.debug, 'cached')));
    assert.ok(f.messages.some((message) => message.includes('Cargo/Rust is running')));
    assert.equal(await completed, 0, stderr);
  } finally {
    if (child.exitCode === null) { child.kill(); await completed; }
  }
});
