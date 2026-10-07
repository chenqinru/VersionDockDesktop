import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compareVersions, fileHash, validateVersion, verifySignature } from './release-artifacts.mjs';
import { gitcodeReleaseConfig } from './gitcode-release-config.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const serialize = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

class HttpError extends Error {
  constructor(status) { super(`GitCode 请求失败：HTTP ${status}`); this.status = status; }
}
class NetworkError extends Error {
  constructor(url, method, error) {
    const causes = [error, error?.cause];
    const code = causes.map((cause) => cause?.code).find((value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value));
    const reason = code || (causes.some((cause) => ['TimeoutError', 'AbortError'].includes(cause?.name)) ? 'REQUEST_TIMEOUT'
      : causes.some((cause) => cause?.message === 'unexpected redirect') ? 'REDIRECT_NOT_ALLOWED' : 'FETCH_FAILED');
    super(`GitCode 网络请求失败：${method} ${new URL(url).hostname}，错误码 ${reason}`);
  }
}

class UploadError extends Error {
  constructor(url, file, result, elapsed) {
    const status = /^\d{3}$/.test(result.status) ? result.status : '000';
    const code = Number.isInteger(result.code) ? result.code : 'SPAWN_FAILED';
    super(`GitCode 附件上传失败：${path.basename(file)} (${fs.statSync(file).size} bytes)，PUT ${new URL(url).hostname}，HTTP ${status}，curl ${code}，耗时 ${elapsed.toFixed(1)} 秒`);
    this.retryable = [5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 92, 95].includes(code) || code === 0 && (status === '429' || Number(status) >= 500);
  }
}

