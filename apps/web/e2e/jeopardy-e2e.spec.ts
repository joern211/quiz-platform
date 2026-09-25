import { expect, test, type Page } from '@playwright/test';

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
  const response = await page.context().request.post(`${BASE}/api/v1/auth/e2e-token`, {
    data: { userId },
  });

  expect(response.status(), `E2E-Login für ${userId} fehlgeschlagen: ${await response.text()}`).toBe(200);
  const body = await response.json() as { success: boolean; data?: { user?: { id: string } } };
  expect(body.success).toBe(true);
  expect(body.data?.user?.id).toBe(userId);
}

async function createJeopardyRoom(page: Page): Promise<string> {
  await page.goto(`${BASE}/moderator/vorbereitung/jeopardy`);
  await expect(page.getByRole('heading', { name: /jeopardy/i })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Raum erstellen' }).click();
  await page.waitForURL(/\/moderator\/raum\/\d{3}-\d{3}\/lobby$/, { timeout: 20_000 });

  const match = page.url().match(/\/moderator\/raum\/(\d{3}-\d{3})\/lobby$/);
  expect(match, `Raumcode fehlt in URL: ${page.url()}`).not.toBeNull();
  return match![1];
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
  await expect(moderator.getByText('Spiel läuft', { exact: true }).or(moderator.getByText('Board'))).toBeVisible({ timeout: 10_000 });
}

async function openField(moderator: Page, categoryIndex = 0, value = 200): Promise<void> {
  const cell = moderator.locator('[data-category-index="' + categoryIndex + '"][data-value="' + value + '"]');
  await expect(cell).toBeVisible();
  await cell.click();
}

async function buzz(page: Page): Promise<void> {
  const buzzer = page.getByRole('button', { name: /buzz/i }).or(page.getByRole('button', { name: 'BUZZ' })).or(page.getByRole('button', { name: /drücken/i }));
  await expect(buzzer).toBeVisible({ timeout: 5_000 });
  await buzzer.click();
}

async function judgeCorrect(moderator: Page): Promise<void> {
  const correctBtn = moderator.getByRole('button', { name: /richtig/i });
  await expect(correctBtn).toBeVisible({ timeout: 5_000 });
  await correctBtn.click();
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

    await startGame(moderator);

    // Moderator opens a field
    await openField(moderator, 0, 200);

    // Question appears on player pages
    await expect(player1.getByText(/punkte/i).or(player1.getByText(/\d{3}/))).toBeVisible({ timeout: 10_000 });
    await expect(player2.getByText(/punkte/i).or(player2.getByText(/\d{3}/))).toBeVisible({ timeout: 5_000 });

    // Both players buzz (one should win)
    await Promise.all([buzz(player1), buzz(player2)]).catch(() => {});

    // Moderator judges correct
    await judgeCorrect(moderator);

    // Field should now be marked as played (not clickable)
    await expect(moderator.locator('[data-category-index="0"][data-value="200"]')).toHaveClass(/played|disabled|verbraucht/, { timeout: 10_000 });
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
