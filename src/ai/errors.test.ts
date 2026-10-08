import { afterEach, expect, it } from 'vitest';
import type { BootstrapData } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { aiErrorText } from './errors';

afterEach(() => useAppStore.setState({ bootstrap: undefined }));

it('shows sanitized provider details alongside localized error guidance', () => {
  for (const [language, guidance, details] of [
    ['en', 'The AI provider rejected the request.', 'Provider details: HTTP 400: input must be an array'],
    ['zhCn', 'AI 提供商拒绝了请求', '提供商详情：HTTP 400: input must be an array'],
  ] as const) {
    useAppStore.setState({ bootstrap: { state: { settings: { language } } } as BootstrapData });
    for (const code of ['AI_HTTP_REJECTED', 'AI_PROVIDER_ERROR']) {
      const text = aiErrorText({ code, hint: 'HTTP 400: input must be an array' });
      expect(text).toContain(guidance);
      expect(text).toContain(details);
    }
  }
});

it('keeps fallback guidance when provider details are absent', () => {
  useAppStore.setState({ bootstrap: { state: { settings: { language: 'en' } } } as BootstrapData });
  expect(aiErrorText({ code: 'AI_HTTP_REJECTED', hint: null })).toBe('The AI provider rejected the request. Check the endpoint, credentials and selected model.');
  expect(aiErrorText({ code: 'AI_KEY_REQUIRED', hint: 'unrelated' })).toBe('Configure an AI API key in Settings');
});
