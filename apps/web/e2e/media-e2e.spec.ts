import { expect, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
function wav() {
  const samples = 48000, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 100), 44 + i * 2);
  return bytes;
}

test('M1: upload real audio in both editors, play normalized output on a guest device and revoke it when playtest closes', async ({ browser }) => {
  const host = await browser.newContext(), guest = await browser.newContext();
  try {
    expect((await host.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const page = await host.newPage(), player = await guest.newPage();
    for (const gameSlug of ['wissensduell', 'jeopardy']) {
      const name = `Audio ${gameSlug} ${crypto.randomUUID()}`;
      const created = await host.request.post(`${BASE}/api/v1/content/pools`, { data: { commandId: crypto.randomUUID(), gameSlug, name } }); expect(created.status()).toBe(201); const pool = (await created.json()).data;
      const payload = gameSlug === 'wissensduell' ? { prompt: 'Audiofrage?', category: 'Audio', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'a', explanation: 'AUDIO_BROWSER_SECRET' } : { question: 'Audiofrage?', category: 'Audio', value: 100, answer: 'AUDIO_BROWSER_SECRET' };
      expect((await host.request.post(`${BASE}/api/v1/content/pools/${pool.id}/items`, { data: { commandId: crypto.randomUUID(), item: { title: 'Audiofrage', payload } } })).status()).toBe(201);
      await page.goto(`${BASE}/inhalte`); await page.getByLabel('Spiel', { exact: true }).selectOption(gameSlug); await page.getByRole('button').filter({ hasText: name }).click(); await page.getByRole('button', { name: 'Audiofrage · DRAFT · V1', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Frageneditor' });
      if (await editor.getByRole('button', { name: 'Erweiterte Optionen' }).count()) await editor.getByRole('button', { name: 'Erweiterte Optionen' }).click();
      const uploaded = page.waitForResponse(r => r.url().endsWith('/api/v1/media') && r.request().method() === 'POST'); await editor.getByLabel('Medium hochladen').setInputFiles({ name: 'quiet.wav', mimeType: 'audio/wav', buffer: wav() });
      const response = await uploaded; expect(response.ok()).toBe(true); expect((await response.json()).data.mimeType).toBe('audio/mpeg');
      await editor.getByRole('checkbox', { name: 'Eigenes Material', exact: true }).check(); await expect(editor.getByRole('status')).toContainText('Gespeichert');
      await editor.getByRole('button', { name: 'Gespeichertes Medium anzeigen', exact: true }).click(); const preview = editor.locator('audio'); await expect.poll(() => preview.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(1);
      const privateUrl = await preview.getAttribute('src'); expect((await guest.request.get(`${BASE}${privateUrl}`)).status()).toBe(403);
      await editor.getByRole('button', { name: 'Playtest starten', exact: true }).click(); const share = await editor.getByLabel('Testlink für andere Geräte').inputValue(); await player.goto(share);
      const audio = player.getByLabel('Audio zur Frage', { exact: true }); await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
      await audio.evaluate((element: HTMLAudioElement) => { element.muted = true; return element.play(); }); await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
      await expect(player.getByText('AUDIO_BROWSER_SECRET', { exact: true })).toHaveCount(0); await player.reload(); await expect(player.getByLabel('Audio zur Frage')).toBeVisible();
      const url = await player.getByLabel('Audio zur Frage').getAttribute('src'), code = new URL(share).pathname.split('/').at(-1);
      expect((await host.request.post(`${BASE}/api/v1/content/playtests/${code}/control`, { data: { commandId: crypto.randomUUID(), version: 1, action: 'CLOSE' } })).status()).toBe(200);
      expect((await guest.request.get(`${BASE}${url}`)).status()).toBe(403);
    }
  } finally { await Promise.allSettled([host.close(), guest.close()]); }
});
