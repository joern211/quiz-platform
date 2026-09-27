import { test, expect } from '@playwright/test';

// TEST GATE 0: Homepage muss erreichbar sein (via Server-SPA-Routing)
test.describe('Online Quiz Plattform', () => {
  test('sollte Homepage laden', async ({ page }) => {
    await page.goto('http://localhost:3001/');
    await expect(page).toHaveTitle(/Quiz/i);
  });
});
