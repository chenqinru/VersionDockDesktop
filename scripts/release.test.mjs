import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RELEASE_REPOSITORY, compareVersions, fileHash, prepareRelease, stageArtifacts, validateVersion } from './release-artifacts.mjs';
import { assertPublishable, createGitHubClient, publishRelease } from './publish-release.mjs';

const temporaryDirectories = [];
afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

function fixture(extraInstallers = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-release-test-'));
  temporaryDirectories.push(root);
  const publicKey = path.join(root, 'public.key');
  const secretKey = path.join(root, 'secret.key');
  execFileSync('minisign', ['-G', '-W', '-p', publicKey, '-s', secretKey], { stdio: 'pipe' });
  const pubkey = fs.readFileSync(publicKey).toString('base64');
  const artifactsDir = path.join(root, 'artifacts');
  for (const [platform, name] of [
    ['macos', 'VersionDock Desktop.app.tar.gz'],
    ['windows', 'VersionDock.Desktop_0.1.1_x64-setup.exe'],
    ['linux', 'VersionDock.Desktop_0.1.1_amd64.AppImage'],
  ]) {
    const sourceDir = path.join(root, platform);
    fs.mkdirSync(sourceDir);
    const file = path.join(sourceDir, name);
    const installers = [file];
    if (extraInstallers && platform === 'windows') installers.push(path.join(sourceDir, 'VersionDock_0.1.1_x64_en-US.msi'));
    if (extraInstallers && platform === 'linux') installers.push(path.join(sourceDir, 'VersionDock_0.1.1_amd64.deb'), path.join(sourceDir, 'VersionDock-0.1.1-1.x86_64.rpm'));
    for (const installer of installers) {
      fs.writeFileSync(installer, `signed fixture for ${platform} ${path.basename(installer)}`);
      execFileSync('minisign', ['-S', '-s', secretKey, '-m', installer, '-x', `${installer}.sig`], { stdio: 'pipe' });
      // Tauri 的 .sig 文件是整个 minisign 签名文本的 Base64。
      fs.writeFileSync(`${installer}.sig`, fs.readFileSync(`${installer}.sig`).toString('base64'));
    }
    stageArtifacts({ platform, version: '0.1.1', files: installers.flatMap((installer) => [installer, `${installer}.sig`]), outputDir: path.join(artifactsDir, `release-${platform}`) });
  }
  const outputDir = path.join(root, 'prepared');
  return { root, artifactsDir, outputDir, version: '0.1.1', pubkey };
}

function changeMetadata(input, platform, change) {
  const file = path.join(input.artifactsDir, `release-${platform}`, 'release-artifact.json');
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(metadata);
  fs.writeFileSync(file, JSON.stringify(metadata));
}

function githubFixture() {
  const state = { latest: { tag_name: 'v0.1.0' }, draft: null, packages: new Map(), publications: 0, failUpload: false, corruptDownload: false };
  const github = {
    repository: () => ({ full_name: RELEASE_REPOSITORY, private: false, default_branch: 'main' }),
    latest: () => state.latest,
    release: () => state.draft,
    releaseById: () => state.draft,
    create: (body) => (state.draft = { ...body, id: 1, assets: [] }),
    deleteAsset: (id) => {
      const name = state.draft.assets.find((asset) => asset.id === id).name;
      state.packages.delete(name);
      state.draft.assets = state.draft.assets.filter((asset) => asset.id !== id);
    },
    upload: (_tag, files) => {
      for (const file of files) state.packages.set(path.basename(file), fs.readFileSync(file));
      state.draft.assets = [...state.packages].map(([name, data], id) => ({ id, name, size: data.length, state: 'uploaded' }));
      if (state.failUpload) throw new Error('网络上传失败');
    },
    download: (_tag, directory) => {
      for (const [name, data] of state.packages) fs.writeFileSync(path.join(directory, name), state.corruptDownload ? 'corrupted' : data);
    },
    publish: () => {
      state.publications++;
      state.draft.draft = false;
      state.latest = { tag_name: state.draft.tag_name };
      return state.draft;
    },
  };
  return { state, github };
}

