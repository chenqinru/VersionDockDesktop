import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findReusableCi, verifyReusableCi } from './reuse-release-ci.mjs';
import { downloadReleaseArtifact, downloadPlatformArtifacts } from './download-release-artifact.mjs';
import { mergeMacosBinaries, stageMacosBinary } from './macos-release-binaries.mjs';

const directories = [];
const temporary = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-pipeline-'));
  directories.push(directory); return directory;
};
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
const sha = 'a'.repeat(40);
const repository = 'chenqinru/VersionDockDesktop';
const now = new Date('2026-10-07T10:00:00Z');

function ciFixture() {
  const run = {
    id: 12, head_sha: sha, head_repository: { full_name: repository }, event: 'push', head_branch: 'main',
    path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', updated_at: '2026-10-07T09:00:00Z',
  };
  const jobs = ['Frontend checks', 'Rust checks', 'Quality gate', 'Test and bundle (Linux x64)', 'Test and bundle (Windows x64)', 'Test and bundle (macOS universal)']
    .map((name) => ({ name, status: 'completed', conclusion: 'success', completed_at: '2026-10-07T09:00:00Z' }));
  const api = (url) => url.includes('/workflows/') ? { workflow_runs: [run] } : url.includes('/jobs?') ? { jobs } : run;
  return { run, jobs, api, options: { repository, sha, now, api } };
}

test('Release 只复用同一提交上 main push 的近期成功 CI 及完整三平台检查', () => {
  const { options } = ciFixture();
  assert.equal(findReusableCi(options), '12');
  assert.equal(verifyReusableCi({ ...options, runId: 12 }), true);
  for (const changes of [
    { head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { event: 'pull_request' },
    { head_repository: { full_name: 'other/repo' } }, { path: '.github/workflows/other.yml' },
    { conclusion: 'failure' }, { status: 'in_progress' }, { updated_at: '2026-10-05T09:00:00Z' },
  ]) {
    const fixture = ciFixture(); Object.assign(fixture.run, changes);
    assert.equal(findReusableCi(fixture.options), '');
  }
  for (const conclusion of ['skipped', 'failure', 'cancelled']) {
    const fixture = ciFixture(); fixture.jobs[4].conclusion = conclusion;
    assert.equal(findReusableCi(fixture.options), '');
  }
  const staleAudit = ciFixture(); staleAudit.jobs[0].completed_at = '2026-10-05T09:00:00Z';
  assert.equal(findReusableCi(staleAudit.options), '');
});

test('Release 发布前重新验证复用 CI，重跑中或重复同名 job 不能通过', () => {
  const fixture = ciFixture();
  assert.equal(findReusableCi(fixture.options), '12');
  fixture.run.status = 'in_progress';
  assert.equal(verifyReusableCi({ ...fixture.options, runId: 12 }), false);
  fixture.run.status = 'completed'; fixture.jobs.push({ ...fixture.jobs[0] });
  assert.equal(verifyReusableCi({ ...fixture.options, runId: 12 }), false);
});

function archiveFixture(entries = { 'assets/latest.json': '{}', 'assets/app.exe': 'signed package', 'release-notes.md': 'notes' }) {
  const root = temporary();
  const archive = path.join(root, 'source.zip');
  execFileSync('python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.loads(sys.argv[2]).items()]; z.close()', archive, JSON.stringify(entries)]);
  const bytes = fs.readFileSync(archive);
  const artifact = { id: 100, name: `prepared-release-${sha}`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, expired: false, size_in_bytes: bytes.length };
  let downloads = 0;
  const options = {
    repository, runId: 42, name: artifact.name, artifactId: artifact.id, cacheDir: path.join(root, 'cache'), outputDir: path.join(root, 'prepared'),
    api: () => ({ artifacts: [artifact] }), download: (_url, file) => { downloads++; fs.copyFileSync(archive, file); }, sleep: async () => {},
  };
  return { root, options, artifact, getDownloads: () => downloads };
}

