import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { RELEASE_REPOSITORY, compareVersions, fileHash, validateVersion } from './release-artifacts.mjs';

export function assertPublishable(version, latest, existing) {
  validateVersion(version);
  if (existing && (!existing.draft || existing.prerelease)) throw new Error('该版本已经公开或不是正式版本，禁止覆盖');
  if (latest && compareVersions(version, latest.tag_name.replace(/^v/, '')) <= 0) {
    throw new Error(`版本 ${version} 必须高于当前公开版本 ${latest.tag_name}`);
  }
}

export function createGitHubClient({ run = execFileSync } = {}) {
  const api = (endpoint, method = 'GET', body) => {
    const args = ['api', endpoint, '--method', method, '--header', 'Cache-Control: no-cache'];
    if (body !== undefined) args.push('--input', '-');
    const response = run('gh', args, {
      input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return response.trim() ? JSON.parse(response) : null;
  };
  const optional = (endpoint) => {
    try { return api(endpoint); } catch (error) {
      if (String(error.stderr).includes('(HTTP 404)')) return null;
      throw error;
    }
  };
  return {
    repository: () => api(`repos/${RELEASE_REPOSITORY}`),
    tagCommit: (tag) => {
      let object = api(`repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`).object;
      while (object.type === 'tag') {
        object = api(`repos/${RELEASE_REPOSITORY}/git/tags/${object.sha}`).object;
      }
      if (object.type !== 'commit') throw new Error('版本标签必须指向源码提交');
      return object.sha;
    },
    latest: () => optional(`repos/${RELEASE_REPOSITORY}/releases/latest`),
    release: (tag) => {
      const published = optional(`repos/${RELEASE_REPOSITORY}/releases/tags/${tag}`);
      if (published) return published;
      // 标签接口不返回草稿。显式分页兼容系统包管理器提供的旧版 gh，
      // 并在找到目标草稿后停止读取后续页面。
      for (let page = 1; ; page++) {
        const releases = api(`repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`);
        if (!Array.isArray(releases)) throw new Error('GitHub Release 列表响应格式不正确');
        const release = releases.find((value) => value.tag_name === tag);
        if (release) return release;
        if (releases.length < 100) return null;
      }
    },
    releaseById: (id) => api(`repos/${RELEASE_REPOSITORY}/releases/${id}`),
    create: (body) => api(`repos/${RELEASE_REPOSITORY}/releases`, 'POST', body),
    deleteAsset: (id) => api(`repos/${RELEASE_REPOSITORY}/releases/assets/${id}`, 'DELETE'),
    upload: (draft, files) => {
      for (const file of files) {
        const name = path.basename(file);
        const previous = draft.assets?.find((asset) => asset.name === name);
        if (previous) api(`repos/${RELEASE_REPOSITORY}/releases/assets/${previous.id}`, 'DELETE');
        // 刚创建的草稿标签可能尚未被索引，始终使用 POST 返回的 ID 上传。
        run('gh', [
          'api', `https://uploads.github.com/repos/${RELEASE_REPOSITORY}/releases/${draft.id}/assets?name=${encodeURIComponent(name)}`,
          '--method', 'POST', '--header', 'Content-Type: application/octet-stream', '--input', file,
        ], { stdio: 'pipe' });
      }
    },
    download: (release, directory) => {
      for (const asset of release.assets) {
        const file = fs.openSync(path.join(directory, asset.name), 'wx');
        try {
          run('gh', ['api', `repos/${RELEASE_REPOSITORY}/releases/assets/${asset.id}`, '--header', 'Accept: application/octet-stream'], {
            stdio: ['ignore', file, 'pipe'],
          });
        } finally {
          fs.closeSync(file);
        }
      }
    },
    publish: (id) => api(`repos/${RELEASE_REPOSITORY}/releases/${id}`, 'PATCH', { draft: false, prerelease: false, make_latest: 'true' }),
  };
}

export function publishRelease({ directory, version, sourceSha, github = createGitHubClient() }) {
  validateVersion(version);
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new Error('发布必须提供已验证的源码提交 SHA');
  const assetsDir = path.join(directory, 'assets');
  const names = fs.readdirSync(assetsDir).sort();
  const manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'latest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('更新清单版本不一致');
  const repository = github.repository();
  if (repository.private || repository.full_name !== RELEASE_REPOSITORY || repository.default_branch !== 'main') {
    throw new Error('发布仓库必须是指定的公开仓库，默认分支为 main');
  }
  const tag = `v${version}`;
  const assertSourceTag = () => {
    if (github.tagCommit(tag) !== sourceSha) throw new Error('版本标签与已验证的源码提交不一致，停止发布');
  };
  assertSourceTag();
  const existing = github.release(tag);
  assertPublishable(version, github.latest(), existing);
  const draft = existing || github.create({
    tag_name: tag, target_commitish: sourceSha, name: `VersionDock Desktop ${tag}`,
    body: fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), draft: true, prerelease: false,
  });
  for (const asset of draft.assets || []) {
    if (!names.includes(asset.name)) github.deleteAsset(asset.id);
  }
  github.upload(draft, names.map((name) => path.join(assetsDir, name)));
  const uploaded = github.releaseById(draft.id);
  if (!uploaded?.draft || JSON.stringify(uploaded.assets.map(({ name }) => name).sort()) !== JSON.stringify(names)) {
    throw new Error('草稿附件不完整或草稿状态发生变化，停止发布');
  }
  for (const asset of uploaded.assets) {
    if (asset.state !== 'uploaded' || asset.size !== fs.statSync(path.join(assetsDir, asset.name)).size) {
      throw new Error(`附件上传校验失败：${asset.name}`);
    }
  }
  const downloaded = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-release-'));
  try {
    github.download(uploaded, downloaded);
    for (const name of names) {
      if (fileHash(path.join(downloaded, name)) !== fileHash(path.join(assetsDir, name))) {
        throw new Error(`远程附件内容校验失败：${name}`);
      }
    }
  } finally {
    fs.rmSync(downloaded, { recursive: true, force: true });
  }
  // 上传期间可能有人在网页发布其他版本，公开前再检查一次。
  assertSourceTag();
  assertPublishable(version, github.latest(), github.releaseById(draft.id));
  const published = github.publish(draft.id);
  if (published.draft || published.prerelease || github.latest()?.tag_name !== tag) {
    throw new Error('版本已提交发布，但 latest 状态未确认；请检查公开仓库，不要覆盖已公开版本');
  }
  return published;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.env.GH_TOKEN) throw new Error('请提供 GH_TOKEN；Actions 使用具有 contents: write 权限的 GITHUB_TOKEN');
  const release = publishRelease({
    directory: process.env.RELEASE_OUTPUT_DIR, version: process.env.RELEASE_VERSION, sourceSha: process.env.RELEASE_SOURCE_SHA,
  });
  console.log(`已发布：${release.html_url}`);
}
