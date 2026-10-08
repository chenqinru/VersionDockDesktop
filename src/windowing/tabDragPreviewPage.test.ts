import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('public/tab-drag-preview.html'), 'utf8');
const script = readFileSync(resolve('public/tab-drag-preview.js'), 'utf8');

describe('standalone native tab preview page', () => {
  it.each(['light', 'dark'])('renders the badge with the %s preview and preserves the project name', (theme) => {
    const page = document.implementation.createHTMLDocument();
    page.documentElement.innerHTML = html;
    runInNewContext(script, { document: page, location: { search: `?name=VersionDockDesktop&theme=${theme}&detachBadge=true` }, window: {}, URLSearchParams });
    expect(page.body.classList.contains('show-detach-badge')).toBe(true);
    expect(page.body.classList.contains('light')).toBe(theme === 'light');
    expect(page.querySelector('.tab-detach-badge')?.getAttribute('aria-hidden')).toBe('true');
    expect(page.querySelector('.titlebar-tab-title')?.textContent).toBe('VersionDockDesktop');
  });

  it('leaves the badge hidden for the macOS native copy cursor', () => {
    const page = document.implementation.createHTMLDocument();
    page.documentElement.innerHTML = html;
    runInNewContext(script, { document: page, location: { search: '?name=Mac&detachBadge=false' }, window: {}, URLSearchParams });
    expect(page.body.classList.contains('show-detach-badge')).toBe(false);
  });
});
