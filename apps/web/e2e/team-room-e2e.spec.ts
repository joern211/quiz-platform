import { expect, test, type Page } from '@playwright/test';

test.use({ actionTimeout: 15000 });

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
async function join(page: Page, code: string, name: string) {
  await page.goto(`${BASE}/beitreten?code=${code}`);
  await page.getByLabel('Anzeigename').fill(name);
  await page.getByRole('button', { name: 'Beitreten', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/raum/${code}/lobby$`));
}
test('T1: approval, self-select teams, preflight, play, pause, reconnect, rematch and final close', async ({ browser }) => {
  test.setTimeout(90000);
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const [host, alice, bob, viewer] = await Promise.all(contexts.map(c => c.newPage()));
  try {
    await host.goto(BASE);
    expect((await host.context().request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } })).status()).toBe(200);
    const created = await host.context().request.post(`${BASE}/api/v1/rooms`, { data: {
      gameSlug: 'jeopardy', roomName: 'Team-Room Browserabnahme', idempotencyKey: crypto.randomUUID(), viewerRequiresPin: false,
      setupSnapshotJson: { board1: { categories: [{ name: 'Kategorie 1', clues: [{ value: 100, question: 'Öffentliche Frage', answer: 'TEAM_ROOM_SECRET' }] }] }, board2: { categories: [{ name: 'Kategorie 2', clues: [{ value: 200, question: 'Zweite Frage', answer: 'TEAM_ROOM_SECRET' }] }] } },
    } });
    expect(created.status(), await created.text()).toBe(201);
    const code = (await created.json()).data.code as string;
    await host.goto(`${BASE}/moderator/raum/${code}/lobby`);
    const hostPanel = host.getByRole('region', { name: 'Raum und Teams' });
    await expect(hostPanel.getByText('Raumeinstellungen')).toBeVisible();
    await hostPanel.getByText('Raumeinstellungen').click();
    await hostPanel.getByLabel('Spielerzugang').selectOption('APPROVAL_REQUIRED');
    await hostPanel.getByLabel('Teamzuweisung').selectOption('SELF_SELECT');
    await hostPanel.getByLabel('Wertung', { exact: true }).selectOption('TEAM_SCORE');
    await hostPanel.getByRole('button', { name: 'Einstellungen speichern' }).click();
    await expect(hostPanel.getByRole('heading', { name: /Team 1/ })).toBeVisible();
    await Promise.all([join(alice, code, 'Alice Team'), join(bob, code, 'Bob Team')]);
    for (const page of [alice, bob]) await expect(page.getByText('Du wartest auf die Freigabe durch den Host.')).toBeVisible();
    await expect(hostPanel.getByRole('button', { name: 'Zulassen', exact: true })).toHaveCount(2);
    await hostPanel.getByRole('button', { name: 'Zulassen', exact: true }).first().click();
    await expect(hostPanel.getByRole('button', { name: 'Zulassen', exact: true })).toHaveCount(1);
    await hostPanel.getByRole('button', { name: 'Zulassen', exact: true }).click();
    await expect(hostPanel.getByRole('button', { name: 'Zulassen', exact: true })).toHaveCount(0);
    await alice.getByRole('button', { name: 'Team wählen' }).nth(0).click();
    await bob.getByRole('button', { name: 'Team wählen' }).nth(1).click();
    for (const page of [alice, bob]) await page.getByRole('button', { name: 'Ich bin bereit!' }).click();
    await viewer.goto(`${BASE}/zuschauen/${code}/lobby`);
    await expect(viewer.getByText('Verbunden', { exact: true }).first()).toBeVisible();
    await expect(host.getByRole('button', { name: 'Spiel starten', exact: true })).toBeEnabled();
    await host.getByRole('button', { name: 'Spiel starten', exact: true }).click();
    await expect(host).toHaveURL(new RegExp(`/moderator/raum/${code}/jeopardy$`));
    await expect(alice).toHaveURL(new RegExp(`/jeopardy/spiel/${code}$`));
    await expect(bob).toHaveURL(new RegExp(`/jeopardy/spiel/${code}$`));
    await expect(viewer.getByText('TEAM_ROOM_SECRET')).toHaveCount(0);
    await host.getByRole('button', { name: 'Spiel pausieren', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Spiel fortsetzen', exact: true })).toBeVisible();
    await alice.reload();
    await expect(alice.getByRole('region', { name: 'Raum und Teams' }).getByRole('heading', { name: /Team 1/ })).toBeVisible();
    await host.getByRole('button', { name: 'Spiel fortsetzen', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Spiel pausieren', exact: true })).toBeVisible();
    host.once('dialog', dialog => dialog.accept());
    await host.getByRole('button', { name: 'Spiel abbrechen', exact: true }).click();
    await host.getByRole('button', { name: 'Zum Ergebnis', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Ergebnisprüfung beginnen' })).toBeVisible();
    await host.getByRole('button', { name: 'Ergebnisprüfung beginnen' }).click();
    await expect(host.getByText('In Ergebnisprüfung', { exact: true })).toBeVisible();
    await host.getByLabel('Teilnehmer', { exact: true }).selectOption({ label: 'Alice Team' });
    await host.getByLabel('Punkteänderung', { exact: true }).fill('5');
    await host.getByLabel('Grund', { exact: true }).fill('Browserabnahme der Punkteprüfung');
    await host.getByRole('button', { name: 'Korrektur speichern', exact: true }).click();
    await expect(host.getByText('Alice Team: 5 Punkte', { exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Ergebnis verbindlich bestätigen' }).click();
    await expect(host.getByText('Verbindlich bestätigt', { exact: true })).toBeVisible();
    await host.reload();
    await expect(host.getByText('Verbindlich bestätigt', { exact: true })).toBeVisible();
    await host.getByLabel('Teilnehmer', { exact: true }).selectOption({ label: 'Alice Team' });
    await host.getByLabel('Punkteänderung', { exact: true }).fill('2');
    await host.getByLabel('Grund', { exact: true }).fill('Nachträgliche Korrektur mit Historie');
    await host.getByRole('button', { name: 'Korrektur speichern', exact: true }).click();
    await expect(host.getByText('Alice Team: 7 Punkte', { exact: true })).toBeVisible();
    await host.getByLabel('Ergebnisversion', { exact: true }).selectOption('1');
    await expect(host.getByText('Alice Team: 0 Punkte', { exact: true })).toBeVisible();
    await expect(host.getByRole('button', { name: 'Korrektur speichern' })).toHaveCount(0);
    await host.getByLabel('Ergebnisversion', { exact: true }).selectOption('');
    await expect(host.getByRole('button', { name: 'Revanche vorbereiten' })).toBeVisible();
    await host.getByRole('button', { name: 'Revanche vorbereiten' }).click();
    await expect(host).toHaveURL(new RegExp(`/moderator/raum/${code}/lobby$`));
    await expect(alice).toHaveURL(new RegExp(`/raum/${code}/lobby$`));
    await expect(host.getByText('Lobby geöffnet · Spiel 2')).toBeVisible();
    host.once('dialog', dialog => dialog.accept());
    await host.getByRole('button', { name: 'Raum endgültig schließen', exact: true }).click();
    await expect(host).toHaveURL(`${BASE}/kategorien`);
    await expect(alice).toHaveURL(`${BASE}/kategorien`);
  } finally { await Promise.allSettled(contexts.map(c => c.close())); }
});
