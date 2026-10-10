import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const images = [
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP8zwAFTAyYLAAdWwEFNX6VDAAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAF0lEQVR4nGNkYPjPwMDAwMDAxAADCBYAG10BBdmz9y8AAAAASUVORK5CYII=',
];

async function join(page: Page, code: string, name: string) {
  await page.goto(`${BASE}/beitreten`);
  await page.getByLabel('Anzeigename').fill(name);
  await page.getByLabel('Raumcode').fill(code);
  await page.getByRole('button', { name: 'Beitreten' }).click();
  await page.waitForURL(new RegExp(`/raum/${code}/lobby$`));
  await page.getByRole('button', { name: /bereit/i }).click();
  await expect(page.getByRole('button', { name: 'Nicht mehr bereit' })).toBeVisible();
}

// Langer E2E-Flow (2 echte Uploads + 2 echte Composites + 4 Browser-Kontexte +
// Buzzer/Hinweis/Reveal/Reload). Die kalte Erstausführung (Vite-Cold-Compile +
// sharp-Nativ-Warmup) braucht deutlich länger als die globale 30 s-Grenze,
// daher ein eigenes, großzügiges Timeout pro Test.
test('W1-W10: setup, image, private solution, buzzer, scores, reconnect, viewer and results', { timeout: 90_000 }, async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const [moderator, alice, bob, viewer] = await Promise.all(contexts.map(context => context.newPage()));
  const secret = 'E2E_PERSON_ONLY_MODERATOR';
  try {
    await moderator.goto(`${BASE}/`);
    const login = await moderator.context().request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } });
    expect(login.status(), await login.text()).toBe(200);
    await moderator.goto(`${BASE}/kategorie/buzzer-reaktion`);
    // Kanonischer Katalog: die Spielkarte verlinkt auf den kanonischen
    // Slug wer-ist-das (Regelwerk §14). Legacy-Links werden separat getestet.
    await moderator.locator('a[href="/spiel/wer-ist-das"]').click();
    await expect(moderator).toHaveURL(`${BASE}/spiel/wer-ist-das`);
    await moderator.getByRole('heading', { name: 'Moderator', exact: true }).click();
    await expect(moderator).toHaveURL(`${BASE}/moderator/vorbereitung/wer-ist-das`);
    await expect(moderator.getByRole('heading', { name: 'Wer ist das? einrichten' })).toBeVisible();
    await moderator.getByRole('button', { name: 'Runde hinzufügen' }).click();
    // v2-Setup: pro Runde zwei Originale (Bild A/B), dann ein fusioniertes Spielbild.
    // Das erste Bild trägt den Solution-Namen als Dateiname → prüft, dass der
    // Filename/OriginalName nie in HTTP-Headern des ausgelieferten Spielbilds steht.
    const imageNames = [`${secret}.png`, 'bild-b0.png', 'bild-a1.png', 'bild-b1.png'];
    for (let index = 0; index < 2; index++) {
      await moderator.locator('input[type="file"]').nth(index * 2).setInputFiles({
        name: imageNames[index * 2], mimeType: 'image/png',
        buffer: Buffer.from(images[index % images.length], 'base64'),
      });
      await moderator.locator('input[type="file"]').nth(index * 2 + 1).setInputFiles({
        name: imageNames[index * 2 + 1], mimeType: 'image/png',
        buffer: Buffer.from(images[(index + 1) % images.length], 'base64'),
      });
      await expect(moderator.getByText(`Bild A: ${imageNames[index * 2]}`)).toBeVisible();
      await expect(moderator.getByText(`Bild B: ${imageNames[index * 2 + 1]}`)).toBeVisible();
    }
    await moderator.getByLabel('Name A').nth(0).fill(secret);
    await moderator.getByLabel('Name B').nth(0).fill('Andere Person');
    await moderator.getByLabel('Name A').nth(1).fill('Dritte Person');
    await moderator.getByLabel('Name B').nth(1).fill('Vierte Person');
    // Spielbild pro Runde erzeugen → je eine Vorschau erscheint.
    for (let index = 0; index < 2; index++) {
      await moderator.getByRole('button', { name: 'Spielbild aus beiden Bildern erzeugen' }).first().click();
      await expect(moderator.getByRole('img', { name: 'Vorschau des Spielbilds' })).toHaveCount(index + 1);
    }
    // Audit 11-05: die Vorschau muss VOR der Raumerstellung ECHT laden
    // (naturalWidth > 0) — das Element allein beweist keinen Bildinhalt.
    for (const image of await moderator.getByRole('img', { name: 'Vorschau des Spielbilds' }).all()) {
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
    }
    // PR11-Nacharbeit A: echter Button „Spielbild neu erzeugen" (idempotente
    // Regeneration mit gleicher roundId): gleiches Asset, keine zweite
    // Vorschau, und das Spielbild lädt später trotzdem.
    await moderator.getByRole('button', { name: 'Spielbild neu erzeugen' }).first().click();
    await expect(moderator.getByRole('img', { name: 'Vorschau des Spielbilds' })).toHaveCount(2);
    // Audit 11-05: auch NACH der Regeneration (frische URL) lädt das Bild.
    for (const image of await moderator.getByRole('img', { name: 'Vorschau des Spielbilds' }).all()) {
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
    }
    await moderator.getByRole('button', { name: 'Raum erstellen' }).click();
    await moderator.waitForURL(/\/moderator\/raum\/\d{3}-\d{3}\/lobby$/);
    const code = moderator.url().match(/(\d{3}-\d{3})\/lobby$/)?.[1];
    expect(code).toBeTruthy();
    await Promise.all([join(alice, code!, 'Alice W'), join(bob, code!, 'Bob W')]);
    await viewer.goto(`${BASE}/zuschauen/${code}/lobby`);
    await expect(viewer.getByText('Verbunden', { exact: true }).first()).toBeVisible();
    await moderator.getByRole('button', { name: 'Spiel starten' }).click();
    await Promise.all([
      moderator.waitForURL(new RegExp(`/moderator/raum/${code}/wer-ist-das$`)),
      alice.waitForURL(new RegExp(`/wer-ist-das/spiel/${code}$`)),
      bob.waitForURL(new RegExp(`/wer-ist-das/spiel/${code}$`)),
      viewer.waitForURL(new RegExp(`/wer-ist-das/zuschauer/${code}$`)),
    ]);
    await expect(moderator.getByText(secret)).toBeVisible();
    for (const page of [alice, bob, viewer]) {
      await expect(page.getByText(secret)).toHaveCount(0);
      await expect(page.getByRole('img', { name: 'Errate die beiden Personen' })).toBeVisible();
      await expect.poll(() => page.getByRole('img', { name: 'Errate die beiden Personen' })
        .evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      const imageUrl = await page.getByRole('img', { name: 'Errate die beiden Personen' }).getAttribute('src');
      const imageResponse = await page.request.get(`${BASE}${imageUrl}`);
      expect(imageResponse.status()).toBe(200);
      expect(JSON.stringify(imageResponse.headers())).not.toContain(secret);
    }
    await alice.reload();
    await expect(alice.getByRole('img', { name: 'Errate die beiden Personen' })).toBeVisible();
    await alice.setViewportSize({ width: 390, height: 844 });
    await expect(viewer.getByRole('button', { name: /buzzern|bewerten|hinweis/i })).toHaveCount(0);
    await moderator.getByRole('button', { name: 'Buzzer öffnen' }).click();
    const buzzerSize = await alice.getByRole('button', { name: 'BUZZERN' }).boundingBox();
    expect(buzzerSize?.width).toBeGreaterThan(250);
    expect(buzzerSize?.height).toBeGreaterThan(100);
    await alice.getByRole('button', { name: 'BUZZERN' }).click();
    await expect(alice.getByText('Du bist dran – antworte mündlich.')).toBeVisible();
    await alice.reload();
    await expect(alice.getByText('Du bist dran – antworte mündlich.')).toBeVisible();
    await moderator.getByRole('button', { name: 'Falsch · −1' }).click();
    await expect(alice.getByText('Du bist für den Rest dieser Runde vom Buzzern ausgeschlossen.')).toBeVisible();
    await alice.reload();
    await expect(alice.getByText('Du bist für den Rest dieser Runde vom Buzzern ausgeschlossen.')).toBeVisible();
    await moderator.getByRole('button', { name: 'Buzzer öffnen' }).click();
    await bob.getByRole('button', { name: 'BUZZERN' }).click();
    await moderator.reload();
    await expect(moderator.getByText(secret)).toBeVisible();
    await moderator.getByRole('button', { name: 'Hinweis aktivieren' }).click();
    await expect(viewer.getByText(/Hinweis aktiv: Eine richtige Person/)).toBeVisible();
    await moderator.getByRole('button', { name: 'Eine richtig · +1' }).click();
    await expect(viewer.getByText(secret)).toBeVisible();
    await expect(alice.getByText('Alice W (Du): -1')).toBeVisible();
    await expect(bob.getByText('Bob W (Du): 1')).toBeVisible();
    await viewer.reload();
    await expect(viewer.getByText(secret)).toBeVisible();
    await moderator.getByRole('button', { name: 'Nächste Runde' }).click();
    await expect(viewer.getByText('Dritte Person')).toHaveCount(0);
    await moderator.getByRole('button', { name: 'Buzzer öffnen' }).click();
    await alice.getByRole('button', { name: 'BUZZERN' }).click();
    await moderator.getByRole('button', { name: 'Beide richtig · +3' }).click();
    await moderator.getByRole('button', { name: 'Ergebnis anzeigen' }).click();
    await expect(viewer.getByText('Spiel beendet · Ergebnis')).toBeVisible();
    await viewer.reload();
    await expect(viewer.getByText('Spiel beendet · Ergebnis')).toBeVisible();
    await expect(viewer.getByText('Alice W: 2')).toBeVisible();
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
