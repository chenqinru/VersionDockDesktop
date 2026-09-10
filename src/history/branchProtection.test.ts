import { describe, expect, it } from 'vitest';
import { isBranchProtected, sanitizeBranchName, validateBranchNameInput } from './branchProtection';

describe('branchProtection', () => {
  it('correctly identifies default protected branches', () => {
    expect(isBranchProtected('main')).toBe(true);
    expect(isBranchProtected('master')).toBe(true);
    expect(isBranchProtected('origin/main')).toBe(true);
    expect(isBranchProtected('remotes/origin/master')).toBe(true);
    expect(isBranchProtected('release/1.0')).toBe(true);
    expect(isBranchProtected('origin/release/2.0.0')).toBe(true);

    expect(isBranchProtected('feature/login')).toBe(false);
    expect(isBranchProtected('bugfix/issue-123')).toBe(false);
    expect(isBranchProtected('HEAD')).toBe(false);
  });

  it('supports custom protection patterns', () => {
    const patterns = ['production', 'stable/*', 'hotfix/**'];
    expect(isBranchProtected('production', patterns)).toBe(true);
    expect(isBranchProtected('stable/v1', patterns)).toBe(true);
    expect(isBranchProtected('hotfix/critical/p1', patterns)).toBe(true);
    expect(isBranchProtected('main', patterns)).toBe(false);
  });

  it('sanitizes branch names according to git-check-ref-format rules', () => {
    expect(sanitizeBranchName('feature login')).toBe('feature-login');
    expect(sanitizeBranchName('feature/login ')).toBe('feature/login');
    expect(sanitizeBranchName('feature..login')).toBe('feature-login');
    expect(sanitizeBranchName('feature/branch.lock')).toBe('feature/branch');
    expect(sanitizeBranchName('feat~1^2:3?4*5[6\\7@{8')).toBe('feat-1-2-3-4-5-6-7-8');
    expect(sanitizeBranchName('//feature///test//')).toBe('feature/test');
  });

  it('validates branch name inputs with friendly warnings', () => {
    const fakeT = (key: string, ...args: Array<string | number>) =>
      args.length > 0 ? key.replace('{0}', String(args[0])) : key;

    expect(validateBranchNameInput('', fakeT).valid).toBe(false);
    expect(validateBranchNameInput('   ', fakeT).valid).toBe(false);

    const result = validateBranchNameInput('feature login', fakeT);
    expect(result.valid).toBe(true);
    expect(result.formatted).toBe('feature-login');
    expect(result.error).toBeDefined();

    const okResult = validateBranchNameInput('feature-login', fakeT);
    expect(okResult.valid).toBe(true);
    expect(okResult.error).toBeUndefined();
  });
});
