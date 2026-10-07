import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RELEASE_REPOSITORY, compareVersions, fileHash, prepareRelease, stageArtifacts, validateVersion } from './release-artifacts.mjs';
import { assertPublishable, createGitHubClient, publishRelease } from './publish-release.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { gitcodeReleaseConfig, prepareUpdaterConfig } from './gitcode-release-config.mjs';
import { createGitCodeClient, publishGitCodeRelease } from './publish-gitcode-release.mjs';
import { releaseNotesForVersion, validateReleaseNotes } from './release-notes.mjs';

test('GitCode 构建配置只注入公开清单，拒绝 URL、凭据及无效分支', () => {
  assert.equal(gitcodeReleaseConfig({}), null);
  const env = { GITCODE_RELEASE_REPOSITORY: 'chenqinru/VersionDockDesktop-Releases', GITCODE_RELEASE_TOKEN: 'client-must-not-contain-this' };
  const config = gitcodeReleaseConfig(env);
  assert.equal(config.latestUrl, 'https://api.gitcode.com/api/v5/repos/chenqinru/VersionDockDesktop-Releases/raw/latest.json?ref=main');
  assert.equal(config.packageUrl('0.1.1', 'app.tar.gz'), 'https://gitcode.com/chenqinru/VersionDockDesktop-Releases/releases/download/v0.1.1/app.tar.gz');
  const updater = prepareUpdaterConfig(env);
  assert.deepEqual(updater.plugins.updater.endpoints, ['https://github.com/chenqinru/VersionDockDesktop/releases/latest/download/latest.json', config.latestUrl]);
  assert.ok(!JSON.stringify(updater).includes(env.GITCODE_RELEASE_TOKEN));
  for (const repository of ['https://gitcode.com/a/b', 'token@a/b', 'a/b/c', 'a/..', 'a/b?access_token=secret']) {
    assert.throws(() => gitcodeReleaseConfig({ GITCODE_RELEASE_REPOSITORY: repository }), /owner\/repo/);
  }
  assert.throws(() => gitcodeReleaseConfig({ ...env, GITCODE_RELEASE_BRANCH: '../main' }), /分支/);
});

