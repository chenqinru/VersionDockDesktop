import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MockBridge } from '../platform/bridge';
import { createTranslator } from '../i18n';
import { useWindowsCaptionLabels } from './useWindowsCaptionLabels';

const bridge = new MockBridge(() => null);
bridge.platform = () => 'windows';
function Labels({ language = 'zh-CN' }: { language?: 'en' | 'zh-CN' }) {
  useWindowsCaptionLabels(bridge, createTranslator(language));
  return null;
}
function injectControls() {
  const element = document.createElement('div');
  element.id = 'tbo-controls';
  element.innerHTML = '<button class="tbo-min" aria-label="Minimize"></button><button class="tbo-max" aria-label="Maximize"></button><button class="tbo-close" aria-label="Close"></button>';
  document.body.append(element);
  return element;
}
afterEach(() => { cleanup(); document.getElementById('tbo-controls')?.remove(); });

describe('Windows caption labels', () => {
  it('localizes late injected captions and native maximize-state changes', async () => {
    render(<Labels />);
    const element = injectControls();
    const max = element.querySelector<HTMLButtonElement>('.tbo-max')!;
    await waitFor(() => expect(max).toHaveAccessibleName('最大化'));
    expect(element.querySelector('.tbo-min')).toHaveAccessibleName('最小化');
    expect(element.querySelector('.tbo-close')).toHaveAccessibleName('关闭');
    max.setAttribute('aria-label', 'Restore');
    await waitFor(() => expect(max).toHaveAccessibleName(createTranslator('zh-CN')('Restore')));
    expect(max).toHaveAttribute('title', createTranslator('zh-CN')('Restore'));
  });

  it('keeps the restore action when switching languages', async () => {
    const element = injectControls();
    const max = element.querySelector<HTMLButtonElement>('.tbo-max')!;
    max.setAttribute('aria-label', 'Restore');
    const view = render(<Labels />);
    await waitFor(() => expect(max).toHaveAccessibleName(createTranslator('zh-CN')('Restore')));
    view.rerender(<Labels language="en" />);
    await waitFor(() => expect(max).toHaveAccessibleName('Restore'));
    max.setAttribute('aria-label', 'Maximize');
    await waitFor(() => expect(max).toHaveAccessibleName('Maximize'));
  });
});
