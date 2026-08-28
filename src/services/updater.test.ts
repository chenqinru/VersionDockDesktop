import { describe, expect, it } from 'vitest';
import { generateDiagnosticReport, isNewerVersion, APP_CURRENT_VERSION } from './updater';

describe('updater service', () => {
  describe('isNewerVersion', () => {
    it('correctly compares semantic versions', () => {
      expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true);
      expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
      expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true);
      expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
      expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false);
      expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
    });
  });

  describe('generateDiagnosticReport', () => {
    it('generates markdown report with system and tools information', () => {
      const snapshot = {
        generation: 1,
        workspace: { id: 'ws-1', name: 'Test WS', paths: ['/path/to/repo'], available: true, lastOpenedAt: new Date().toISOString() },
        tools: { git: true, svn: false, svnadmin: false },
        repositories: [],
      };
      const settings = {
        theme: 'dark' as const,
        language: 'en' as const,
        uiFontSize: 'standard' as const,
        changesDisplayMode: 'simplified' as const,
        defaultCommitAction: 'commit' as const,
        defaultSaveAction: 'stash' as const,
        promptBeforeAddingUntracked: true,
        suppressDivergedWarning: false,
        autoRefreshInterval: 0,
        fetchOnStartup: false,
        resetViewLocationsOnStartup: false,
        notifyIncomingCommits: false,
        notifyUnpushedCommits: false,
        autoCheckUpdates: true,
        repositoryScanDepth: 4,
        ignoredFolders: [],
        maximumGraphCommits: 1000,
        projectColors: {},
        externalEditor: null,
      };

      const report = generateDiagnosticReport(snapshot, settings);
      expect(report).toContain(`- **App Version**: v${APP_CURRENT_VERSION}`);
      expect(report).toContain('- **Git**: Available / Installed');
      expect(report).toContain('- **SVN**: Not installed');
      expect(report).toContain('- **Auto Check Updates**: Enabled');
    });
  });
});
