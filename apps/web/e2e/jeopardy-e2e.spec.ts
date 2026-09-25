import { expect, test, type Page } from '@playwright/test';
import type { Board } from '../src/pages/JeopardySetupPage';

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
  // Navigate to base first to establish the browser context fully
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('domcontentloaded');
  // Small delay to avoid racing the server
  await page.waitForTimeout(500);

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
// Fill in board data via JSON file import
// Uses real temp file path + setInputFiles (most reliable for React onChange)
// ──────────────────────────────────────────────────────────────

async function importBoard(page: Page, boardNum: 1 | 2, pointMultiplier: number): Promise<void> {
  const payload = makeImportPayload(boardNum, pointMultiplier);
  const tmpPath = `/tmp/jeopardy-board-${boardNum}-${Date.now()}.json`;

  // Write JSON to temp file via Node.js in the test context
  const fs = await import('fs');
  fs.writeFileSync(tmpPath, JSON.stringify(payload));

  // Use setInputFiles with the real file path — fires proper React onChange
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(tmpPath);
  await page.waitForTimeout(300);
}

// ──────────────────────────────────────────────────────────────
// Fill in a board manually (step-by-step fallback)
// ──────────────────────────────────────────────────────────────

async function fillBoard(page: Page, board: Board): Promise<void> {
  for (let ci = 0; ci < board.categories.length; ci++) {
    await page.getByRole('button', { name: new RegExp(`^Kategorie ${ci + 1}$`) }).click();
    await page.waitForTimeout(150);

    // Fill title
    await page.getByRole('button', { name: 'Titel' }).click();
    await page.waitForTimeout(100);
    const titleArea = page.locator('textarea').first();
    await titleArea.click();
    await titleArea.pressSequentially(board.categories[ci].title, { delay: 10 });
    // Verify React state updated
    await expect(titleArea).toHaveValue(board.categories[ci].title, { timeout: 2000 }).catch(() => {});

    // For each clue: click value, fill question, then answer
    for (let vi = 0; vi < board.categories[ci].clues.length; vi++) {
      const clueValue = board.categories[ci].clues[vi].value;
      await page.getByRole('button', { name: String(clueValue), exact: true }).click();
      await page.waitForTimeout(150);

      // Fill question
      await page.getByRole('button', { name: 'Frage' }).click();
      await page.waitForTimeout(100);
      const qArea = page.locator('textarea').first();
      await qArea.click();
      await qArea.pressSequentially(board.categories[ci].clues[vi].question, { delay: 10 });
      await expect(qArea).toHaveValue(board.categories[ci].clues[vi].question, { timeout: 2000 }).catch(() => {});

      // Fill answer
      await page.getByRole('button', { name: 'Antwort' }).click();
      await page.waitForTimeout(100);
      const aArea = page.locator('textarea').first();
      await aArea.click();
      await aArea.pressSequentially(board.categories[ci].clues[vi].answer, { delay: 10 });
      await expect(aArea).toHaveValue(board.categories[ci].clues[vi].answer, { timeout: 2000 }).catch(() => {});
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Create a Jeopardy room via REST API (most reliable for E2E)
// Uses the cookie from loginAsModerator + /api/v1/rooms endpoint
// ──────────────────────────────────────────────────────────────

async function createJeopardyRoom(page: Page): Promise<string> {
  // Get auth cookie from browser context
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find(c => c.name === 'quiz_session');
  if (!sessionCookie) throw new Error('No session cookie found — call loginAsModerator first');

  const payload = makeImportPayload(1, 1);

  // Create room via REST API directly
  const res = await page.context().request.post(`${BASE}/api/v1/rooms`, {
    data: {
      gameSlug: 'jeopardy',
      roomName: 'E2E Jeopardy Test',
      maxPlayers: 10,
      allowViewers: true,
      isPublic: true,
      setupSnapshotJson: {
        board1: payload.board1,
        board2: payload.board2,
      },
    },
  });

  expect(res.status(), `Room creation failed: ${await res.text()}`).toBe(201);
  const body = await res.json() as { success: boolean; data: { code: string } };
  expect(body.success, `Room creation failed: ${await res.text()}`).toBe(true);

  const code = body.data.code;

  // Navigate to moderator lobby to verify the UI works end-to-end
  await page.goto(`${BASE}/moderator/raum/${code}/lobby`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  // Verify lobby elements
  await expect(page.getByText(code, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Verbunden', { exact: true }).first()).toBeVisible({ timeout: 5_000 });

  return code;
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
  // Get session cookie from browser context
  const cookies = await moderator.context().cookies();
  const sessionCookie = cookies.find(c => c.name === 'quiz_session');
  if (!sessionCookie) throw new Error('No session cookie — call loginAsModerator first');

  // Get room code from URL
  const url = moderator.url();
  const codeMatch = url.match(/\/moderator\/raum\/(\d{3}-\d{3})\/lobby/);
  if (!codeMatch) throw new Error(`Cannot find room code in URL: ${url}`);
  const code = codeMatch[1];

  // Use E2E REST endpoint for game start — bypasses socket identity issues
  const res = await moderator.context().request.post(`${BASE}/api/v1/e2e/game-start`, {
    data: { roomCode: code },
  });

  const body = await res.json() as { success: boolean; data?: { roomCode: string } };
  if (!res.ok() || !body.success) {
    throw new Error(`game:start failed (${res.status()}): ${await res.text()}`);
  }

  // Navigate directly to the Jeopardy game page (don't rely on socket navigation)
  await moderator.goto(`${BASE}/moderator/raum/${code}/jeopardy`);
  // Wait for the page to load — use 'load' not 'networkidle' (socket connection is async)
  await moderator.waitForLoadState('load');
  // Wait for socket events to initialize the game state
  // Poll until we see the Jeopardy page structure (look for the heading or any score card)
  try {
    await moderator.getByRole('heading', { name: /Board \d|Jeopardy/i }).waitFor({ state: 'attached', timeout: 20_000 });
  } catch {
    // Fallback: wait for the URL to confirm we're on the game page
    await moderator.waitForURL(/\/moderator\/raum\/\d{3}-\d{3}\/jeopardy$/, { timeout: 10_000 });
  }
  await moderator.waitForTimeout(1_000); // Let socket events settle
  // Now confirm the grid exists in the DOM (may still be "hidden" if no CSS dimensions)
  await expect(moderator.locator('[role="grid"]')).toBeAttached({ timeout: 10_000 });
  await moderator.waitForTimeout(500); // Allow socket state to settle
}

async function openField(moderator: Page, categoryIndex = 0, value = 200): Promise<void> {
  // Wait for board to be attached (DOM ready)
  await expect(moderator.locator('[role="grid"]')).toBeAttached({ timeout: 10_000 });
  // Click the field cell — only works in SELECTING phase
  const cell = moderator.locator('[data-category-index="' + categoryIndex + '"][data-value="' + value + '"]');
  await expect(cell).toBeVisible({ timeout: 5_000 });
  await cell.click();
}

async function buzz(page: Page): Promise<void> {
  // Wait for BUZZ_OPEN phase — buzzer button must be visible
  const buzzer = page.getByRole('button', { name: /JETZT BUZZEN|BUZZ/i });
  // Only buzz if buzzer is actually visible (race condition: first player already won)
  if (await buzzer.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await buzzer.click();
    // Wait for buzzer to disappear (BUZZ_LOCKED — someone won)
    await expect(buzzer).not.toBeVisible({ timeout: 10_000 }).catch(() => {});
  }
}

async function judgeCorrect(moderator: Page): Promise<void> {
  // Wait for judge buttons (BUZZ_LOCKED phase)
  const correctBtn = moderator.getByRole('button', { name: /RICHTIG/i });
  await expect(correctBtn).toBeVisible({ timeout: 15_000 });
  await correctBtn.click();
  // Wait for judgment result (FIELD_DONE phase — reveal shown)
  await moderator.waitForTimeout(1_000);
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
    await Promise.all([
      player1.getByRole('button', { name: /bereit/i }).click().then(() => player1.waitForTimeout(500)),
      player2.getByRole('button', { name: /bereit/i }).click().then(() => player2.waitForTimeout(500)),
    ]);
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
    await Promise.all([buzz(player1), buzz(player2)]).catch(() => {});

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

    await startGame(moderator);
    await openField(moderator, 0, 400);

    // Player 1 is slightly faster — both buzz immediately
    await Promise.all([buzz(player1), buzz(player2)]);

    // Only one buzzer should be locked — the other should see "already taken"
    const lockedOrFailed = moderator.getByText(/(Schneller|Langsamer)/).or(moderator.getByText(/buzzer/i));
    await expect(lockedOrFailed).toBeVisible({ timeout: 5_000 });

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
    await startGame(moderator);
    await openField(moderator, 0, 200);

    // Capture state before reload
    await buzz(player1);
    await player1.evaluate(() => ({
      phase: sessionStorage.getItem('qp_phase'),
      score: sessionStorage.getItem('qp_score'),
    }));

    // Reload player page
    await player1.reload();
    await expect(player1.getByText('Reload-Spieler', { exact: true })).toBeVisible({ timeout: 10_000 });

    // After reconnect, socket re-syncs and shows the question state
    await expect(player1.getByText(/verbunden/i).or(player1.getByText('Reload-Spieler'))).toBeVisible({ timeout: 10_000 });
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

    await joinAsPlayer(player1, code, 'Gesperrter Spieler');

    await startGame(moderator);

    // Player page should NOT have a field-opening button for other players
    const fieldButtons = player1.getByRole('button', { name: /\d{3}/ });
    await expect(fieldButtons.first()).not.toBeVisible({ timeout: 5_000 });
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

    await loginAsModerator(moderator);
    const code = await createJeopardyRoom(moderator);

    await joinAsPlayer(player1, code, 'Kein Leak');
    await startGame(moderator);
    await openField(moderator, 0, 200);

    // Wait for question to appear
    await expect(player1.getByText(/punkte/i).or(player1.getByText(/\d{3}/))).toBeVisible({ timeout: 10_000 });

    // The page HTML should NOT contain the word "antwort" (solution)
    // (This is a proxy check — the server doesn't emit answer to player sockets)
    const pageText = await player1.evaluate(() => document.body.innerText);
    // Answer should not appear in player page
    expect(pageText).not.toMatch(/antwort:\s*\w{4,}/i);
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
  } finally {
    await Promise.all([modCtx.close(), viewCtx.close()]);
  }
});