test('真正的 ZIP 下载以 artifact ID 和 GitHub digest 缓存，发布重试无需重新下载', async () => {
  const fixture = archiveFixture();
  const first = await downloadReleaseArtifact(fixture.options);
  assert.equal(first.cached, false); assert.equal(fixture.getDownloads(), 1);
  assert.equal(fs.readFileSync(path.join(fixture.options.outputDir, 'assets/app.exe'), 'utf8'), 'signed package');
  fs.rmSync(fixture.options.outputDir, { recursive: true });
  assert.equal((await downloadReleaseArtifact(fixture.options)).cached, true);
  assert.equal(fixture.getDownloads(), 1);
  const cache = fs.readdirSync(fixture.options.cacheDir)[0];
  const cached = path.join(fixture.options.cacheDir, cache, fs.readdirSync(path.join(fixture.options.cacheDir, cache))[0]);
  fs.writeFileSync(cached, 'corrupted');
  fs.rmSync(fixture.options.outputDir, { recursive: true });
  assert.equal((await downloadReleaseArtifact(fixture.options)).cached, false);
  assert.equal(fixture.getDownloads(), 2);
});

test('下载损坏重试三次但不写缓存，过期或 ID 不匹配在下载前拒绝', async () => {
  const fixture = archiveFixture();
  let downloads = 0;
  await assert.rejects(downloadReleaseArtifact({ ...fixture.options, download: (_url, file) => { downloads++; fs.writeFileSync(file, 'broken'); } }), /SHA-256/);
  assert.equal(downloads, 3); assert.equal(fs.existsSync(fixture.options.outputDir), false);
  fixture.artifact.expired = true;
  await assert.rejects(downloadReleaseArtifact(fixture.options), /expired/);
  fixture.artifact.expired = false;
  await assert.rejects(downloadReleaseArtifact({ ...fixture.options, artifactId: 101 }), /expired/);
  assert.equal(fixture.getDownloads(), 0);
});

test('缓存身份相同但 ZIP 含路径穿越或非预期文件时拒绝解压', async () => {
  for (const name of ['../outside', '/outside', 'assets/../../outside', 'other/file']) {
    const fixture = archiveFixture({ 'assets/latest.json': '{}', 'release-notes.md': 'notes', [name]: 'bad' });
    await assert.rejects(downloadReleaseArtifact(fixture.options));
    assert.equal(fs.existsSync(fixture.options.outputDir), false);
    assert.equal(fs.existsSync(path.join(fixture.root, 'outside')), false);
  }
});

test('平台安装包只在完整 ZIP digest 通过后解压，三平台身份及 metadata 必须齐全', async () => {
  const fixtures = ['macos', 'windows', 'linux'].map((platform, index) => {
    const name = platform === 'macos' ? 'VersionDock.Desktop_0.1.7_universal.dmg' : platform === 'windows' ? 'VersionDock.exe' : 'VersionDock.AppImage';
    const fixture = archiveFixture({ 'release-artifact.json': JSON.stringify({ platform, version: '0.1.7', files: [] }), [name]: 'complete payload' });
    fixture.artifact.id += index;
    fixture.artifact.name = `release-${platform}`;
    fixture.options.name = fixture.artifact.name;
    fixture.options.artifactId = fixture.artifact.id;
    return { fixture, platform, name };
  });
  const root = temporary();
  const artifacts = fixtures.map(({ fixture }) => fixture.artifact);
  const results = await downloadPlatformArtifacts({
    repository, runId: 42, outputDir: path.join(root, 'artifacts'), cacheDir: path.join(root, 'cache'),
    api: () => ({ artifacts }), sleep: async () => {},
    download: (url, file) => {
      const index = fixtures.findIndex(({ fixture }) => url.endsWith(`/${fixture.artifact.id}/zip`));
      assert.ok(index >= 0); fixtures[index].fixture.options.download(url, file);
    },
  });
  assert.equal(results.length, 3);
  for (const { platform, name } of fixtures) {
    assert.equal(fs.readFileSync(path.join(root, 'artifacts', `release-${platform}`, name), 'utf8'), 'complete payload');
  }
  const missing = temporary();
  await assert.rejects(downloadPlatformArtifacts({ repository, runId: 42, outputDir: missing, cacheDir: path.join(root, 'cache'), api: () => ({ artifacts: [] }) }), /Expected one release-macos/);
});

