import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../src/bindings/generated.ts', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));
const before = await readFile(path, 'utf8');
const result = spawnSync('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', 'export_bindings', '--', '--nocapture'], {
  cwd,
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const after = await readFile(path, 'utf8');
const normalize = (content) => content.replaceAll('\r\n', '\n');
if (normalize(after) !== normalize(before)) {
  throw new Error('Generated bindings were stale. Run npm run bindings and commit the result.');
}
process.stdout.write('Generated bindings are current.\n');
