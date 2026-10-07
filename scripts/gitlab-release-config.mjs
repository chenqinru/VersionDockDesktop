import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function gitlabReleaseConfig(env = process.env) {
  const projectId = env.GITLAB_RELEASE_PROJECT_ID;
  if (!projectId) return null;
  if (!/^[1-9]\d*$/.test(projectId)) throw new Error('GITLAB_RELEASE_PROJECT_ID 必须是数字项目 ID');
  const base = new URL(env.GITLAB_RELEASE_URL || 'https://git.gsdzone.net');
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('GitLab 必须使用不含凭据的 HTTPS 根地址');
  }
  const packageName = env.GITLAB_RELEASE_PACKAGE || 'versiondock-desktop';
  if (!/^[A-Za-z0-9._-]+$/.test(packageName)) throw new Error('GitLab 安装包名称只能包含字母、数字、点、下划线和连字符');
  const branch = env.GITLAB_RELEASE_BRANCH || 'main';
  const api = `${base.origin}/api/v4/projects/${projectId}`;
  const manifestFile = `${api}/repository/files/latest.json`;
  return {
    api, branch, manifestFile,
    latestUrl: `${manifestFile}/raw?ref=${encodeURIComponent(branch)}`,
    packageUrl: (version, name) => `${api}/packages/generic/${packageName}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`,
  };
}

export function prepareUpdaterConfig(env = process.env) {
  const mirror = gitlabReleaseConfig(env);
  const base = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const endpoints = [base.plugins.updater.endpoints[0], ...(mirror ? [mirror.latestUrl] : [])];
  return { plugins: { updater: { endpoints } } };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  writeFileSync('src-tauri/tauri.release-updater.conf.json', `${JSON.stringify(prepareUpdaterConfig(), null, 2)}\n`);
  console.log(gitlabReleaseConfig() ? '已配置 GitHub 优先、GitLab 备用更新地址' : 'GitLab 项目尚未配置，保留 GitHub 更新地址');
}
