import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'versiondock-v3-验收-'));
const gitRoot = join(root, 'Git 仓库');
const svnRepository = join(root, 'svn-repository');
const svnWorkingCopy = join(root, 'SVN 工作副本');

const run = (program, args, cwd = root) => execFileSync(program, args, { cwd, stdio: 'inherit' });

mkdirSync(gitRoot);
run('git', ['init', '-b', 'main'], gitRoot);
run('git', ['config', 'user.name', 'VersionDock Runtime Fixture'], gitRoot);
run('git', ['config', 'user.email', 'runtime@example.test'], gitRoot);
writeFileSync(join(gitRoot, '中文 文件.txt'), 'base\n');
run('git', ['add', '.'], gitRoot);
run('git', ['commit', '-m', 'runtime fixture base'], gitRoot);
run('git', ['switch', '-c', 'feature/runtime'], gitRoot);
mkdirSync(join(gitRoot, 'src', 'nested'), { recursive: true });
writeFileSync(join(gitRoot, 'src', 'feature.ts'), 'export const feature = true;\n');
writeFileSync(join(gitRoot, 'src', 'nested', 'details.ts'), 'export const details = "runtime";\n');
run('git', ['add', '.'], gitRoot);
run('git', ['commit', '-m', 'feat: add runtime branch files'], gitRoot);
writeFileSync(join(gitRoot, 'src', 'feature.ts'), 'export const feature = "updated";\n');
run('git', ['add', '.'], gitRoot);
run('git', ['commit', '-m', 'fix: update runtime branch file'], gitRoot);
run('git', ['switch', 'main'], gitRoot);
writeFileSync(join(gitRoot, 'main-only.txt'), 'main branch\n');
run('git', ['add', '.'], gitRoot);
run('git', ['commit', '-m', 'feat: add main-only file'], gitRoot);
writeFileSync(join(gitRoot, '中文 文件.txt'), 'base\nworking change\n');
writeFileSync(join(gitRoot, 'untracked file.txt'), 'untracked\n');

try {
  run('svnadmin', ['create', svnRepository]);
  run('svn', ['checkout', `file://${svnRepository}`, svnWorkingCopy]);
  writeFileSync(join(svnWorkingCopy, '中文 SVN.txt'), 'base\n');
  run('svn', ['add', '中文 SVN.txt'], svnWorkingCopy);
  run('svn', ['commit', '-m', 'runtime fixture base'], svnWorkingCopy);
  writeFileSync(join(svnWorkingCopy, '中文 SVN.txt'), 'base\nworking change\n');
} catch (error) {
  process.stderr.write(`SVN fixture unavailable: ${String(error)}\n`);
}

process.stdout.write(`${root}\n`);