async function gitcodeServer(t, options = {}) {
  const state = { releases: new Map(), packages: new Map(), uploadedNames: [], latest: null, commits: 0, uploads: 0,
    uploadAttempts: 0, uploadUrls: 0, privateDownloads: 0, creations: 0, publications: 0, ...options };
  const digest = () => createHash('sha1').update(state.latest || '').digest('hex');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const api = url.pathname.includes('/api/v5/');
      const authorized = req.headers['private-token'] === 'pipeline-only-token';
      if (api && !url.pathname.includes('/raw/') && !authorized) { res.writeHead(401).end(); return; }
      const respond = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      const body = async () => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); };
      if (url.pathname.includes('/releases/download/')) {
        if (authorized) state.privateDownloads++;
        const name = decodeURIComponent(url.pathname.split('/').pop());
        const data = state.packages.get(name);
        res.writeHead(data ? 200 : 404).end(data ? state.corrupt && !name.endsWith('.json') ? 'broken' : data : '');
      } else if (url.pathname.startsWith('/upload/')) {
        assert.equal(authorized, false);
        assert.equal(req.headers.expect, undefined);
        assert.equal(req.headers['x-obs-callback'], 'fixture-callback');
        state.uploadAttempts++;
        if (state.failUploads && state.uploadAttempts <= state.failUploads) { await body(); respond({}, 503); return; }
        const name = decodeURIComponent(url.pathname.split('/').pop());
        const content = await body();
        assert.equal(Number(req.headers['content-length']), content.length);
        if (state.uploadStatus) { respond({}, state.uploadStatus); return; }
        state.packages.set(name, content); state.uploads++; state.uploadedNames.push(name);
        const release = [...state.releases.values()][0];
        release.assets.push({ name, type: 'attach' });
        if (state.onUpload) state.onUpload(name);
        if (state.loseUploadResponse && state.uploads === 1) res.destroy(); else respond({});
      } else if (url.pathname.includes('/upload_url')) {
        state.uploadUrls++;
        respond({ url: state.uploadTarget || `${base}/upload/${encodeURIComponent(url.searchParams.get('file_name'))}`, headers: state.uploadHeaders || { 'Content-Type': 'application/octet-stream', 'x-obs-callback': 'fixture-callback' } });
      } else if (url.pathname.endsWith('/branches/main')) {
        respond({ name: 'main' });
      } else if (url.pathname.includes('/contents/') || url.pathname.includes('/raw/')) {
        const raw = url.pathname.includes('/raw/');
        if (raw && authorized) state.privateDownloads++;
        if (req.method === 'GET') {
          if (!state.latest) respond({}, 404);
          else if (raw) res.writeHead(200).end(state.latest);
          else respond({ encoding: 'base64', content: Buffer.from(state.latest).toString('base64'), sha: digest() });
        } else {
          const input = JSON.parse(await body());
          if (state.rejectCommit) { respond({}, 403); return; }
          if (state.changeBeforeCommit) state.latest = JSON.stringify({ version: '9.0.0' });
          if (state.latest && input.sha !== digest() || !state.latest && input.sha) { respond({}, 409); return; }
          state.latest = Buffer.from(input.content, 'base64').toString(); state.commits++;
          if (state.loseCommitResponse) res.destroy(); else respond({});
        }
      } else if (url.pathname.endsWith('/releases') && req.method === 'POST') {
        const input = JSON.parse(await body()); state.creations++;
        state.releases.set(input.tag_name, { ...input, prerelease: true, assets: [] });
        if (state.loseCreateResponse) res.destroy(); else respond(input);
      } else if (req.method === 'PATCH') {
        const current = state.releases.get(url.pathname.split('/').pop());
        Object.assign(current, JSON.parse(await body()), { prerelease: false }); state.publications++;
        if (state.losePublishResponse) res.destroy(); else respond(current);
      } else {
        const current = state.releases.get(url.pathname.split('/').pop());
        respond(current || {}, current ? 200 : 404);
      }
    } catch (error) { res.writeHead(500).end(); state.serverError = error; }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); assert.equal(state.serverError, undefined); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = `${base}/api/v5/repos/owner/mirror`;
  const config = { api, branch: 'main', manifestFile: `${api}/contents/latest.json`, latestUrl: `${api}/raw/latest.json?ref=main`,
    releaseUrl: (version) => `${api}/releases/tags/v${version}`,
    packageUrl: (version, name) => `${base}/owner/mirror/releases/download/v${version}/${encodeURIComponent(name)}` };
  return { state, config, client: createGitCodeClient({ config, token: 'pipeline-only-token', sleep: async () => {}, log: () => {} }) };
}

const publishMirror = (input, server) => publishGitCodeRelease({ directory: input.outputDir, version: input.version, pubkey: input.pubkey, config: server.config, client: server.client });

test('GitCode 真实 HTTP 上传签名附件、匿名校验后更新清单，重跑不重复上传', async (t) => {
  const input = fixture(); prepareRelease(input);
  const server = await gitcodeServer(t);
  const original = fs.readFileSync(path.join(input.outputDir, 'assets/latest.json'), 'utf8');
  const manifest = await publishMirror(input, server);
  assert.equal(server.state.uploads, 7); assert.equal(server.state.commits, 1); assert.equal(server.state.privateDownloads, 0);
  assert.ok(server.state.uploadedNames[0].endsWith('.sig'));
  assert.ok(Object.values(manifest.platforms).every(({ url }) => url.includes('/releases/download/v0.1.1/')));
  assert.equal(fs.readFileSync(path.join(input.outputDir, 'assets/latest.json'), 'utf8'), original);
  assert.equal(JSON.parse(server.state.latest).version, input.version);
  const regenerated = JSON.parse(original); regenerated.pub_date = '2026-10-07T00:00:00Z';
  fs.writeFileSync(path.join(input.outputDir, 'assets/latest.json'), JSON.stringify(regenerated));
  await publishMirror(input, server);
  assert.equal(server.state.uploads, 7); assert.equal(server.state.commits, 1); assert.equal(server.state.creations, 1);
  assert.equal(JSON.parse(server.state.latest).pub_date, manifest.pub_date);
  server.state.latest = JSON.stringify({ version: '9.0.0' });
  await assert.rejects(publishMirror(input, server), /回退/);
});

