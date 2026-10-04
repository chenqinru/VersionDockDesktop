import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../bindings/generated';
import { formatDemoLogs, mergeLogEntries } from './entries';
const log = (id: string, timestamp: string): LogEntry => ({ id, timestamp, level: 'info', channel: 'git', message: id, details: null, durationMs: null, exitCode: null, cwd: null });
describe('log entries', () => {
  it('merges live events with a late snapshot and deduplicates by ID', () => {
    const older = log('older', '2026-10-04T00:00:00Z');
    const newer = log('newer', '2026-10-04T00:00:01Z');
    expect(mergeLogEntries([newer], [older, newer]).map((entry) => entry.id)).toEqual(['older', 'newer']);
    expect(mergeLogEntries([{ ...older, message: 'snapshot' }], [{ ...older, message: 'live' }])[0].message).toBe('live');
  });
  it('retains the latest 3000 records when worker events arrive out of order', () => {
    const entries = Array.from({ length: 3100 }, (_, i) => log(String(i), new Date(i * 1000).toISOString()));
    const merged = mergeLogEntries(entries.slice(3000), entries.slice(0, 3000));
    expect(merged).toHaveLength(3000);
    expect(merged[0].id).toBe('100');
    expect(merged.at(-1)?.id).toBe('3099');
  });
  it('browser formatting includes sources and keeps multiline messages on one header', () => {
    const entry = { ...log('test', '2026-10-04T00:00:00Z'), message: 'first\nsecond', details: 'output', durationMs: 5, exitCode: 1, cwd: '/tmp/repo', context: { workspaceId: 'w', workspaceName: 'Workspace', repositoryId: 'r', repositoryName: 'Repository', operationId: 'op' } };
    expect(formatDemoLogs([entry])).toBe('[2026-10-04T00:00:00Z] [INFO] [GIT] first\\nsecond [workspace=Workspace] [repository=Repository] [operation=op] [cwd=/tmp/repo] (took 5ms) (exit 1)\noutput');
  });
});
