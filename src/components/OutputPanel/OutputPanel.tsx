import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { useI18n } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { useResizable } from '../../hooks/useResizable';
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

function levelPriority(level: LogLevel): number {
  switch (level) {
    case 'error': return 4;
    case 'warn': return 3;
    case 'info': return 2;
    case 'debug': return 1;
    case 'trace': return 0;
    default: return 2;
  }
}

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
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

function OutputDropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (val: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  return (
    <div ref={containerRef} className={`output-dropdown-container ${className} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className={`output-dropdown-trigger ${open ? 'active' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="output-dropdown-label">{t(selectedOption.label)}</span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>

      {open && (
        <div className="output-dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((opt) => {
            const isSelected = opt.id === value;
            return (
              <div
                key={opt.id}
                role="option"
                aria-selected={isSelected}
                className={`output-dropdown-item ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
              >
                <span className="output-dropdown-item-text">{t(opt.label)}</span>
                {isSelected && <Codicon name="check" className="output-dropdown-check" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function OutputPanel() {
  const { t } = useI18n();
  const logPanelOpen = useAppStore((state) => state.logPanelOpen);
  const logPanelHeight = useAppStore((state) => state.logPanelHeight);
  const logEntries = useAppStore((state) => state.logEntries);
  const activeChannel = useAppStore((state) => state.activeLogChannel);
  const activeLevel = useAppStore((state) => state.activeLogLevel);
  const searchQuery = useAppStore((state) => state.logSearchQuery);
  const autoScroll = useAppStore((state) => state.logAutoScroll);

  const setLogPanelOpen = useAppStore((state) => state.setLogPanelOpen);
  const setLogPanelHeight = useAppStore((state) => state.setLogPanelHeight);
  const setLogChannel = useAppStore((state) => state.setLogChannel);
  const setLogLevel = useAppStore((state) => state.setLogLevel);
  const setSearchQuery = useAppStore((state) => state.setLogSearchQuery);
  const setAutoScroll = useAppStore((state) => state.setLogAutoScroll);
  const clearLogs = useAppStore((state) => state.clearLogs);
  const openLogFolder = useAppStore((state) => state.openLogFolder);

  const [copied, setCopied] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(() => new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const resize = useResizable(
    logPanelHeight,
    120,
    600,
    (value) => setLogPanelHeight(value),
    -1,
    'y',
  );

  const filteredEntries = useMemo(() => {
    return logEntries.filter((entry) => {
      if (activeChannel !== 'all' && entry.channel !== activeChannel) {
        return false;
      }
      if (activeLevel !== 'all') {
        const threshold = levelPriority(activeLevel);
        if (levelPriority(entry.level) < threshold) {
          return false;
        }
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const msgMatch = entry.message.toLowerCase().includes(q);
        const detailsMatch = entry.details?.toLowerCase().includes(q);
        if (!msgMatch && !detailsMatch) {
          return false;
        }
      }
      return true;
    });
  }, [logEntries, activeChannel, activeLevel, searchQuery]);

  useEffect(() => {
    if (!logPanelOpen || !autoScroll || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current;
    el.scrollTop = el.scrollHeight;
  }, [filteredEntries.length, logPanelOpen, autoScroll]);

  const handleCopyLogs = async () => {
    const text = filteredEntries
      .map((entry) => {
        let line = `[${formatTime(entry.timestamp)}] [${entry.level.toUpperCase()}] [${entry.channel.toUpperCase()}] ${entry.message}`;
        if (entry.durationMs !== null && entry.durationMs !== undefined) {
          line += ` (${entry.durationMs}ms)`;
        }
        if (entry.exitCode !== null && entry.exitCode !== undefined) {
          line += ` [exit ${entry.exitCode}]`;
        }
        if (entry.details) {
          line += `\n${entry.details}`;
        }
        return line;
      })
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略复制异常
    }
  };

  const handleExportLogs = async () => {
    const text = filteredEntries
      .map((entry) => {
        let line = `[${formatTime(entry.timestamp)}] [${entry.level.toUpperCase()}] [${entry.channel.toUpperCase()}] ${entry.message}`;
        if (entry.durationMs !== null && entry.durationMs !== undefined) {
          line += ` (${entry.durationMs}ms)`;
        }
        if (entry.exitCode !== null && entry.exitCode !== undefined) {
          line += ` [exit ${entry.exitCode}]`;
        }
        if (entry.details) {
          line += `\n${entry.details}`;
        }
        return line;
      })
      .join('\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `versiondock-logs-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
              <button
                type="button"
                className="output-search-clear"
                onClick={() => setSearchQuery('')}
                title={t('Clear filter')}
                aria-label={t('Clear filter')}
              >
                <Codicon name="close" />
              </button>
            )}
          </div>

          <div className="output-actions">
            <button
              type="button"
              className={`output-btn ${autoScroll ? 'active' : ''}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? t('Auto-scroll: ON (Click to lock)') : t('Auto-scroll: OFF (Click to follow)')}
              aria-label={t('Toggle auto scroll')}
            >
              <Codicon name={autoScroll ? 'lock' : 'unlock'} />
            </button>

            <button
              type="button"
              className="output-btn"
              onClick={() => void handleCopyLogs()}
              title={copied ? t('Copied!') : t('Copy all visible output')}
              aria-label={t('Copy logs')}
            >
              <Codicon name={copied ? 'check' : 'copy'} />
            </button>

            <button
              type="button"
              className="output-btn"
              onClick={() => void handleExportLogs()}
              title={t('Export as log file')}
              aria-label={t('Export logs')}
            >
              <Codicon name="desktop-download" />
            </button>

            <button
              type="button"
              className="output-btn"
              onClick={() => void clearLogs()}
              title={t('Clear output')}
              aria-label={t('Clear output')}
            >
              <Codicon name="clear-all" />
            </button>

            <button
              type="button"
              className="output-btn"
              onClick={() => void openLogFolder()}
              title={t('Open log folder on disk')}
              aria-label={t('Open log folder')}
            >
              <Codicon name="folder-opened" />
            </button>

            <button
              type="button"
              className="output-btn close"
              onClick={() => setLogPanelOpen(false)}
              title={t('Close output panel')}
              aria-label={t('Close output panel')}
            >
              <Codicon name="close" />
            </button>
          </div>
        </div>
      </header>

      <div
        ref={scrollContainerRef}
        className="output-panel-body"
        role="log"
        aria-live="polite"
      >
        {filteredEntries.length === 0 ? (
          <div className="output-empty">
            <Codicon name="info" />
            <span>{searchQuery ? t('No output matching filter.') : t('No log output recorded yet.')}</span>
          </div>
        ) : (
          <div className="output-log-list">
            {filteredEntries.map((entry) => {
              const hasDetails = Boolean(entry.details);
              const isExpanded = expandedDetails.has(entry.id);
              return (
                <div key={entry.id} className={`output-log-row ${entry.level}`}>
                  <span className="output-log-time">{formatTime(entry.timestamp)}</span>
                  <span className={`output-log-level ${entry.level}`}>{entry.level.toUpperCase()}</span>
                  <span className="output-log-channel">[{entry.channel.toUpperCase()}]</span>
                  <span className="output-log-msg">{entry.message}</span>
                  {entry.durationMs !== null && entry.durationMs !== undefined && (
                    <span className="output-log-duration">{entry.durationMs}ms</span>
                  )}
                  {entry.exitCode !== null && entry.exitCode !== undefined && entry.exitCode !== 0 && (
                    <span className="output-log-exit-code">exit {entry.exitCode}</span>
                  )}
                  {hasDetails && (
                    <button
                      type="button"
                      className="output-log-details-toggle"
                      onClick={() => toggleDetails(entry.id)}
                      title={isExpanded ? t('Collapse details') : t('Expand details')}
                    >
                      <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
                      <span>{t('Details')}</span>
                    </button>
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
