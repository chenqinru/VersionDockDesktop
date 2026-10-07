import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileHash, validateVersion, stageArtifacts } from './release-artifacts.mjs';
import { validateSourceSha } from './release-github-api.mjs';

const targets = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' };
const configs = ['src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json', 'src-tauri/tauri.reuse-frontend.conf.json', 'src-tauri/tauri.release-updater.conf.json'];

export function configurationHash(root) {
  const digest = createHash('sha256');
  for (const file of configs) digest.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) digest.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
      else throw new Error('Frontend assets must be regular files');
    }
  };
  visit(path.join(root, 'dist'));
  return digest.digest('hex');
}

function architectures(file, run) {
  return run('lipo', ['-archs', file], { encoding: 'utf8', stdio: 'pipe' }).trim().split(/\s+/).sort();
}

export function stageMacosBinary({ root, target, sourceSha, version, outputDir, run = execFileSync }) {
  validateSourceSha(sourceSha); validateVersion(version);
  if (!targets[target]) throw new Error('Unsupported macOS target');
  const source = path.join(root, 'src-tauri/target', target, 'release/versiondock-desktop');
  if (!fs.lstatSync(source).isFile() || JSON.stringify(architectures(source, run)) !== JSON.stringify([targets[target]])) throw new Error('Native binary does not match its target architecture');
  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.readdirSync(outputDir).length) throw new Error('Native binary staging directory must be empty');
  fs.copyFileSync(source, path.join(outputDir, 'versiondock-desktop'));
  fs.writeFileSync(path.join(outputDir, 'native-build.json'), JSON.stringify({
    target, sourceSha, version, configuration: configurationHash(root), sha256: fileHash(source),
  }, null, 2));
}

export function mergeMacosBinaries({ root, binariesDir, sourceSha, version, run = execFileSync }) {
  validateSourceSha(sourceSha); validateVersion(version);
  const configuration = configurationHash(root);
  const files = [];
  for (const [target, arch] of Object.entries(targets)) {
    const directory = path.join(binariesDir, `macos-native-${target}-${sourceSha}`);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'native-build.json'), 'utf8'));
    const file = path.join(directory, 'versiondock-desktop');
    if (metadata.sourceSha !== sourceSha || metadata.version !== version || metadata.target !== target || metadata.configuration !== configuration
      || !fs.lstatSync(file).isFile() || fileHash(file) !== metadata.sha256 || JSON.stringify(architectures(file, run)) !== JSON.stringify([arch])) {
      throw new Error(`macOS ${target} binary has mismatched source, configuration, architecture or hash`);
    }
    fs.chmodSync(file, 0o755); files.push(file);
  }
  const output = path.join(root, 'src-tauri/target/universal-apple-darwin/release/versiondock-desktop');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  run('lipo', ['-create', ...files, '-output', output], { stdio: 'pipe' });
  fs.chmodSync(output, 0o755);
  if (JSON.stringify(architectures(output, run)) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('Merged binary is not Universal');
  return output;
}

export function stageMacosBundles({ root, version, outputDir }) {
  const bundle = path.join(root, 'src-tauri/target/universal-apple-darwin/release/bundle');
  const files = [];
  for (const directory of ['macos', 'dmg']) {
    for (const name of fs.readdirSync(path.join(bundle, directory))) {
      const file = path.join(bundle, directory, name);
      if (fs.lstatSync(file).isFile() && /(?:\.app\.tar\.gz|\.dmg)(?:\.sig)?$/.test(name)) files.push(file);
    }
  }
  return stageArtifacts({ platform: 'macos', version, files, outputDir });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'darwin') throw new Error('Native macOS release handling requires macOS');
  const root = process.cwd();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (sourceSha !== process.env.RELEASE_SOURCE_SHA) throw new Error('Checkout does not match the pinned source commit');
  const options = { root, version, sourceSha, outputDir: process.env.RELEASE_OUTPUT_DIR };
  if (process.argv[2] === 'stage') stageMacosBinary({ ...options, target: process.env.RELEASE_TARGET });
  else if (process.argv[2] === 'merge') console.log(mergeMacosBinaries({ ...options, binariesDir: process.env.RELEASE_BINARIES_DIR }));
  else if (process.argv[2] === 'bundles') stageMacosBundles(options);
  else throw new Error('Expected stage, merge or bundles');
}
