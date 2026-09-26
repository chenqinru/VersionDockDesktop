import { describe, expect, it, vi } from 'vitest';
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

  it('performs safety check with error fallback when bridge fails', async () => {
    const { performCommitSafetyCheck } = await import('./safetyCheck');
    const { useAppStore } = await import('../store/appStore');

    // 1. 无 bridge 场景
    useAppStore.setState({ bridge: undefined });
    const noBridgeResult = await performCommitSafetyCheck('ws', 'repo', ['test.txt']);
    expect(noBridgeResult.checkError).toContain('bridge not available');

    // 2. bridge 抛出异常场景
    const mockBridge = {
      request: vi.fn().mockRejectedValue(new Error('Backend daemon unreachable')),
    };
    useAppStore.setState({ bridge: mockBridge as any });
    const errorResult = await performCommitSafetyCheck('ws', 'repo', ['.env', 'normal.txt']);
    expect(errorResult.checkError).toBe('Backend daemon unreachable');
    // 静态敏感文件识别依然有效
    expect(errorResult.hasIssues).toBe(true);
    expect(errorResult.sensitiveFiles).toContain('.env');
  });

  it('passes staged_only to bridge payload when stagedOnly is provided', async () => {
    const { performCommitSafetyCheck } = await import('./safetyCheck');
    const { useAppStore } = await import('../store/appStore');

    const mockBridge = {
      request: vi.fn().mockResolvedValue({
        hasIssues: false,
        sensitiveFiles: [],
        largeFiles: [],
        invalidFileNameFiles: [],
        crlfFiles: [],
      }),
    };
    useAppStore.setState({ bridge: mockBridge as any });

    await performCommitSafetyCheck('ws-1', 'repo-1', ['a.txt'], true);
    expect(mockBridge.request).toHaveBeenCalledWith({
      type: 'commitSafetyCheck',
      payload: {
        workspace_id: 'ws-1',
        repo_id: 'repo-1',
        paths: ['a.txt'],
        staged_only: true,
      },
    });

    await performCommitSafetyCheck('ws-1', 'repo-1', ['b.txt'], false);
    expect(mockBridge.request).toHaveBeenCalledWith({
      type: 'commitSafetyCheck',
      payload: {
        workspace_id: 'ws-1',
        repo_id: 'repo-1',
        paths: ['b.txt'],
        staged_only: false,
      },
    });
  });
});
