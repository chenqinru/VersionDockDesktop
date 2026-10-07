import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compareVersions, fileHash, validateVersion, verifySignature } from './release-artifacts.mjs';
import { gitlabReleaseConfig } from './gitlab-release-config.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGitLabClient({ config, token, request = fetch, sleep = pause }) {
  if (!token) throw new Error('请在 GitHub Actions Secrets 配置 GITLAB_RELEASE_TOKEN');
  async function send(url, options = {}, authenticated = false, consume) {
    for (let attempt = 0; ; attempt++) {
      try {
        // Open a fresh stream for every retry. Publishing credentials are sent
        // only to GitLab's API, never through redirects or into client bundles.
        const { file, ...init } = options;
        const response = await request(url, {
          ...init, redirect: authenticated ? 'error' : 'follow', signal: AbortSignal.timeout(180_000),
          ...(file ? { body: fs.createReadStream(file), duplex: 'half' } : {}),
          headers: { ...init.headers, ...(authenticated ? { 'PRIVATE-TOKEN': token } : {}) },
        });
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await response.body?.cancel();
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        return consume ? await consume(response) : response;
      } catch (error) {
        if (attempt === 2) throw new Error(`GitLab 请求失败：${new URL(url).pathname}`, { cause: error });
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  async function hash(url) {
    return send(url, {}, false, async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitLab 安装包无法匿名读取：HTTP ${response.status}`);
      const digest = createHash('sha256');
      for await (const chunk of response.body) digest.update(chunk);
      return digest.digest('hex');
    });
  }
  return {
    async latest() {
      const response = await send(`${config.manifestFile}?ref=${encodeURIComponent(config.branch)}`, {}, true);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitLab 清单读取失败：HTTP ${response.status}`);
      const file = await response.json();
      return { manifest: JSON.parse(Buffer.from(file.content, 'base64').toString()), commit: file.last_commit_id };
    },
    hash,
    async upload(url, file) {
      const response = await send(url, { method: 'PUT', file }, true);
      if (!response.ok) throw new Error(`GitLab 安装包上传失败：HTTP ${response.status}`);
      await response.body?.cancel();
    },
    async updateLatest(manifest, previous) {
      const response = await send(config.manifestFile, {
        method: previous ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: config.branch, content: `${JSON.stringify(manifest, null, 2)}\n`,
          commit_message: `Publish VersionDock Desktop v${manifest.version}`,
          ...(previous ? { last_commit_id: previous.commit } : {}),
        }),
      }, true);
      // If the response was lost after a successful commit, read back before
      // treating a duplicate create or stale commit response as a failure.
      if (!response.ok) {
        const current = await this.latest();
        if (JSON.stringify(current?.manifest) !== JSON.stringify(manifest)) {
          throw new Error(`GitLab latest.json 更新失败：HTTP ${response.status}`);
        }
      }
      const visible = await send(config.latestUrl);
      if (!visible.ok || JSON.stringify(await visible.json()) !== JSON.stringify(manifest)) {
        throw new Error('GitLab latest.json 匿名读取校验失败');
      }
    },
  };
}

export async function publishGitLabRelease({ directory, version, config, client, pubkey }) {
  validateVersion(version);
  const assets = path.join(directory, 'assets');
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'latest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('GitLab 发布版本与更新清单不一致');
  const names = fs.readdirSync(assets).filter((name) => name !== 'latest.json').sort();
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !fs.lstatSync(path.join(assets, name)).isFile()) throw new Error('非法发布附件');
    if (name.endsWith('.sig')) {
      verifySignature(path.join(assets, name.slice(0, -4)), fs.readFileSync(path.join(assets, name), 'utf8').trim(), pubkey);
    }
  }
  for (const update of Object.values(manifest.platforms)) {
    const name = decodeURIComponent(new URL(update.url).pathname.split('/').pop());
    if (!names.includes(name) || !names.includes(`${name}.sig`) || update.signature !== fs.readFileSync(path.join(assets, `${name}.sig`), 'utf8').trim()) {
      throw new Error('GitLab 清单中的安装包或签名与附件不一致');
    }
    update.url = config.packageUrl(version, name);
  }
  const previous = await client.latest();
  if (previous && compareVersions(version, previous.manifest.version) < 0) throw new Error('禁止将 GitLab latest.json 回退到旧版本');
  // A rerun of the publish job regenerates the GitHub manifest timestamp.
  // Preserve the already published mirror date while verifying all content.
  if (previous?.manifest.version === version) manifest.pub_date = previous.manifest.pub_date;
  if (previous?.manifest.version === version && JSON.stringify(previous.manifest) !== JSON.stringify(manifest)) throw new Error('禁止覆盖 GitLab 已发布版本');
  for (const name of names) {
    const file = path.join(assets, name);
    const url = config.packageUrl(version, name);
    const local = fileHash(file);
    const remote = await client.hash(url);
    if (remote !== null && remote !== local) throw new Error(`禁止覆盖 GitLab 同版本附件：${name}`);
    if (remote === null) await client.upload(url, file);
    if (await client.hash(url) !== local) throw new Error(`GitLab 远程附件 SHA-256 校验失败：${name}`);
  }
  const latest = await client.latest();
  if (latest && compareVersions(version, latest.manifest.version) < 0) throw new Error('上传期间已有更新版本发布，停止修改 latest.json');
  if (latest?.manifest.version === version) {
    if (JSON.stringify(latest.manifest) !== JSON.stringify(manifest)) throw new Error('禁止覆盖 GitLab 已发布版本');
    if (await client.hash(config.latestUrl) !== createHash('sha256').update(`${JSON.stringify(manifest, null, 2)}\n`).digest('hex')) throw new Error('GitLab 清单无法匿名读取或内容不一致');
  } else {
    await client.updateLatest(manifest, latest);
  }
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const config = gitlabReleaseConfig();
  if (!config) throw new Error('请配置 GITLAB_RELEASE_PROJECT_ID');
  const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  await publishGitLabRelease({ directory: process.env.RELEASE_OUTPUT_DIR, version: process.env.RELEASE_VERSION, config,
    pubkey: tauri.plugins.updater.pubkey, client: createGitLabClient({ config, token: process.env.GITLAB_RELEASE_TOKEN }) });
  console.log(`GitLab 安装包已验证，更新清单已发布：${config.latestUrl}`);
}