test('损坏的 macOS 平台 ZIP 不解压部分 DMG，也不留有效缓存', async () => {
  const fixture = archiveFixture({ 'release-artifact.json': '{}', 'VersionDock.dmg': 'complete' });
  fixture.artifact.name = 'release-macos'; fixture.options.name = 'release-macos';
  await assert.rejects(downloadReleaseArtifact({ ...fixture.options, download: (_url, file) => fs.writeFileSync(file, 'partial archive') }), /SHA-256/);
  assert.equal(fs.existsSync(fixture.options.outputDir), false);
});

function macosFixture() {
  const root = temporary();
  const binariesDir = path.join(root, 'binaries');
  fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  for (const file of ['tauri.conf.json', 'tauri.macos.conf.json', 'tauri.reuse-frontend.conf.json', 'tauri.release-updater.conf.json']) {
    fs.writeFileSync(path.join(root, 'src-tauri', file), '{}');
  }
  fs.mkdirSync(path.join(root, 'dist')); fs.writeFileSync(path.join(root, 'dist/index.html'), 'same frontend');
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    const file = path.join(root, 'src-tauri/target', target, 'release/versiondock-desktop');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, target);
    stageMacosBinary({ root, target, sourceSha: sha, version: '0.1.7', outputDir: path.join(binariesDir, `macos-native-${target}-${sha}`),
      run: () => target.startsWith('aarch64') ? 'arm64' : 'x86_64' });
  }
  return { root, binariesDir, sourceSha: sha, version: '0.1.7' };
}

test('macOS 合包前拒绝不同提交、不同配置、损坏文件或不同前端产物', () => {
  for (const change of ['source', 'configuration', 'hash', 'frontend']) {
    const fixture = macosFixture();
    const directory = path.join(fixture.binariesDir, `macos-native-aarch64-apple-darwin-${sha}`);
    const file = path.join(directory, 'native-build.json');
    const metadata = JSON.parse(fs.readFileSync(file));
    if (change === 'source') metadata.sourceSha = 'b'.repeat(40);
    if (change === 'configuration') metadata.configuration = 'invalid';
    if (change === 'hash') fs.writeFileSync(path.join(directory, 'versiondock-desktop'), 'broken');
    if (change === 'frontend') fs.writeFileSync(path.join(fixture.root, 'dist/index.html'), 'different frontend');
    fs.writeFileSync(file, JSON.stringify(metadata));
    assert.throws(() => mergeMacosBinaries({ ...fixture, run: () => 'arm64' }), /mismatched/);
  }
});

test('真实 macOS 双架构可执行文件经记录校验后合成 Universal', { skip: process.platform !== 'darwin' }, () => {
  const fixture = macosFixture();
  const source = path.join(fixture.root, 'main.c'); fs.writeFileSync(source, 'int main(void) { return 0; }');
  for (const [target, arch] of [['aarch64-apple-darwin', 'arm64'], ['x86_64-apple-darwin', 'x86_64']]) {
    const file = path.join(fixture.root, 'src-tauri/target', target, 'release/versiondock-desktop');
    execFileSync('clang', ['-arch', arch, source, '-o', file], { stdio: 'pipe' });
    const outputDir = path.join(fixture.binariesDir, `macos-native-${target}-${sha}`);
    fs.rmSync(outputDir, { recursive: true });
    stageMacosBinary({ ...fixture, target, outputDir });
  }
  const output = mergeMacosBinaries(fixture);
  const architectures = execFileSync('lipo', ['-archs', output], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  assert.deepEqual(architectures, ['arm64', 'x86_64']);
  execFileSync('lipo', [output, '-verify_arch', 'arm64', 'x86_64'], { stdio: 'pipe' });
  execFileSync(output, [], { stdio: 'pipe' });
});
