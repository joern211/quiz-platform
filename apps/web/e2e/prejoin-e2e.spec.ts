import { expect, test } from '@playwright/test';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test('M2: explicit independent local capture, microphone level, speaker test and release on collapse', async ({ page, context }) => {
  await context.grantPermissions(['camera', 'microphone']);
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const streams: MediaStream[] = [];
    Object.assign(window, { previewStreams: streams });
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await original(constraints); streams.push(stream); return stream; };
  });
  await page.goto('/beitreten');
  await expect(page.getByText('Geräte vorab testen (optional)')).toBeVisible();
  await page.getByText('Geräte vorab testen (optional)').click();
  const streams = () => page.evaluate(() => (window as unknown as { previewStreams: MediaStream[] }).previewStreams.map(stream => stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }))));
  expect(await streams()).toEqual([]);
  await page.getByRole('button', { name: 'Kamera testen', exact: true }).click();
  await expect.poll(() => page.getByLabel('Lokale Kameravorschau').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  expect(await streams()).toEqual([[{ kind: 'video', state: 'live' }]]);
  await page.getByRole('button', { name: 'Mikrofon testen', exact: true }).click();
  await expect(page.getByRole('meter', { name: 'Mikrofonpegel' })).toBeVisible();
  expect(await streams()).toEqual([[{ kind: 'video', state: 'live' }], [{ kind: 'audio', state: 'live' }]]);
  await page.getByRole('button', { name: 'Standardlautsprecher testen' }).click();
  await expect(page.getByRole('status')).toContainText('Testton');
  await page.getByText('Geräte vorab testen (optional)').click();
  await expect.poll(streams).toEqual([[{ kind: 'video', state: 'ended' }], [{ kind: 'audio', state: 'ended' }]]);
  await expect(page.getByRole('button', { name: 'Beitreten', exact: true })).toBeEnabled();
});

test('M3: denied microphone permission does not block actual room admission', async ({ page, browser }) => {
  const host = await browser.newContext();
  try {
    expect((await host.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const created = await host.request.post(`${BASE}/api/v1/rooms`, { data: { gameSlug: 'wissensduell', roomName: `Prejoin ${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), setupSnapshotJson: {} } });
    expect(created.status()).toBe(201); const code = (await created.json()).data.code;
    await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
    await page.goto(`/beitreten?code=${code}`);
    await page.getByText('Geräte vorab testen (optional)').click();
    await page.getByRole('button', { name: 'Mikrofon testen', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Freigabe verweigert');
    await page.getByLabel('Anzeigename').fill('Permission denied player');
    await page.getByRole('button', { name: 'Beitreten', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/raum/${code}/lobby$`));
  } finally { await host.close(); }
});
