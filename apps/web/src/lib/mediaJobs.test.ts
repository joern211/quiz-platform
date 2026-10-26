import { afterEach, expect, it, vi } from 'vitest';
import { uploadMediaJob, waitMediaJob } from './mediaJobs';
afterEach(() => { vi.unstubAllGlobals(); });
it('retries uncertain uploads with the identical multipart command rather than creating another job intention', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'persisted-job', status: 'QUEUED' } }) }); vi.stubGlobal('fetch', fetch);
  const file = new File(['image'], 'image.png'), command = crypto.randomUUID();
  expect((await uploadMediaJob(file, command, new AbortController().signal)).id).toBe('persisted-job'); expect(fetch).toHaveBeenCalledTimes(2);
  for (const call of fetch.mock.calls) expect((call[1].body as FormData).get('commandId')).toBe(command);
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
});
it('does not poll or apply a stale completed job after cancellation while its response was pending', async () => {
  let resolve!: (value: unknown) => void; const controller = new AbortController(), update = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(done => { resolve = done; })));
  const pending = waitMediaJob('old-question-job', controller.signal, update); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); resolve({ ok: true, json: async () => ({ success: true, data: { id: 'old-question-job', status: 'READY', asset: { id: 'secret-old-asset' } } }) });
  await rejected; expect(update).not.toHaveBeenCalled();
});