test('GitCode 安装包损坏或已有同名不同内容时不提交更新清单', async (t) => {
  for (const corrupt of [true, false]) {
    const input = fixture(); prepareRelease(input);
    const server = await gitcodeServer(t, { corrupt });
    if (!corrupt) server.state.packages.set('VersionDock.Desktop.app.tar.gz', Buffer.from('wrong-existing-package'));
    await assert.rejects(publishMirror(input, server), /SHA-256|同版本附件/);
    assert.equal(server.state.commits, 0); assert.equal(server.state.latest, null); assert.equal(server.state.publications, 0);
  }
});

test('GitCode 创建、上传、公开及提交响应丢失时读取实际结果，避免重复写入', async (t) => {
  const input = fixture(); prepareRelease(input);
  const server = await gitcodeServer(t, { loseCreateResponse: true, loseUploadResponse: true, losePublishResponse: true, loseCommitResponse: true });
  await publishMirror(input, server);
  assert.equal(server.state.creations, 1); assert.equal(server.state.uploadAttempts, 7);
  assert.equal(server.state.publications, 1); assert.equal(server.state.commits, 1);
});

test('GitCode 版本附件已齐全但清单提交失败，重跑恢复原发布时间', async (t) => {
  const input = fixture(); prepareRelease(input);
  const server = await gitcodeServer(t, { rejectCommit: true });
  await assert.rejects(publishMirror(input, server), /403/);
  const original = JSON.parse(server.state.packages.get('latest.json'));
  const file = path.join(input.outputDir, 'assets/latest.json');
  const regenerated = JSON.parse(fs.readFileSync(file)); regenerated.pub_date = '2026-10-08T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify(regenerated)); server.state.rejectCommit = false;
  await publishMirror(input, server);
  assert.equal(server.state.uploads, 7); assert.equal(JSON.parse(server.state.latest).pub_date, original.pub_date);
});

test('GitCode 已正式发布版本缺失附件时拒绝修改，不能补传改变历史版本', async (t) => {
  const input = fixture(); prepareRelease(input);
  const server = await gitcodeServer(t);
  await publishMirror(input, server);
  server.state.releases.get('v0.1.1').assets.pop();
  await assert.rejects(publishMirror(input, server), /正式发布版本的附件列表/);
  assert.equal(server.state.uploads, 7); assert.equal(server.state.commits, 1);
});

test('GitCode 并发修改通过 Blob SHA 拒绝覆盖，上传期间新版本也不能回退', async (t) => {
  const input = fixture(); prepareRelease(input);
  const server = await gitcodeServer(t, { latest: JSON.stringify({ version: '0.1.0' }), changeBeforeCommit: true });
  await assert.rejects(publishMirror(input, server), /409/);
  assert.equal(server.state.commits, 0); assert.equal(JSON.parse(server.state.latest).version, '9.0.0');
  const second = await gitcodeServer(t);
  second.state.onUpload = () => { second.state.latest = JSON.stringify({ version: '9.0.0' }); };
  await assert.rejects(publishMirror(input, second), /上传期间已有更新版本/);
  assert.equal(second.state.publications, 0);
});

test('GitCode 上传 503 重试前重新检查远程文件并申请新的上传地址', async (t) => {
  const input = fixture(); prepareRelease(input);
  const server = await gitcodeServer(t, { failUploads: 2 });
  await publishMirror(input, server);
  assert.equal(server.state.uploads, 7); assert.equal(server.state.uploadAttempts, 9); assert.equal(server.state.uploadUrls, 9);
});

