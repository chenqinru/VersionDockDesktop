import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const currentScriptPath = fileURLToPath(import.meta.url);
const ignored = new Set(['.git', 'node_modules', 'dist', 'target']);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.toml', '.rs', '.html', '.css']);
const failures = [];

async function walk(dirPath) {
  for (const name of await readdir(dirPath)) {
    if (ignored.has(name) || name === 'v1.md' || name === 'v2.md') continue;
    const childPath = join(dirPath, name);
    if (childPath === currentScriptPath) continue;
    const stat = await lstat(childPath);
    const shown = relative(rootDir, childPath).replaceAll('\\', '/');
    if (shown === 'scripts/check-independence.mjs') continue;
    if (stat.isSymbolicLink()) {
      failures.push(`${shown}: symbolic links are forbidden`);
      continue;
    }
    if (stat.isDirectory()) {
      await walk(childPath);
      continue;
    }
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    if (!textExtensions.has(extension)) continue;
    const source = await readFile(childPath, 'utf8');
    if (source.includes('/Volumes/WorkSSD/Project/VersionDock') || source.includes('../VersionDock')) {
      failures.push(`${shown}: references the source plugin`);
    }
    if ((name === 'package.json' || name === 'package-lock.json') && /"file:[^"]+"/.test(source)) {
      failures.push(`${shown}: contains a file: dependency`);
    }
    if (/src\/(ai|aiCodeReview|aiCommit|aiMerge)/i.test(source)) failures.push(`${shown}: contains an AI source dependency`);
  }
}

await walk(rootDir);
if (failures.length) {
  throw new Error(`Independence check failed:\n${failures.join('\n')}`);
}
process.stdout.write(`Independence check passed for ${rootDir}\n`);
