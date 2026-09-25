import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

interface PlayerSession {
  participationId: string;
  rejoinToken: string;
  role: string;
}

async function loginAsModerator(page: Page, userId = 'mod-1'): Promise<void> {
  const response = await page.context().request.post(`${BASE}/api/v1/auth/e2e-token`, {
    data: { userId },
  });

  expect(response.status(), `E2E-Login für ${userId} fehlgeschlagen: ${await response.text()}`).toBe(200);
  const body = await response.json() as { success: boolean; data?: { user?: { id: string } } };
  expect(body.success).toBe(true);
  expect(body.data?.user?.id).toBe(userId);
}

async function createGeoRoom(page: Page, questionCount = 1): Promise<string> {
  await page.goto(`${BASE}/moderator/vorbereitung/geo`);
  await expect(page.getByRole('heading', { name: 'Raum vorbereiten' })).toBeVisible();
  await page.getByLabel('Raumname (optional)').fill('E2E Geo Test');
  await page.getByLabel('Anzahl Fragen').fill(String(questionCount));

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

  expect(session.participationId, `${name}: participationId wurde nicht gespeichert`).toBeTruthy();
  expect(session.rejoinToken, `${name}: rejoinToken wurde nicht gespeichert`).toBeTruthy();
  expect(session.role).toBe('PLAYER');

  return session as PlayerSession;
}