test('只接受正式版本，并按数字比较多位版本号', () => {
  for (const invalid of ['0.1.1-beta.1', 'v0.1.1', '01.1.1', '0.1', '0.1.1+build']) assert.throws(() => validateVersion(invalid));
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
});

test('三平台签名产物生成四个架构入口，公开文件不含私有构建元数据', () => {
  const input = fixture();
  const manifest = prepareRelease({ ...input, now: new Date('2026-10-06T00:00:00Z') });
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-x86_64-appimage', 'windows-x86_64', 'windows-x86_64-nsis']);
  assert.deepEqual(manifest.platforms['darwin-aarch64'], manifest.platforms['darwin-x86_64']);
  for (const update of Object.values(manifest.platforms)) {
    assert.ok(update.url.startsWith(`https://github.com/${RELEASE_REPOSITORY}/releases/download/v0.1.1/`));
    assert.ok(update.signature.length > 0);
  }
  assert.equal(manifest.pub_date, '2026-10-06T00:00:00.000Z');
  assert.equal(fs.existsSync(path.join(input.outputDir, 'assets', 'release-artifact.json')), false);
});

test('可选 MSI、deb 和 rpm 安装包使用对应格式的更新入口', () => {
  const input = fixture(true);
  const manifest = prepareRelease(input);
  for (const [target, suffix] of [['windows-x86_64-msi', '.msi'], ['linux-x86_64-deb', '.deb'], ['linux-x86_64-rpm', '.rpm']]) {
    assert.ok(manifest.platforms[target].url.endsWith(suffix));
  }
  assert.ok(manifest.platforms['windows-x86_64'].url.endsWith('.exe'));
  assert.ok(manifest.platforms['linux-x86_64'].url.endsWith('.AppImage'));
});

test('缺少平台、版本不一致、缺少签名时停止生成清单', () => {
  for (const change of [
    (input) => fs.rmSync(path.join(input.artifactsDir, 'release-linux'), { recursive: true }),
    (input) => changeMetadata(input, 'windows', (metadata) => { metadata.version = '0.1.0'; }),
    (input) => {
      const directory = path.join(input.artifactsDir, 'release-windows');
      fs.readdirSync(directory).filter((name) => name.endsWith('.sig')).forEach((name) => fs.unlinkSync(path.join(directory, name)));
      changeMetadata(input, 'windows', (metadata) => { metadata.files = metadata.files.filter(({ name }) => !name.endsWith('.sig')); });
    },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => prepareRelease(input));
    assert.equal(fs.existsSync(input.outputDir), false);
  }
});

test('签名损坏或来自其他公钥时停止发布', () => {
  const input = fixture();
  const directory = path.join(input.artifactsDir, 'release-windows');
  const name = fs.readdirSync(directory).find((file) => file.endsWith('.sig'));
  fs.writeFileSync(path.join(directory, name), Buffer.from('invalid signature').toString('base64'));
  changeMetadata(input, 'windows', (metadata) => { metadata.files.find((file) => file.name === name).sha256 = fileHash(path.join(directory, name)); });
  assert.throws(() => prepareRelease(input), /签名无效/);
  const validInput = fixture();
  assert.throws(() => prepareRelease({ ...validInput, pubkey: input.pubkey }), /公钥不匹配/);
});

test('拒绝未登记文件、路径穿越及校验值不匹配的文件', () => {
  const input = fixture();
  const directory = path.join(input.artifactsDir, 'release-linux');
  fs.writeFileSync(path.join(directory, 'internal.log'), 'private');
  assert.throws(() => prepareRelease(input), /未登记/);
  fs.unlinkSync(path.join(directory, 'internal.log'));
  changeMetadata(input, 'linux', (metadata) => { metadata.files[0].name = '../private.key'; });
  assert.throws(() => prepareRelease(input), /无效产物名称/);
  const corrupted = fixture();
  changeMetadata(corrupted, 'linux', (metadata) => { metadata.files[0].sha256 = 'bad hash'; });
  assert.throws(() => prepareRelease(corrupted), /校验失败/);
});

