import { t } from './i18n';
const messages: Record<string, string> = {
  AI_KEY_ACCESS_FAILED: 'Unable to read AI API key from system secure storage. Retry access in AI settings.',
  AI_KEY_REQUIRED: 'Configure an AI API key in Settings',
  AI_MODEL_REQUIRED: 'Configure an AI model in Settings',
  AI_URL_INVALID: 'Use an HTTP(S) API URL without embedded credentials',
  AI_URL_REQUIRED: 'Set the custom API URL',
  AI_HTTP_REJECTED: 'The AI provider rejected the request. Check the endpoint, credentials and selected model.',
  AI_PROVIDER_ERROR: 'The AI provider rejected the request. Check the endpoint, credentials and selected model.',
  AI_HTTP_FAILED: 'Unable to connect to the AI provider. Check the API URL and network.',
  AI_STREAM_FAILED: 'The AI connection was interrupted. Try again.',
  AI_STREAM_INTERRUPTED: 'The AI connection was interrupted. Try again.',
  AI_OUTPUT_TRUNCATED: 'AI output was truncated. Increase the output budget or reduce the selection.',
  AI_OUTPUT_TOO_LARGE: 'AI output exceeds the size limit. Reduce the selection.',
  AI_EMPTY_RESPONSE: 'AI returned no assistant message. Check the selected model.',
  AI_CLI_UNAVAILABLE: 'Agent CLI is unavailable. Check its executable path and required options.',
  AI_CLI_START_FAILED: 'Unable to start Agent CLI. Check its executable path.',
  AI_CLI_FAILED: 'Agent CLI failed. Check its login and selected model.',
  AI_CLI_TIMEOUT: 'Agent CLI timed out. Increase the timeout or reduce the selection.',
  AI_CONTEXT_EMPTY: 'Select changes or commits before using AI',
  AI_CONTEXT_TOO_LARGE: 'Complete evidence exceeds the input budget. Increase the budget or reduce the selection.',
  AI_JSON_INVALID: 'AI returned invalid JSON. Run the task again.',
  AI_RESULT_INVALID: 'AI returned invalid structured data. Run the task again.',
  AI_REVIEW_INVALID: 'AI returned invalid review findings. Run the review again.',
  AI_MERGE_INVALID: 'AI conflict results are incomplete or invalid. Existing resolutions were preserved.',
  AI_CONFLICT_STALE: 'The conflict file changed while AI was running. Reload it and try again.',
  AI_COMPOSER_COVERAGE: 'The AI commit plan does not cover every change exactly once. Analyze again.',
  AI_COMPOSER_INVALID: 'The AI commit plan is invalid. Analyze again.',
  AI_COMPOSER_STALE: 'Repository changes have changed since analysis. Analyze again.',
  AI_COMPOSER_SESSION_STALE: 'The AI commit plan expired. Analyze again.',
  AI_COMPOSER_PUSHED: 'Pushed commits cannot be reorganized.',
  AI_COMPOSER_DIRTY: 'Clean the working tree before reorganizing history',
  AI_COMPOSER_RANGE: 'Select consecutive unpushed commits ending at HEAD',
  AI_COMPOSER_DETACHED: 'Switch to a local branch before composing commits.',
  AI_COMPOSER_TREE_MISMATCH: 'The composed commits do not reproduce the original changes. No branch was changed.',
  AI_COMPOSER_INDEX_LOCKED: 'Another Git operation holds the index lock. Retry after it finishes.',
  AI_BINARY_UNSUPPORTED: 'AI cannot resolve a binary conflict',
  SECURE_STORAGE_FAILED: 'Unable to update AI API key in system secure storage',
};
export function aiErrorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const text = error instanceof Error ? error.message : String(error);
  const message = t(messages[code] ?? text);
  if (['AI_HTTP_REJECTED', 'AI_PROVIDER_ERROR'].includes(code)
    && error && typeof error === 'object' && 'hint' in error
    && typeof error.hint === 'string' && error.hint.trim()) {
    return `${message}\n${t('Provider details: {0}', error.hint)}`;
  }
  return message;
}
