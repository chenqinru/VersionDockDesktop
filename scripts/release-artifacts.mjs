import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseNotesForVersion } from './release-notes.mjs';

export const RELEASE_REPOSITORY = 'chenqinru/VersionDockDesktop';
export const RELEASE_PLATFORMS = ['macos', 'windows', 'linux'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetPattern = /(?:\.app\.tar\.gz|\.dmg|\.exe|\.msi|\.AppImage|\.deb|\.rpm)(?:\.sig)?$/;

export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`只允许正式版本号，收到 ${version}`);
  }
  return version;
}

export function compareVersions(left, right) {
  const a = validateVersion(left).split('.').map(BigInt);
  const b = validateVersion(right).split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeOutput(directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw new Error(`输出目录必须为空：${directory}`);
}

export function stageArtifacts({ platform, version, files, outputDir }) {
  validateVersion(version);
  if (!RELEASE_PLATFORMS.includes(platform)) throw new Error(`未知平台：${platform}`);
  const selected = files.filter((file) => assetPattern.test(path.basename(file)));
  if (!selected.length) throw new Error(`平台 ${platform} 没有安装产物`);
  const entries = selected.map((file) => {
    if (!fs.lstatSync(file).isFile()) throw new Error(`产物必须是普通文件：${file}`);
    return { file, name: path.basename(file).replace(/[^A-Za-z0-9._-]/g, '.') };
  });
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) {
    throw new Error(`平台 ${platform} 出现重名产物`);
  }
  makeOutput(outputDir);
  const metadata = { platform, version, files: [] };
  for (const { file, name } of entries) {
    const destination = path.join(outputDir, name);
    fs.copyFileSync(file, destination);
    metadata.files.push({ name, sha256: fileHash(destination) });
  }
  fs.writeFileSync(path.join(outputDir, 'release-artifact.json'), JSON.stringify(metadata, null, 2));
  return metadata;
}

function decodeBase64(text) {
  const value = text.trim();
  const decoded = Buffer.from(value, 'base64');
  if (!value || decoded.toString('base64') !== value) throw new Error('签名或公钥不是有效的 Base64');
  return decoded;
}

export function verifySignature(file, signature, pubkey) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-signature-'));
  try {
    const keyFile = path.join(temporary, 'public.key');
    const signatureFile = path.join(temporary, 'package.sig');
    fs.writeFileSync(keyFile, decodeBase64(pubkey));
    fs.writeFileSync(signatureFile, decodeBase64(signature));
    try {
      execFileSync('minisign', ['-V', '-q', '-m', file, '-p', keyFile, '-x', signatureFile], { stdio: 'pipe' });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('需要安装 minisign 才能校验更新签名');
      throw new Error(`更新签名无效或与客户端公钥不匹配：${path.basename(file)}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function prepareRelease({ artifactsDir, outputDir, version, pubkey, now = new Date(), releaseNotes }) {
  validateVersion(version);
  const notes = releaseNotesForVersion(version, releaseNotes);
  const files = new Map();
  const platformFiles = new Map();
  for (const platform of RELEASE_PLATFORMS) {
    const directory = path.join(artifactsDir, `release-${platform}`);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'release-artifact.json'), 'utf8'));
    if (metadata.platform !== platform || metadata.version !== version) {
      throw new Error(`平台 ${platform} 的版本或平台标识不一致`);
    }
    if (!Array.isArray(metadata.files) || !metadata.files.length) throw new Error(`平台 ${platform} 没有产物`);
    const names = metadata.files.map(({ name }) => name);
    if (new Set(names).size !== names.length) throw new Error(`平台 ${platform} 出现重名产物`);
    for (const { name, sha256 } of metadata.files) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || !assetPattern.test(name)) {
        throw new Error(`无效产物名称：${name}`);
      }
      if (files.has(name)) throw new Error(`平台间产物重名：${name}`);
      const source = path.join(directory, name);
      const stat = fs.lstatSync(source);
      if (!stat.isFile()) throw new Error(`产物不是普通文件：${name}`);
      const actualHash = stat.size > 0 ? fileHash(source) : '<empty>';
      if (stat.size === 0 || actualHash !== sha256) {
        throw new Error(`产物为空或校验失败：${name}（大小 ${stat.size} 字节；期望 SHA-256 ${sha256}；实际 ${actualHash}）`);
      }
      files.set(name, source);
    }
    const received = fs.readdirSync(directory).filter((name) => name !== 'release-artifact.json').sort();
    if (JSON.stringify(received) !== JSON.stringify([...names].sort())) throw new Error(`平台 ${platform} 存在未登记产物`);
    platformFiles.set(platform, names);
  }

  // 检验所有签名，而不只是清单中最终选用的安装包。
  for (const [name, source] of files) {
    if (!name.endsWith('.sig')) continue;
    const packageFile = files.get(name.slice(0, -4));
    if (!packageFile) throw new Error(`签名缺少安装包：${name}`);
    verifySignature(packageFile, fs.readFileSync(source, 'utf8').trim(), pubkey);
  }

  const manifest = { version, notes, pub_date: now.toISOString(), platforms: {} };
  for (const [platform, suffix, targets, required] of [
    ['macos', '.app.tar.gz', ['darwin-aarch64', 'darwin-x86_64'], true],
    ['windows', '.exe', ['windows-x86_64', 'windows-x86_64-nsis'], true],
    ['linux', '.AppImage', ['linux-x86_64', 'linux-x86_64-appimage'], true],
    ['windows', '.msi', ['windows-x86_64-msi'], false],
    ['linux', '.deb', ['linux-x86_64-deb'], false],
    ['linux', '.rpm', ['linux-x86_64-rpm'], false],
  ]) {
    const candidates = platformFiles.get(platform).filter((name) => name.endsWith(suffix));
    if (!required && candidates.length === 0) continue;
    if (candidates.length !== 1) throw new Error(`平台 ${platform} 必须有且只有一个 ${suffix} 更新包`);
    const name = candidates[0];
    const signatureFile = files.get(`${name}.sig`);
    if (!signatureFile) throw new Error(`更新包缺少签名：${name}`);
    const update = {
      signature: fs.readFileSync(signatureFile, 'utf8').trim(),
      url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${encodeURIComponent(name)}`,
    };
    for (const target of targets) manifest.platforms[target] = update;
  }

  makeOutput(outputDir);
  const assetsDir = path.join(outputDir, 'assets');
  fs.mkdirSync(assetsDir);
  for (const [name, file] of files) fs.copyFileSync(file, path.join(assetsDir, name));
  fs.writeFileSync(path.join(assetsDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'release-notes.md'), `${notes}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === 'stage') {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (process.env.RELEASE_VERSION !== expected) throw new Error('构建版本与源码版本不一致');
    stageArtifacts({
      platform: process.env.RELEASE_PLATFORM,
      version: process.env.RELEASE_VERSION,
      files: JSON.parse(process.env.RELEASE_ARTIFACT_PATHS),
      outputDir: process.env.RELEASE_OUTPUT_DIR,
    });
  } else if (process.argv[2] === 'prepare') {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    prepareRelease({
      artifactsDir: process.env.RELEASE_ARTIFACTS_DIR,
      outputDir: process.env.RELEASE_OUTPUT_DIR,
      version: process.env.RELEASE_VERSION,
      pubkey: config.plugins.updater.pubkey,
    });
  } else {
    throw new Error('用法：node scripts/release-artifacts.mjs stage|prepare');
  }
}
