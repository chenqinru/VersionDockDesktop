import { createHighlightSession, type HighlightSession, type HighlightWorkerRequest, type HighlightWorkerResponse } from './highlightWorker';

const sessions = new Map<number, HighlightSession>();

self.onmessage = async ({ data }: MessageEvent<HighlightWorkerRequest>) => {
  if (data.action === 'cancel') { sessions.delete(data.id); return; }
  const response: HighlightWorkerResponse = { id: data.id };
  try {
    const session = data.action === 'start'
      ? await createHighlightSession(data.code, data.language, data.theme)
      : sessions.get(data.id);
    if (!session) throw new Error('Syntax highlight session expired');
    Object.assign(response, session.next());
    if (response.done) sessions.delete(data.id);
    else sessions.set(data.id, session);
  } catch (error) {
    sessions.delete(data.id);
    response.error = error instanceof Error ? error.message : 'Syntax highlighting failed';
  }
  self.postMessage(response);
};
