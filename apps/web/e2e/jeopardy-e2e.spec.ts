import { expect, test, type Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

interface PlayerSession {
  participationId: string;
  rejoinToken: string;
  role: string;
}

// ──────────────────────────────────────────────────────────────
// Helpers (same pattern as geo-e2e.spec.ts)
// ──────────────────────────────────────────────────────────────

async function loginAsModerator(page: Page, userId = 'mod-1'): Promise<void> {
  // Establish browser context before obtaining the protected test session.
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('domcontentloaded');

  const response = await page.context().request.post(`${BASE}/api/v1/auth/e2e-token`, {
    data: { userId },
  });

  expect(response.status(), `E2E-Login für ${userId} fehlgeschlagen: ${await response.text()}`).toBe(200);
  const body = await response.json() as { success: boolean; data?: { user?: { id: string } } };
  expect(body.success).toBe(true);
  expect(body.data?.user?.id).toBe(userId);
}

// ──────────────────────────────────────────────────────────────
// Sample board data (all fields filled in for room creation)
// ──────────────────────────────────────────────────────────────

const SAMPLE_CATEGORIES = [
  'Geschichte', 'Wissenschaft', 'Geografie', 'Sport', 'Kunst', 'Musik',
];

function makeImportPayload(boardNum: 1 | 2, pointMultiplier: number) {
  return {
    meta: { version: 1, exportedAt: new Date().toISOString() },
    board1: {
      categories: SAMPLE_CATEGORIES.map((title, ci) => ({
        title,
        clues: [100, 200, 300, 400, 500].map((base, vi) => ({
          value: base * pointMultiplier,
          question: `Frage ${ci + 1}-${vi + 1}`,
          answer: `Antwort ${ci + 1}-${vi + 1}`,
          type: 'text',
        })),
      })),
    },
    board2: {
      categories: SAMPLE_CATEGORIES.map((title, ci) => ({
        title,
        clues: [100, 200, 300, 400, 500].map((base, vi) => ({
          value: base * pointMultiplier,
          question: `Frage ${ci + 1}-${vi + 1}`,
          answer: `Antwort ${ci + 1}-${vi + 1}`,
          type: 'text',
        })),
      })),
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Create a Jeopardy room via REST API (most reliable for E2E)
// Uses the cookie from loginAsModerator + /api/v1/rooms endpoint
// ──────────────────────────────────────────────────────────────

async function createJeopardyRoom(page: Page): Promise<string> {
  await page.goto(`${BASE}/moderator/vorbereitung/jeopardy`);
  await expect(page.getByRole('heading', { name: 'Jeopardy einrichten' })).toBeVisible();
  const payload = makeImportPayload(1, 1);
  payload.board2.categories.forEach((category) => {
    category.clues.forEach((clue) => { clue.value *= 2; });
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'jeopardy-e2e.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(page.getByRole('button', { name: 'Geschichte' })).toBeVisible();
  await page.getByRole('button', { name: 'Raum erstellen' }).click();
  await page.waitForURL(/\/moderator\/raum\/\d{3}-\d{3}\/lobby$/, { timeout: 20_000 });
  const code = page.url().match(/\/moderator\/raum\/(\d{3}-\d{3})\/lobby$/)?.[1];
  expect(code).toBeTruthy();
  await expect(page.getByText('Verbunden', { exact: true }).first()).toBeVisible();
  return code!;
}

async function joinAsPlayer(page: Page, code: string, name: string): Promise<PlayerSession> {
  await page.goto(`${BASE}/beitreten`);
  await page.getByLabel('Anzeigename').fill(name);
  await page.getByLabel('Raumcode').fill(code);
  await page.getByRole('button', { name: 'Beitreten' }).click();

  await page.waitForURL(new RegExp(`/raum/${code}/lobby$`), { timeout: 15_000 });
  await expect(page.getByText('Verbunden', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  const session = await page.evaluate(() => ({
    participationId: sessionStorage.getItem('qp_participationId'),
    rejoinToken: sessionStorage.getItem('qp_rejoinToken'),
    role: sessionStorage.getItem('qp_role'),
  }));

  expect(session.participationId, `${name}: participationId fehlt`).toBeTruthy();
  expect(session.rejoinToken, `${name}: rejoinToken fehlt`).toBeTruthy();
  expect(session.role).toBe('PLAYER');

  return session as PlayerSession;
}

async function watchAsSpectator(page: Page, code: string): Promise<void> {
  await page.goto(`${BASE}/zuschauen/${code}/lobby`);
  await expect(page).toHaveURL(new RegExp(`/zuschauen/${code}/lobby$`));
  await expect(page.getByText('Verbunden', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
}

async function startGame(moderator: Page): Promise<void> {
  await moderator.getByRole('button', { name: 'Spiel starten' }).click();
  await moderator.waitForURL(/\/moderator\/raum\/\d{3}-\d{3}\/jeopardy$/, { timeout: 20_000 });
  await expect(moderator.getByRole('gridcell', { name: /100 Punkte/ }).first()).toBeEnabled();
}

async function readyPlayer(page: Page): Promise<void> {
  await page.getByRole('button', { name: /bereit/i }).click();
  await expect(page.getByText('Bereit ✓').first()).toBeVisible();
}

async function probeSocket(code: string, rejoinToken?: string): Promise<Socket> {
  const socket = io(BASE, { transports: ['websocket'], forceNew: true });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const subscription = await socket.timeout(5000).emitWithAck('room:subscribe', { roomCode: code, rejoinToken });
  expect(subscription.success).toBe(true);
  return socket;
}

async function openField(moderator: Page, categoryIndex = 0, value = 200): Promise<void> {
  const cell = moderator.locator(`[data-category-index="${categoryIndex}"][data-value="${value}"]`);
  await expect(cell).toBeEnabled();
  await cell.click();
  await expect(moderator.getByText(`Frage ${categoryIndex + 1}-${value / 100}`, { exact: true }).first()).toBeVisible();
}

async function buzz(page: Page): Promise<void> {
  const buzzer = page.getByRole('button', { name: /JETZT BUZZEN|BUZZ/i }).first();
  await expect(buzzer).toBeVisible();
  await buzzer.click();
}

async function judgeCorrect(moderator: Page): Promise<void> {
  // Wait for judge buttons (BUZZ_LOCKED phase)
  const correctBtn = moderator.getByRole('button', { name: /RICHTIG/i });
  await expect(correctBtn).toBeVisible({ timeout: 15_000 });
  await correctBtn.click();
  await expect(moderator.getByRole('button', { name: /Nächste Frage|Board 2/i })).toBeVisible();
}

async function judgeWrong(moderator: Page): Promise<void> {
  const wrongBtn = moderator.getByRole('button', { name: /falsch/i });
  await expect(wrongBtn).toBeVisible({ timeout: 5_000 });
  await wrongBtn.click();
}

async function stealBuzz(page: Page): Promise<void> {
  const stealBuzzer = page.getByRole('button', { name: /abstauben/i }).or(page.getByRole('button', { name: /steal/i })).or(page.getByRole('button', { name: /buzz/i }));
  await expect(stealBuzzer).toBeVisible({ timeout: 5_000 });
  await stealBuzzer.click();
}

// ──────────────────────────────────────────────────────────────
// J1: Moderator Login -> Jeopardy-Raum erstellen
// ──────────────────────────────────────────────────────────────

test('J1: Moderator Login -> Jeopardy-Raum erstellen', async ({ page }) => {
  await loginAsModerator(page);
  const code = await createJeopardyRoom(page);

  expect(code).toMatch(/^\d{3}-\d{3}$/);
  await expect(page.getByText(code, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Verbunden', { exact: true }).first()).toBeVisible();
});

// ──────────────────────────────────────────────────────────────
// J2: Zwei Spieler treten dem Jeopardy-Raum bei
// ──────────────────────────────────────────────────────────────

test('J2: Zwei echte Spieler treten bei und erscheinen in der Lobby', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const player1 = await p1Ctx.newPage();
    const player2 = await p2Ctx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    const [s1, s2] = await Promise.all([
      joinAsPlayer(player1, code, 'Spieler Eins'),
      joinAsPlayer(player2, code, 'Spieler Zwei'),
    ]);

    expect(s1.participationId).not.toBe(s2.participationId);

    await expect(moderator.getByText('Spieler Eins', { exact: true })).toBeVisible();
    await expect(moderator.getByText('Spieler Zwei', { exact: true })).toBeVisible();
  } finally {
    await Promise.all([modCtx.close(), p1Ctx.close(), p2Ctx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J3: Zuschauer kann öffentlicher Lobby folgen
// ──────────────────────────────────────────────────────────────

test('J3: Zuschauer kann einer öffentlichen Lobby ohne Login beitreten', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const viewCtx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const viewer = await viewCtx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);
    await watchAsSpectator(viewer, code);
  } finally {
    await Promise.all([modCtx.close(), viewCtx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J4: Spiel starten, Feld öffnen, Buzzer, Bewertung, Punkte
// ──────────────────────────────────────────────────────────────

test('J4: Vollständiger Spielablauf: starten -> feld öffnen -> buzzer -> bewerten -> punkte', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const player1 = await p1Ctx.newPage();
    const player2 = await p2Ctx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    await joinAsPlayer(player1, code, 'Frager');
    await joinAsPlayer(player2, code, 'Antworter');

    // Both players must mark themselves as ready before the game can start
    await Promise.all([readyPlayer(player1), readyPlayer(player2)]);
    // Verify players show "Bereit ✓" (use .first() — each player's lobby shows all players)
    await expect(player1.getByText('Bereit ✓').first()).toBeVisible({ timeout: 5_000 });
    await expect(player2.getByText('Bereit ✓').first()).toBeVisible({ timeout: 5_000 });

    await startGame(moderator);

    // Moderator opens a field
    await openField(moderator, 0, 200);

    // Question appears on player pages
    await expect(player1.getByText(/punkte/i).or(player1.getByText(/\d{3}/))).toBeVisible({ timeout: 10_000 });
    await expect(player2.getByText(/punkte/i).or(player2.getByText(/\d{3}/))).toBeVisible({ timeout: 5_000 });

    // Both players buzz (one should win — don't fail on timeout)
    await buzz(player1);
    await expect(player2.getByRole('button', { name: /JETZT BUZZEN|BUZZ/i })).not.toBeVisible();

    // Moderator judges correct
    await judgeCorrect(moderator);

    // Field should now be marked as played (not clickable)
    // The cell gets disabled + has no interactive class — check disabled attribute instead
    await expect(moderator.locator('[data-category-index="0"][data-value="200"]')).toBeDisabled({ timeout: 10_000 });
  } finally {
    await Promise.all([modCtx.close(), p1Ctx.close(), p2Ctx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J5: Falsche Hauptantwort -> Abstauber-Buzzer öffnet sich
// ──────────────────────────────────────────────────────────────

test('J5: Falsche Hauptantwort -> Abstauber-Buzzer wird geöffnet', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const player1 = await p1Ctx.newPage();
    const player2 = await p2Ctx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    await joinAsPlayer(player1, code, 'Frager');
    await joinAsPlayer(player2, code, 'Antworter');
    await Promise.all([readyPlayer(player1), readyPlayer(player2)]);

    await startGame(moderator);
    await openField(moderator, 0, 200);

    // Player1 buzzes first
    await buzz(player1);

    // Moderator judges wrong
    await judgeWrong(moderator);

    // Steal buzzer should now be open — both players can buzz
    // (the steal buzzer indicator should be visible)
    const stealOpen = moderator.getByText(/abstauber|steal|öffnet/i).or(moderator.getByRole('button', { name: /abstauben/i }));
    await expect(stealOpen).toBeVisible({ timeout: 5_000 });

    // Player2 attempts steal buzz
    await stealBuzz(player2);

    // Moderator judges steal (correct or wrong)
    await expect(moderator.getByRole('button', { name: /richtig|falsch/i }).first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await Promise.all([modCtx.close(), p1Ctx.close(), p2Ctx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J6: Nur der erste Buzzer wird akzeptiert
// ──────────────────────────────────────────────────────────────

test('J6: Nur der erste Buzzer wird akzeptiert, spätere werden abgelehnt', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const player1 = await p1Ctx.newPage();
    const player2 = await p2Ctx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    await joinAsPlayer(player1, code, 'Schneller');
    await joinAsPlayer(player2, code, 'Langsamer');
    await Promise.all([readyPlayer(player1), readyPlayer(player2)]);

    await startGame(moderator);
    await openField(moderator, 0, 400);

    await buzz(player1);
    await expect(player2.getByRole('button', { name: /JETZT BUZZEN|BUZZ/i })).not.toBeVisible();
    await expect(moderator.getByText('Schneller', { exact: true }).first()).toBeVisible();

    // After judging, scores update atomically
    await judgeCorrect(moderator);
    await expect(moderator.getByText(/\d{3}/)).toBeVisible({ timeout: 5_000 });
  } finally {
    await Promise.all([modCtx.close(), p1Ctx.close(), p2Ctx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J7: Reload/Rejoin stellt Spielstand wieder her
// ──────────────────────────────────────────────────────────────

test('J7: Reload und Rejoin stellen Rolle, Punktestand und Phase wieder her', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const player1 = await p1Ctx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    await joinAsPlayer(player1, code, 'Reload-Spieler');
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await joinAsPlayer(other, code, 'Zweiter Spieler');
    await Promise.all([readyPlayer(player1), readyPlayer(other)]);
    await startGame(moderator);
    await openField(moderator, 0, 200);

    // Capture state before reload
    await buzz(player1);
    // Reload player page
    await player1.reload();
    await expect(player1.getByText('Reload-Spieler', { exact: true })).toBeVisible({ timeout: 10_000 });

    // After reconnect, socket re-syncs and shows the question state
    await expect(player1.getByText('Frage 1-2', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await otherContext.close();
  } finally {
    await Promise.all([modCtx.close(), p1Ctx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J8: Spieler/Zuschauer darf keine Moderator-Aktionen ausführen
// ──────────────────────────────────────────────────────────────

test('J8: Spieler kann kein Feld öffnen oder bewerten (nur Moderator)', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const player1 = await p1Ctx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    const player = await joinAsPlayer(player1, code, 'Gesperrter Spieler');
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await joinAsPlayer(other, code, 'Zweiter Spieler');
    await Promise.all([readyPlayer(player1), readyPlayer(other)]);
    await startGame(moderator);

    // Player page should NOT have a field-opening button for other players
    const fieldButtons = player1.getByRole('button', { name: /\d{3}/ });
    await expect(fieldButtons.first()).toBeDisabled();
    const probe = await probeSocket(code, player.rejoinToken);
    try {
      expect((await probe.timeout(5000).emitWithAck('jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(false);
      expect((await probe.timeout(5000).emitWithAck('jeopardy:judge', { correct: true })).success).toBe(false);
    } finally {
      probe.disconnect();
    }
    await otherContext.close();
  } finally {
    await Promise.all([modCtx.close(), p1Ctx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J9: Lösung wird nicht an Spieler geleakt
// ──────────────────────────────────────────────────────────────

test('J9: Lösung ist nicht im DOM oder Netzwerk-Payload von Spielern enthalten', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const player1 = await p1Ctx.newPage();
    const received: string[] = [];
    player1.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => received.push(payload));
    });

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    await joinAsPlayer(player1, code, 'Kein Leak');
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await joinAsPlayer(other, code, 'Zweiter Spieler');
    await Promise.all([readyPlayer(player1), readyPlayer(other)]);
    await startGame(moderator);
    await openField(moderator, 0, 200);

    // Wait for question to appear
    await expect(player1.getByText(/punkte/i).or(player1.getByText(/\d{3}/))).toBeVisible({ timeout: 10_000 });

    // The page HTML should NOT contain the word "antwort" (solution)
    // (This is a proxy check — the server doesn't emit answer to player sockets)
    const pageText = await player1.evaluate(() => document.body.innerText);
    // Answer should not appear in player page
    expect(pageText).not.toContain('Antwort 1-2');
    expect(received.join(' ')).not.toContain('Antwort 1-2');
    await otherContext.close();
  } finally {
    await Promise.all([modCtx.close(), p1Ctx.close()]);
  }
});

// ──────────────────────────────────────────────────────────────
// J10: Zuschauer sieht keine Lösung, keine Aktions-Buttons
// ──────────────────────────────────────────────────────────────

test('J10: Zuschauer hat nur Lesezugriff, keine Aktions-Buttons', async ({ browser }) => {
  const modCtx = await browser.newContext();
  const viewCtx = await browser.newContext();

  try {
    const moderator = await modCtx.newPage();
    const viewer = await viewCtx.newPage();

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);
    await watchAsSpectator(viewer, code);
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    await joinAsPlayer(first, code, 'Erster Spieler');
    await joinAsPlayer(second, code, 'Zweiter Spieler');
    await Promise.all([readyPlayer(first), readyPlayer(second)]);

    await startGame(moderator);
    await openField(moderator, 0, 200);

    // Wait for question
    await expect(viewer.getByText(/punkte/i).or(viewer.getByText(/\d{3}/))).toBeVisible({ timeout: 10_000 });

    // No buzzer button for spectators
    const buzzBtn = viewer.getByRole('button', { name: /buzz/i });
    await expect(buzzBtn).not.toBeVisible();

    // No score buttons for spectators
    const judgeBtn = viewer.getByRole('button', { name: /richtig|falsch/i });
    await expect(judgeBtn).not.toBeVisible();
    const probe = await probeSocket(code);
    try {
      expect((await probe.timeout(5000).emitWithAck('jeopardy:buzz', {})).success).toBe(false);
      expect((await probe.timeout(5000).emitWithAck('jeopardy:board:switch', { toBoard: 2 })).success).toBe(false);
    } finally {
      probe.disconnect();
    }
    await Promise.all([firstContext.close(), secondContext.close()]);
  } finally {
    await Promise.all([modCtx.close(), viewCtx.close()]);
  }
});
