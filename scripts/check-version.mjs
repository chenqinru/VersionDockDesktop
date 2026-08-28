#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function readPackageVersion(relativePath, packageName) {
  const content = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\[\\[package\\]\\]\\s+name\\s*=\\s*"${escapedName}"\\s+version\\s*=\\s*"([^"]+)"`,
  );
  const match = content.match(pattern);
  if (!match) throw new Error(`${relativePath} 中找不到 ${packageName} 的版本号`);
  return match[1];
}

function readCargoTomlVersion() {
  const content = fs.readFileSync(path.join(rootDir, 'src-tauri/Cargo.toml'), 'utf8');
  const match = content.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('src-tauri/Cargo.toml 中找不到 [package] 版本号');
  return match[1];
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const tauriConfig = readJson('src-tauri/tauri.conf.json');
const expectedVersion = packageJson.version;
const versions = new Map([
  ['package.json', expectedVersion],
  ['package-lock.json', packageLock.version],
  ['package-lock.json packages[""]', packageLock.packages?.['']?.version],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
  ['src-tauri/Cargo.toml', readCargoTomlVersion()],
  ['src-tauri/Cargo.lock', readPackageVersion('src-tauri/Cargo.lock', packageJson.name)],
]);

const mismatches = [...versions].filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  const details = mismatches.map(([file, version]) => `${file}: ${version ?? '<missing>'}`).join('\n');
  throw new Error(`项目版本号不一致，期望 ${expectedVersion}:\n${details}`);
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const expectedTag = `v${expectedVersion}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(`发布标签 ${process.env.GITHUB_REF_NAME} 与项目版本 ${expectedVersion} 不一致，应为 ${expectedTag}`);
  }
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${expectedVersion}\nprerelease=${expectedVersion.includes('-')}\n`,
  );
}

console.log(`Version metadata is consistent: ${expectedVersion}`);
