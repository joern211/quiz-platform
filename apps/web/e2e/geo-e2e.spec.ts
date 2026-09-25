import { test, expect, type Page } from '@playwright/test';

// ── Browser-Console-Logger ────────────────────────────────────────
function setupBrowserLogger(page: Page, label: string) {
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[SOCKET') || text.startsWith('[FORCE') || text.startsWith('[E2E')) {
      console.log(`[${label}] ${text}`);
    }
  });
  page.on('pageerror', err => console.log(`[${label}] PAGE ERROR: ${err.message}`));
}

// Gate 4: Vollständiger Geo-Vertical-Slice
// Testet: Moderator + 2 Spieler + 1 Zuschauer, alle Spielphasen

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';

// --- Hilfsfunktionen ---

async function loginAsModerator(page: Page, userIdOverride?: string) {
  const uid = userIdOverride ?? 'mod-host'; // 'mod-host' für den Host, nicht 'mod-1'
  // Distinct userId per call: tsx generates a random suffix to avoid DB unique-constraint errors
  const sessionUserId = `${uid}-player-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const response = await page.context().request.post(`${BASE}/api/v1/auth/e2e-token`, {
    data: { userId: sessionUserId },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok()) {
    throw new Error(`E2E token failed: ${response.status()} ${await response.text()}`);
  }
  const json = await response.json();
  if (!json.success) {
    throw new Error(`E2E token failed: ${JSON.stringify(json)}`);
  }
  console.log(`[loginAsModerator] Session cookie gesetzt für: ${json.data.user.displayName}`);
  await page.goto(`${BASE}/moderator/vorbereitung/geo`);
  await page.waitForTimeout(1000);
  await expect(page.getByRole('button', { name: /Raum erstellen/ })).toBeVisible({ timeout: 10000 });
}

async function createGeoRoom(page: Page): Promise<string> {
  await page.goto(`${BASE}/moderator/vorbereitung/geo`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  await expect(page.getByRole('heading', { name: /Raum vorbereiten/i })).toBeVisible();

  const roomNameInput = page.locator('input[placeholder*="Quiz"]').first();
  if (await roomNameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await roomNameInput.fill('E2E Geo Test');
  }

  const createBtn = page.locator('button:has-text("Raum erstellen")').first();
  await expect(createBtn).toBeVisible();
  console.log('[createGeoRoom] Clicking "Raum erstellen" button');
  await createBtn.click();

  try {
    await page.waitForURL(/\/moderator\/raum\/[A-Z0-9-]+\/lobby/, { timeout: 20000 });
  } catch (e) {
    console.log('[createGeoRoom] Navigation failed. URL:', page.url());
    throw e;
  }

  const url = page.url();
  const match = url.match(/\/moderator\/raum\/([A-Z0-9-]+)\/lobby/);
  return match ? match[1] : '';
}

async function joinAsPlayer(page: Page, code: string, name: string) {
  // Players müssen die echte JoinPage nutzen, damit der Server role=PLAYER/MODERATOR
  // bestimmt und die korrekte Lobby-URL berechnet.
  await page.context().addInitScript(([c, n]: [string, string]) => {
    sessionStorage.setItem('qp_roomCode', c);
    sessionStorage.setItem('qp_displayName', n);
    // Kein qp_role setzen – der Server soll es aus dem Auth-Token ableiten
  }, [code, name]);
  // Navigiert zur JoinPage (nicht direkt zur Lobby)
  await page.goto(`${BASE}/beitreten`);
  await page.waitForLoadState('networkidle');
  // Findet das Name- und Code-Eingabefeld
  const inputs = page.locator('input');
  const nameInput = inputs.nth(0); // Erstes Input = Anzeigename
  const codeInput = inputs.nth(1); // Zweites Input = Raumcode
  await nameInput.waitFor({ timeout: 5000 });
  await nameInput.fill(name);
  await codeInput.fill(code);
  // Submit-Button
  await page.getByRole('button', { name: /treten|join|beigetreten/i }).click();
  // Wartet auf Navigation zur Lobby (moderator oder nicht — toleriert beides)
  const lobbyPattern = new RegExp(`/raum/${code.replace('-', '[^/]*')}/lobby`);
  await page.waitForURL(url => lobbyPattern.test(url.pathname), { timeout: 10000 }).catch(() => {});
  const url = page.url();
  console.log(`[joinAsPlayer] ${name} — URL: ${url}`);
  // Wartet auf "Verbunden"-Status
  await page.waitForFunction(
    () => document.body.textContent?.includes('Verbunden') === true,
    { timeout: 15000 }
  ).catch(() => null);
  const connected = await page.locator('text=Verbunden').isVisible({ timeout: 3000 }).catch(() => false);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log(`[joinAsPlayer] ${name} — Verbunden=${connected}, Body: ${bodyText.substring(0, 300)}`);
}

async function joinAsViewer(page: Page, code: string) {
  await page.goto(`${BASE}/zuschauen/${code}/lobby`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.waitForURL(RegExp(`/zuschauen/${code}/(lobby|spiel)`), { timeout: 20000 }).catch(
    async () => { await page.waitForTimeout(3000); }
  );
}

// --- Tests ---

test('G4-1: Moderator Login → Geo-Raum erstellen', async ({ page }) => {
  await loginAsModerator(page);
  await expect(page).not.toHaveURL(/anmelden/, { ignoreCase: true });
  const code = await createGeoRoom(page);
  expect(code).toMatch(/^[A-Z0-9-]+$/);
  expect(code.length).toBeGreaterThan(0);
  await expect(page).toHaveURL(/\/moderator\/raum\/[A-Z0-9-]+\/lobby/);
  await expect(page.getByText(code).first()).toBeVisible({ timeout: 5000 });
});

test('G4-2: Zwei Spieler treten bei → Lobby zeigt beide', async ({ browser }) => {
  test.setTimeout(90000);
  const modCtx = await browser.newContext();
  const playerACtx = await browser.newContext();
  const playerBCtx = await browser.newContext();

  const modPage = await modCtx.newPage();
  const playerAPage = await playerACtx.newPage();
  const playerBPage = await playerBCtx.newPage();

  try {
    await loginAsModerator(modPage);
    const code = await createGeoRoom(modPage);

    // Beide Spieler parallel beitreten
    await Promise.all([
      joinAsPlayer(playerAPage, code, 'Spieler A'),
      joinAsPlayer(playerBPage, code, 'Spieler B'),
    ]);

    // DEBUG: Log pre-reload state
    console.log(`[G4-2] Vor Reload — Players im DOM:`);
    const preEls = await modPage.locator('[class*="player"]').allInnerTexts().catch(() => []);
    console.log(`  preReload players: ${JSON.stringify(preEls)}`);
    const preUrl = modPage.url();
    console.log(`  preReload URL: ${preUrl}`);

    // E2E-Fix: Reset the socket singleton BEFORE reload so the new page gets a
    // FRESH socket connection (fresh socket ID) that subscribes to the current room.
    // Without this, the old socket ID persists and subscribes to the WRONG room.
    await modPage.evaluate(() => (window as any).__resetSocket?.());

    await modPage.context().addInitScript((c: string) => {
      sessionStorage.setItem('qp_roomCode', c);
      sessionStorage.setItem('qp_role', 'MODERATOR');
    }, code);
    await modPage.reload();

    // DEBUG: Log post-reload state (mit Socket-Zustand)
    console.log(`[G4-2] Nach Reload (sofort):`);
    const postUrl = modPage.url();
    console.log(`  URL: ${postUrl}`);

    // Prüfe Socket-Instanz-Zustand
    const socketState = await modPage.evaluate(() => (window as any).__getSocketState?.());
    console.log(`  Socket-Instanz: ${JSON.stringify(socketState)}`);

    const postEl = await modPage.locator('body').innerText().catch(() => '');
    console.log(`  Body: ${postEl.substring(0, 200)}`);

    // Warte auf Verbunden-Status statt festes Timeout
    console.log('[G4-2] Warte auf Verbunden-Status...');
    try {
      await modPage.waitForFunction(
        () => document.body.textContent?.includes('Verbunden') === true,
        { timeout: 10000 }
      );
      console.log('[G4-2] Verbunden-Status erreicht');
    } catch {
      console.log('[G4-2] Verbunden-Status Timeout!');
    }

    // Prüfe Socket-Instanz nach Warten
    const socketStateAfter = await modPage.evaluate(() => (window as any).__getSocketState?.());
    console.log(`  Socket-Instanz (nach Warten): ${JSON.stringify(socketStateAfter)}`);

    // DEBUG: Logge room:subscribe-Zustand in sessionStorage
    const ss = await modPage.evaluate(() => ({
      roomCode: sessionStorage.getItem('qp_roomCode'),
      role: sessionStorage.getItem('qp_role'),
      rejoinToken: sessionStorage.getItem('qp_rejoinToken'),
      partId: sessionStorage.getItem('qp_participationId'),
    }));
    console.log(`  sessionStorage: ${JSON.stringify(ss)}`);

    await modPage.waitForTimeout(2000);

    // DEBUG: Log nach 2s Warten (nach Verbunden)
    console.log(`[G4-2] Nach 2s Warten — Players im DOM:`);
    const postEls = await modPage.locator('[class*="player"]').allInnerTexts().catch(() => []);
    console.log(`  postReload players: ${JSON.stringify(postEls)}`);
    const bodyText = await modPage.locator('body').innerText().catch(() => '');
    console.log(`  Body full: ${bodyText.substring(0, 400)}`);
    const playerCount = await modPage.locator('text=Spieler').first().textContent().catch(() => '');
    console.log(`  'Spieler'-Text: ${playerCount}`);

    // Beide Spieler in der Lobby sichtbar
    const playerALoaded = await modPage.getByText('Spieler A').isVisible({ timeout: 3000 }).catch(() => false);
    const playerBLoaded = await modPage.getByText('Spieler B').isVisible({ timeout: 3000 }).catch(() => false);
    expect(playerALoaded, 'Spieler A muss in der Lobby sichtbar sein').toBeTruthy();
    expect(playerBLoaded, 'Spieler B muss in der Lobby sichtbar sein').toBeTruthy();
  } finally {
    await modCtx.close();
    await playerACtx.close();
    await playerBCtx.close();
  }
});

test('G4-3: Zuschauer kann Lobby beitreten ohne Login', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    const modCtx = await browser.newContext();
    const modPage = await modCtx.newPage();
    // Use 'mod-host' as the host userId so it's distinct from 'mod-1' players
    await loginAsModerator(modPage, 'mod-host');
    const code = await createGeoRoom(modPage);
    await modCtx.close();

    await joinAsViewer(page, code);
    await expect(page).toHaveURL(RegExp(`/zuschauen/${code}/(lobby|spiel)`), { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

test('G4-5: Private Raum — nicht in öffentlicher Liste, Moderator sieht eigenen', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const anonCtx = await browser.newContext();

  const modPage = await modCtx.newPage();
  const anonPage = await anonCtx.newPage();

  try {
    await loginAsModerator(modPage);

    const createRes = await modPage.context().request.post(`${BASE}/api/v1/rooms`, {
      data: {
        gameSlug: 'geo',
        roomName: 'E2E Privater Test',
        isPublic: false,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(createRes.ok(), `Raum erstellen fehlgeschlagen: ${createRes.status()} ${await createRes.text()}`).toBeTruthy();
    const privateCode = (await createRes.json()).data.code;
    expect(privateCode).toMatch(/^[A-Z0-9-]+$/);
    console.log(`[G4-5] Privater Raum erstellt: ${privateCode}`);

    // Privater Raum fehlt in öffentlicher Liste
    const listRes = await modPage.context().request.get(`${BASE}/api/v1/rooms/public`);
    expect(listRes.ok()).toBeTruthy();
    const listJson = await listRes.json();
    const publicCodes: string[] = Array.isArray(listJson.data) ? listJson.data.map((r: any) => r.code) : [];
    expect(publicCodes, `Privater Raum ${privateCode} sollte NICHT in öffentlicher Liste sein`).not.toContain(privateCode);

    // Anonymer GET /api/v1/rooms/:code → 404
    const unauthRes = await anonPage.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    const unauthJson = await unauthRes.json().catch(() => null);
    expect(
      unauthRes.status() === 404 || (unauthJson && unauthJson.success === false && unauthJson.error?.code === 'NOT_FOUND'),
      `Anonym GET /api/v1/rooms/:code → 404, bekam status=${unauthRes.status()} body=${JSON.stringify(unauthJson)}`
    ).toBe(true);

    // Host mit Session → 200
    const hostRes = await modPage.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    const hostJson = await hostRes.json();
    expect(
      hostRes.status() === 200 && hostJson && hostJson.success && hostJson.data && hostJson.data.code === privateCode,
      `Host-GET /api/v1/rooms/:code → 200, bekam status=${hostRes.status()} body=${JSON.stringify(hostJson)}`
    ).toBe(true);

    // Browser-URL zeigt Lobby für Host
    await modPage.goto(`${BASE}/moderator/raum/${privateCode}/lobby`);
    await modPage.waitForTimeout(2000);
    expect(modPage.url(), 'Host sollte Lobby erreichen').toContain(privateCode);
  } finally {
    await modCtx.close();
    await anonCtx.close();
  }
});

test('G4-4: Vollständiger Spielablauf (Moderator startet, 1 Spieler antwortet)', async ({ browser }) => {
  test.setTimeout(120000);
  const modCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const player2Ctx = await browser.newContext();

  const modPage = await modCtx.newPage();
  const playerPage = await playerCtx.newPage();
  const player2Page = await player2Ctx.newPage();
  setupBrowserLogger(modPage, 'modPage');
  setupBrowserLogger(playerPage, 'playerPage');

  try {
    await loginAsModerator(modPage);
    const code = await createGeoRoom(modPage);

    // ── Schritt 3: Zwei Spieler treten bei und sind bereit ─────────────
    await Promise.all([
      joinAsPlayer(playerPage, code, 'Quiz Champion'),
      joinAsPlayer(player2Page, code, 'Spieler B'),
    ]);
    await modPage.waitForTimeout(1000);
    const readyBtn = playerPage.locator('button:has-text("bereit")').first();
    const readyVisible = await readyBtn.isVisible({ timeout: 3000 }).catch(() => false);
    expect(readyVisible, '"Bereit"-Button muss sichtbar sein').toBe(true);
    await readyBtn.click();
    await player2Page.locator('button:has-text("bereit")').first().click().catch(() => {});
    await playerPage.waitForTimeout(1000);
    console.log('[Block 3] Spieler hat Bereit-Button geklickt');

    // Warten bis Lobby bereit synchronisiert hat
    await modPage.waitForTimeout(2000);

    // DEBUG: Lobby-Status protokollieren
    const connText = await modPage.locator('body').innerText().catch(() => '');
    console.log(`[Block 3] Lobby-Text: ${connText.substring(0, 300)}`);

    // DEBUG: Player-Liste im DOM
    const playerEls = await modPage.locator('[class*="player"], [class*="Player"]').allInnerTexts().catch(() => []);
    console.log(`[Block 3] Player-DOM-Elemente: ${JSON.stringify(playerEls)}`);

    // DEBUG: Sichtbare Text-Elemente im gesamten Body
    const allVisible = await modPage.locator('body').getByText(/Spieler|Host|Verbunden/g).allInnerTexts().catch(() => []);
    console.log(`[Block 3] Sichtbare Texte: ${JSON.stringify(allVisible)}`);

    // ── Schritt 4: E2E-Socket-Identity ──────────────────────────────
    // Modera...[truncated]

    // ── Schritt 4: E2E-Socket-Identity ──────────────────────────────
    // sessionStorage VOR reload setzen → Socket liest MODERATOR beim reconnect
    await modPage.context().addInitScript((c: string) => {
      sessionStorage.setItem('qp_roomCode', c);
      sessionStorage.setItem('qp_role', 'MODERATOR');
    }, code);
    await modPage.reload();
    await modPage.waitForTimeout(3000);
    console.log('[E2E] Moderator reload done, socket as MODERATOR');

    // ── Schritt 5: "Spiel starten" Button ───────────────────────────
    // Button MUSS sichtbar sein — kein Fallback
    console.log('[Block 4] Suche "Spiel starten"-Button...');
    const startBtn = modPage.getByRole('button', { name: /Spiel starten/i }).first();
    const startVisible = await startBtn.isVisible({ timeout: 5000 }).catch(() => false);
    expect(startVisible, '"Spiel starten"-Button muss sichtbar sein').toBe(true);

    // Dialog-Handler vor dem Klick
    let dialogShown = false;
    modPage.on('dialog', async dialog => {
      dialogShown = true;
      console.log(`[Block 4] Dialog: "${dialog.message()}"`);
      await dialog.dismiss();
    });

    await startBtn.click();
    console.log('[Block 4] UI-Button geklickt — warte auf Spielstart');

    // Warten auf Navigation zur /spiel URL (max 20s)
    let reachedGame = false;
    for (let i = 0; i < 40; i++) {
      await modPage.waitForTimeout(500);
      if (modPage.url().includes('/spiel')) {
        reachedGame = true;
        console.log('[Block 4] Spiel-Seite für Moderator erreicht!');
        break;
      }
    }
    if (!reachedGame) {
      const debugBody = (await modPage.locator('body').innerText().catch(() => '')).substring(0, 300);
      console.log(`[Block 4] KEINE Navigation. Dialog=${dialogShown}, URL=${modPage.url()}, Body=${debugBody}`);
    }
    expect(reachedGame, `Spiel-Seite nach Button-Klick erreichen (warte 20s). Aktuelle URL: ${modPage.url()}`).toBe(true);

    // ── Schritt 6: Spieler auf Spiel-Seite ─────────────────────────
    await playerPage.waitForURL(/\/spiel/, { timeout: 15000 });
    expect(playerPage.url(), 'Spiel-Seite für Spieler erreicht').toContain('/spiel');
    console.log('[Block 5] Spieler auf Spiel-Seite');

    // ── Schritt 7: Spieler sieht Frage und beantwortet sie ─────────
    // Max 20s auf Frage-Buttons warten
    const optionBtns = playerPage.locator('button.option, [class*="option"]').first();
    let questionVisible = false;
    for (let i = 0; i < 20; i++) {
      if (await optionBtns.isVisible({ timeout: 1000 }).catch(() => false)) {
        questionVisible = true;
        break;
      }
      await playerPage.waitForTimeout(1000);
    }
    expect(questionVisible, 'Frage/Optionen sollten nach Spielstart sichtbar sein').toBe(true);
    console.log('[Block 6] Frage für Spieler sichtbar — klicke Antwort');

    const answerBtns = playerPage.locator('button.option, [class*="option"]');
    const count = await answerBtns.count();
    expect(count, `Mindestens 1 Antwort-Button erwartet, gefunden: ${count}`).toBeGreaterThanOrEqual(1);
    await answerBtns.first().click();
    await playerPage.waitForTimeout(2000);
    console.log('[Block 6] Antwort geklickt');

    // ── Schritt 8: Zwischenstand sichtbar ────────────────────────────
    const scoreEl = playerPage.locator('[class*="score"]').first();
    const scoreVisible = await scoreEl.isVisible({ timeout: 10000 }).catch(() => false);
    expect(scoreVisible, 'Score/Punkte müssen nach dem Beantworten sichtbar sein').toBe(true);
    console.log(`[Block 7] Score sichtbar: ${scoreVisible}`);

    // ── Schritt 9: Spiel erreicht Ergebnis-/Endzustand ──────────────
    // Max 45 × 2s = 90s warten
    const endStates = ['Ergebnis', 'Endergebnis', 'Final', 'Results', 'Gewinner'];
    let reachedEnd = false;
    for (let i = 0; i < 45; i++) {
      const bodyText = await playerPage.locator('body').innerText().catch(() => '');
      if (endStates.some((s) => bodyText.includes(s)) || playerPage.url().includes('/ergebnis')) {
        reachedEnd = true;
        console.log(`[Block 8] Endzustand erreicht nach ~${i * 2}s`);
        break;
      }
      if (!(await playerPage.locator('body').isVisible({ timeout: 1000 }).catch(() => false))) {
        console.log('[Block 8] Spieler-Seite nicht mehr sichtbar — Spiel beendet');
        reachedEnd = true;
        break;
      }
      await playerPage.waitForTimeout(2000);
    }
    expect(reachedEnd, 'Spiel muss Ergebnis-/Endzustand erreichen').toBe(true);
  } finally {
    await modCtx.close();
    await playerCtx.close();
    await player2Ctx.close();
  }
});
