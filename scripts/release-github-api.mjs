import { execFileSync } from 'node:child_process';

export function readGitHubApi(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint, '--method', 'GET', '--header', 'Cache-Control: no-cache'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  }));
}

export function validateRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid GitHub repository');
  return repository;
}

export function validateSourceSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('A pinned source commit SHA is required');
  return sha;
}
