import { expect, test } from '@playwright/test';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test('M4: live audio and independent camera reach a viewer; host mute, release and team privacy revoke actual receiver tracks', async ({ browser }) => {
  const host = await browser.newContext(), player = await browser.newContext({ permissions: ['camera', 'microphone'] }), viewer = await browser.newContext();
  try {
    expect((await host.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const created = await host.request.post(`${BASE}/api/v1/rooms`, { data: { gameSlug: 'wissensduell', roomName: `Live ${crypto.randomUUID()}`, cameraEnabled: true, viewerRequiresPin: false, idempotencyKey: crypto.randomUUID(), setupSnapshotJson: {} } });
    expect(created.status()).toBe(201); const code = (await created.json()).data.code;
    const h = await host.newPage(), p = await player.newPage(), v = await viewer.newPage();
    await p.addInitScript(() => {
      const counter = window as unknown as { reviewMediaOffers: number }; counter.reviewMediaOffers = 0;
      const createOffer = RTCPeerConnection.prototype.createOffer;
      RTCPeerConnection.prototype.createOffer = function (...args) { counter.reviewMediaOffers++; return createOffer.apply(this, args); };
    });
    await h.goto(`${BASE}/moderator/raum/${code}/lobby`);
    await p.goto(`${BASE}/beitreten?code=${code}`); await p.getByLabel('Anzeigename').fill('Live Alice'); await p.getByRole('button', { name: 'Beitreten', exact: true }).click();
    await v.goto(`${BASE}/zuschauen/${code}/lobby`);
    const hp = h.getByRole('region', { name: 'Live-Medien' }), pp = p.getByRole('region', { name: 'Live-Medien' }), vp = v.getByRole('region', { name: 'Live-Medien' });
    await expect(hp).toBeVisible(); await expect(pp).toBeVisible(); await expect(vp).toBeVisible();
    await expect(vp.getByRole('button', { name: 'Mikrofon einschalten', exact: true })).toHaveCount(0);
    await pp.getByRole('button', { name: 'Mikrofon einschalten', exact: true }).click(); await expect(pp.getByRole('button', { name: 'Mikrofon ausschalten', exact: true })).toBeVisible();
    await pp.getByRole('button', { name: 'Kamera einschalten', exact: true }).click();
    const camera = vp.getByLabel('Livekamera Live Alice', { exact: true });
    await expect.poll(() => camera.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
    await vp.getByRole('button', { name: 'Live-Audio hören', exact: true }).click();
    const audio = vp.getByLabel('Liveaudio Live Alice', { exact: true });
    await expect.poll(() => audio.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => audio.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
    // Break only the receiver's tracks. A local close/recreate cannot fix this:
    // the existing sender must receive fresh routes and produce new offers.
    const offers = await p.evaluate(() => (window as unknown as { reviewMediaOffers: number }).reviewMediaOffers);
    for (const media of [audio, camera]) await media.evaluate((element: HTMLMediaElement) => {
      element.dataset.reviewOldRoute = 'true';
      (element.srcObject as MediaStream).getTracks().forEach(track => track.stop());
    });
    await vp.getByRole('button', { name: 'Medien neu verbinden', exact: true }).click();
    await expect.poll(() => p.evaluate(() => (window as unknown as { reviewMediaOffers: number }).reviewMediaOffers)).toBeGreaterThan(offers);
    await expect(audio).not.toHaveAttribute('data-review-old-route', 'true');
    await expect(camera).not.toHaveAttribute('data-review-old-route', 'true');
    await expect.poll(() => camera.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
    await expect.poll(() => audio.evaluate((element: HTMLMediaElement) => (element.srcObject as MediaStream).getAudioTracks()[0]?.readyState)).toBe('live');
    const restartedAt = await audio.evaluate((element: HTMLMediaElement) => element.currentTime);
    await expect.poll(() => audio.evaluate((element: HTMLMediaElement) => element.currentTime)).toBeGreaterThan(restartedAt);
    await hp.getByRole('button', { name: 'Mikrofon sperren: Live Alice', exact: true }).click();
    await expect(audio).toHaveCount(0); await expect(camera).toBeVisible();
    await expect(pp.getByRole('button', { name: 'Mikrofon einschalten', exact: true })).toBeDisabled();
    await hp.getByRole('button', { name: 'Mikrofon freigeben: Live Alice', exact: true }).click();
    await expect(pp.getByRole('button', { name: 'Mikrofon einschalten', exact: true })).toBeEnabled(); await expect(audio).toHaveCount(0);
    await pp.getByRole('button', { name: 'Mikrofon einschalten', exact: true }).click(); await expect(audio).toBeVisible();
    await hp.getByLabel('Raumsprachkanal', { exact: true }).selectOption('TEAM'); await expect(audio).toHaveCount(0); await expect(camera).toBeVisible();
    await hp.getByRole('button', { name: 'Kamera verbergen: Live Alice', exact: true }).click(); await expect(camera).toHaveCount(0);
  } finally { await Promise.allSettled([host.close(), player.close(), viewer.close()]); }
});

test('M5: generated DISPLAY link opens a public broadcast on multiple devices without viewer capacity or host controls', async ({ browser }) => {
  const host = await browser.newContext(), guest = await browser.newContext();
  try {
    expect((await host.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const created = await host.request.post(`${BASE}/api/v1/rooms`, { data: { gameSlug: 'wissensduell', roomName: `Display ${crypto.randomUUID()}`, allowViewers: false, viewerRequiresPin: false, idempotencyKey: crypto.randomUUID(), setupSnapshotJson: {} } });
    expect(created.status()).toBe(201); const code = (await created.json()).data.code;
    const h = await host.newPage(); await h.goto(`${BASE}/moderator/raum/${code}/lobby`);
    const media = h.getByRole('region', { name: 'Live-Medien' }); await media.getByRole('button', { name: 'Display-Link erzeugen', exact: true }).click();
    const link = await media.getByLabel('Display-Link (12 Stunden)', { exact: true }).inputValue();
    const first = await guest.newPage(), ownerDisplay = await host.newPage();
    for (const page of [first, ownerDisplay]) {
      await page.goto(link); await expect(page.getByRole('region', { name: 'Broadcast', exact: true })).toContainText('DISPLAY');
      const panel = page.getByRole('region', { name: 'Live-Medien' }); await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Mikrofon einschalten', exact: true })).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Alle Mikrofone sperren', exact: true })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Raum und Teams' })).toHaveCount(0);
    }
    const info = await host.request.get(`${BASE}/api/v1/rooms/${code}`); expect((await info.json()).data.viewerCount).toBe(0);
    await first.reload(); await expect(first.getByRole('region', { name: 'Live-Medien' })).toBeVisible();
  } finally { await Promise.allSettled([host.close(), guest.close()]); }
});
