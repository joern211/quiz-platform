import { expect, test } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
test('R1: public discovery shows real occupancy and joins the selected room through the UI', async ({ browser }) => {
  const hostContext = await browser.newContext(), playerContext = await browser.newContext();
  try {
    const host = await hostContext.newPage(), player = await playerContext.newPage();
    expect((await hostContext.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const roomName = `Discovery ${crypto.randomUUID()}`;
    const created = await hostContext.request.post(`${BASE}/api/v1/rooms`, { data: {
      gameSlug: 'wissensduell', roomName, idempotencyKey: crypto.randomUUID(), maxPlayers: 2,
      isPublic: true, viewerRequiresPin: false, roomPolicy: { waitlist: true }, setupSnapshotJson: {},
    } });
    expect(created.status(), await created.text()).toBe(201);
    const code = (await created.json()).data.code as string;
    await host.goto(`${BASE}/moderator/raum/${code}/lobby`);
    await expect(host.getByRole('region', { name: 'Raum und Teams' })).toBeVisible();
    // A second anonymous identity uses real HTTP admission, without host secrets.
    const joined = await playerContext.request.post(`${BASE}/api/v1/rooms/${code}/join`, { data: { displayName: 'Already here' } });
    expect(joined.status()).toBe(201);
    await player.goto(`${BASE}/moderator/raeume`);
    const card = player.locator('div').filter({ has: player.getByRole('heading', { name: roomName, exact: true }) }).filter({ has: player.getByRole('link', { name: 'Beitreten', exact: true }) }).last();
    await expect(card.getByText('👥 1/2')).toBeVisible();
    await card.getByRole('link', { name: 'Beitreten', exact: true }).click();
    await expect(player.getByLabel('Raumcode')).toHaveValue(code);
    await player.getByLabel('Anzeigename').fill('Discovery Player');
    await player.getByRole('button', { name: 'Beitreten', exact: true }).click();
    await expect(player).toHaveURL(new RegExp(`/raum/${code}/lobby$`));
    await expect(host.getByText('Discovery Player', { exact: false }).first()).toBeVisible();
    const waiting = await playerContext.request.post(`${BASE}/api/v1/rooms/${code}/join`, { data: { displayName: 'Waiting player' } });
    expect(waiting.status()).toBe(201);
    const full = await hostContext.request.get(`${BASE}/api/v1/rooms/public`);
    expect((await full.json()).data.find((r: { code: string }) => r.code === code)).toMatchObject({ playerCount: 2, maxPlayers: 2, waitlist: true });
    await host.getByRole('region', { name: 'Raum und Teams' }).getByRole('button', { name: 'Entfernen', exact: true }).first().click();
    // The click sends an asynchronous socket command. Observe its committed
    // effect, rather than racing an HTTP read against the in-flight mutation.
    await expect.poll(async () => {
      const listed = await hostContext.request.get(`${BASE}/api/v1/rooms/public`);
      return (await listed.json()).data.find((r: { code: string }) => r.code === code);
    }).toMatchObject({ playerCount: 1, maxPlayers: 2, canJoin: true });
  } finally { await Promise.allSettled([hostContext.close(), playerContext.close()]); }
});
