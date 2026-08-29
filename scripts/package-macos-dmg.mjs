import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const app = join(root, 'src-tauri/target/release/bundle/macos/VersionDock Desktop.app');
const output = join(root, 'src-tauri/target/release/bundle/dmg/VersionDock Desktop_0.1.0_aarch64.dmg');
const staging = mkdtempSync(join(tmpdir(), 'versiondock-dmg-stage-'));
process.on('exit', () => rmSync(staging, { recursive: true, force: true }));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('ditto', ['--rsrc', '--extattr', '--acl', app, join(staging, 'VersionDock Desktop.app')]);
run('codesign', ['--force', '--deep', '--sign', '-', join(staging, 'VersionDock Desktop.app')]);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', join(staging, 'VersionDock Desktop.app')]);
run('ln', ['-s', '/Applications', join(staging, 'Applications')]);
run('hdiutil', ['create', '-ov', '-fs', 'HFS+', '-volname', 'VersionDock Desktop', '-srcfolder', staging, '-format', 'UDZO', output]);

console.log(`Created locally verifiable arm64 DMG: ${output}`);
