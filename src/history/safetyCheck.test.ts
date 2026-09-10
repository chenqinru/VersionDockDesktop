import { describe, expect, it } from 'vitest';
import { checkCommitSafety, isSensitivePath } from './safetyCheck';

describe('safetyCheck', () => {
  it('detects sensitive files correctly', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('.env.local')).toBe(true);
    expect(isSensitivePath('.env.production')).toBe(true);
    expect(isSensitivePath('server.key')).toBe(true);
    expect(isSensitivePath('cert.pem')).toBe(true);
    expect(isSensitivePath('id_rsa')).toBe(true);
    expect(isSensitivePath('id_ed25519.pub')).toBe(true);

    expect(isSensitivePath('.env.example')).toBe(false);
    expect(isSensitivePath('regular.ts')).toBe(false);
  });

  it('runs commit safety check and returns aggregated issues', () => {
    const safePaths = ['src/index.ts', 'package.json', 'README.md', '.env.example'];
    const safeResult = checkCommitSafety(safePaths);
    expect(safeResult.hasIssues).toBe(false);
    expect(safeResult.sensitiveFiles).toHaveLength(0);
    expect(safeResult.invalidFileNameFiles).toHaveLength(0);

    const dangerousPaths = [
      'src/.env.local',
      'keys/private.key',
      'docs/con.txt',
      'invalid:name.txt',
    ];
    const dangerousResult = checkCommitSafety(dangerousPaths);
    expect(dangerousResult.hasIssues).toBe(true);
    expect(dangerousResult.sensitiveFiles).toEqual(['src/.env.local', 'keys/private.key']);
    expect(dangerousResult.invalidFileNameFiles).toHaveLength(2);
  });
});
