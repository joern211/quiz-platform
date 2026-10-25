import { afterEach, it, expect, vi } from 'vitest';
import { contentApi } from '../contentApi';

afterEach(() => vi.unstubAllGlobals());
it('retries an uncertain content creation with the same command and starts a fresh intent after success', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Connection lost after commit')).mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { id: 'saved-pool' } }) });
  vi.stubGlobal('fetch', fetch);
  await expect(contentApi.createPool('wissensduell', 'Retry intent test')).rejects.toThrow('Connection lost');
  expect((await contentApi.createPool('wissensduell', 'Retry intent test')).id).toBe('saved-pool');
  await contentApi.createPool('wissensduell', 'Retry intent test');
  const bodies = fetch.mock.calls.map(call => JSON.parse(call[1].body));
  expect(bodies[0].commandId).toBe(bodies[1].commandId);
  expect(bodies[2].commandId).not.toBe(bodies[1].commandId);
  expect(fetch.mock.calls.every(call => call[1].credentials === 'include')).toBe(true);
});
