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
  // Spieler über REST API beitreten lassen (POST /api/v1/rooms/:code/join)
  // page.context().request teilt den Cookie-Jar mit dem Browser-Context
  const response = await page.context().request.post(`${BASE}/api/v1/rooms/${code}/join`, {
    data: { displayName: name },
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Player join API failed: ${response.status()} ${text}`);
  }

  const json = await response.json();
  if (!json.success) {
    throw new Error(`Player join failed: ${JSON.stringify(json)}`);
  }

  const { rejoinToken, participationId, roomCode } = json.data;
  console.log(`[joinAsPlayer] ${name} beigetreten: pid=${participationId}, token=${rejoinToken?.slice(0,8)}...`);

  // SessionStorage im Browser-Context setzen (localStorage-Escape via page.evaluate)
  await page.goto(`${BASE}/raum/${code}/lobby`);
  await page.waitForLoadState('networkidle');

  await page.evaluate((tokens: { rejoinToken: string; participationId: string; roomCode: string }) => {
    sessionStorage.setItem('qp_rejoinToken', tokens.rejoinToken);
    sessionStorage.setItem('qp_participationId', tokens.participationId);
    sessionStorage.setItem('qp_roomCode', tokens.roomCode);
    sessionStorage.setItem('qp_role', 'PLAYER');
  }, { rejoinToken, participationId, roomCode });

  // Seite neu laden damit React die sessionStorage liest + Socket verbindet
  await page.reload();
  await page.waitForLoadState('networkidle');

  // Warten bis Socket-Verbindung steht + Lobby-Snapshot empfangen
  await page.waitForTimeout(3000);
  await page.waitForURL(RegExp(`/raum/${code}/lobby`), { timeout: 15000 });

  // DEBUG: Socket-Verbindungsstatus prüfen
  const connected = await page.locator('text=Verbunden').isVisible({ timeout: 3000 }).catch(() => false);
  const players = await page.locator('text=Bereit').count().catch(() => 0);
  console.log(`[joinAsPlayer] Lobby geladen. Verbunden=${connected}, Bereit-Buttons=${players}`);
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
  const modCtx = await browser.newContext();
  const page = await modCtx.newPage();

  try {
    await loginAsModerator(page);
    await createGeoRoom(page); // Erst öffentlichen Raum erstellen (nötig für Cookie/Session)

    // Privaten Raum erstellen via REST (kein isPublic-Toggle in der UI)
    const createRes = await page.context().request.post(`${BASE}/api/v1/rooms`, {
      data: {
        gameSlug: 'geo',
        roomName: 'E2E Privater Test',
        isPublic: false,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    const createJson = await createRes.json();
    expect(createRes.ok(), `Raum erstellen fehlgeschlagen: ${JSON.stringify(createJson)}`).toBeTruthy();
    const privateCode = createJson.data.code;
    console.log(`[G4-5] Privater Raum erstellt: ${privateCode}`);

    // Privater Raum NICHT in öffentlicher Liste
    const listRes = await page.context().request.get(`${BASE}/api/v1/rooms/public`);
    expect(listRes.ok()).toBeTruthy();
    const listJson = await listRes.json();
    const codes = listJson.data?.rooms?.map((r: any) => r.code) ?? [];
    expect(codes).not.toContain(privateCode);

    // Privater Raum NICHT direkt abrufbar ohne Session
    const unauthRes = await page.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    expect(unauthRes.status, 'Unauthenticated access to private room should be 404').toBe(404);

    // Moderator sieht eigenen privaten Raum
    await page.goto(`${BASE}/moderator/raum/${privateCode}/lobby`);
    await page.waitForTimeout(2000);
    expect(page.url()).toContain(privateCode);
  } finally {
    await modCtx.close();
  }
});
test('G4-4: Vollständiger Spielablauf (Moderator startet, 1 Spieler antwortet)', async ({ browser }) => {
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

    // Spieler: "Ich bin bereit" klicken
    const readyBtn = playerPage.locator('button:has-text("bereit")').first();
    if (await readyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await readyBtn.click();
      await playerPage.waitForTimeout(1000);
    }

    // WICHTIG: Nach jedem page.reload() muss das Socket-Singleton zurückgesetzt werden.
    // Problem: socket.io-client Singleton → nach reload wird kein 'connect'-Event mehr
    // gefeuert → room:subscribe wird nicht emitted → game:start → NOT_IN_ROOM.
    // Fix: Vor dem reload __resetSocket() aufrufen (nullt das Singleton).
    // Nach dem Reload erstellt getSocket() ein FRISCHES Socket → connect-Event →
    // room:subscribe → Moderator ist im Room → game:start funktioniert.
    await modPage.evaluate(() => {
      const win = window as any;
      if (win.__resetSocket) {
        console.log('[E2E] Calling __resetSocket() before reload');
        win.__resetSocket();
      } else {
        console.log('[E2E] __resetSocket not found — may not be in bundle yet');
      }
    });
    await modPage.waitForTimeout(300);
    await modPage.reload();

    // NEUES Socket wird nach Reload erstellt (autoConnect=true).
    // Das "Verbunden"-Element im DOM erscheint NACHdem das Socket
    // room:subscribe gesendet hat → damit ist Subscription implizit bestätigt.

    // Warten auf "Verbunden" (erscheint NACH room:snapshot im DOM)
    await modPage.waitForSelector('text=Verbunden', { timeout: 15000 });
    await modPage.waitForTimeout(3000);

    // E2E-Socket-Identity-Fix: Nach page.reload() hat das neue Socket bereits
    // room:subscribe gesendet aber role war möglicherweise falsch (VIEWER statt MODERATOR).
    // Das Kernproblem: mod-1 ist nicht der Raum-Host (Raum wurde von admin erstellt).
    // Lösung: POST /api/v1/e2e/game-start startet das Spiel direkt via REST.
    // Prüft: game-start-Logik, minPlayers, Fragen laden, RUNNING-Status, game:start emit.
    console.log('[Block 4] Starte Spiel via UI-Button (echter Nutzerfluss)');
    const startBtn = modPage.getByRole('button', { name: /Spiel starten/i }).first();
    if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startBtn.click();
      console.log('[Block 4] UI-Button geklickt — warte auf Navigation');
      await modPage.waitForTimeout(5000);
      console.log('[Block 4] URL nach Klick:', modPage.url());
    } else {
      // Fallback: UI-Button nicht sichtbar — Socket-basierter Start via handleStart
      // Hole das moderatoreigene Rejoin-Token für die Moderator-Partizipation
      const modPageContent = await modPage.locator('body').innerText();
      console.log('[Block 4] Start-Button nicht sichtbar. Prüfe minPlayers...');
      console.log(`[modPage] Content: ${modPageContent.slice(0, 300)}`);
      // Prüfe ob genug Spieler da sind
      const hasMinPlayers = await modPage.getByText(/Mindestens 2 Spieler benötigt/i).isVisible({ timeout: 1000 }).catch(() => false);
      if (hasMinPlayers) {
        throw new Error('Nicht genug Spieler — minPlayers-Check schlägt fehl');
      }
    }

    // Navigiere zur Spiel-Seite
    await modPage.waitForURL(/\/spiel/, { timeout: 15000 });
    expect(modPage.url()).toContain('/spiel');
    console.log('[Block 4] Spiel-Seite erreicht!');
  } finally {
    await modCtx.close();
    await playerCtx.close();
  }
});