async function markReady(page: Page): Promise<void> {
  const readyButton = page.getByRole('button', { name: 'Ich bin bereit!' });
  await expect(readyButton).toBeVisible();
  await readyButton.click();
  await expect(page.getByRole('button', { name: 'Nicht mehr bereit' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
}

test('G4-1: Moderator Login -> Geo-Raum erstellen', async ({ page }) => {
  await loginAsModerator(page);
  const code = await createGeoRoom(page);

  expect(code).toMatch(/^\d{3}-\d{3}$/);
  await expect(page.getByText(code, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Verbunden', { exact: true }).first()).toBeVisible();
});

test('G4-2: Zwei echte Spieler treten bei und erscheinen in der Lobby', async ({ browser }) => {
  const modContext = await browser.newContext();
  const playerAContext = await browser.newContext();
  const playerBContext = await browser.newContext();

  try {
    const moderator = await modContext.newPage();
    const playerA = await playerAContext.newPage();
    const playerB = await playerBContext.newPage();

    await loginAsModerator(moderator);
    const code = await createGeoRoom(moderator);
    const [sessionA, sessionB] = await Promise.all([
      joinAsPlayer(playerA, code, 'Spieler A'),
      joinAsPlayer(playerB, code, 'Spieler B'),
    ]);

    expect(sessionA.participationId).not.toBe(sessionB.participationId);
    await expect(moderator.getByText('Spieler A', { exact: true })).toBeVisible();
    await expect(moderator.getByText('Spieler B', { exact: true })).toBeVisible();
  } finally {
    await Promise.all([modContext.close(), playerAContext.close(), playerBContext.close()]);
  }
});

test('G4-3: Zuschauer kann einer öffentlichen Lobby ohne Login beitreten', async ({ browser }) => {
  const moderatorContext = await browser.newContext();
  const viewerContext = await browser.newContext();

  try {
    const moderator = await moderatorContext.newPage();
    const viewer = await viewerContext.newPage();
    await loginAsModerator(moderator);
    const code = await createGeoRoom(moderator);

    await viewer.goto(`${BASE}/zuschauen/${code}/lobby`);
    await expect(viewer).toHaveURL(new RegExp(`/zuschauen/${code}/lobby$`));
    await expect(viewer.getByText('Verbunden', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await Promise.all([moderatorContext.close(), viewerContext.close()]);
  }
});

test('G4-5: Privater Raum ist nur für den Host abrufbar', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const anonymousContext = await browser.newContext();
  const otherUserContext = await browser.newContext();

  try {
    const host = await hostContext.newPage();
    const anonymous = await anonymousContext.newPage();
    const otherUser = await otherUserContext.newPage();
    await loginAsModerator(host, 'mod-1');
    await loginAsModerator(otherUser, 'admin-1');

    const createResponse = await host.context().request.post(`${BASE}/api/v1/rooms`, {
      data: {
        gameSlug: 'geo',
        roomName: 'E2E Privater Test',
        isPublic: false,
        setupSnapshotJson: { questionCount: 1, timerDuration: 20 },
      },
    });
    expect(createResponse.status(), await createResponse.text()).toBe(201);
    const createBody = await createResponse.json() as { data: { code: string } };
    const privateCode = createBody.data.code;

    const publicResponse = await host.context().request.get(`${BASE}/api/v1/rooms/public`);
    expect(publicResponse.status()).toBe(200);
    const publicBody = await publicResponse.json() as { data: Array<{ code: string }> };
    expect(publicBody.data.map(room => room.code)).not.toContain(privateCode);

    const anonymousResponse = await anonymous.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    expect(anonymousResponse.status()).toBe(404);

    const otherUserResponse = await otherUser.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    expect(otherUserResponse.status()).toBe(404);

    const hostResponse = await host.context().request.get(`${BASE}/api/v1/rooms/${privateCode}`);
    expect(hostResponse.status()).toBe(200);
    const hostBody = await hostResponse.json() as { success: boolean; data: { code: string } };
    expect(hostBody.success).toBe(true);
    expect(hostBody.data.code).toBe(privateCode);
  } finally {
    await Promise.all([hostContext.close(), anonymousContext.close(), otherUserContext.close()]);
  }
});

test('G4-4: Vollständiger Geo-UI-Ablauf mit zwei Spielern', async ({ browser }) => {
  test.setTimeout(90_000);
  const moderatorContext = await browser.newContext();
  const playerAContext = await browser.newContext();
  const playerBContext = await browser.newContext();

  try {
    const moderator = await moderatorContext.newPage();
    const playerA = await playerAContext.newPage();
    const playerB = await playerBContext.newPage();

    await loginAsModerator(moderator);
    const code = await createGeoRoom(moderator, 1);
    await Promise.all([
      joinAsPlayer(playerA, code, 'Quiz Champion'),
      joinAsPlayer(playerB, code, 'Spieler B'),
    ]);
    await Promise.all([markReady(playerA), markReady(playerB)]);

    await expect(moderator.getByText('Quiz Champion', { exact: true })).toBeVisible();
    await expect(moderator.getByText('Spieler B', { exact: true })).toBeVisible();
    const startButton = moderator.getByRole('button', { name: 'Spiel starten' });
    await expect(startButton).toBeEnabled();

    await Promise.all([
      moderator.waitForURL(new RegExp(`/moderator/raum/${code}/spiel$`), { timeout: 20_000 }),
      playerA.waitForURL(new RegExp(`/raum/${code}/spiel$`), { timeout: 20_000 }),
      playerB.waitForURL(new RegExp(`/raum/${code}/spiel$`), { timeout: 20_000 }),
      startButton.click(),
    ]);

    const answerOptions = playerA.locator('button[class*="option"]');
    await expect(answerOptions.first()).toBeVisible({ timeout: 15_000 });
    await expect(playerA.getByRole('heading', { level: 2 })).toBeVisible();
    await answerOptions.first().click();
    await expect(playerA.getByRole('status')).toHaveText('Antwort gespeichert.');

    const revealButton = moderator.getByRole('button', { name: /Auflösen/ });
    await expect(revealButton).toBeVisible();
    await revealButton.click();
    await expect(moderator.getByRole('heading', { name: /Lösung:/ })).toBeVisible();

    const nextButton = moderator.getByRole('button', { name: /Nächste Frage/ });
    await expect(nextButton).toBeVisible();
    await Promise.all([
      moderator.waitForURL(new RegExp(`/moderator/raum/${code}/ergebnis$`), { timeout: 15_000 }),
      playerA.waitForURL(new RegExp(`/raum/${code}/ergebnis$`), { timeout: 15_000 }),
      playerB.waitForURL(new RegExp(`/raum/${code}/ergebnis$`), { timeout: 15_000 }),
      nextButton.click(),
    ]);

    await expect(playerA.getByRole('heading', { name: /gewonnen|Top 3|Spiel beendet/ })).toBeVisible();
    await expect(playerA.getByText('Quiz Champion', { exact: false })).toBeVisible();
    await expect(playerA.getByText(/\d+ pts/).first()).toBeVisible();
    await expect(playerB.getByText(/\d+ pts/).first()).toBeVisible();
    await expect(moderator.getByRole('heading', { name: 'Ergebnis' })).toBeVisible();
  } finally {
    await Promise.all([moderatorContext.close(), playerAContext.close(), playerBContext.close()]);
  }
});
