import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function gitcodeReleaseConfig(env = process.env) {
  const repository = env.GITCODE_RELEASE_REPOSITORY;
  if (!repository) return null;
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('GITCODE_RELEASE_REPOSITORY 必须是 owner/repo，不含 URL 或凭据');
  }
  const branch = env.GITCODE_RELEASE_BRANCH || 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('/') || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
    throw new Error('GitCode 镜像分支名称无效');
  }
  const api = `https://api.gitcode.com/api/v5/repos/${repository}`;
  return {
    api, repository, branch,
    manifestFile: `${api}/contents/latest.json`,
    latestUrl: `${api}/raw/latest.json?ref=${encodeURIComponent(branch)}`,
    releaseUrl: (version) => `${api}/releases/tags/v${version}`,
    packageUrl: (version, name) => `https://gitcode.com/${repository}/releases/download/v${version}/${encodeURIComponent(name)}`,
  };
}

export function prepareUpdaterConfig(env = process.env) {
  const mirror = gitcodeReleaseConfig(env);
  const base = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const endpoints = [base.plugins.updater.endpoints[0], ...(mirror ? [mirror.latestUrl] : [])];
  return { plugins: { updater: { endpoints } } };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  writeFileSync('src-tauri/tauri.release-updater.conf.json', `${JSON.stringify(prepareUpdaterConfig(), null, 2)}\n`);
  console.log(gitcodeReleaseConfig() ? '已配置 GitHub 优先、GitCode 备用更新地址' : 'GitCode 仓库尚未配置，保留 GitHub 更新地址');
}
