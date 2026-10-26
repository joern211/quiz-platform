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
      if (await editor.getByRole('button', { name: 'Erweiterte Optionen' }).count()) await editor.getByRole('button', { name: 'Erweiterte Optionen' }).click();
      const uploaded = page.waitForResponse(r => r.url().endsWith('/api/v1/media') && r.request().method() === 'POST');
      await editor.getByLabel('Medium hochladen').setInputFiles({ name: 'question.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGNgZGJmZGJmgFAAAK4AGQw8f7AAAAAASUVORK5CYII=', 'base64') });
      expect((await uploaded).ok()).toBe(true);
      await editor.getByRole('checkbox', { name: 'Eigenes Material', exact: true }).check();
      await editor.getByRole('button', { name: 'Entwurf speichern' }).click();
      await expect(editor.getByRole('status')).toContainText('Gespeichert');
      await editor.getByLabel('Interner Titel').fill('Gespeicherte Frage');
      await expect(editor.getByRole('status')).toContainText('Ungespeichert');
      await expect(editor.getByRole('status')).toContainText('Gespeichert');
      expect(await editor.getByRole('status').textContent()).toContain('DRAFT');
      page.once('dialog', d => d.accept());
      await editor.getByRole('button', { name: 'Für Spiele freigeben' }).click();
      await expect(editor.getByRole('status')).toContainText('READY');
      await editor.getByRole('button', { name: 'Gespeichertes Medium anzeigen' }).click();
      await expect(editor.getByRole('group', { name: 'Bild oder Audio' }).getByRole('img', { name: 'Bild zur Frage' })).toHaveJSProperty('naturalWidth', 2);
      await editor.getByRole('button', { name: 'Vorschau laden' }).click();
      await expect(editor.getByRole('group', { name: 'Vorschau der gespeicherten Version' }).getByText('CONTENT_BROWSER_FRAGE', { exact: false })).toBeVisible();
      expect(await editor.getByRole('group', { name: 'Vorschau der gespeicherten Version' }).textContent()).not.toContain('CONTENT_BROWSER_SECRET');
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

