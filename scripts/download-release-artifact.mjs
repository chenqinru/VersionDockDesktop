import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readGitHubApi, validateRepository } from './release-github-api.mjs';

async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function downloadZip(endpoint, file) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    const debug = (process.env.GODEBUG || '').split(',').filter((value) => value && !value.startsWith('http2client='));
    execFileSync('gh', ['api', endpoint], { stdio: ['ignore', descriptor, 'pipe'], env: { ...process.env, GODEBUG: [...debug, 'http2client=0'].join(',') } });
  } finally { fs.closeSync(descriptor); }
}

const extractCode = `
import sys, zipfile, pathlib, stat, re
archive, destination = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    for entry in z.infolist():
        parts = pathlib.PurePosixPath(entry.filename).parts
        mode = entry.external_attr >> 16
        if not parts or entry.filename.startswith('/') or '\\\\' in entry.filename or '..' in parts or stat.S_ISLNK(mode):
            raise ValueError('Unsafe artifact archive entry')
        if entry.is_dir() or len(parts) != 1 or not (parts[0] == 'release-artifact.json' or re.fullmatch(r'[A-Za-z0-9._-]+(?:\\.app\\.tar\\.gz|\\.dmg|\\.exe|\\.msi|\\.AppImage|\\.deb|\\.rpm)(?:\\.sig)?', parts[0])):
            raise ValueError('Unexpected platform artifact file')
    z.extractall(destination)
`;

export async function downloadReleaseArtifact({ repository, runId, name, artifactId, cacheDir, outputDir, api = readGitHubApi, download = downloadZip, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  validateRepository(repository);
  if (!/^[1-9]\d*$/.test(String(runId)) || !/^release-(?:macos|windows|linux)$/.test(name)) throw new Error('Invalid platform artifact identity');
  const matches = [];
  for (let page = 1; ; page++) {
    const result = api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    if (!Array.isArray(result.artifacts)) throw new Error('Invalid artifact list');
    matches.push(...result.artifacts.filter((artifact) => artifact.name === name));
    if (result.artifacts.length < 100) break;
  }
  if (matches.length !== 1) throw new Error('Expected exactly one platform artifact from this run');
  const artifact = matches[0];
  if (artifact.expired || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.id !== artifactId || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '')) {
    throw new Error('Artifact is expired or has no trusted SHA-256 digest');
  }
  const expected = artifact.digest.slice(7);
  const namespace = createHash('sha256').update(repository).digest('hex').slice(0, 16);
  const directory = path.join(cacheDir, namespace);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = path.join(directory, `${artifact.id}-${expected}.zip`);
  let cached = false;
  if (fs.existsSync(archive)) {
    cached = fs.lstatSync(archive).isFile() && !fs.lstatSync(archive).isSymbolicLink() && await hashFile(archive) === expected;
    if (!cached) fs.rmSync(archive);
  }
  if (!cached) {
    const temporary = fs.mkdtempSync(path.join(directory, 'download-'));
    try {
      const file = path.join(temporary, 'artifact.zip');
      for (let attempt = 0; ; attempt++) {
        try {
          await download(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, file);
          if (await hashFile(file) !== expected) throw new Error('Downloaded artifact SHA-256 does not match GitHub');
          break;
        } catch (error) {
          fs.rmSync(file, { force: true });
          if (attempt === 2) throw error;
          await sleep(1000 * 2 ** attempt);
        }
      }
      fs.renameSync(file, archive);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  const now = new Date(); fs.utimesSync(archive, now, now);
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) throw new Error('Platform artifact output must be empty');
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(outputDir), 'extract-release-'));
  try {
    execFileSync('python3', ['-c', extractCode, archive, staging], { stdio: 'pipe' });
    if (!fs.existsSync(path.join(staging, 'release-artifact.json'))) throw new Error('Incomplete platform archive');
    if (fs.existsSync(outputDir)) fs.rmdirSync(outputDir);
    fs.renameSync(staging, outputDir);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  // Keep the five most recently used archives; retries reuse files by immutable
  // artifact ID + server digest, not a mutable tag or package name.
  const archives = fs.readdirSync(directory).filter((file) => /^\d+-[a-f0-9]{64}\.zip$/.test(file))
    .map((file) => path.join(directory, file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of archives.slice(5)) if (file !== archive) fs.rmSync(file);
  return { cached, artifactId: artifact.id, bytes: artifact.size_in_bytes };
}

export async function downloadPlatformArtifacts({ repository, runId, outputDir, cacheDir, api = readGitHubApi, download = downloadZip, sleep }) {
  validateRepository(repository);
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error('Invalid release run');
  const artifacts = [];
  for (let page = 1; ; page++) {
    const result = api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    if (!Array.isArray(result.artifacts)) throw new Error('Invalid artifact list');
    artifacts.push(...result.artifacts);
    if (result.artifacts.length < 100) break;
  }
  const results = [];
  for (const platform of ['macos', 'windows', 'linux']) {
    const name = `release-${platform}`;
    const matches = artifacts.filter((artifact) => artifact.name === name);
    if (matches.length !== 1) throw new Error(`Expected one ${name} artifact from this run`);
    results.push(await downloadReleaseArtifact({ repository, runId, name, artifactId: matches[0].id, cacheDir,
      outputDir: path.join(outputDir, name), api: () => ({ artifacts: matches }), download, sleep }));
  }
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/download-release-artifact.mjs');
  const options = {
    repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
    outputDir: process.env.RELEASE_ARTIFACTS_DIR,
    cacheDir: process.env.VERSIONDOCK_ARTIFACT_CACHE_DIR || path.join(os.homedir(), '.cache/versiondock-release-artifacts'),
  };
  const results = await downloadPlatformArtifacts(options);
  for (const result of results) console.log(`${result.cached ? 'Reused verified cached' : 'Downloaded and verified'} artifact ${result.artifactId} (${(result.bytes / 1024 / 1024).toFixed(1)} MiB)`);
}
