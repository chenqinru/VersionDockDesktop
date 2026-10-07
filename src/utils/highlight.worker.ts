import { tokenizeCode, type HighlightWorkerRequest, type HighlightWorkerResponse } from './highlightWorker';

self.onmessage = async ({ data }: MessageEvent<HighlightWorkerRequest>) => {
  const response: HighlightWorkerResponse = { id: data.id };
  try {
    response.tokens = await tokenizeCode(data.code, data.language, data.theme);
  } catch (error) {
    response.error = error instanceof Error ? error.message : 'Syntax highlighting failed';
  }
  self.postMessage(response);
};
