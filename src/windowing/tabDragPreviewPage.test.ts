import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const html = readFileSync(resolve('public/tab-drag-preview.html'), 'utf8');
const script = readFileSync(resolve('public/tab-drag-preview.js'), 'utf8');

afterEach(() => document.querySelectorAll('iframe[data-preview-test]').forEach((frame) => frame.remove()));

describe('standalone native tab preview page', () => {
  it.each([
    ['dark', 'rgb(37, 37, 38)'],
    ['light', 'rgb(243, 243, 243)'],
  ] as const)('uses the %s preview background without exposing white corners', (theme, background) => {
    const frame = document.createElement('iframe');
    frame.dataset.previewTest = '';
    document.body.append(frame);
    const page = frame.contentDocument!;
    page.documentElement.innerHTML = html;
    runInNewContext(script, { document: page, location: { search: `?theme=${theme}` }, window: {}, URLSearchParams });
    expect(frame.contentWindow!.getComputedStyle(page.body).backgroundColor).toBe(background);
  });

  it.each(['light', 'dark'])('preserves the project name and %s theme', (theme) => {
    const page = document.implementation.createHTMLDocument();
    page.documentElement.innerHTML = html;
    runInNewContext(script, { document: page, location: { search: `?name=VersionDockDesktop&theme=${theme}` }, window: {}, URLSearchParams });
    expect(page.body.classList.contains('light')).toBe(theme === 'light');
    expect(page.querySelector('.titlebar-tab-title')?.textContent).toBe('VersionDockDesktop');
  });

});