test('GitCode 匿名读取 503 重试三次，权限错误不重试，API 重定向不转发令牌', async () => {
  const config = gitcodeReleaseConfig({ GITCODE_RELEASE_REPOSITORY: 'owner/mirror' });
  let calls = 0; const waits = [];
  const client = createGitCodeClient({ config, token: 'secret', sleep: async (delay) => waits.push(delay),
    request: async (_url, options) => {
      assert.deepEqual(options.headers, {}); calls++;
      return new Response('', { status: calls < 3 ? 503 : 404 });
    } });
  assert.equal(await client.hash(config.packageUrl('0.1.1', 'file.exe')), null);
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
  for (const status of [401, 403, 307]) {
    let attempts = 0;
    const forbidden = createGitCodeClient({ config, token: 'secret', sleep: async () => {}, request: async (_url, options) => {
      assert.equal(options.redirect, 'error'); assert.equal(options.headers['PRIVATE-TOKEN'], 'secret'); attempts++;
      return new Response('', { status });
    } });
    await assert.rejects(forbidden.latest(), new RegExp(String(status)));
    assert.equal(attempts, 1);
  }
});

test('GitCode 拒绝非可信存储地址和把发布令牌带到存储的上传配置', async (t) => {
  for (const options of [{ uploadTarget: 'https://evil.example/upload' }, { uploadHeaders: { Authorization: 'pipeline-only-token' } },
    { uploadHeaders: { 'x-obs-callback': 'fixture-callback\nurl = "https://evil.example"' } }]) {
    const input = fixture(); prepareRelease(input);
    const server = await gitcodeServer(t, options);
    await assert.rejects(publishMirror(input, server), /上传地址|上传头|控制字符/);
    assert.equal(server.state.uploadAttempts, 0); assert.equal(server.state.commits, 0);
  }
});

test('GitCode curl 上传真实大文件，保留签名请求头、字节长度和全部内容', async (t) => {
  const server = await gitcodeServer(t);
  await server.client.ensureRelease('0.1.1', 'test upload');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-upload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'payload.exe');
  const content = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < content.length; i++) content[i] = i % 256;
  fs.writeFileSync(file, content);
  await server.client.upload('0.1.1', 'payload.exe', file);
  assert.deepEqual(server.state.packages.get('payload.exe'), content);
  assert.equal(server.state.uploadAttempts, 1);
});

