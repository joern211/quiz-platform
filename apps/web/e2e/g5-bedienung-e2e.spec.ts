import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const SMALL = { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true } as const;

/** Counts the client's outgoing socket events by name (socket.io text frames start with 42[...,"event"). */
function countEmits(page: Page) {
  const counts = new Map<string, number>();
  page.on('websocket', ws => ws.on('framesent', frame => {
    const match = typeof frame.payload === 'string' ? /^42\d*\["([^"]+)"/.exec(frame.payload) : null;
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }));
  return counts;
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function inViewport(page: Page, locator: ReturnType<Page['getByRole']>) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!; const width = page.viewportSize()!.width;
  return box.x >= 0 && box.x + box.width <= width + 1 && box.width >= 24 && box.height >= 24;
}

test('G5-B1: on a 360px screen host and players run a round with named, reachable core actions, no horizontal scroll and a bounded number of core reads per change', async ({ browser }) => {
  const host = await browser.newContext(SMALL), a = await browser.newContext(SMALL), b = await browser.newContext(SMALL);
  try {
    expect((await host.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const created = await host.request.post(`${BASE}/api/v1/rooms`, { data: { gameSlug: 'wissensduell', roomName: `G5 small ${crypto.randomUUID()}`, viewerRequiresPin: false, idempotencyKey: crypto.randomUUID(), setupSnapshotJson: {} } });
    expect(created.status()).toBe(201); const code = (await created.json()).data.code as string;
    const h = await host.newPage(), pa = await a.newPage(), pb = await b.newPage();
    const hostEmits = countEmits(h), playerEmits = countEmits(pa);
    await h.goto(`${BASE}/moderator/raum/${code}/lobby`);
    for (const [page, name] of [[pa, 'Klein A'], [pb, 'Klein B']] as const) {
      await page.goto(`${BASE}/beitreten`); await page.getByLabel('Anzeigename').fill(name); await page.getByLabel('Raumcode').fill(code);
      await page.getByRole('button', { name: 'Beitreten' }).click(); await page.waitForURL(new RegExp(`/raum/${code}/lobby$`));
      await page.getByRole('button', { name: 'Ich bin bereit!' }).click(); await expect(page.getByRole('button', { name: 'Nicht mehr bereit' })).toBeVisible();
    }
    expect(await noHorizontalScroll(h)).toBe(true); expect(await noHorizontalScroll(pa)).toBe(true);
    const start = h.getByRole('button', { name: 'Spiel starten' }); await expect(start).toBeEnabled();
    await Promise.all([h.waitForURL(new RegExp(`/moderator/raum/${code}/spiel$`)), pa.waitForURL(new RegExp(`/raum/${code}/spiel$`)), pb.waitForURL(new RegExp(`/raum/${code}/spiel$`)), start.click()]);
    // player: the answer options are buttons with a name and fit the screen
    const option = pa.getByRole('button', { name: /^(Antwort )?A\b|Antwort A/ }).first();
    await expect(option).toBeVisible({ timeout: 15000 });
    expect(await inViewport(pa, option)).toBe(true); expect(await noHorizontalScroll(pa)).toBe(true);
    // host: reveal and end are named buttons within the screen
    const reveal = h.getByRole('button', { name: /Auflösen/ }), end = h.getByRole('button', { name: 'Spiel beenden' });
    await expect(reveal).toBeEnabled({ timeout: 15000 });
    expect(await inViewport(h, reveal)).toBe(true); expect(await inViewport(h, end)).toBe(true); expect(await noHorizontalScroll(h)).toBe(true);
    await option.click(); await expect(pa.getByRole('status')).toHaveText('Antwort gespeichert.');
    // one state change (reveal): how many core reads does each client issue, until the count is stable?
    const settle = async (counts: Map<string, number>) => { let last = -1; await expect.poll(async () => { const now = counts.get('game:core:read') ?? 0; const stable = now === last; last = now; return stable; }, { intervals: [400, 400, 400], timeout: 8000 }).toBe(true); };
    await settle(hostEmits); await settle(playerEmits);
    const before = { host: hostEmits.get('game:core:read') ?? 0, player: playerEmits.get('game:core:read') ?? 0 };
    await reveal.click(); await expect(h.getByRole('heading', { name: /Lösung:/ })).toBeVisible();
    await settle(hostEmits); await settle(playerEmits);
    const perReveal = { host: (hostEmits.get('game:core:read') ?? 0) - before.host, player: (playerEmits.get('game:core:read') ?? 0) - before.player };
    test.info().annotations.push({ type: 'core-reads-per-reveal', description: JSON.stringify(perReveal) });
    // REQUEST allows a burst of 40 and 12/s; one change must stay far below the burst, so ordinary play can never exhaust it
    expect(perReveal.host).toBeLessThanOrEqual(8); expect(perReveal.player).toBeLessThanOrEqual(8);
    await expect(h.getByRole('alert')).toHaveCount(0); await expect(pa.getByRole('alert')).toHaveCount(0);
  } finally { await Promise.allSettled([host.close(), a.close(), b.close()]); }
});