test('拒绝规范化后重名的构建文件', () => {
  const input = fixture();
  const a = path.join(input.root, 'same name.exe');
  const b = path.join(input.root, 'same.name.exe');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
  assert.throws(() => stageArtifacts({ platform: 'windows', version: input.version, files: [a, b], outputDir: path.join(input.root, 'duplicates') }), /重名/);
});

test('重复公开版本、较旧版本以及 prerelease 草稿不能发布', () => {
  assert.throws(() => assertPublishable('0.1.1', null, { draft: false, prerelease: false }), /禁止覆盖/);
  assert.throws(() => assertPublishable('0.1.1', { tag_name: 'v0.2.0' }, null), /必须高于/);
  assert.throws(() => assertPublishable('0.1.1', null, { draft: true, prerelease: true }), /禁止覆盖/);
  assert.doesNotThrow(() => assertPublishable('0.1.1', { tag_name: 'v0.1.0' }, { draft: true, prerelease: false }));
});

test('草稿按标签查询返回 404 时使用分页列表查找，其他 API 错误不能当成不存在', () => {
  const calls = [];
  const client = createGitHubClient({ run: (_command, args) => {
    calls.push(args);
    if (args[1].includes('/tags/')) {
      const error = new Error('not found');
      error.stderr = Buffer.from('gh: Not Found (HTTP 404)');
      throw error;
    }
    return JSON.stringify([[{ id: 1, tag_name: 'v0.1.0', draft: false }], [{ id: 2, tag_name: 'v0.1.1', draft: true }]]);
  } });
  assert.equal(client.release('v0.1.1').id, 2);
  assert.ok(calls[1].includes('--paginate'));
  assert.ok(calls[1].includes('--slurp'));
  const forbidden = createGitHubClient({ run: () => {
    const error = new Error('forbidden'); error.stderr = Buffer.from('gh: Forbidden (HTTP 403)'); throw error;
  } });
  assert.throws(() => forbidden.release('v0.1.1'), /forbidden/);
});

test('上传全部附件并核对远程内容后才公开，已公开版本重试失败', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  publishRelease({ directory: input.outputDir, version: input.version, github });
  assert.equal(state.publications, 1);
  assert.equal(state.latest.tag_name, 'v0.1.1');
  assert.equal(state.draft.target_commitish, 'main');
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, github }), /禁止覆盖/);
});

test('上传失败保留草稿和上一 latest，可清除多余附件后重试', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  state.failUpload = true;
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, github }), /网络上传失败/);
  assert.equal(state.draft.draft, true);
  assert.equal(state.latest.tag_name, 'v0.1.0');
  state.packages.set('obsolete.txt', Buffer.from('old draft'));
  state.draft.assets.push({ id: 99, name: 'obsolete.txt' });
  state.failUpload = false;
  publishRelease({ directory: input.outputDir, version: input.version, github });
  assert.equal(state.packages.has('obsolete.txt'), false);
  assert.equal(state.publications, 1);
});

test('远程内容损坏不公开，上传过程中更高版本发布时也不回退 latest', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  state.corruptDownload = true;
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, github }), /内容校验失败/);
  assert.equal(state.publications, 0);
  state.corruptDownload = false;
  const download = github.download;
  github.download = (...args) => { download(...args); state.latest = { tag_name: 'v0.2.0' }; };
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, github }), /必须高于/);
  assert.equal(state.publications, 0);
});

test('发布仓库不是指定公开仓库时不创建 Release', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  github.repository = () => ({ full_name: RELEASE_REPOSITORY, private: true, default_branch: 'main' });
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, github }), /公开仓库/);
  assert.equal(state.draft, null);
});