function curlConfigValue(value) {
  if (typeof value !== 'string' || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('GitCode 上传配置含无效控制字符');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function uploadFile(url, file, headers) {
  // A signed OBS PUT uses curl's file upload rather than a JS request stream.
  // Feed the signed URL and headers through stdin, never process arguments or logs.
  const config = [`url = ${curlConfigValue(url)}`, `upload-file = ${curlConfigValue(path.resolve(file))}`,
    ...Object.entries(headers).map(([name, value]) => `header = ${curlConfigValue(`${name}: ${value}`)}`)].join('\n');
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn('curl', ['--disable', '--config', '-', '--http1.1', '--globoff', '--request', 'PUT', '--silent', '--show-error',
      '--connect-timeout', '30', '--max-time', '180', '--output', os.devNull, '--write-out', '%{http_code}'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    let status = '';
    child.stdout.on('data', (chunk) => { status = (status + chunk.toString()).slice(0, 64); });
    // curl stderr can contain a signed URL. Report only its exit code below.
    child.stderr.resume();
    child.on('error', () => resolve({ code: null, status }));
    child.on('close', (code) => resolve({ code, status }));
    child.stdin.on('error', () => {});
    child.stdin.end(`${config}\n`);
  });
  if (result.code !== 0 || !/^2\d{2}$/.test(result.status)) {
    throw new UploadError(url, file, result, (Date.now() - started) / 1000);
  }
}

export function createGitCodeClient({ config, token, request = fetch, sleep = pause, log = console.log }) {
  if (!token) throw new Error('请在 GitHub Actions Secrets 配置 GITCODE_RELEASE_TOKEN');
  async function send(url, options = {}, authenticated = false, consume = async (response) => response) {
    if (authenticated && (!url.startsWith(`${config.api}/`) || new URL(url).origin !== new URL(config.api).origin)) {
      throw new Error('发布令牌只能发送到配置的 GitCode API');
    }
    const maxRetries = !options.method || options.method === 'GET' ? 2 : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await request(url, {
          ...options, redirect: authenticated ? 'error' : 'follow', signal: AbortSignal.timeout(180_000),
          headers: { ...options.headers, ...(authenticated ? { 'PRIVATE-TOKEN': token } : {}) },
        });
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          if (attempt === maxRetries) throw new HttpError(response.status);
          await sleep(1000 * 2 ** attempt); continue;
        }
        return await consume(response);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof SyntaxError) throw new Error('GitCode 返回的 JSON 格式无效');
        // Do not include fetch errors or signed upload URLs in logs.
        if (attempt === maxRetries) throw new NetworkError(url, options.method || 'GET', error);
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  const json = (url, options, authenticated = true, missing = false) => send(url, options, authenticated, async (response) => {
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
    return response.json();
  });
  const hash = (url) => send(url, {}, false, async (response) => {
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
    const digest = createHash('sha256');
    for await (const chunk of response.body) digest.update(chunk);
    return digest.digest('hex');
  });
  const release = (version) => json(config.releaseUrl(version), {}, true, true);
  const latest = async () => {
    const file = await json(`${config.manifestFile}?ref=${encodeURIComponent(config.branch)}`, {}, true, true);
    if (!file) return null;
    if (file.encoding !== 'base64' || !/^[a-f0-9]{40}$/.test(file.sha || '') || typeof file.content !== 'string') {
      throw new Error('GitCode latest.json 文件元数据无效');
    }
    return { manifest: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), sha: file.sha };
  };
  return {
    latest, hash, release,
    readManifest: (url) => json(url, {}, false, true),
    async ensureRelease(version, notes) {
      // Verify the branch separately so a missing/private repository is not
      // mistaken for a missing release or manifest.
      await json(`${config.api}/branches/${encodeURIComponent(config.branch)}`);
      let existing = await release(version);
      if (!existing) {
        try {
          await json(`${config.api}/releases`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_name: `v${version}`, target_commitish: config.branch,
              name: `VersionDock Desktop v${version}`, body: notes, release_status: 'pre' }),
          });
        } catch (error) {
          // Creation may have succeeded even if its response was lost.
          existing = await release(version);
          if (!existing) throw error;
        }
        existing = await release(version);
      }
      if (existing?.tag_name !== `v${version}` || typeof existing.body !== 'string' || existing.body.trim() !== notes.trim()) {
        throw new Error('GitCode 已有 Release 的标签或说明与本次发布不一致');
      }
      return existing;
    },
    async upload(version, name, file) {
      for (let attempt = 0; ; attempt++) {
        log(`GitCode 上传 v${version}/${name} (${fs.statSync(file).size} bytes)，第 ${attempt + 1}/3 次`);
        try { await this.uploadOnce(version, name, file); return; }
        catch (error) {
          // Check whether the object arrived before obtaining a new upload URL;
          // replaying a callback-bearing PUT can create duplicate attachments.
          if (await hash(config.packageUrl(version, name)) === fileHash(file)) {
            log(`GitCode 已确认附件上传成功：${name}`); return;
          }
          const retryable = error instanceof NetworkError || error instanceof UploadError && error.retryable
            || error instanceof HttpError && (error.status === 429 || error.status >= 500);
          if (!retryable || attempt === 2) throw error;
          log(error.message);
          await sleep(1000 * 2 ** attempt);
        }
      }
    },
    async uploadOnce(version, name, file) {
      const upload = await json(`${config.api}/releases/v${version}/upload_url?file_name=${encodeURIComponent(name)}`);
      let target;
      try { target = new URL(upload.url); } catch { throw new Error('GitCode 附件上传地址无效'); }
      const sameOrigin = target.origin === new URL(config.api).origin;
      if (!sameOrigin && (target.protocol !== 'https:' || !/(?:^|\.)(?:gitcode\.com|myhuaweicloud\.com)$/.test(target.hostname))) {
        throw new Error('GitCode 附件上传地址不是受支持的 HTTPS 存储地址');
      }
      if (target.username || target.password || upload.url.includes(token) || !upload.headers || typeof upload.headers !== 'object') throw new Error('GitCode 附件上传配置无效');
      const headers = {};
      for (const [key, value] of Object.entries(upload.headers)) {
        if (!/^(?:content-type|x-obs-[a-z0-9-]+)$/i.test(key) || typeof value !== 'string' || value.includes(token)) {
          throw new Error('GitCode 附件上传头无效');
        }
        headers[key] = value;
      }
      headers['Content-Length'] = String(fs.statSync(file).size);
      await uploadFile(upload.url, file, headers);
    },
    async finishRelease(version, notes) {
      const current = await release(version);
      if (current?.tag_name !== `v${version}` || typeof current.body !== 'string' || current.body.trim() !== notes.trim()) throw new Error('GitCode Release 状态发生变化');
      if (current.release_status !== 'latest') {
        try {
          await json(`${config.api}/releases/v${version}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: current.name, body: notes, release_status: 'latest' }),
          });
        } catch (error) {
          const recovered = await release(version);
          if (recovered?.release_status !== 'latest' || recovered.body !== notes) throw error;
        }
      }
      const published = await release(version);
      if (published?.release_status !== 'latest' || published.prerelease) throw new Error('GitCode Release 正式发布状态未确认');
    },
    async updateLatest(manifest, previous) {
      try {
        await json(config.manifestFile, {
          method: previous ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: config.branch, content: Buffer.from(serialize(manifest)).toString('base64'),
            message: `Publish VersionDock Desktop v${manifest.version}`, ...(previous ? { sha: previous.sha } : {}) }),
        });
      } catch (error) {
        if (!equal((await latest())?.manifest, manifest)) throw error;
      }
      if (await hash(config.latestUrl) !== createHash('sha256').update(serialize(manifest)).digest('hex')) {
        throw new Error('GitCode latest.json 匿名读取校验失败');
      }
    },
  };
}

export async function publishGitCodeRelease({ directory, version, config, client, pubkey }) {
  validateVersion(version);
  const assets = path.join(directory, 'assets');
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'latest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('GitCode 发布版本与更新清单不一致');
  const names = fs.readdirSync(assets).filter((name) => name !== 'latest.json').sort();
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !fs.lstatSync(path.join(assets, name)).isFile()) throw new Error('非法发布附件');
    if (name.endsWith('.sig')) verifySignature(path.join(assets, name.slice(0, -4)), fs.readFileSync(path.join(assets, name), 'utf8').trim(), pubkey);
  }
  if (!manifest.platforms || !Object.keys(manifest.platforms).length) throw new Error('GitCode 更新清单没有平台安装包');
  for (const update of Object.values(manifest.platforms)) {
    const name = decodeURIComponent(new URL(update.url).pathname.split('/').pop());
    if (!names.includes(name) || !names.includes(`${name}.sig`) || update.signature !== fs.readFileSync(path.join(assets, `${name}.sig`), 'utf8').trim()) {
      throw new Error('GitCode 清单中的安装包或签名与附件不一致');
    }
    update.url = config.packageUrl(version, name);
  }
  const previous = await client.latest();
  if (previous && compareVersions(version, previous.manifest.version) < 0) throw new Error('禁止将 GitCode latest.json 回退到旧版本');
  const versionManifestUrl = config.packageUrl(version, 'latest.json');
  const existingRelease = await client.release(version);
  if (existingRelease && !existingRelease.prerelease) {
    const publishedNames = existingRelease.assets?.filter(({ type }) => type === 'attach').map(({ name }) => name).sort();
    if (!equal(publishedNames, [...names, 'latest.json'].sort())) throw new Error('禁止修改 GitCode 已正式发布版本的附件列表');
  }
  const attachedManifest = existingRelease?.assets?.find((asset) => asset.name === 'latest.json');
  if (attachedManifest) {
    const published = await client.readManifest(versionManifestUrl);
    if (published?.version !== version) throw new Error('GitCode 已有版本清单无效或无法匿名读取');
    manifest.pub_date = published.pub_date;
    if (!equal(published, manifest)) throw new Error('禁止覆盖 GitCode 已发布版本');
  }
  if (previous?.manifest.version === version) manifest.pub_date = previous.manifest.pub_date;
  if (previous?.manifest.version === version && !equal(previous.manifest, manifest)) throw new Error('禁止覆盖 GitCode 已发布版本');
  const notes = fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8');
  if (manifest.notes.trim() !== notes.trim()) throw new Error('GitCode 更新清单与发布说明不一致');
  await client.ensureRelease(version, notes);
  async function publishFile(name, file) {
    const url = config.packageUrl(version, name);
    const local = fileHash(file);
    const remote = await client.hash(url);
    if (remote !== null && remote !== local) throw new Error(`禁止覆盖 GitCode 同版本附件：${name}`);
    if (remote === null) await client.upload(version, name, file);
    if (await client.hash(url) !== local) throw new Error(`GitCode 远程附件 SHA-256 校验失败：${name}`);
  }
  for (const name of names) await publishFile(name, path.join(assets, name));
  // Use a separate file so GitHub's prepared manifest remains unchanged.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-gitcode-'));
  const file = path.join(temporary, 'latest.json');
  try {
    fs.writeFileSync(file, serialize(manifest));
    await publishFile('latest.json', file);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const latest = await client.latest();
  if (latest && compareVersions(version, latest.manifest.version) < 0) throw new Error('上传期间已有更新版本发布，停止修改 latest.json');
  if (latest?.manifest.version === version && !equal(latest.manifest, manifest)) throw new Error('禁止覆盖 GitCode 已发布版本');
  await client.finishRelease(version, notes);
  if (latest?.manifest.version === version) {
    if (await client.hash(config.latestUrl) !== fileHashForManifest(manifest)) throw new Error('GitCode 清单无法匿名读取或内容不一致');
  } else await client.updateLatest(manifest, latest);
  return manifest;
}

function fileHashForManifest(manifest) { return createHash('sha256').update(serialize(manifest)).digest('hex'); }

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const config = gitcodeReleaseConfig();
  if (!config) throw new Error('请配置 GITCODE_RELEASE_REPOSITORY');
  const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  await publishGitCodeRelease({ directory: process.env.RELEASE_OUTPUT_DIR, version: process.env.RELEASE_VERSION, config,
    pubkey: tauri.plugins.updater.pubkey, client: createGitCodeClient({ config, token: process.env.GITCODE_RELEASE_TOKEN }) });
  console.log(`GitCode 安装包已验证，更新清单已发布：${config.latestUrl}`);
}
