import type { LogEntry, LogLevel } from '../bindings/generated';

export const LOG_LIMIT = 3000;
export const logLevelPriority = (level: LogLevel): number => ['trace', 'debug', 'info', 'warn', 'error'].indexOf(level);

/** Merge the snapshot and live stream by ID; late worker records keep their original time. */
export function mergeLogEntries(...batches: LogEntry[][]): LogEntry[] {
  const byId = new Map<string, LogEntry>();
  for (const batch of batches) for (const entry of batch) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => {
    const left = Date.parse(a.timestamp);
    const right = Date.parse(b.timestamp);
    return ((Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0))
      || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
  }).slice(-LOG_LIMIT);
}

/** Browser demo only. The native app uses the Rust formatter for disk, copy and export. */
export function formatDemoLogs(entries: LogEntry[]): string {
  const singleLine = (text: string) => text.replace(/[\r\n]/g, ' ');
  return entries.map((entry) => {
    let line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.channel.toUpperCase()}] ${entry.message.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`;
    const context = entry.context;
    for (const [label, value] of [
      ['workspace', context?.workspaceName ?? context?.workspaceId],
      ['repository', context?.repositoryName ?? context?.repositoryId],
      ['operation', context?.operationId],
      ['cwd', entry.cwd],
    ]) if (value) line += ` [${label}=${singleLine(value)}]`;
    if (entry.durationMs != null) line += ` (took ${entry.durationMs}ms)`;
    if (entry.exitCode != null) line += ` (exit ${entry.exitCode})`;
    if (entry.details?.trim()) line += `\n${entry.details}`;
    return line;
  }).join('\n');
}
