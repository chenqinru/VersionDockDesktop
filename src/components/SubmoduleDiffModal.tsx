import { IconButton } from './IconButton';
import { useRef } from 'react';
import { Codicon } from './Codicon';
import { useI18n } from '../i18n';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap';
import { useAppStore } from '../store/appStore';
import type { FileChange, RepositoryStatus } from '../bindings/generated';

interface SubmoduleDiffModalProps {
  repo: RepositoryStatus;
  file: FileChange;
  onClose: () => void;
  onRevealPanel: () => void;
}

export function SubmoduleDiffModal({
  repo,
  file,
  onClose,
  onRevealPanel,
}: SubmoduleDiffModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(true, onClose);

  const submodules = useAppStore((state) => state.submodules[repo.meta.id] ?? []);
  const submoduleOperation = useAppStore((state) => state.submoduleOperation);

  const sub = submodules.find((s) => s.path === file.path);
  const parentCommit = sub?.recordedCommit || null;
  const indexCommit = sub?.indexCommit || null;
  const headCommit = sub?.revision || null;
  const summary = sub?.diffSummary || null;

  const handleAlign = async () => {
    await submoduleOperation(repo.meta.id, {
      type: 'update',
      path: file.path,
      init: false,
      recursive: false,
      remote: false,
    });
    onClose();
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('Submodule Pointer Diff')}
        style={{ width: 520, maxWidth: '90vw' }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))' }}>
          <Codicon name="repo-clone" style={{ fontSize: 16 }} />
          <strong style={{ fontSize: 13, flex: 1 }}>{t('Submodule Pointer Diff')}</strong>
          <IconButton
            type="button"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', padding: 4 }}
            onClick={onClose}
            title={t('Close')}
          >
            <Codicon name="close" />
          </IconButton>
        </header>

        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, wordBreak: 'break-all' }}>
            <span style={{ fontWeight: 600 }}>{repo.meta.name}</span> / {file.path}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '12px',
              backgroundColor: 'var(--vscode-sideBar-background, rgba(0, 0, 0, 0.15))',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 4 }}>{t('Parent Commit')}</div>
              <div style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}>
                <Codicon name="git-commit" style={{ marginRight: 4, opacity: 0.7 }} />
                {parentCommit ? parentCommit.slice(0, 8) : '--------'}
              </div>
            </div>

            <Codicon name="arrow-right" style={{ opacity: 0.5, flexShrink: 0 }} />

            {indexCommit && indexCommit !== parentCommit && (
              <>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 4 }}>{t('Staged in Index')}</div>
                  <div style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600, color: 'var(--vscode-gitDecoration-stageModifiedResourceForeground, #89d185)' }}>
                    <Codicon name="git-commit" style={{ marginRight: 4, opacity: 0.7 }} />
                    {indexCommit.slice(0, 8)}
                  </div>
                </div>
                <Codicon name="arrow-right" style={{ opacity: 0.5, flexShrink: 0 }} />
              </>
            )}

            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 4 }}>{t('Current Submodule HEAD')}</div>
              <div style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontWeight: 600 }}>
                <Codicon name="git-commit" style={{ marginRight: 4, opacity: 0.7 }} />
                {headCommit ? headCommit.slice(0, 8) : '--------'}
              </div>
            </div>
          </div>

          {summary && (
            <div
              style={{
                marginTop: 4,
                padding: 10,
                backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2))',
                borderRadius: 4,
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                maxHeight: 140,
                overflowY: 'auto',
              }}
            >
              {summary}
            </div>
          )}
        </div>

        <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--vscode-panel-border, var(--versiondock-border-soft))' }}>
          <button
            type="button"
            onClick={() => {
              onClose();
              onRevealPanel();
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Codicon name="link-external" />
            {t('View in Submodule Panel')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handleAlign()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Codicon name="refresh" />
            {t('Align Submodule with Parent')}
          </button>
        </footer>
      </section>
    </div>
  );
}
