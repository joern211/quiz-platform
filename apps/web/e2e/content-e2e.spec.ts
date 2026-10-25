import { test, expect } from '@playwright/test';
test.use({ actionTimeout: 15000 });

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
test('C1: edit, autosave, explicit release and real pool-based setup for two games', async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext(); const page = await context.newPage();
  try {
    expect((await context.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    for (const gameSlug of ['wissensduell', 'jeopardy']) {
      const name = `Content ${gameSlug} ${crypto.randomUUID()}`;
      await page.goto(`${BASE}/inhalte`);
      await page.getByLabel('Spiel', { exact: true }).selectOption(gameSlug);
      await page.getByLabel('Poolname', { exact: true }).fill(name);
      await page.getByRole('button', { name: 'Pool erstellen', exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Neue Frage', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Frageneditor' });
      await editor.getByLabel('Interner Titel').fill('Meine Frage');
      await editor.getByLabel('Frage', { exact: true }).fill('CONTENT_BROWSER_FRAGE');
      if (gameSlug === 'wissensduell') for (let i = 1; i <= 4; i++) await editor.getByLabel(`Antwort ${i}`, { exact: true }).fill(`Option ${i}`);
      else await editor.getByLabel('Lösung', { exact: true }).fill('CONTENT_BROWSER_SECRET');
      await editor.getByRole('button', { name: 'Entwurf speichern' }).click();
      await expect(editor.getByRole('status')).toContainText('Gespeichert');
      await editor.getByLabel('Interner Titel').fill('Gespeicherte Frage');
      await expect(editor.getByRole('status')).toContainText('Ungespeichert');
      await expect(editor.getByRole('status')).toContainText('Gespeichert');
      expect(await editor.getByRole('status').textContent()).toContain('DRAFT');
      page.once('dialog', d => d.accept());
      await editor.getByRole('button', { name: 'Für Spiele freigeben' }).click();
      await expect(editor.getByRole('status')).toContainText('READY');
      await editor.getByRole('button', { name: 'Vorschau laden' }).click();
      await expect(editor.getByText('CONTENT_BROWSER_FRAGE', { exact: false })).toBeVisible();
      expect(await editor.locator('fieldset').textContent()).not.toContain('CONTENT_BROWSER_SECRET');
      await editor.getByRole('button', { name: 'Versionsverlauf' }).click();
      await expect(editor.getByRole('region', { name: 'Versionsverlauf' })).toBeVisible();
      await page.goto(`${BASE}/moderator/vorbereitung/${gameSlug}`);
      await page.getByRole('checkbox', { name: `${name} · PRIVATE`, exact: true }).check();
      if (gameSlug === 'wissensduell') { await page.getByRole('slider', { name: 'Anzahl Fragen' }).focus(); await page.keyboard.press('Home'); }
      else await page.getByLabel('Fragen aus Pools', { exact: true }).fill('1');
      const created = page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST');
      await page.getByRole('button', { name: /Raum erstellen/ }).click();
      const response = await created; expect(response.status(), await response.text()).toBe(201);
      const room = (await response.json()).data;
      await expect(page).toHaveURL(new RegExp(`/moderator/raum/${room.code}/lobby$`));
      const info = await context.request.get(`${BASE}/api/v1/rooms/${room.code}`);
      expect(await info.text()).not.toContain('CONTENT_BROWSER_SECRET');
    }
  } finally { await context.close(); }
});

test('C2: import preview, draft release and ADMIN-only public review through the UI', async ({ browser }) => {
  test.setTimeout(90000);
  const hostContext = await browser.newContext(), adminContext = await browser.newContext();
  try {
    expect((await hostContext.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    expect((await adminContext.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'admin-1' } })).status()).toBe(200);
    const name = `Review ${crypto.randomUUID()}`;
    const created = await hostContext.request.post(`${BASE}/api/v1/content/pools`, { data: { commandId: crypto.randomUUID(), gameSlug: 'wissensduell', name } });
    expect(created.status()).toBe(201);
    const page = await hostContext.newPage(), admin = await adminContext.newPage();
    await page.goto(`${BASE}/inhalte`);
    await page.getByRole('button').filter({ hasText: name }).click();
    await page.getByText('Import, Export und Qualität', { exact: true }).click();
    const file = { schemaVersion: 1, gameSlug: 'wissensduell', items: [{ title: 'Importierte Browserfrage',
      payload: { prompt: 'Importfrage?', category: 'Test', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'a', explanation: '', durationMs: 20000, points: 100, wrongPoints: 0 },
      source: 'Eigenes Material', license: 'Eigene Nutzungsrechte', tags: ['browser-test-tag'] }] };
    await page.getByLabel('Importdatei').setInputFiles({ name: 'content.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await expect(page.getByRole('region', { name: 'Importvorschau' })).toBeVisible();
    await page.getByLabel('Unbekannter Tag „browser-test-tag“').selectOption('IGNORE');
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'Import bestätigen' }).click();
    await expect(page.getByText('1 Fragen als Entwurf übernommen.', { exact: true })).toBeVisible();
    await page.getByRole('button').filter({ hasText: 'Importierte Browserfrage · DRAFT' }).click();
    const editor = page.getByRole('region', { name: 'Frageneditor' });
    page.once('dialog', d => d.accept());
    await editor.getByRole('button', { name: 'Für Spiele freigeben' }).click();
    await expect(editor.getByRole('status')).toContainText('READY');
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'Öffentliche Freigabe beantragen' }).click();
    await expect(page.getByText('Zur Admin-Prüfung eingereicht. Der Pool ist bis zur Entscheidung gesperrt.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Prüfungen & Inbox' }).click();
    const hostReview = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(hostReview).toBeVisible(); await expect(hostReview.getByRole('button', { name: 'Freigeben', exact: true })).toHaveCount(0);
    await admin.goto(`${BASE}/inhalte`); await admin.getByRole('button', { name: 'Prüfungen & Inbox' }).click();
    const adminReview = admin.getByRole('article').filter({ has: admin.getByRole('heading', { name, exact: true }) });
    admin.once('dialog', d => d.accept()); await adminReview.getByRole('button', { name: 'Freigeben', exact: true }).click();
    await expect(adminReview).toHaveCount(0);
    await page.reload(); await page.getByRole('button').filter({ hasText: name }).click();
    await expect(page.getByText('wissensduell · PUBLIC · Version 3', { exact: true })).toBeVisible();
  } finally { await Promise.allSettled([hostContext.close(), adminContext.close()]); }
});
