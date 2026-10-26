export type MediaJobView = { id: string; status: string; originalId: string; retryable: boolean; errorCode: string | null; asset: { id: string; type: string; mimeType: string } | null };
async function response(response: Response): Promise<MediaJobView> { const json = await response.json(); if (!response.ok || !json.success) throw new Error(json.error?.message ?? 'Medienverarbeitung nicht erreichbar.'); return json.data; }
export async function uploadMediaJob(file: File, commandId: string, signal: AbortSignal) { const body = new FormData(); body.append('commandId', commandId); body.append('file', file); let result: Response; try { result = await fetch('/api/v1/media/jobs', { method: 'POST', credentials: 'include', body, signal }); } catch (error) { if (signal.aborted) throw error; result = await fetch('/api/v1/media/jobs', { method: 'POST', credentials: 'include', body, signal }); } return response(result); }
export async function getMediaJob(id: string, signal: AbortSignal) { return response(await fetch(`/api/v1/media/jobs/${encodeURIComponent(id)}`, { credentials: 'include', signal })); }
export async function retryMediaJob(id: string, signal: AbortSignal) { return response(await fetch(`/api/v1/media/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', credentials: 'include', signal })); }
export async function waitMediaJob(id: string, signal: AbortSignal, update: (job: MediaJobView) => void): Promise<MediaJobView> {
  const deadline = Date.now() + 120000;
  while (!signal.aborted) {
    const job = await getMediaJob(id, signal); if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError'); update(job);
    if (['READY', 'FAILED', 'REJECTED'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error('Die Verarbeitung läuft im Hintergrund. Bitte später erneut prüfen.');
    await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(new DOMException('Abgebrochen', 'AbortError')); }; const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 400); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  }
  throw new DOMException('Abgebrochen', 'AbortError');
}
