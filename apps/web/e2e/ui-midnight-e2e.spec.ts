import { expect, test, type Browser, type Page } from '@playwright/test';

// Midnight-UI: persönliche Darstellung (Theme + Akzent) gegen echte Räume.
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const SMALL = { viewport: { width: 360, height: 700 }, isMobile: true, hasTouch: true } as const;

/** Zählt ausgehende Socket-Events nach Namen und geöffnete WebSockets. */
function trackSocket(page: Page) {
  const emits: string[] = []; let sockets = 0;
  page.on('websocket', ws => { sockets++; ws.on('framesent', frame => {
    const match = typeof frame.payload === 'string' ? /^42\d*\["([^"]+)"/.exec(frame.payload) : null;
    if (match) emits.push(match[1]);
  }); });
  return { emits, sockets: () => sockets };
}
const appearance = (page: Page) => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent }));
const READS = new Set(['room:core:read', 'game:core:read', 'geo:resync']);

async function wissensduellRoom(browser: Browser) {
  const host = await browser.newContext(), a = await browser.newContext(), b = await browser.newContext();
  expect((await host.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
  const created = await host.request.post(`${BASE}/api/v1/rooms`, { data: { gameSlug: 'wissensduell', roomName: `Midnight ${crypto.randomUUID()}`, viewerRequiresPin: false, idempotencyKey: crypto.randomUUID(), setupSnapshotJson: {} } });
  expect(created.status()).toBe(201); const code = (await created.json()).data.code as string;
  const h = await host.newPage(), pa = await a.newPage(), pb = await b.newPage();
  await h.goto(`${BASE}/moderator/raum/${code}/lobby`);
  for (const [page, name] of [[pa, 'Midnight A'], [pb, 'Midnight B']] as const) {
    await page.goto(`${BASE}/beitreten`); await page.getByLabel('Anzeigename').fill(name); await page.getByLabel('Raumcode').fill(code);
    await page.getByRole('button', { name: 'Beitreten' }).click(); await page.waitForURL(new RegExp(`/raum/${code}/lobby$`));
    await page.getByRole('button', { name: 'Ich bin bereit!' }).click(); await expect(page.getByRole('button', { name: 'Nicht mehr bereit' })).toBeVisible();
  }
  return { code, h, pa, pb, close: () => Promise.allSettled([host.close(), a.close(), b.close()]) };
}

test('UI-1: Darstellung ist pro Browser, wirkt sofort und wird vor React wieder angewendet', async ({ browser }) => {
  const room = await wissensduellRoom(browser);
  try {
    const { pa, pb, h } = room;
    expect(await appearance(pa)).toEqual({ theme: 'dark', accent: 'lila' });
    await pa.getByRole('button', { name: /Darstellung/ }).click();
    const dialog = pa.getByRole('dialog', { name: 'Darstellung' });
    await dialog.getByText('Orange', { exact: true }).click();
    await dialog.getByText('Hell', { exact: true }).click();
    expect(await appearance(pa)).toEqual({ theme: 'light', accent: 'orange' });
    // Hauptaktion nimmt die gewählte Akzentfarbe sofort an
    await expect(pa.getByRole('button', { name: 'Fertig' })).toHaveCSS('background-color', 'rgb(154, 71, 8)');
    await pa.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    // Andere Personen im selben Raum bleiben unberührt
    expect(await appearance(pb)).toEqual({ theme: 'dark', accent: 'lila' });
    expect(await appearance(h)).toEqual({ theme: 'dark', accent: 'lila' });
    // Frühanwendung: ohne App-Skript setzt bereits index.html Theme und Akzent
    await pa.route('**/src/main.tsx*', route => route.abort());
    await pa.reload();
    expect(await appearance(pa)).toEqual({ theme: 'light', accent: 'orange' });
    await pa.unroute('**/src/main.tsx*');
    // Defekter Wert → kontrollierter Standard, App bleibt bedienbar
    await pb.evaluate(() => localStorage.setItem('quiz-appearance', '{"v":1,"theme":"neon","accent":"#ff00ff"'));
    await pb.reload();
    expect(await appearance(pb)).toEqual({ theme: 'dark', accent: 'lila' });
    await expect(pb.getByRole('button', { name: /bereit/ })).toBeVisible();
  } finally { await room.close(); }
});

test('UI-2: Wechsel während laufender Frage löst keine Commands aus, verbindet nicht neu und erhält die Partie', async ({ browser }) => {
  const room = await wissensduellRoom(browser);
  try {
    const { code, h, pa } = room;
    const player = trackSocket(pa);
    await Promise.all([pa.waitForURL(new RegExp(`/raum/${code}/spiel$`)), h.waitForURL(new RegExp(`/moderator/raum/${code}/spiel$`)), h.getByRole('button', { name: 'Spiel starten' }).click()]);
    const option = pa.getByRole('button', { name: /^A\b/ }).first();
    await expect(option).toBeEnabled({ timeout: 15000 });
    const prompt = await pa.getByRole('region', { name: 'Aktuelle Frage' }).getByRole('heading').textContent();
    const before = player.emits.length, socketsBefore = player.sockets();
    const trigger = pa.getByRole('button', { name: /Darstellung/ });
    await trigger.click();
    const dialog = pa.getByRole('dialog', { name: 'Darstellung' });
    for (const accent of ['Blau', 'Türkis', 'Grün', 'Orange', 'Rosa']) await dialog.getByText(accent, { exact: true }).click();
    await dialog.getByText('Hell', { exact: true }).click();
    await pa.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await pa.getByRole('button', { name: 'Zum dunklen Theme wechseln' }).click();
    expect(await appearance(pa)).toEqual({ theme: 'dark', accent: 'rosa' });
    // keine Spiel-/Raumaktion, keine neue Verbindung, gleiche Route und Frage
    const sent = player.emits.slice(before).filter(name => !READS.has(name));
    expect(sent).toEqual([]);
    expect(player.sockets()).toBe(socketsBefore);
    await expect(pa).toHaveURL(new RegExp(`/raum/${code}/spiel$`));
    await expect(pa.getByRole('region', { name: 'Aktuelle Frage' }).getByRole('heading')).toHaveText(prompt!);
    // Antwort funktioniert danach genau einmal
    await option.click();
    await expect(pa.getByRole('status').filter({ hasText: 'Antwort gespeichert.' })).toBeVisible();
    await expect(option).toBeDisabled();
    expect(await appearance(h)).toEqual({ theme: 'dark', accent: 'lila' });
  } finally { await room.close(); }
});

test('UI-3: Navigation bleibt mobil oben; Menü und Darstellungsdialog sind per Tastatur bedienbar', async ({ browser }) => {
  const context = await browser.newContext(SMALL); const page = await context.newPage();
  try {
    await page.goto(`${BASE}/`);
    const toggle = page.getByRole('button', { name: 'Menü öffnen' });
    const box = (await toggle.boundingBox())!;
    expect(box.y).toBeLessThan(80); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    await toggle.click();
    const nav = page.getByRole('navigation', { name: 'Navigation' });
    await expect(nav.getByRole('link', { name: 'Spiele' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(nav).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menü öffnen' })).toBeFocused();
    // Räume-Link führt auf die echte Seite (kein 404)
    await page.getByRole('button', { name: 'Menü öffnen' }).click();
    await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Räume' }).click();
    await expect(page.getByRole('heading', { name: 'Öffentliche Räume' })).toBeVisible();
    // Darstellung aus dem Menü: Focus-Trap, Escape, Fokus zurück an den Menüschalter
    await page.getByRole('button', { name: 'Menü öffnen' }).click();
    await page.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name: 'Darstellung' }).click();
    const dialog = page.getByRole('dialog', { name: 'Darstellung' });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menü öffnen' })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  } finally { await context.close(); }
});

test('UI-4: vorzeitiges Beenden verlangt Bestätigung; Abbrechen lässt die Partie laufen', async ({ browser }) => {
  const room = await wissensduellRoom(browser);
  try {
    const { code, h, pa } = room;
    await Promise.all([h.waitForURL(new RegExp(`/moderator/raum/${code}/spiel$`)), pa.waitForURL(new RegExp(`/raum/${code}/spiel$`)), h.getByRole('button', { name: 'Spiel starten' }).click()]);
    const host = trackSocket(h);
    const end = h.getByRole('button', { name: 'Spiel beenden' });
    await expect(end).toBeEnabled({ timeout: 15000 });
    await end.click();
    const confirm = h.getByRole('alertdialog', { name: 'Spiel vorzeitig beenden?' });
    await expect(confirm.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
    await h.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect(host.emits.filter(name => name === 'game:end')).toEqual([]);
    await expect(h).toHaveURL(new RegExp(`/moderator/raum/${code}/spiel$`));
    await end.click();
    await h.getByRole('alertdialog').getByRole('button', { name: 'Spiel beenden' }).click();
    await h.waitForURL(new RegExp(`/moderator/raum/${code}/ergebnis$`));
    await pa.waitForURL(new RegExp(`/raum/${code}/ergebnis$`));
  } finally { await room.close(); }
});

test('UI-5: Spielstart während offenem Darstellungsdialog – Route folgt dem Server, Dialog bleibt bedienbar, Spiel startet normal', async ({ browser }) => {
  const room = await wissensduellRoom(browser);
  try {
    const { code, h, pa } = room;
    const player = trackSocket(pa);
    const settingsOnly = (from: number) => player.emits.slice(from).filter(name => !READS.has(name));
    await pa.getByRole('button', { name: /Darstellung/ }).click();
    const dialog = pa.getByRole('dialog', { name: 'Darstellung' });
    let mark = player.emits.length;
    await dialog.getByText('Grün', { exact: true }).click();
    expect(settingsOnly(mark)).toEqual([]);
    // Host startet, während der Spieler noch im Dialog ist: Server-Ereignis navigiert den Spieler.
    // (Der Seitenwechsel selbst abonniert Raum/Medien neu – das ist bestehendes Verhalten und nicht Teil der Messung.)
    await Promise.all([pa.waitForURL(new RegExp(`/raum/${code}/spiel$`)), h.getByRole('button', { name: 'Spiel starten' }).click()]);
    await expect(dialog).toBeVisible();
    const option = pa.getByRole('button', { name: /^A\b/ }).first();
    await expect(option).toBeEnabled({ timeout: 15000 });
    // bis der Seitenwechsel abgeschlossen ist: keine neuen Events über drei Messpunkte
    let last = -1;
    await expect.poll(() => { const stable = player.emits.length === last; last = player.emits.length; return stable; }, { intervals: [400, 400, 400], timeout: 8000 }).toBe(true);
    mark = player.emits.length;
    await dialog.getByText('Hell', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Fertig' }).click();
    await expect(dialog).toHaveCount(0);
    expect(settingsOnly(mark)).toEqual([]);
    await option.click();
    await expect(pa.getByRole('status').filter({ hasText: 'Antwort gespeichert.' })).toBeVisible();
    expect(await appearance(pa)).toEqual({ theme: 'light', accent: 'gruen' });
  } finally { await room.close(); }
});

// R1 (Prüfbericht PR #29): Infofenster der Spielkarten dürfen nicht von der Karte (overflow) oder dem Viewport abgeschnitten werden.
for (const [width, height, theme] of [[320, 640, 'dark'], [390, 844, 'light'], [430, 932, 'dark'], [1280, 800, 'light']] as const) {
  test(`UI-6: Info-Popups echter Kategorien sind bei ${width}px (${theme}) vollständig sichtbar und treffbar`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
    await context.addInitScript(t => localStorage.setItem('quiz-appearance', JSON.stringify({ v: 1, theme: t, accent: 'lila' })), theme);
    const page = await context.newPage();
    try {
      for (const [slug, heading, games] of [['quiz-wissen', 'Quiz & Wissen', ['Wissensduell']], ['buzzer-reaktion', 'Buzzer & Reaktion', ['Jeopardy', 'Wer ist das?']]] as const) {
        await page.goto(`${BASE}/kategorie/${slug}`);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        for (const game of games) {
          await expect(page.getByRole('heading', { level: 3, name: game, exact: true })).toBeVisible();
          const trigger = page.getByRole('button', { name: `Info zu ${game}` });
          await trigger.scrollIntoViewIfNeeded();
          await trigger.click();
          const dialog = page.getByRole('dialog', { name: game });
          await expect(dialog).toBeVisible();
          const box = (await dialog.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5); expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
          // Treffbarkeit: Ecken, Mitte und jede Regelzeile liegen tatsächlich oben auf dem Popup
          const allHit = await dialog.evaluate(el => {
            const points: Array<[number, number]> = [];
            const r = el.getBoundingClientRect();
            const i = 8; // innerhalb der abgerundeten Ecken (Radius 20 px), aber nahe am Rand
            points.push([r.left + i, r.top + i], [r.right - i, r.top + i], [r.left + i, r.bottom - i], [r.right - i, r.bottom - i], [r.left + r.width / 2, r.top + r.height / 2]);
            for (const line of el.querySelectorAll('li, p, h4')) { const b = line.getBoundingClientRect(); points.push([b.left + 2, b.top + b.height / 2], [b.right - 2, b.top + b.height / 2]); }
            return points.filter(([x, y]) => !el.contains(document.elementFromPoint(x, y))).map(([x, y]) => `${Math.round(x)},${Math.round(y)}`);
          });
          expect(allHit, 'Punkte, an denen das Popup verdeckt/abgeschnitten ist').toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
          // Schließen per echtem Mausklick an der Position des Buttons, Fokus zurück an den Trigger
          const close = dialog.getByRole('button', { name: 'Schließen' }); const cb = (await close.boundingBox())!;
          expect(cb.width).toBeGreaterThanOrEqual(44);
          await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
          await expect(dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
          // Tastatur: öffnen, Escape schließt und gibt den Fokus zurück
          await page.keyboard.press('Enter');
          await expect(dialog).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
        }
      }
    } finally { await context.close(); }
  });
}
