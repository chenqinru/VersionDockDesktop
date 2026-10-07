import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGitHubApi, validateRepository, validateSourceSha } from './release-github-api.mjs';

const requiredJobs = ['Frontend checks', 'Rust checks', 'Quality gate', 'Test and bundle (Linux x64)', 'Test and bundle (Windows x64)', 'Test and bundle (macOS universal)'];
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function reusableRun(run, { repository, sha, now }) {
  const age = now.getTime() - Date.parse(run.updated_at);
  return Number.isSafeInteger(run.id) && run.id > 0 && run.head_sha === sha
    && run.head_repository?.full_name === repository && run.event === 'push' && run.head_branch === 'main'
    && run.path === '.github/workflows/ci.yml' && run.status === 'completed' && run.conclusion === 'success'
    && age >= 0 && age <= MAX_AGE_MS;
}

export function verifyReusableCi({ repository, sha, runId, api = readGitHubApi, now = new Date() }) {
  validateRepository(repository); validateSourceSha(sha);
  if (!Number.isSafeInteger(runId) || runId <= 0) return false;
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  if (!reusableRun(run, { repository, sha, now })) return false;
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = api(`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    if (!Array.isArray(result.jobs)) throw new Error('Invalid CI jobs response');
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
  }
  return requiredJobs.every((name) => {
    const matches = jobs.filter((job) => job.name === name);
    const age = now.getTime() - Date.parse(matches[0]?.completed_at);
    return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success'
      && age >= 0 && age <= MAX_AGE_MS;
  });
}

export function findReusableCi({ repository, sha, api = readGitHubApi, now = new Date() }) {
  validateRepository(repository); validateSourceSha(sha);
  // A CI push on main executes ci.yml and all checks from this exact commit.
  // Manual/PR runs, other commits, incomplete checks and stale dependency
  // audits are not evidence for skipping release checks.
  const result = api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&status=completed&per_page=100`);
  if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid CI runs response');
  for (const run of result.workflow_runs) {
    if (reusableRun(run, { repository, sha, now }) && verifyReusableCi({ repository, sha, runId: run.id, api, now })) return String(run.id);
  }
  return '';
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = { repository: process.env.GITHUB_REPOSITORY, sha: process.env.RELEASE_SOURCE_SHA };
  if (process.argv[2] === 'verify') {
    if (!verifyReusableCi({ ...options, runId: Number(process.env.REUSED_CI_RUN_ID) })) throw new Error('Reused CI no longer meets the release checks');
    console.log(`Verified successful CI for ${options.sha}`);
  } else {
    let runId = '';
    try { runId = findReusableCi(options); } catch {
      console.log('CI reuse could not be verified; release will run all checks.');
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ci_run_id=${runId}\n`);
    console.log(runId ? `Reusing successful CI run ${runId} for the exact source commit` : 'No reusable CI; release will run all checks');
  }
}
