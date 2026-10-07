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
import { gitlabReleaseConfig, prepareUpdaterConfig } from './gitlab-release-config.mjs';
import { createGitLabClient, publishGitLabRelease } from './publish-gitlab-release.mjs';
import { releaseNotesForVersion, validateReleaseNotes } from './release-notes.mjs';

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

test('GitLab 构建配置使用固定清单地址且只注入公开地址', () => {
  assert.equal(gitlabReleaseConfig({}), null);
  const env = { GITLAB_RELEASE_PROJECT_ID: '42', GITLAB_RELEASE_TOKEN: 'should-never-be-in-client' };
  const config = gitlabReleaseConfig(env);
  assert.equal(config.latestUrl, 'https://git.gsdzone.net/api/v4/projects/42/repository/files/latest.json/raw?ref=main');
  const updater = prepareUpdaterConfig(env);
  assert.equal(updater.plugins.updater.endpoints.length, 2);
  assert.equal(updater.plugins.updater.endpoints[0], 'https://github.com/chenqinru/VersionDockDesktop/releases/latest/download/latest.json');
  assert.equal(updater.plugins.updater.endpoints[1], config.latestUrl);
  assert.ok(!JSON.stringify(updater).includes(env.GITLAB_RELEASE_TOKEN));
  assert.throws(() => gitlabReleaseConfig({ GITLAB_RELEASE_PROJECT_ID: 'abc' }), /数字项目/);
  assert.throws(() => gitlabReleaseConfig({ ...env, GITLAB_RELEASE_URL: 'https://token@git.gsdzone.net' }), /不含凭据/);
});

async function gitlabServer(t, corrupt = false) {
  const state = { packages: new Map(), latest: null, commits: 0, uploads: 0, authenticatedReads: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const packageRequest = url.pathname.includes('/packages/generic/');
    const raw = url.pathname.endsWith('/raw');
    const authorized = req.headers['private-token'] === 'pipeline-only-token';
    if ((req.method !== 'GET' || !packageRequest && !raw) && !authorized) {
      res.writeHead(401).end(); return;
    }
    if (req.method === 'GET' && (packageRequest || raw) && authorized) state.authenticatedReads++;
    if (packageRequest) {
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        state.packages.set(url.pathname, Buffer.concat(chunks)); state.uploads++;
        res.writeHead(201).end('{}');
      } else {
        const data = state.packages.get(url.pathname);
        res.writeHead(data ? 200 : 404).end(data ? corrupt ? 'broken' : data : '');
      }
    } else if (req.method === 'GET') {
      if (!state.latest) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(raw ? state.latest : JSON.stringify({
        content: Buffer.from(state.latest).toString('base64'), last_commit_id: String(state.commits),
      }));
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      if (state.latest && input.last_commit_id !== String(state.commits)) { res.writeHead(400).end(); return; }
      state.latest = input.content; state.commits++;
      res.writeHead(201).end('{}');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const api = `http://127.0.0.1:${server.address().port}/api/v4/projects/42`;
  const config = { api, branch: 'main', manifestFile: `${api}/repository/files/latest.json`,
    latestUrl: `${api}/repository/files/latest.json/raw?ref=main`,
    packageUrl: (version, name) => `${api}/packages/generic/versiondock-desktop/${version}/${name}` };
  return { state, config, client: createGitLabClient({ config, token: 'pipeline-only-token', sleep: async () => {} }) };
}

test('真实 HTTP 上传签名附件，匿名校验完成后提交固定清单，重跑不重复上传', async (t) => {
  const input = fixture(); prepareRelease(input);
  const { state, config, client } = await gitlabServer(t);
  const result = await publishGitLabRelease({ directory: input.outputDir, version: input.version, pubkey: input.pubkey, config, client });
  assert.equal(result.notes, JSON.parse(fs.readFileSync(path.join(input.outputDir, 'assets/latest.json'), 'utf8')).notes);
  assert.equal(state.packages.size, 6); assert.equal(state.commits, 1); assert.equal(state.authenticatedReads, 0);
  assert.ok(Object.values(result.platforms).every(({ url }) => url.includes('/packages/generic/')));
  assert.ok(!state.latest.includes('pipeline-only-token'));
  const githubManifestFile = path.join(input.outputDir, 'assets', 'latest.json');
  const regenerated = JSON.parse(fs.readFileSync(githubManifestFile));
  regenerated.pub_date = '2026-10-07T00:00:00Z';
  fs.writeFileSync(githubManifestFile, JSON.stringify(regenerated));
  await publishGitLabRelease({ directory: input.outputDir, version: input.version, pubkey: input.pubkey, config, client });
  assert.equal(state.uploads, 6); assert.equal(state.commits, 1);
  assert.equal(JSON.parse(state.latest).pub_date, result.pub_date);
  state.latest = JSON.stringify({ version: '9.0.0' });
  await assert.rejects(publishGitLabRelease({ directory: input.outputDir, version: input.version, pubkey: input.pubkey, config, client }), /回退/);
});

test('远程安装包损坏时停止发布且不修改 latest.json', async (t) => {
  const input = fixture(); prepareRelease(input);
  const { state, config, client } = await gitlabServer(t, true);
  await assert.rejects(publishGitLabRelease({ directory: input.outputDir, version: input.version, pubkey: input.pubkey, config, client }), /SHA-256/);
  assert.equal(state.commits, 0); assert.equal(state.latest, null);
});

test('GitLab 服务端 503 最多重试三次，匿名请求不附带凭据', async () => {
  let calls = 0;
  const waits = [];
  const config = gitlabReleaseConfig({ GITLAB_RELEASE_PROJECT_ID: '42' });
  const client = createGitLabClient({ config, token: 'secret', sleep: async (delay) => waits.push(delay),
    request: async (_url, options) => {
      assert.deepEqual(options.headers, {});
      calls++; return new Response('', { status: calls < 3 ? 503 : 404 });
    } });
  assert.equal(await client.hash(config.packageUrl('0.1.1', 'file.exe')), null);
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
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
