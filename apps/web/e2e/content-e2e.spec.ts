import { test, expect } from '@playwright/test';

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
