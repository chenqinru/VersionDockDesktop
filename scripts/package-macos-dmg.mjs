import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateVersion } from './release-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function macosPackageName(productName, expectedVersion, bundleVersion, architectures) {
  validateVersion(expectedVersion);
  if (bundleVersion !== expectedVersion) {
    throw new Error(`App 版本 ${bundleVersion} 与项目版本 ${expectedVersion} 不一致，请先重新构建 App。`);
  }
  const archs = new Set(architectures);
  let arch;
  if (archs.size === 2 && archs.has('arm64') && archs.has('x86_64')) arch = 'universal';
  else if (archs.size === 1 && archs.has('arm64')) arch = 'aarch64';
  else if (archs.size === 1 && archs.has('x86_64')) arch = 'x64';
  else throw new Error(`不支持的 macOS 架构：${[...archs].join(', ')}`);
  return `${productName}_${expectedVersion}_${arch}.dmg`;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} 执行失败：${result.error?.message ?? result.status}`);
}

function main() {
  if (process.platform !== 'darwin') throw new Error('此打包脚本仅支持 macOS。');
  run(process.execPath, [join(root, 'scripts/check-version.mjs')]);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { productName, identifier } = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  // An explicit app path also supports universal and Intel build directories.
  const app = resolve(process.argv[2] || join(root, 'src-tauri/target/release/bundle/macos', `${productName}.app`));
  const plist = join(app, 'Contents/Info.plist');
  const info = (key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  if (info('CFBundleIdentifier') !== identifier) throw new Error('App 标识与发布配置不一致，不能作为当前应用打包。');
  const bundleVersion = info('CFBundleShortVersionString');
  const executable = join(app, 'Contents/MacOS', info('CFBundleExecutable'));
  const archs = execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/);
  const output = join(root, 'src-tauri/target/release/bundle/dmg', macosPackageName(productName, version, bundleVersion, archs));
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), 'versiondock-dmg-stage-'));
  try {
    const stagedApp = join(staging, `${productName}.app`);
    run('ditto', ['--rsrc', '--extattr', '--acl', app, stagedApp]);
    run('codesign', ['--force', '--deep', '--options', 'runtime', '--sign', '-', stagedApp]);
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp]);
    run('ln', ['-s', '/Applications', join(staging, 'Applications')]);
    run('hdiutil', ['create', '-ov', '-fs', 'HFS+', '-volname', productName, '-srcfolder', staging, '-format', 'UDZO', output]);
    console.log(`Created locally verifiable DMG: ${output}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
