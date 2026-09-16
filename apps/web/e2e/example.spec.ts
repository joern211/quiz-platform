import { test, expect } from '@playwright/test';

test.describe('Online Quiz Plattform', () => {
  test('should load homepage', async ({ page }) => {
    await page.goto('/');
    
    // Check title
    await expect(page).toHaveTitle(/Online Quiz/);
    
    // Check main heading
    await expect(page.locator('h1')).toContainText('Spiel entdecken');
  });

  test('should navigate to categories', async ({ page }) => {
    await page.goto('/');
    
    // Click on categories link
    await page.click('text=Kategorien');
    
    // Should show categories page
    await expect(page).toHaveURL(/\/kategorien/);
  });

  test('should show game info popup', async ({ page }) => {
    await page.goto('/kategorien');
    
    // Click info button on first game
    const infoButton = page.locator('[aria-label*="Info"]').first();
    await infoButton.click();
    
    // Should show popup with rules
    await expect(page.locator('text=Spielregeln')).toBeVisible();
  });
});

test.describe('Moderator Flow', () => {
  test('should show login page', async ({ page }) => {
    await page.goto('/moderator/anmelden');
    
    await expect(page.locator('h1')).toContainText('Moderator');
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });
});

test.describe('Player Flow', () => {
  test('should show join page', async ({ page }) => {
    await page.goto('/beitreten');
    
    await expect(page.locator('h1')).toContainText('Raum beitreten');
    await expect(page.locator('input[placeholder*="000"]')).toBeVisible();
  });
});
