import { IconButton } from '../IconButton';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useI18n } from '../../i18n';
import { isLogEntryInWorkspace, useAppStore } from '../../store/appStore';
import { useResizable } from '../../hooks/useResizable';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBridge } from '../../platform/context';
import { OutputDropdown } from './OutputDropdown';
import { logLevelPriority } from '../../logs/entries';
import type { LogChannel, LogLevel } from '../../bindings/generated';

const LOG_CHANNELS: Array<{ id: LogChannel | 'all'; label: string }> = [
  { id: 'all', label: 'All Channels' },
  { id: 'git', label: 'Git' },
  { id: 'svn', label: 'SVN' },
  { id: 'core', label: 'Core / System' },
  { id: 'ui', label: 'UI' },
];

const LOG_LEVELS: Array<{ id: LogLevel | 'all'; label: string }> = [
  { id: 'all', label: 'All Levels' },
  { id: 'error', label: 'Errors Only' },
  { id: 'warn', label: 'Warnings & Errors' },
  { id: 'info', label: 'Info and above' },
  { id: 'debug', label: 'Debug' },
];

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (!Number.isFinite(date.getTime())) return isoString;
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const millis = date.getMilliseconds().toString().padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
  } catch {
    return isoString;
  }
}

export function OutputPanel() {
  const { t } = useI18n();
  const bridge = useBridge();
  const logPanelOpen = useAppStore((state) => state.logPanelOpen);
  const logPanelHeight = useAppStore((state) => state.logPanelHeight);
  const logError = useAppStore((state) => state.logError);
  const storageError = useAppStore((state) => state.logStorageError);
  const [actionError, setActionError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const logEntries = useAppStore((state) => state.logEntries);
  const activeChannel = useAppStore((state) => state.activeLogChannel);
  const activeLevel = useAppStore((state) => state.activeLogLevel);
  const activeProject = useAppStore((state) => state.activeLogProject);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const searchQuery = useAppStore((state) => state.logSearchQuery);
  const autoScroll = useAppStore((state) => state.logAutoScroll);

  const setLogPanelOpen = useAppStore((state) => state.setLogPanelOpen);
  const setLogPanelHeight = useAppStore((state) => state.setLogPanelHeight);
  const setLogChannel = useAppStore((state) => state.setLogChannel);
  const setLogLevel = useAppStore((state) => state.setLogLevel);
  const setLogProject = useAppStore((state) => state.setLogProject);
  const resolvedProject = activeProject !== 'all' && activeProject !== 'current'
    && !tabs.some((tab) => tab.id === activeProject) ? 'current' : activeProject;
  useEffect(() => {
    if (resolvedProject !== activeProject) setLogProject(resolvedProject);
  }, [resolvedProject, activeProject, setLogProject]);
  const setSearchQuery = useAppStore((state) => state.setLogSearchQuery);
  const setAutoScroll = useAppStore((state) => state.setLogAutoScroll);
  const clearLogs = useAppStore((state) => state.clearLogs);
  const openLogFolder = useAppStore((state) => state.openLogFolder);

  const [copied, setCopied] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(() => new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const retained = new Set(logEntries.map((entry) => entry.id));
    setExpandedDetails((previous) => {
      const next = new Set([...previous].filter((id) => retained.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [logEntries]);

  const resize = useResizable(
    logPanelHeight,
    120,
    600,
    (value) => setLogPanelHeight(value),
    -1,
    'y',
  );

  const projectOptions = useMemo(() => {
    const list: Array<{ id: string; label: string }> = [
      { id: 'current', label: 'Current Project' },
      { id: 'all', label: 'All Projects' },
    ];
    if (tabs.length > 1 || tabs.some((tab) => tab.id === resolvedProject)) {
      tabs.forEach((tab) => {
        list.push({ id: tab.id, label: tab.name });
      });
    }
    return list;
  }, [tabs, resolvedProject]);

  const snapshot = useAppStore((state) => state.snapshot);
  const currentTab = tabs.find((t) => t.id === activeTabId);
  const currentPaths = useMemo(() => {
    if (currentTab) return currentTab.paths;
    if (snapshot) return snapshot.workspace.paths;
    return [];
  }, [currentTab, snapshot]);
  const selectedTab = resolvedProject !== 'current' && resolvedProject !== 'all'
    ? tabs.find((t) => t.id === resolvedProject)
    : null;
  const selectedPaths = useMemo(() => selectedTab ? selectedTab.paths : [], [selectedTab]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return logEntries.filter((entry) => {
      if (resolvedProject === 'current') {
        const workspaceId = currentTab?.id ?? snapshot?.workspace.id;
        if ((currentPaths.length > 0 || workspaceId) && !isLogEntryInWorkspace(entry, currentPaths, workspaceId)) {
          return false;
        }
        if (!workspaceId && currentPaths.length === 0 && (entry.context?.workspaceId || entry.cwd)) return false;
      } else if (resolvedProject !== 'all') {
        if (!isLogEntryInWorkspace(entry, selectedPaths, selectedTab?.id)) {
          return false;
        }
      }
      if (activeChannel !== 'all' && entry.channel !== activeChannel) {
        return false;
      }
      if (activeLevel !== 'all') {
        const threshold = logLevelPriority(activeLevel);
        if (logLevelPriority(entry.level) < threshold) {
          return false;
        }
      }
      if (query) {
        const fields = [entry.message, entry.details, entry.cwd, ...Object.values(entry.context ?? {})];
        if (!fields.some((field) => field?.toLowerCase().includes(query))) return false;
      }
      return true;
    });
  }, [logEntries, resolvedProject, currentPaths, selectedPaths, activeChannel, activeLevel, searchQuery, currentTab?.id, snapshot?.workspace.id, selectedTab?.id]);

  const virtual = filteredEntries.length > 100;
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtual ? filteredEntries.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => filteredEntries[index].id,
    estimateSize: () => 26,
    measureElement: (element) => element.getBoundingClientRect().height || 26,
    gap: 2,
    overscan: 10,
    enabled: virtual && logPanelOpen,
    initialRect: { width: 800, height: logPanelHeight - 44 },
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement;
      if (!element) return;
      const update = () => callback({ width: element.offsetWidth || 800, height: element.offsetHeight || logPanelHeight - 44 });
      update();
      if (!window.ResizeObserver) return;
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    },
  });
  const lastId = filteredEntries.at(-1)?.id;
  const totalHeight = virtualizer.getTotalSize();
  const readerAnchor = useRef<{ id: string; offset: number }>();
  const lastScrollTop = useRef(0);
  useLayoutEffect(() => {
    const element = scrollContainerRef.current;
    if (!logPanelOpen || !element) return;
    if (autoScroll) {
      // Variable row heights may change after measurement; follow the real bottom.
      element.scrollTop = element.scrollHeight;
      readerAnchor.current = undefined;
    } else if (readerAnchor.current) {
      const anchor = readerAnchor.current;
      const index = filteredEntries.findIndex((entry) => entry.id === anchor.id);
      if (index >= 0) {
        if (virtual) {
          const position = virtualizer.getOffsetForIndex(index, 'start');
          if (position) element.scrollTop = position[0] + anchor.offset;
        } else {
          const row = element.querySelector<HTMLElement>(`[data-log-id="${CSS.escape(anchor.id)}"]`);
          if (row) element.scrollTop = row.offsetTop - element.offsetTop + anchor.offset;
        }
      }
    }
    lastScrollTop.current = element.scrollTop;
  }, [lastId, logPanelOpen, autoScroll, totalHeight, filteredEntries, virtual, virtualizer]);

  const rememberAnchor = () => {
    const element = scrollContainerRef.current;
    if (!element) return;
    const item = virtualizer.getVirtualItems().find((item) => item.end > element.scrollTop);
    if (virtual && item) readerAnchor.current = { id: filteredEntries[item.index].id, offset: element.scrollTop - item.start };
  };
  const runAction = async (action: () => Promise<unknown>, failure: string) => {
    setActionError(null);
    try { await action(); } catch { setActionError(failure); }
  };
  const handleCopyLogs = () => runAction(async () => {
    const text = bridge.formatLogs(filteredEntries);
    // WebKit requires clipboard.write during the click, before the native request resolves.
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': text.then((value) => new Blob([value], { type: 'text/plain' })),
      })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  }, 'Unable to copy logs.');
  const handleExportLogs = () => runAction(async () => {
    const path = await bridge.saveFileDialog({
      title: t('Export logs'),
      defaultPath: `versiondock-logs-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: t('Output and Logs'), extensions: ['log'] }],
    });
    if (!path) return;
    if (!await bridge.exportLogs(path, filteredEntries)) throw new Error('Log export failed');
  }, 'Unable to export logs.');

  const toggleDetails = (id: string) => {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!logPanelOpen) return null;

  return (
    <section
      className="output-panel"
      style={{ height: logPanelHeight }}
      role="region"
      aria-label={t('Output and Logs')}
    >
      <div
        className="output-panel-resizer"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-valuemin={120}
        aria-valuemax={600}
        aria-valuenow={logPanelHeight}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          setLogPanelHeight(event.key === 'Home' ? 120 : event.key === 'End' ? 600 : logPanelHeight + (event.key === 'ArrowUp' ? 20 : -20));
        }}
        title={t('Drag to resize output panel')}
      />

      <header className="output-panel-toolbar">
        <div className="output-panel-title">
          <Codicon name="output" />
          <strong>{t('Output')}</strong>
          <span className="output-count-badge">{filteredEntries.length}</span>
        </div>

        <div className="output-panel-controls">
          <OutputDropdown
            ariaLabel={t('Filter by project')}
            value={resolvedProject}
            options={projectOptions}
            onChange={(val) => setLogProject(val)}
            className="output-dropdown-project"
          />

          <OutputDropdown
            ariaLabel={t('Filter by channel')}
            value={activeChannel}
            options={LOG_CHANNELS}
            onChange={(val) => setLogChannel(val)}
            className="output-dropdown-channel"
          />

          <OutputDropdown
            ariaLabel={t('Filter by level')}
            value={activeLevel}
            options={LOG_LEVELS}
            onChange={(val) => setLogLevel(val)}
            className="output-dropdown-level"
          />

          <div className="output-search-wrap">
            <Codicon name="search" className="output-search-icon" />
            <input
              type="text"
              className="output-search-input"
              placeholder={t('Filter output…')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={t('Filter output…')}
            />
            {searchQuery && (
              <IconButton
                type="button"
                className="output-search-clear"
                onClick={() => setSearchQuery('')}
                title={t('Clear filter')}
                aria-label={t('Clear filter')}
              >
                <Codicon name="close" />
              </IconButton>
            )}
          </div>

          <div className="output-actions">
            <IconButton
              type="button"
              className={`output-btn ${autoScroll ? 'active' : ''}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? t('Auto-scroll: ON (Click to lock)') : t('Auto-scroll: OFF (Click to follow)')}
              aria-label={t('Toggle auto scroll')}
            >
              <Codicon name={autoScroll ? 'lock' : 'unlock'} />
            </IconButton>

            <IconButton
              type="button"
              className="output-btn"
              onClick={() => void handleCopyLogs()}
              title={copied ? t('Copied!') : t('Copy all visible output')}
              aria-label={t('Copy logs')}
            >
              <Codicon name={copied ? 'check' : 'copy'} />
            </IconButton>

            <IconButton
              type="button"
              className="output-btn"
              onClick={() => void handleExportLogs()}
              title={t('Export as log file')}
              aria-label={t('Export logs')}
            >
              <Codicon name="desktop-download" />
            </IconButton>

            <IconButton
              type="button"
              className="output-btn"
              onClick={() => void runAction(clearLogs, 'Unable to clear logs.')}
              title={t('Clear output')}
              aria-label={t('Clear output')}
            >
              <Codicon name="clear-all" />
            </IconButton>

            <IconButton
              type="button"
              className="output-btn"
              onClick={() => void runAction(openLogFolder, 'Unable to open log folder.')}
              title={t('Open log folder on disk')}
              aria-label={t('Open log folder')}
            >
              <Codicon name="folder-opened" />
            </IconButton>

            <IconButton
              type="button"
              className="output-btn close"
              onClick={() => setLogPanelOpen(false)}
              title={t('Close output panel')}
              aria-label={t('Close output panel')}
            >
              <Codicon name="close" />
            </IconButton>
          </div>
        </div>
      </header>

      {(actionError || logError || storageError) && <div className="output-error-banner" role="status">
        <Codicon name="warning" />
        <span>{actionError ? t(actionError) : logError ? t(logError) : t('Log files are unavailable. Logs remain available in this window.')}</span>
        {storageError && <span className="output-storage-error" title={t(storageError)}>{t(storageError)}</span>}
      </div>}
      <div
        ref={scrollContainerRef}
        className="output-panel-body"
        role="log"
        aria-live="off"
        tabIndex={0}
        onWheel={(event) => { if (event.deltaY < 0) { rememberAnchor(); setAutoScroll(false); } }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { rememberAnchor(); setAutoScroll(false); }
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (autoScroll && element.scrollTop < lastScrollTop.current && element.scrollHeight - element.clientHeight - element.scrollTop > 8) setAutoScroll(false);
          if (!autoScroll) rememberAnchor();
          lastScrollTop.current = element.scrollTop;
        }}
      >
        {filteredEntries.length === 0 ? (
          <div className="output-empty">
            <Codicon name="info" />
            <span>{searchQuery ? t('No output matching filter.') : t('No log output recorded yet.')}</span>
          </div>
        ) : (
          <div className={`output-log-list ${virtual ? 'virtual' : ''}`} style={virtual ? { height: totalHeight, position: 'relative' } : undefined}>
            {(virtual ? virtualizer.getVirtualItems().map((item) => ({ entry: filteredEntries[item.index], item })) : filteredEntries.map((entry) => ({ entry, item: undefined }))).map(({ entry, item }) => {
              const hasDetails = Boolean(entry.details);
              const isExpanded = expandedDetails.has(entry.id);
              return (
                <div key={entry.id} data-log-id={entry.id} data-index={item?.index}
                  ref={item ? virtualizer.measureElement : undefined}
                  style={item ? { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` } : undefined}
                  className={`output-log-row ${entry.level}`}>
                  <span className="output-log-time">{formatTime(entry.timestamp)}</span>
                  <span className={`output-log-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
                  <span className="output-log-channel">[{entry.channel.toUpperCase()}]</span>
                  {resolvedProject === 'all' && (() => {
                    const matchedTab = entry.cwd || entry.context?.workspaceId ? tabs.find((tab) => isLogEntryInWorkspace(entry, tab.paths, tab.id)) : undefined;
                    const name = entry.context?.workspaceName ?? matchedTab?.name ?? entry.context?.workspaceId;
                    return name ? <span className="output-log-project" title={entry.cwd ?? undefined}>[{name}]</span> : null;
                  })()}
                  {entry.context?.repositoryName && <span className="output-log-project" title={entry.cwd ?? undefined}>[{entry.context.repositoryName}]</span>}
                  <span className="output-log-msg">{t(entry.message)}</span>
                  {entry.durationMs !== null && entry.durationMs !== undefined && (
                    <span className="output-log-duration">{entry.durationMs}ms</span>
                  )}
                  {entry.exitCode !== null && entry.exitCode !== undefined && entry.exitCode !== 0 && (
                    <span className="output-log-exit-code">exit {entry.exitCode}</span>
                  )}
                  {hasDetails && (
                    <IconButton
                      type="button"
                      aria-expanded={isExpanded}
                      className="output-log-details-toggle"
                      onClick={() => toggleDetails(entry.id)}
                      title={isExpanded ? t('Collapse details') : t('Expand details')}
                    >
                      <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
                      <span>{t('Details')}</span>
                    </IconButton>
                  )}
                  {hasDetails && isExpanded && (
                    <div className="output-log-details-box">
                      <pre>{entry.details}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
