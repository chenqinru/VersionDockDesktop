import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const html = readFileSync(resolve('public/tab-drag-preview.html'), 'utf8');
const script = readFileSync(resolve('public/tab-drag-preview.js'), 'utf8');

afterEach(() => document.querySelectorAll('iframe[data-preview-test]').forEach((frame) => frame.remove()));

describe('standalone native tab preview page', () => {
  it.each([
    ['dark', false, 'rgb(37, 37, 38)'],
    ['light', false, 'rgb(243, 243, 243)'],
    ['dark', true, 'rgba(0, 0, 0, 0)'],
    ['light', true, 'rgba(0, 0, 0, 0)'],
  ] as const)('uses the %s preview background with detachBadge=%s without exposing white corners', (theme, badge, background) => {
    const frame = document.createElement('iframe');
    frame.dataset.previewTest = '';
    document.body.append(frame);
    const page = frame.contentDocument!;
    page.documentElement.innerHTML = html;
    runInNewContext(script, { document: page, location: { search: `?theme=${theme}&detachBadge=${badge}` }, window: {}, URLSearchParams });
    expect(frame.contentWindow!.getComputedStyle(page.body).backgroundColor).toBe(background);
  });

  it.each(['light', 'dark'])('renders the badge with the %s preview and preserves the project name', (theme) => {
    const page = document.implementation.createHTMLDocument();
    page.documentElement.innerHTML = html;
    runInNewContext(script, { document: page, location: { search: `?name=VersionDockDesktop&theme=${theme}&detachBadge=true` }, window: {}, URLSearchParams });
    expect(page.body.classList.contains('show-detach-badge')).toBe(true);
    expect(page.body.classList.contains('light')).toBe(theme === 'light');
    expect(page.querySelector('.tab-detach-badge')?.getAttribute('aria-hidden')).toBe('true');
    expect(page.querySelector('.titlebar-tab-title')?.textContent).toBe('VersionDockDesktop');
    expect(page.querySelector('.tab-preview-label')?.contains(page.querySelector('.tab-detach-badge'))).toBe(false);
  });

  it('leaves the badge hidden for the macOS native copy cursor', () => {
    const page = document.implementation.createHTMLDocument();
    page.documentElement.innerHTML = html;
    runInNewContext(script, { document: page, location: { search: '?name=Mac&detachBadge=false' }, window: {}, URLSearchParams });
    expect(page.body.classList.contains('show-detach-badge')).toBe(false);
  });
});
