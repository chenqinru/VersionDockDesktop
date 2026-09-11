import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Codicon } from './Codicon';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  separator?: false;
}
export interface ContextMenuSeparator {
  separator: true;
}
export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const activeEl = document.activeElement;
      if (activeEl?.tagName !== 'INPUT' && activeEl?.tagName !== 'TEXTAREA') {
        sel.removeAllRanges();
      }
    }
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const posX = x + w > vw - margin ? Math.max(margin, vw - w - margin) : Math.max(margin, x);
    const posY = y + h > vh - margin ? Math.max(margin, vh - h - margin) : Math.max(margin, y);
    setPos({ x: posX, y: posY });
  }, [x, y]);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      const entries = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (!entries.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const current = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (current === -1) {
        entries[e.key === 'ArrowUp' ? entries.length - 1 : 0]?.focus();
        return;
      }
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? entries.length - 1
        : e.key === 'ArrowDown' ? (current + 1 + entries.length) % entries.length
          : (current - 1 + entries.length) % entries.length;
      entries[next]?.focus();
    };
    const blurHandler = () => onClose();
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') onClose();
    };
    document.addEventListener('mousedown', handler, true);
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    window.addEventListener('pagehide', blurHandler);
    return () => {
      document.removeEventListener('mousedown', handler, true);
      document.removeEventListener('keydown', keyHandler);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
      window.removeEventListener('pagehide', blurHandler);
      trigger?.focus();
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: pos ? pos.y : y,
    left: pos ? pos.x : x,
    zIndex: 99999,
    visibility: pos ? 'visible' : 'hidden',
    pointerEvents: pos ? 'auto' : 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ ...styles.menu, ...style }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => {
        if ('separator' in item && item.separator) {
          return <div key={i} style={styles.separator} />;
        }
        const it = item as ContextMenuItem;
        return (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            title={it.disabled ? it.disabledReason : undefined}
            style={styles.item(!!it.danger, !!it.disabled)}
            onClick={() => { if (!it.disabled) { onSelect(it.id); onClose(); } }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--vscode-list-hoverBackground, var(--versiondock-hover))'; }}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Codicon name={it.icon} style={styles.icon} />
            <span>{it.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

const styles = {
  menu: {
    background: 'var(--vscode-menu-background, var(--versiondock-surface-alt, var(--versiondock-surface)))',
    border: '1px solid var(--vscode-menu-border, var(--versiondock-border))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    minWidth: '180px',
    padding: '4px 0',
    fontSize: '12px',
    color: 'var(--vscode-menu-foreground, var(--versiondock-text))',
    userSelect: 'none' as const,
  },
  item: (danger: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 12px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.48 : 1,
    background: 'transparent',
    color: danger
      ? 'var(--vscode-errorForeground, var(--versiondock-danger))'
      : 'var(--vscode-menu-foreground, var(--versiondock-text))',
    transition: 'background 0.08s',
    width: '100%',
    border: 0,
    textAlign: 'left',
    font: 'inherit',
  }),
  icon: {
    fontSize: '14px',
    flexShrink: 0,
  },
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground, var(--versiondock-border-soft, var(--versiondock-border)))',
    margin: '4px 0',
  } as React.CSSProperties,
};
