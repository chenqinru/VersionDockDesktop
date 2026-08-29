import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const sourceRoots = [join(root, 'src', 'App.tsx'), join(root, 'src', 'components')];
const technicalAllowlist = new Set([
  'VersionDock', 'VersionDock Desktop', 'Git & SVN', 'Git:', 'SVN:', 'HEAD',
  'Promise',
]);

function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

const violations = [];
for (const file of sourceRoots.flatMap(files).filter((path) => path.endsWith('.tsx') && !path.endsWith('.test.tsx'))) {
  const source = readFileSync(file, 'utf8');
  const patterns = [
    /(?:aria-label|title|placeholder)="([^"{]*[A-Za-z][^"]*)"/g,
    />\s*([A-Z][A-Za-z0-9 &:+.()-]{2,})\s*</g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const text = match[1].trim();
      if (technicalAllowlist.has(text)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${relative(root, file)}:${line}: ${text}`);
    }
  }
}

if (violations.length) {
  console.error('Visible English text must use the shared translator:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('Visible text i18n scan passed.');
