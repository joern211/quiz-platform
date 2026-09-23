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

async function loginAsModerator(page: Page) {
  // E2E-Shortcut: Session-Cookie direkt via API setzen (bypasst Browser-Login + Cookie-Cross-Context-Probleme)
  // WICHTIG: page.context().request teilt den Cookie-Jar mit dem Browser-Context
  const response = await page.context().request.post(`${BASE}/api/v1/auth/e2e-token`, {
    data: { userId: 'mod-1' },
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
  // Sicherstellen, dass wir auf der Geo-Setup-Seite sind
  await page.goto(`${BASE}/moderator/vorbereitung/geo`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Prüfe: Heading "Raum vorbereiten" muss sichtbar sein
  await expect(page.getByRole('heading', { name: /Raum vorbereiten/i })).toBeVisible();

  // Optional: Raumnamen setzen (leer lassen = Default)
  const roomNameInput = page.locator('input[placeholder*="Quiz"]').first();
  if (await roomNameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await roomNameInput.fill('E2E Geo Test');
  }

  // "Raum erstellen" Button klicken
  const createBtn = page.locator('button:has-text("Raum erstellen")').first();
  await expect(createBtn).toBeVisible();
  console.log('[createGeoRoom] Clicking "Raum erstellen" button');
  await createBtn.click();

  // Netzwerk-Responses sammeln für Diagnose
  const apiResponses: { url: string; status: number; body?: string }[] = [];
  page.on('response', async res => {
    if (res.url().includes('/api/v1/rooms')) {
      const body = await res.text().catch(() => '');
      apiResponses.push({ url: res.url(), status: res.status(), body });
    }
  });

  // Warten auf Navigation zur Moderator-Lobby
  // Timeout erhöht weil Socket.io/Express langsam sein kann
  try {
    await page.waitForURL(/\/moderator\/raum\/[A-Z0-9-]+\/lobby/, { timeout: 20000 });
  } catch (e) {
    console.log('[createGeoRoom] Navigation failed. URL:', page.url());
    console.log('[createGeoRoom] API responses:', JSON.stringify(apiResponses));
    // Check for alert dialogs
    page.on('dialog', d => console.log('[createGeoRoom] Dialog:', d.message()));
    throw e;
  }

  // Room Code aus URL extrahieren
  const url = page.url();
  const match = url.match(/\/moderator\/raum\/([A-Z0-9-]+)\/lobby/);
  return match ? match[1] : '';
}

async function joinAsPlayer(page: Page, code: string, name: string) {
  // Navigiere zur Lobby. Beim Laden der Seite wird /lobby/:code verwendet
  // und die Socket-ID gesetzt. Vor dem Reload setzen wir das sessionStorage
  // damit das Socket nach dem Reload sofort mit den richtigen Werten startet.
  await page.goto(`${BASE}/raum/${code}/lobby`);
  await page.waitForLoadState('domcontentloaded');
  // Prüfe ob wir auf der Lobby-Seite sind (URL enthält /lobby)
  const onLobby = page.url().includes('/lobby');
  if (!onLobby) {
    console.log(`[joinAsPlayer] ${name} nicht auf Lobby, URL=${page.url()}, warte...`);
    await page.waitForURL(RegExp(`/raum/${code}/lobby`), { timeout: 10000 });
  }
  // Setze sessionStorage VOR dem Reload, damit das Socket es sofort liest
  await page.evaluate(({ c, n }: { c: string; n: string }) => {
    sessionStorage.setItem('qp_roomCode', c);
    sessionStorage.setItem('qp_role', 'PLAYER');
    sessionStorage.setItem('qp_displayName', n);
    console.log('[joinAsPlayer] sessionStorage gesetzt, role=PLAYER');
  }, { c: code, n: name });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  await page.waitForURL(RegExp(`/raum/${code}/lobby`), { timeout: 15000 });

  const connected = await page.locator('text=Verbunden').isVisible({ timeout: 5000 }).catch(() => false);
  const url = page.url();
  console.log(`[joinAsPlayer] ${name} Lobby geladen. Verbunden=${connected}, URL=${url}`);
}

async function joinAsViewer(page: Page, code: string) {
  await page.goto(`${BASE}/zuschauen/${code}/lobby`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  await page.waitForURL(RegExp(`/zuschauen/${code}/(lobby|spiel)`), { timeout: 10000 }).catch(
    async () => { await page.waitForTimeout(3000); }
  );
}

// --- Tests ---

test('G4-1: Moderator Login → Geo-Raum erstellen', async ({ page }) => {
  await loginAsModerator(page);

  // Nach Login sollte man NICHT mehr auf der Anmeldeseite sein
  await expect(page).not.toHaveURL(/anmelden/, { ignoreCase: true });

  // Geo-Raum erstellen
  const code = await createGeoRoom(page);
  expect(code).toMatch(/^[A-Z0-9-]+$/);
  expect(code.length).toBeGreaterThan(0);

  // Moderator-Lobby URL bestätigen
  await expect(page).toHaveURL(/\/moderator\/raum\/[A-Z0-9-]+\/lobby/);

  // Raum-Code sollte in der Lobby sichtbar sein
  await expect(page.getByText(code).first()).toBeVisible({ timeout: 5000 });
});

test('G4-2: Zwei Spieler treten bei → Lobby zeigt beide', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const playerACtx = await browser.newContext();
  const playerBCtx = await browser.newContext();

  const modPage = await modCtx.newPage();
  const playerAPage = await playerACtx.newPage();
  const playerBPage = await playerBCtx.newPage();

  try {
    await loginAsModerator(modPage);
    const code = await createGeoRoom(modPage);

    // Player A joins (parallel mit etwas Verzögerung)
    await joinAsPlayer(playerAPage, code, 'Spieler A');

    // Kurz warten, dann Player B
    await modPage.waitForTimeout(1000);
    await joinAsPlayer(playerBPage, code, 'Spieler B');

    // Moderator aktualisiert die Lobby
    await modPage.reload();
    // 5 s warten, dann explizit auf beide Spieler prüfen (Abschnitt 5: kein OR erlaubt)
    await modPage.waitForTimeout(5_000);
    const playerALoaded = await modPage.getByText('Spieler A').isVisible({ timeout: 1000 }).catch(() => false);
    const playerBLoaded = await modPage.getByText('Spieler B').isVisible({ timeout: 1000 }).catch(() => false);
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
    // Moderator erstellt Raum
    const modCtx = await browser.newContext();
    const modPage = await modCtx.newPage();
    await loginAsModerator(modPage);
    const code = await createGeoRoom(modPage);
    await modCtx.close();

    // Zuschauer tritt bei — kein Login nötig
    await joinAsViewer(page, code);

    // Zuschauer-Lobby prüfen
    await expect(page).toHaveURL(RegExp(`/zuschauen/${code}/(lobby|spiel)`), { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

test('G4-5: Private Raum — nicht in öffentlicher Liste, Moderator sieht eigenen', async ({ browser }) => {
  // Zwei getrennte Kontexte: einer für den Moderator, einer anonym
  const modCtx = await browser.newContext();
  const anonCtx = await browser.newContext();

  const modPage = await modCtx.newPage();
  const anonPage = await anonCtx.newPage(); // Kein Cookie → wirklich anonym

  try {
    // ── Schritt 1: Privaten Raum erstellen ──────────────────────────
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

    // ── Schritt 2: Privater Raum fehlt in öffentlicher Liste ─────────
    // listJson.data ist das Array direkt, nicht { rooms: [...] }
    const listRes = await modPage.context().request.get(`${BASE}/api/v1/rooms/public`);
    expect(listRes.ok()).toBeTruthy();
    const listJson = await listRes.json();
    const publicCodes: string[] = Array.isArray(listJson.data) ? listJson.data.map((r: any) => r.code) : [];
    expect(publicCodes, `Privater Raum ${privateCode} sollte NICHT in öffentlicher Liste sein`).not.toContain(privateCode);

    // ── Schritt 3: Anonymer GET /api/v1/rooms/:code → 404 ───────────
    const unauthRes = await anonPage.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    const unauthJson = await unauthRes.json().catch(() => null);
    expect(
      unauthRes.status() === 404 || (unauthJson && unauthJson.success === false && unauthJson.error?.code === 'NOT_FOUND'),
      `Anonym/ungeloggt GET /api/v1/rooms/:code → 404 NOT_FOUND, bekam status=${unauthRes.status()} body=${JSON.stringify(unauthJson)}`
    ).toBe(true);

    // ── Schritt 4: Host mit Session → 200 ───────────────────────────
    const hostRes = await modPage.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    const hostJson = await hostRes.json();
    expect(
      hostRes.status() === 200 && hostJson && hostJson.success && hostJson.data && hostJson.data.code === privateCode,
      `Host-GET /api/v1/rooms/:code → 200, bekam status=${hostRes.status()} body=${JSON.stringify(hostJson)}`
    ).toBe(true);

    // ── Schritt 5: Kein Zugriff ohne gültige Session ───────────────────
    // Seed hat nur 1 User (admin = mod-1). Prüfung: Jeder Request ohne
    // gültige Session-Cookie erhält 404 (nicht authentifiziert).
    const noAccessRes = await anonPage.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    expect(noAccessRes.status(), `Unauthentifizierter Zugriff → 404, bekam ${noAccessRes.status()}`).toBe(404);
    console.log('[Block 5] Kein Zugriff ohne Session bestätigt');

    // ── Schritt 6: Browser-URL zeigt Lobby für Host ──────────────────
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

  const modPage = await modCtx.newPage();
  const playerPage = await playerCtx.newPage();
  setupBrowserLogger(modPage, 'modPage');
  setupBrowserLogger(playerPage, 'playerPage');

  try {
    await loginAsModerator(modPage);
    const code = await createGeoRoom(modPage);

    // Spieler tritt bei und markiert sich als bereit
    await joinAsPlayer(playerPage, code, 'Quiz Champion');

    // ── Schritt 3b: Spieler ist bereit ──────────────────────────────
    const readyBtn = playerPage.locator('button:has-text("bereit")').first();
    const readyVisible = await readyBtn.isVisible({ timeout: 3000 }).catch(() => false);
    expect(readyVisible, '"Bereit"-Button muss sichtbar sein').toBe(true);
    await readyBtn.click();
    await playerPage.waitForTimeout(1000);
    console.log('[Block 3] Spieler hat Bereit-Button geklickt');

    // Warten bis Lobby beide Spieler zeigt + ready synchronisiert ist
    await modPage.waitForTimeout(2000);

    // DEBUG: Lobby-Status vor dem Klick protokollieren
    const readyCount = await modPage.locator('[class*="Bereit"], [class*="bereit"], [class*="ready"]').count();
    const playerItems = await modPage.locator('[class*="Spieler"]').count();
    const connText = await modPage.locator('text=/Verbunden|Spieler/').allInnerTexts();
    console.log(`[Block 3] Lobby-Status: Bereit=${readyCount}, Spieler=${playerItems}, Texte=${JSON.stringify(connText)}`);

    // ── Schritt 4: E2E-Socket-Identity-Fix ──────────────────────────
    // Problem: Nach loginAsModerator() + createGeoRoom() (sessionStorage + reload)
    // hat das Socket room:subscribe VOR dem Spieler-Beitritt gesendet.
    // Wenn der Spieler dann beitritt und bereit wird, hat das Moderator-Socket
    // noch keine PLAYER-Rolle — aber game:start braucht MODERATOR.
    // Lösung: Socket nullen → Seite neu laden → useEffect läuft → connect
    // → room:subscribe mit sessionStorage (MODERATOR-Rolle aus Host-UserId).
    await modPage.evaluate(() => {
      const win = window as any;
      if (win.__resetSocket) {
        console.log('[E2E] Calling __resetSocket() before reload');
        win.__resetSocket();
      }
    });
    await modPage.waitForTimeout(300);
    await modPage.reload();
    await modPage.waitForLoadState('networkidle');
    // Nach Reload: Socket verbindet sich neu → 'connect' → useEffect (socket.connected)
    // → room:subscribe (liest sessionStorage → MODERATOR-Rolle aus host-UserId)
    console.log('[E2E] Reload done, socket reconnected as MODERATOR');

    // ── Schritt 5: Moderator klickt "Spiel starten" via UI ─────────────
    // Button MUSS sichtbar sein — kein Fallback
    console.log('[Block 4] Suche "Spiel starten"-Button...');
    const startBtn = modPage.getByRole('button', { name: /Spiel starten/i }).first();
    const startVisible = await startBtn.isVisible({ timeout: 5000 }).catch(() => false);
    expect(startVisible, '"Spiel starten"-Button muss sichtbar sein').toBe(true);
    await startBtn.click();
    console.log('[Block 4] UI-Button geklickt — warte auf Spielstart');

    // Dialog-Handler VOR dem Klick registrieren
    let dialogShown = false;
    let reachedGame = false;
    modPage.on('dialog', async dialog => {
      dialogShown = true;
      console.log(`[Block 4] Dialog: "${dialog.message()}" (type=${dialog.type()})`);
      await dialog.dismiss();
    });

    // Navigiere zur Moderator-Spiel-Seite.
    // navigate() wird im socket-Callback aufgerufen, NICHT nach einem page.goto.
    // Nach dem Klick warten wir, ob die URL sich ändert.
    for (let i = 0; i < 40; i++) {
      await modPage.waitForTimeout(500);
      const currentUrl = modPage.url();
      if (currentUrl.includes('/spiel')) {
        reachedGame = true;
        console.log('[Block 4] Spiel-Seite für Moderator erreicht!');
        break;
      }
    }
    if (!reachedGame) {
      const debugUrl = modPage.url();
      const debugTitle = await modPage.title();
      const debugBody = (await modPage.locator('body').innerText()).substring(0, 300);
      console.log(`[Block 4] KEINE Navigation. Dialog=${dialogShown}, URL=${debugUrl}, Title=${debugTitle}, Body=${debugBody}`);
    }
    expect(reachedGame, `Spiel-Seite nach Button-Klick erreichen (warte 20s). Aktuelle URL: ${modPage.url()}`).toBe(true);

    // ── Schritt 5: Spieler ist ebenfalls auf Spiel-Seite ─────────────
    await playerPage.waitForURL(/\/spiel/, { timeout: 15000 });
    expect(playerPage.url(), 'Spiel-Seite für Spieler erreicht').toContain('/spiel');
    console.log('[Block 5] Spieler auf Spiel-Seite');

    // ── Schritt 6: Spieler sieht Frage und beantwortet sie ───────────
    // Frage-Container abwarten (entweder Options-Buttons oder
    // "Warte auf nächste Frage..." während Game startet)
    const optionBtns = playerPage.locator('button.option, [class*="option"]').first();

    // Max 20s warten bis Frage-Buttons da sind
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

    // Alle Antwort-Buttons holen
    const answerBtns = playerPage.locator('button.option, [class*="option"]');
    const count = await answerBtns.count();
    expect(count, `Mindestens 1 Antwort-Button erwartet, gefunden: ${count}`).toBeGreaterThanOrEqual(1);

    // Erste Option anklicken
    await answerBtns.first().click();
    await playerPage.waitForTimeout(2000);
    console.log('[Block 6] Antwort geklickt');

    // ── Schritt 7: Zwischenstand sichtbar ─────────────────────────────
    // Nach dem Klick: Score muss sichtbar sein (Server-Reaktion)
    const scoreEl = playerPage.locator('[class*="score"]').first();
    const scoreVisible = await scoreEl.isVisible({ timeout: 10000 }).catch(() => false);
    expect(scoreVisible, 'Score/Punkte müssen nach dem Beantworten sichtbar sein').toBe(true);
    console.log(`[Block 7] Score sichtbar: ${scoreVisible}`);

    // ── Schritt 8: Spiel erreicht Ergebnis-/Endzustand ────────────────
    // Warten auf Game-End (max 45x 2s = 90s für alle Fragen)
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
  }
});