test('GitCode 上传权限和重定向失败不重试，诊断不暴露签名地址', async (t) => {
  for (const uploadStatus of [403, 307]) {
    const input = fixture(); prepareRelease(input);
    const server = await gitcodeServer(t, { uploadStatus });
    const origin = new URL(server.config.api).origin;
    server.state.uploadTarget = `${origin}/upload/file.exe?signature=private-upload-signature`;
    await assert.rejects(publishMirror(input, server), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${uploadStatus}.*curl 0`));
      assert.match(error.message, /VersionDock.*bytes.*127\.0\.0\.1/);
      assert.match(error.message, /已发送 \d+\/\d+ bytes，已接收 \d+ bytes/);
      assert.ok(!String(error.stack).includes('private-upload-signature'));
      assert.ok(!String(error.stack).includes('pipeline-only-token'));
      return true;
    });
    assert.equal(server.state.uploadAttempts, 1); assert.equal(server.state.commits, 0);
  }
});

test('GitCode fetch 诊断保留底层错误码与超时类别，丢弃原始敏感错误', async () => {
  const config = gitcodeReleaseConfig({ GITCODE_RELEASE_REPOSITORY: 'owner/mirror' });
  for (const cause of [Object.assign(new Error('https://storage?signature=private-signature'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    Object.assign(new Error('sensitive request details'), { name: 'TimeoutError' })]) {
    let attempts = 0;
    const client = createGitCodeClient({ config, token: 'secret-token', sleep: async () => {}, request: async () => {
      attempts++; throw new TypeError('request contains secret-token', { cause });
    } });
    await assert.rejects(client.latest(), (error) => {
      assert.match(error.message, /GET api\.gitcode\.com/);
      assert.ok(error.message.includes(cause.code || 'REQUEST_TIMEOUT'));
      assert.doesNotMatch(String(error.stack), /private-signature|secret-token|sensitive request/);
      return true;
    });
    assert.equal(attempts, 3);
  }
});

test('发布说明匹配指定版本，不借用其他版本内容', () => {
  const records = [
    { version: '0.1.2', date: '2026-10-07', highlights: { 'zh-CN': ['修复 SVN 中文路径'], en: ['Fix SVN Unicode paths'] } },
    { version: '0.1.1', date: '2026-10-06', highlights: { 'zh-CN': ['提供签名更新'], en: ['Provide signed updates'] } },
  ];
  assert.equal(releaseNotesForVersion('0.1.1', records), 'VersionDock Desktop v0.1.1\n\n- 提供签名更新');
  assert.match(releaseNotesForVersion('0.1.2', records), /修复 SVN 中文路径/);
  assert.throws(() => releaseNotesForVersion('0.1.3', records), /缺少 v0.1.3/);
});

test('公开更新记录拒绝重复版本、无效日期和缺少翻译的内容', () => {
  const entry = { version: '0.1.1', date: '2026-10-06', highlights: { 'zh-CN': ['修复检出'], en: ['Fix checkout'] } };
  assert.throws(() => validateReleaseNotes([entry, entry]), /版本重复/);
  assert.throws(() => validateReleaseNotes([{ ...entry, date: '2026-02-30' }]), /日期无效/);
  assert.throws(() => validateReleaseNotes([{ ...entry, highlights: { 'zh-CN': ['修复检出'] } }]), /en/);
  assert.throws(() => validateReleaseNotes([{ ...entry, highlights: { ...entry.highlights, en: [' '] } }]), /en/);
});

test('清单与公开 Release 共用版本更新内容，缺失说明时不准备发布产物', () => {
  const input = fixture();
  const releaseNotes = [{ version: input.version, date: '2026-10-06',
    highlights: { 'zh-CN': ['修复真实检出问题', '优化更新重试'], en: ['Fix checkout', 'Improve update retries'] } }];
  const manifest = prepareRelease({ ...input, releaseNotes });
  assert.match(manifest.notes, /修复真实检出问题/);
  assert.doesNotMatch(manifest.notes, /请根据操作系统选择安装包/);
  assert.equal(fs.readFileSync(path.join(input.outputDir, 'release-notes.md'), 'utf8').trim(), manifest.notes);
  const { state, github } = githubFixture();
  publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github });
  assert.equal(state.draft.body.trim(), manifest.notes);
  const missing = fixture();
  assert.throws(() => prepareRelease({ ...missing, releaseNotes: [{ ...releaseNotes[0], version: '0.1.2' }] }), /缺少/);
  assert.equal(fs.existsSync(missing.outputDir), false);
});

const SOURCE_SHA = 'a'.repeat(40);
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
    tagCommit: () => SOURCE_SHA,
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
    assert.ok(update.url.startsWith('https://github.com/chenqinru/VersionDockDesktop/releases/download/v0.1.1/'));
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

test('产物完整性错误明确输出大小和期望实际哈希，空文件仍拒绝发布', () => {
  const corrupted = fixture();
  const directory = path.join(corrupted.artifactsDir, 'release-macos');
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'release-artifact.json')));
  const entry = metadata.files[0]; const file = path.join(directory, entry.name);
  fs.writeFileSync(file, 'partial dmg');
  assert.throws(() => prepareRelease(corrupted), (error) => {
    assert.ok(error.message.includes(entry.sha256));
    assert.ok(error.message.includes(fileHash(file)));
    assert.ok(error.message.includes('大小 11 字节')); return true;
  });
  fs.writeFileSync(file, '');
  assert.throws(() => prepareRelease(corrupted), /大小 0 字节.*<empty>/);
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
    if (args.includes('--slurp')) throw new Error('unknown flag: --slurp');
    if (args[1].includes('/tags/')) {
      const error = new Error('not found');
      error.stderr = Buffer.from('gh: Not Found (HTTP 404)');
      throw error;
    }
    if (args[1].endsWith('&page=1')) return JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, tag_name: `v1.0.${id}`, draft: false })));
    if (args[1].endsWith('&page=2')) return JSON.stringify([{ id: 102, tag_name: 'v0.1.1', draft: true }]);
    throw new Error('unexpected API request');
  } });
  assert.equal(client.release('v0.1.1').id, 102);
  assert.equal(calls.length, 3);
  assert.ok(calls[1][1].endsWith('&page=1'));
  assert.ok(calls[2][1].endsWith('&page=2'));
  assert.ok(calls.every((args) => !args.includes('--paginate') && !args.includes('--slurp')));
  const forbidden = createGitHubClient({ run: () => {
    const error = new Error('forbidden'); error.stderr = Buffer.from('gh: Forbidden (HTTP 403)'); throw error;
  } });
  assert.throws(() => forbidden.release('v0.1.1'), /forbidden/);
});

test('Release 列表分页读到末页才认定不存在，异常响应和分页权限错误保留失败', () => {
  const client = createGitHubClient({ run: (_command, args) => {
    if (args[1].includes('/tags/')) {
      const error = new Error('not found'); error.stderr = Buffer.from('gh: Not Found (HTTP 404)'); throw error;
    }
    return args[1].endsWith('&page=1') ? JSON.stringify(Array.from({ length: 100 }, () => ({ tag_name: 'v0.0.1' }))) : '[]';
  } });
  assert.equal(client.release('v0.1.1'), null);
  for (const invalid of ['malformed', 'forbidden']) {
    const broken = createGitHubClient({ run: (_command, args) => {
      if (args[1].includes('/tags/')) {
        const error = new Error('not found'); error.stderr = Buffer.from('gh: Not Found (HTTP 404)'); throw error;
      }
      if (invalid === 'malformed') return '{}';
      throw new Error('HTTP 403');
    } });
    assert.throws(() => broken.release('v0.1.1'), invalid === 'malformed' ? /响应格式/ : /HTTP 403/);
  }
});

test('标签接口已返回 Release 时不额外遍历列表', () => {
  let calls = 0;
  const client = createGitHubClient({ run: (_command, args) => {
    calls++;
    assert.ok(args[1].endsWith('/tags/v0.1.1'));
    return JSON.stringify({ id: 7, tag_name: 'v0.1.1' });
  } });
  assert.equal(client.release('v0.1.1').id, 7);
  assert.equal(calls, 1);
});

function ghTransferFixture({ onUpload, onDownload } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-gh-transfer-'));
  temporaryDirectories.push(root);
  const local = path.join(root, 'latest.json'); fs.writeFileSync(local, '{"version":"0.1.7"}');
  const state = { draft: { id: 12, tag_name: 'v0.1.7', draft: true, assets: [] }, uploads: 0, deletes: 0, downloads: 0, waits: [], bytes: fs.readFileSync(local) };
  const saveComplete = () => {
    state.draft.assets = [{ id: 99, name: 'latest.json', state: 'uploaded', size: state.bytes.length, digest: `sha256:${fileHash(local)}` }];
  };
  const client = createGitHubClient({
    environment: { GODEBUG: 'gctrace=1,http2client=1', https_proxy: 'http://127.0.0.1:7897' },
    sleep: (milliseconds) => state.waits.push(milliseconds),
    run: (_command, args, options) => {
      assert.equal(options.env.GODEBUG, 'gctrace=1,http2client=0');
      assert.equal(options.env.https_proxy, 'http://127.0.0.1:7897');
      if (args[1].startsWith('https://uploads.github.com/')) {
        state.uploads++;
        assert.equal(args.at(-1), local);
        if (onUpload) return onUpload(state, saveComplete);
        saveComplete(); return '{}';
      }
      if (args.includes('DELETE')) {
        state.deletes++; state.draft.assets = []; return '';
      }
      if (args.includes('Accept: application/octet-stream')) {
        state.downloads++;
        if (onDownload) return onDownload(state, options.stdio[1]);
        fs.writeSync(options.stdio[1], state.bytes); return '';
      }
      assert.ok(args[1].endsWith('/releases/12'));
      return JSON.stringify(state.draft);
    },
  });
  const destination = path.join(root, 'downloads'); fs.mkdirSync(destination);
  return { local, destination, state, client, saveComplete };
}

function refusedStream() {
  const error = new Error('http2: Transport: cannot retry after Request.Body was written');
  error.stderr = Buffer.from('stream error: stream ID 1; REFUSED_STREAM; received from peer');
  return error;
}

test('HTTP/2 上传失败时清理残留草稿附件并打开新请求体重试，远程哈希仍可校验', () => {
  const fixture = ghTransferFixture({ onUpload: (state, save) => {
    if (state.uploads === 1) {
      state.draft.assets = [{ id: 88, name: 'latest.json', state: 'starter', size: 0 }]; throw refusedStream();
    }
    save(); return '{}';
  } });
  fixture.client.upload(fixture.state.draft, [fixture.local]);
  assert.equal(fixture.state.uploads, 2); assert.equal(fixture.state.deletes, 1);
  assert.deepEqual(fixture.state.waits, [1000]);
  fixture.client.download(fixture.state.draft, fixture.destination);
  assert.equal(fileHash(path.join(fixture.destination, 'latest.json')), fileHash(fixture.local));
});

test('已完整上传或上传成功后响应丢失时按 GitHub digest 复用，不重复上传', () => {
  const cached = ghTransferFixture(); cached.saveComplete();
  cached.client.upload(cached.state.draft, [cached.local]);
  assert.equal(cached.state.uploads, 0); assert.equal(cached.state.deletes, 0);
  const lostResponse = ghTransferFixture({ onUpload: (_state, save) => { save(); throw refusedStream(); } });
  lostResponse.client.upload(lostResponse.state.draft, [lostResponse.local]);
  assert.equal(lostResponse.state.uploads, 1); assert.equal(lostResponse.state.deletes, 0);
  assert.deepEqual(lostResponse.state.waits, []);
});

test('上传最后一次响应丢失仍确认远程结果，持续失败只尝试三次', () => {
  const recovered = ghTransferFixture({ onUpload: (state, save) => {
    if (state.uploads === 3) save(); throw refusedStream();
  } });
  recovered.client.upload(recovered.state.draft, [recovered.local]);
  assert.equal(recovered.state.uploads, 3);
  const failed = ghTransferFixture({ onUpload: () => { throw refusedStream(); } });
  assert.throws(() => failed.client.upload(failed.state.draft, [failed.local]), /cannot retry/);
  assert.equal(failed.state.uploads, 3); assert.deepEqual(failed.state.waits, [1000, 2000]);
});

test('草稿同名文件缺少或不匹配 digest 时重传，避免只按文件大小认定一致', () => {
  for (const digest of [undefined, `sha256:${'0'.repeat(64)}`]) {
    const fixture = ghTransferFixture(); fixture.saveComplete(); fixture.state.draft.assets[0].digest = digest;
    fixture.client.upload(fixture.state.draft, [fixture.local]);
    assert.equal(fixture.state.uploads, 1); assert.equal(fixture.state.deletes, 1);
  }
});

test('上传中草稿变为公开或权限失败时停止，不删除附件或继续网络重试', () => {
  const published = ghTransferFixture({ onUpload: (state) => { state.draft.draft = false; throw refusedStream(); } });
  assert.throws(() => published.client.upload(published.state.draft, [published.local]), /禁止修改已公开/);
  assert.equal(published.state.uploads, 1); assert.equal(published.state.deletes, 0);
  assert.deepEqual(published.state.waits, []);
  const forbidden = ghTransferFixture({ onUpload: () => {
    const error = new Error('forbidden'); error.stderr = Buffer.from('gh: Forbidden (HTTP 403)'); throw error;
  } });
  assert.throws(() => forbidden.client.upload(forbidden.state.draft, [forbidden.local]), /forbidden/);
  assert.equal(forbidden.state.uploads, 1); assert.deepEqual(forbidden.state.waits, []);
});

test('远程附件下载中断后清除部分文件并从头重试，不拼接残留内容', () => {
  const fixture = ghTransferFixture({ onDownload: (state, descriptor) => {
    if (state.downloads === 1) { fs.writeSync(descriptor, 'partial'); throw refusedStream(); }
    fs.writeSync(descriptor, state.bytes); return '';
  } });
  fixture.saveComplete(); fixture.client.download(fixture.state.draft, fixture.destination);
  assert.equal(fixture.state.downloads, 2); assert.deepEqual(fixture.state.waits, [1000]);
  assert.equal(fileHash(path.join(fixture.destination, 'latest.json')), fileHash(fixture.local));
});

test('API 读取可以重试 503，创建或公开 Release 的写请求不盲目重试', () => {
  for (const method of ['GET', 'POST', 'PATCH']) {
    let calls = 0; const waits = [];
    const client = createGitHubClient({ sleep: (ms) => waits.push(ms), run: () => {
      calls++; const error = new Error('service unavailable'); error.stderr = Buffer.from('gh: HTTP 503 (HTTP 503)'); throw error;
    } });
    assert.throws(() => method === 'GET' ? client.repository() : method === 'POST' ? client.create({}) : client.publish(12), /service unavailable/);
    assert.equal(calls, method === 'GET' ? 3 : 1);
    assert.deepEqual(waits, method === 'GET' ? [1000, 2000] : []);
  }
});

test('上传全部附件并核对远程内容后才公开，已公开版本重试失败', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github });
  assert.equal(state.publications, 1);
  assert.equal(state.latest.tag_name, 'v0.1.1');
  assert.equal(state.draft.target_commitish, SOURCE_SHA);
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /禁止覆盖/);
});

test('上传失败保留草稿和上一 latest，可清除多余附件后重试', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  state.failUpload = true;
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /网络上传失败/);
  assert.equal(state.draft.draft, true);
  assert.equal(state.latest.tag_name, 'v0.1.0');
  state.packages.set('obsolete.txt', Buffer.from('old draft'));
  state.draft.assets.push({ id: 99, name: 'obsolete.txt' });
  state.failUpload = false;
  publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github });
  assert.equal(state.packages.has('obsolete.txt'), false);
  assert.equal(state.publications, 1);
});

test('远程内容损坏不公开，上传过程中更高版本发布时也不回退 latest', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  state.corruptDownload = true;
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /内容校验失败/);
  assert.equal(state.publications, 0);
  state.corruptDownload = false;
  const download = github.download;
  github.download = (...args) => { download(...args); state.latest = { tag_name: 'v0.2.0' }; };
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /必须高于/);
  assert.equal(state.publications, 0);
});

test('发布仓库不是指定公开仓库时不创建 Release', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  github.repository = () => ({ full_name: RELEASE_REPOSITORY, private: true, default_branch: 'main' });
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /公开仓库/);
  assert.equal(state.draft, null);
});

test('主仓库 Release 要求已有标签对应实际构建提交', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, github }), /源码提交 SHA/);
  github.tagCommit = () => 'b'.repeat(40);
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /标签.*不一致/);
  assert.equal(state.draft, null);
  github.tagCommit = () => { throw new Error('标签不存在'); };
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /标签不存在/);
  assert.equal(state.draft, null);
});

test('上传期间版本标签移动时停止公开草稿', () => {
  const input = fixture(); prepareRelease(input);
  const { state, github } = githubFixture();
  const download = github.download;
  github.download = (...args) => { download(...args); github.tagCommit = () => 'b'.repeat(40); };
  assert.throws(() => publishRelease({ directory: input.outputDir, version: input.version, sourceSha: SOURCE_SHA, github }), /标签.*不一致/);
  assert.equal(state.publications, 0);
  assert.equal(state.draft.draft, true);
});

test('GitHub 标签校验解析 lightweight 与 annotated 标签且不掩盖 404', () => {
  for (const annotated of [false, true]) {
    const calls = [];
    const client = createGitHubClient({ run: (_command, args) => {
      calls.push(args[1]);
      return JSON.stringify({ object: annotated && calls.length === 1
        ? { type: 'tag', sha: 'b'.repeat(40) } : { type: 'commit', sha: SOURCE_SHA } });
    } });
    assert.equal(client.tagCommit('v0.1.1'), SOURCE_SHA);
    assert.equal(calls[0], 'repos/chenqinru/VersionDockDesktop/git/ref/tags/v0.1.1');
    assert.equal(calls.length, annotated ? 2 : 1);
  }
  const client = createGitHubClient({ run: () => { throw new Error('HTTP 404'); } });
  assert.throws(() => client.tagCommit('v0.1.1'), /HTTP 404/);
});
