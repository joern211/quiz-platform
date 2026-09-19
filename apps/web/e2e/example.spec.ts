// NOTE: Diese Legacy-Tests prüfen das alte UI-Design (vor Redesign).
// Werden schrittweise durch geo-e2e.spec.ts Gate-Tests ersetzt.
// TODO: Aktualisieren oder löschen nach Abschluss von Gate 5+.
import { test, expect } from '@playwright/test';

// TEST GATE 0: Homepage muss erreichbar sein (via Server-SPA-Routing)
test.describe('Online Quiz Plattform', () => {
  test('sollte Homepage laden', async ({ page }) => {
    await page.goto('http://localhost:3001/');
    await expect(page).toHaveTitle(/Quiz/i);
  });
});

test.describe.skip('Player Flow', () => {
  test('placeholder', async () => {});
});