test('C3: concurrent editors preserve conflicts; confirmed batch action and internal comments work in the UI', async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext();
  try {
    expect((await context.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const name = `Collaboration ${crypto.randomUUID()}`;
    const created = await context.request.post(`${BASE}/api/v1/content/pools`, { data: { commandId: crypto.randomUUID(), gameSlug: 'wissensduell', name } });
    expect(created.status()).toBe(201); const pool = (await created.json()).data;
    const question = await context.request.post(`${BASE}/api/v1/content/pools/${pool.id}/items`, { data: { commandId: crypto.randomUUID(), item: { title: 'Gemeinsame Frage',
      payload: { prompt: 'Ursprüngliche Frage', category: 'Test', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'a' } } } });
    expect(question.status()).toBe(201);
    const first = await context.newPage(), second = await context.newPage();
    for (const page of [first, second]) {
      await page.goto(`${BASE}/inhalte`); await page.getByRole('button').filter({ hasText: name }).click();
      const registered = page.waitForResponse(response => response.url().endsWith('/presence') && response.request().postDataJSON()?.active === true && response.status() === 200);
      await page.getByRole('button', { name: 'Gemeinsame Frage · DRAFT · V1', exact: true }).click();
      await registered;
    }
    const editor2 = second.getByRole('region', { name: 'Frageneditor' }), editor1 = first.getByRole('region', { name: 'Frageneditor' });
    await expect(editor2.getByText(/Gerade ebenfalls geöffnet/)).toBeVisible();
    await editor2.getByLabel('Frage', { exact: true }).fill('Änderung vom zweiten Tab');
    await expect(editor2.getByRole('status')).toContainText('Version 2');
    await editor1.getByLabel('Frage', { exact: true }).fill('Lokaler Entwurf bleibt erhalten');
    await expect(editor1.getByRole('alert')).toContainText('inzwischen geändert');
    await expect(editor1.getByLabel('Frage', { exact: true })).toHaveValue('Lokaler Entwurf bleibt erhalten');
    await editor1.getByRole('button', { name: 'Aktuelle Version vergleichen' }).click();
    await expect(editor1.getByRole('region', { name: 'Bearbeitungskonflikt' })).toContainText('Änderung vom zweiten Tab');
    first.once('dialog', d => d.accept()); await editor1.getByRole('button', { name: 'Aktuelle Fassung übernehmen' }).click();
    await expect(editor1.getByLabel('Frage', { exact: true })).toHaveValue('Änderung vom zweiten Tab');
    await editor1.getByText('Zusammenarbeit und Verwendung', { exact: true }).click();
    await editor1.getByLabel('Neuer interner Kommentar').fill('Bitte Quelle nachtragen.');
    await editor1.getByRole('button', { name: 'Kommentar senden' }).click();
    await expect(editor1.getByText('Bitte Quelle nachtragen.', { exact: true })).toBeVisible();
    await first.getByText('Sammelbearbeitung', { exact: true }).click();
    const batch = first.locator('details').filter({ has: first.locator('summary', { hasText: /^Sammelbearbeitung$/ }) });
    await batch.getByRole('checkbox').check(); await batch.getByRole('button', { name: 'Auswirkungen prüfen' }).click();
    await expect(batch.getByRole('region', { name: 'Auswirkungen der Sammelaktion' })).toContainText('ARCHIVED');
    first.once('dialog', d => d.accept()); await batch.getByRole('button', { name: 'Sammelaktion bestätigen' }).click();
    await expect(batch.getByRole('status')).toContainText('1 erfolgreich, 0 fehlgeschlagen');
    await expect(first.getByRole('button', { name: 'Gemeinsame Frage · ARCHIVED · V3', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('C4: private template creates a new draft, versioned review work stays separate from approval and the queue accepts shortcuts', async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext();
  try {
    expect((await context.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const name = `Templates ${crypto.randomUUID()}`, templateName = `Vorlage ${crypto.randomUUID()}`;
    const p = await context.request.post(`${BASE}/api/v1/content/pools`, { data: { commandId: crypto.randomUUID(), gameSlug: 'wissensduell', name } });
    expect(p.status()).toBe(201); const pool = (await p.json()).data;
    const q = await context.request.post(`${BASE}/api/v1/content/pools/${pool.id}/items`, { data: { commandId: crypto.randomUUID(), item: { title: 'Vorlagenfrage',
      payload: { prompt: 'Frage aus Vorlage', category: 'Test', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'a' } } } });
    expect(q.status()).toBe(201); const original = (await q.json()).data;
    const page = await context.newPage(); await page.goto(`${BASE}/inhalte`); await page.getByRole('button').filter({ hasText: name }).click();
    await page.getByRole('button', { name: 'Vorlagenfrage · DRAFT · V1', exact: true }).click();
    let editor = page.getByRole('region', { name: 'Frageneditor' }); await editor.getByText('Als private Vorlage speichern', { exact: true }).click();
    await editor.getByLabel('Vorlagenname').fill(templateName); await editor.getByRole('button', { name: 'Vorlage speichern', exact: true }).click();
    await expect(editor.getByText('Private Vorlage gespeichert. Neue Fragen daraus bleiben Entwürfe.', { exact: true })).toBeVisible();
    await page.getByText('Fragenvorlagen', { exact: true }).click(); await page.getByRole('button', { name: 'Vorlagen laden', exact: true }).click();
    const used = page.waitForResponse(r => r.url().includes('/api/v1/content/templates/') && r.url().endsWith('/use') && r.request().method() === 'POST');
    await page.getByRole('button', { name: `Neuen Entwurf aus „${templateName}“ erstellen`, exact: true }).click();
    const useResponse = await used; expect(useResponse.status()).toBe(201); const draft = (await useResponse.json()).data; expect(draft.id).not.toBe(original.id);
    editor = page.getByRole('region', { name: 'Frageneditor' }); await expect(editor.getByRole('status')).toContainText('DRAFT');
    await editor.getByText('Prüfaufgabe zu dieser Frage', { exact: true }).click(); await editor.getByRole('button', { name: 'Prüfaufgaben laden' }).click();
    await editor.getByLabel('Prüfauftrag').fill('Antwort und Quelle prüfen'); await editor.getByRole('button', { name: 'Prüfaufgabe zuweisen' }).click();
    await editor.getByRole('button', { name: 'Prüfung beginnen', exact: true }).click();
    page.once('dialog', d => d.accept()); await editor.getByRole('button', { name: 'Prüfung abschließen', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('DRAFT');
    page.once('dialog', d => d.accept()); await editor.getByRole('button', { name: 'Zur Prüfung einreichen', exact: true }).click();
    await page.getByRole('button', { name: 'Prüfungen & Inbox' }).click(); await page.getByRole('button', { name: 'Einzeln prüfen', exact: true }).click();
    const queue = page.getByRole('region', { name: 'Einzelprüfung der Warteschlange' }); await expect(queue).toContainText(name);
    await queue.focus(); page.once('dialog', d => d.accept()); await queue.press('a');
    await expect(queue.getByText('Keine offenen Prüfungen.', { exact: true })).toBeVisible();
    const checked = await context.request.get(`${BASE}/api/v1/content/items/${draft.id}`);
    expect((await checked.json()).data).toMatchObject({ status: 'DRAFT', reviewState: 'APPROVED' });
  } finally { await context.close(); }
});

test('C5: editor playtest shares a draft with a guest device, hides solutions until reveal, collects a warning and closes access', async ({ browser }) => {
  test.setTimeout(90000);
  const hostContext = await browser.newContext(), guestContext = await browser.newContext();
  try {
    expect((await hostContext.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const name = `Playtest ${crypto.randomUUID()}`;
    const created = await hostContext.request.post(`${BASE}/api/v1/content/pools`, { data: { commandId: crypto.randomUUID(), gameSlug: 'wissensduell', name } });
    expect(created.status()).toBe(201); const pool = (await created.json()).data;
    const question = await hostContext.request.post(`${BASE}/api/v1/content/pools/${pool.id}/items`, { data: { commandId: crypto.randomUUID(), item: { title: 'Playtestfrage',
      payload: { prompt: 'Test auf anderem Gerät?', category: 'Test', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'a', explanation: 'PLAYTEST_PRIVATE_SOLUTION', durationMs: 60000 } } } });
    expect(question.status()).toBe(201);
    const editor = await hostContext.newPage(); await editor.goto(`${BASE}/inhalte`);
    await editor.getByRole('button').filter({ hasText: name }).click(); await editor.getByRole('button', { name: 'Playtestfrage · DRAFT · V1', exact: true }).click();
    await editor.getByRole('button', { name: 'Playtest starten', exact: true }).click();
    const share = await editor.getByLabel('Testlink für andere Geräte').inputValue();
    const opened = hostContext.waitForEvent('page'); await editor.getByRole('link', { name: 'Playtest als Host öffnen' }).click(); const host = await opened;
    await expect(host.getByText('PLAYTEST_PRIVATE_SOLUTION', { exact: true })).toBeVisible();
    const guest = await guestContext.newPage(); await guest.goto(share);
    await expect(guest.getByRole('heading', { name: 'Test auf anderem Gerät?' })).toBeVisible();
    await expect(guest.getByText('PLAYTEST_PRIVATE_SOLUTION', { exact: true })).toHaveCount(0);
    await guest.getByLabel('Perspektive').selectOption('VIEWER');
    await expect(guest.getByRole('button', { name: 'Testantwort abgeben' })).toHaveCount(0);
    await guest.getByLabel('Perspektive').selectOption('PLAYER');
    await guest.getByRole('radio', { name: 'Ja', exact: true }).check(); await guest.getByRole('button', { name: 'Testantwort abgeben' }).click();
    await expect(guest.getByText('Deine Testantwort: a', { exact: true })).toBeVisible();
    await guest.reload(); await expect(guest.getByText('Deine Testantwort: a', { exact: true })).toBeVisible();
    await guest.getByLabel('Fehler oder Warnung melden').fill('Bitte Formulierung prüfen'); await guest.getByRole('button', { name: 'Hinweis speichern' }).click();
    await expect(host.getByRole('region', { name: 'Gesammelte Playtest-Hinweise' })).toContainText('Bitte Formulierung prüfen');
    await host.getByRole('button', { name: 'Auflösen', exact: true }).click();
    await expect(guest.getByText('PLAYTEST_PRIVATE_SOLUTION', { exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Playtest beenden', exact: true }).click();
    await expect(guest.getByRole('alert')).toContainText('beendet, abgelaufen');
    const unchanged = await hostContext.request.get(`${BASE}/api/v1/content/pools/${pool.id}`);
    expect((await unchanged.json()).data.items[0].status).toBe('DRAFT');
  } finally { await Promise.allSettled([hostContext.close(), guestContext.close()]); }
});

test('C6: setup validates exact difficulty counts, saves a private distribution and creates a real pinned room', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    expect((await context.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const name = `Difficulty ${crypto.randomUUID()}`;
    const p = await context.request.post(`${BASE}/api/v1/content/pools`, { data: { commandId: crypto.randomUUID(), gameSlug: 'wissensduell', name } }); expect(p.status()).toBe(201); const pool = (await p.json()).data;
    for (const difficulty of ['EASY', 'HARD']) {
      const q = await context.request.post(`${BASE}/api/v1/content/pools/${pool.id}/items`, { data: { commandId: crypto.randomUUID(), item: { title: difficulty, difficulty,
        payload: { prompt: `Frage ${difficulty}`, category: 'Test', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'a' } } } }); expect(q.status()).toBe(201);
      const question = (await q.json()).data;
      expect((await context.request.post(`${BASE}/api/v1/content/items/${question.id}/status`, { data: { commandId: crypto.randomUUID(), revision: question.revision, status: 'READY' } })).status()).toBe(200);
    }
    const page = await context.newPage(); await page.goto(`${BASE}/moderator/vorbereitung/wissensduell`);
    await page.getByRole('checkbox', { name: `${name} · PRIVATE`, exact: true }).check();
    const slider = page.getByRole('slider', { name: 'Anzahl Fragen' }); await slider.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    const editor = page.getByRole('region', { name: 'Schwierigkeitsverlauf' });
    await editor.getByLabel('Schwierigkeitsvorlage', { exact: true }).selectOption('distribution');
    for (const label of ['Sehr leicht (%)', 'Mittel (%)', 'Sehr schwer (%)']) await editor.getByLabel(label, { exact: true }).fill('0');
    await expect(editor.getByRole('alert')).toContainText('100 Prozent');
    for (const label of ['Leicht (%)', 'Schwer (%)']) await editor.getByLabel(label, { exact: true }).fill('50');
    await expect(editor.getByRole('status')).toHaveText('2 Fragen: 1 Leicht · 1 Schwer');
    await editor.getByLabel('Name der eigenen Schwierigkeitsvorlage').fill(name);
    await editor.getByRole('button', { name: 'Schwierigkeitsvorlage speichern', exact: true }).click();
    await expect(editor.getByRole('option', { name: `${name} · Eigene Vorlage`, exact: true })).toBeAttached();
    const created = page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Raum erstellen/ }).click(); expect((await created).status()).toBe(201);
    await expect(page).toHaveURL(/\/moderator\/raum\/\d{3}-\d{3}\/lobby$/);
  } finally { await context.close(); }
});

test('C7: complete preset and room template preserve settings, favorites and explicit overrides across reload and room creation', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    expect((await context.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const page = await context.newPage(), name = `Whole preset ${crypto.randomUUID()}`;
    await page.goto(`${BASE}/moderator/vorbereitung/wissensduell`);
    const view = page.getByRole('region', { name: 'Spiel- und Raumvorlagen' });
    const viewers = page.getByRole('checkbox', { name: 'Zuschauer erlauben', exact: true }); if (await viewers.isChecked()) await viewers.uncheck();
    await view.getByLabel('Presetname', { exact: true }).fill(name);
    await view.getByRole('button', { name: 'Aktuelle Konfiguration als Preset speichern' }).click();
    await expect(view.getByRole('option', { name: `${name} · V1`, exact: true })).toBeAttached();
    await view.getByRole('button', { name: 'Als Favorit pinnen' }).click();
    await expect(view.getByRole('option', { name: `★ ${name} · V2`, exact: true })).toBeAttached();
    await page.reload(); await expect(page.getByRole('checkbox', { name: 'Zuschauer erlauben', exact: true })).toBeChecked();
    await view.getByLabel('Spiel-Preset', { exact: true }).selectOption({ label: `★ ${name} · V2` });
    page.once('dialog', d => d.accept()); await view.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Zuschauer erlauben', exact: true })).not.toBeChecked();
    await view.getByLabel('Raumvorlage', { exact: true }).selectOption('system:room-private');
    const template = view.getByRole('group', { name: 'Room Templates' }); page.once('dialog', d => d.accept()); await template.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Zuschauer erlauben', exact: true }).check();
    const created = page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Raum erstellen/ }).click(); const r = await created; expect(r.status()).toBe(201);
    const room = (await r.json()).data; await expect(page).toHaveURL(new RegExp(`/moderator/raum/${room.code}/lobby$`));
    const info = await context.request.get(`${BASE}/api/v1/rooms/${room.code}`); expect(await info.text()).not.toContain('setupBlueprintsJson');
  } finally { await context.close(); }
});

test('C8: blind setup persists across reload, blocks editor and export reads, and releases the fence when the room closes', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    expect((await context.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'admin-1' } })).status()).toBe(200);
    const name = `Blind ${crypto.randomUUID()}`;
    const p = await context.request.post(`${BASE}/api/v1/content/pools`, { data: { commandId: crypto.randomUUID(), gameSlug: 'wissensduell', name } }); expect(p.status()).toBe(201); const pool = (await p.json()).data;
    const q = await context.request.post(`${BASE}/api/v1/content/pools/${pool.id}/items`, { data: { commandId: crypto.randomUUID(), item: { title: 'Blind UI', payload: { prompt: 'BLIND_BROWSER_PROMPT', category: 'Test', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'b', explanation: 'BLIND_BROWSER_SECRET' } } } }); expect(q.status()).toBe(201); const item = (await q.json()).data;
    expect((await context.request.post(`${BASE}/api/v1/content/items/${item.id}/status`, { data: { commandId: crypto.randomUUID(), revision: 1, status: 'READY' } })).status()).toBe(200);
    const page = await context.newPage(); await page.goto(`${BASE}/moderator/vorbereitung/wissensduell`);
    await page.getByRole('checkbox', { name: `${name} · PRIVATE`, exact: true }).check(); await page.getByRole('slider', { name: 'Anzahl Fragen' }).focus(); await page.keyboard.press('Home');
    await page.getByLabel('Inhaltssicht des Hosts', { exact: true }).selectOption('BLIND_HOST');
    const created = page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST'); await page.getByRole('button', { name: /Raum erstellen/ }).click(); const response = await created; expect(response.status()).toBe(201); const room = (await response.json()).data;
    await page.reload(); await expect(page.getByRole('status').filter({ hasText: 'Blindmoderation: Lösungen erst nach Auflösung' })).toBeVisible();
    const info = await context.request.get(`${BASE}/api/v1/rooms/${room.code}`); expect(await info.text()).not.toContain('BLIND_BROWSER_SECRET'); expect((await info.json()).data.contentVisibility).toBe('BLIND_HOST');
    expect((await context.request.get(`${BASE}/api/v1/content/items/${item.id}/preview?role=HOST&reveal=true`)).status()).toBe(403);
    expect((await context.request.get(`${BASE}/api/v1/content/pools/${pool.id}/export?format=JSON`)).status()).toBe(403);
    expect((await context.request.delete(`${BASE}/api/v1/rooms/${room.code}`)).status()).toBe(200);
    expect((await context.request.get(`${BASE}/api/v1/content/items/${item.id}/preview?role=HOST`)).status()).toBe(200);
  } finally { await context.close(); }
});
