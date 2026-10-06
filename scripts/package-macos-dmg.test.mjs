import assert from 'node:assert/strict';
import test from 'node:test';
import { macosPackageName } from './package-macos-dmg.mjs';

test('macOS 包名使用实际版本及二进制架构', () => {
  for (const version of ['0.1.3', '1.12.34']) {
    assert.equal(macosPackageName('VersionDock Desktop', version, version, ['arm64']), `VersionDock Desktop_${version}_aarch64.dmg`);
    assert.equal(macosPackageName('VersionDock Desktop', version, version, ['x86_64']), `VersionDock Desktop_${version}_x64.dmg`);
    assert.equal(macosPackageName('VersionDock Desktop', version, version, ['x86_64', 'arm64']), `VersionDock Desktop_${version}_universal.dmg`);
  }
});

test('拒绝给旧 App 套上新版本文件名', () => {
  assert.throws(() => macosPackageName('VersionDock Desktop', '0.1.3', '0.1.0', ['arm64']), /版本.*不一致/);
});

test('拒绝无效版本和未知架构', () => {
  assert.throws(() => macosPackageName('VersionDock Desktop', '../0.1.3', '../0.1.3', ['arm64']), /正式版本/);
  assert.throws(() => macosPackageName('VersionDock Desktop', '0.1.3', '0.1.3', ['arm64', 'unknown']), /不支持/);
});
