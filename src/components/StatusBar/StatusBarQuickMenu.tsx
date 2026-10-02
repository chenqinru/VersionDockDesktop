import { Children, cloneElement, forwardRef, isValidElement, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Codicon } from '../Codicon';
import { IconButton } from '../IconButton';
import { useI18n } from '../../i18n';

function itemText(node: ReactNode): string {
  return Children.toArray(node).map((child) => typeof child === 'string' || typeof child === 'number' ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? itemText(child.props.children) : '').join(' ');
}

// Filter the React item tree, including descriptions/details, before rendering it.
// Keeping handlers on the original elements avoids a second action model.
function filterItems(children: ReactNode, terms: string[]): ReactNode {
  return Children.toArray(children).flatMap((child): ReactNode[] => {
    if (!isValidElement<{ children?: ReactNode; className?: string; label?: string; description?: string; detail?: string }>(child)) return [child];
    if (child.type === 'button' || child.props.className?.includes('non-clickable') || typeof child.props.label === 'string') {
      const text = typeof child.props.label === 'string' ? [child.props.label, child.props.description, child.props.detail].filter(Boolean).join(' ') : itemText(child);
      return terms.every((term) => text.toLocaleLowerCase().includes(term)) ? [child] : [];
    }
    if (child.props.className?.includes('statusbar-menu-divider')) return [];
    if (!child.props.children) return [child];
    const next = filterItems(child.props.children, terms);
    if (Children.toArray(next).length === 0) return [];
    if (child.props.className?.includes('statusbar-menu-section') && !Children.toArray(next).some((item) => isValidElement<{ className?: string }>(item) && !item.props.className?.includes('group-header'))) return [];
    return [cloneElement(child, {}, next)];
  });
}

interface Props { title: string; active: boolean; onSearch?: () => void; onBack?: () => void; style?: CSSProperties; className?: string; children: ReactNode }

export const StatusBarQuickMenu = forwardRef<HTMLDivElement, Props>(function StatusBarQuickMenu({ title, active, onSearch, onBack, style, className = '', children }, ref) {
  const { t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const content = useMemo(() => query.trim() ? filterItems(children, query.toLocaleLowerCase().trim().split(/\s+/)) : children, [children, query]);

  useLayoutEffect(() => { if (active) input.current?.focus(); }, [active]);
  useLayoutEffect(() => {
    const items = body.current?.querySelectorAll<HTMLButtonElement>('button.statusbar-menu-item:not(:disabled)');
    items?.forEach((item, index) => {
      item.id = `${id}-item-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === highlighted));
      item.classList.toggle('keyboard-selected', index === highlighted);
    });
    items?.[highlighted]?.scrollIntoView?.({ block: 'nearest' });
  }, [content, highlighted, id]);

  return <div role="dialog" aria-label={title} ref={ref} className={`statusbar-submenu statusbar-quick-menu ${className}`} style={style}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return;
    const items = body.current?.querySelectorAll<HTMLButtonElement>('button.statusbar-menu-item:not(:disabled)');
    if (!items?.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (event.key === 'Home' || event.key === 'End') { setHighlighted(event.key === 'Home' ? 0 : items.length - 1); return; }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((index) => index < 0 ? direction > 0 ? 0 : items.length - 1 : (index + direction + items.length) % items.length);
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault();
      items[highlighted < 0 ? 0 : Math.min(highlighted, items.length - 1)]?.click();
    }
  }}>
    <div className="branch-menu-toolbar">
      <div className="branch-menu-heading">
        {onBack && <IconButton title={t('Back')} onClick={onBack}><Codicon name="arrow-left" /></IconButton>}
        <span title={title}>{title}</span>
      </div>
      <div className="branch-menu-search">
        <Codicon name="search" className="branch-menu-search-icon" />
        <input ref={input} aria-label={t('Filter…')} placeholder={t('Filter…')} value={query}
          role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`}
          aria-activedescendant={highlighted >= 0 ? `${id}-item-${highlighted}` : undefined}
          onChange={(event) => { onSearch?.(); setQuery(event.target.value); setHighlighted(-1); }} />
        <IconButton title={t('Clear search')} className={query ? '' : 'branch-menu-clear-hidden'} tabIndex={query ? 0 : -1} aria-hidden={!query}
          onClick={() => { onSearch?.(); setQuery(''); setHighlighted(-1); input.current?.focus(); }}><Codicon name="close" /></IconButton>
      </div>
    </div>
    <div ref={body} id={`${id}-list`} role="listbox" aria-label={title} className="statusbar-popover-content">{content}</div>
    {query && Children.toArray(content).length === 0 && <div className="statusbar-popover-empty">{t('No matches')}</div>}
  </div>;
});
