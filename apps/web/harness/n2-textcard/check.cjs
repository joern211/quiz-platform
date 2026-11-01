/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N2 TextCardForm harness (Chromium emulation; NOT a real iPhone/Safari).
// Usage: start the harness (pnpm --filter @quiz/web exec vite --config harness/n2-textcard/vite.config.ts),
// then: node apps/web/harness/n2-textcard/check.cjs [outDir]
// Overflow is measured against documentElement.clientWidth/scrollWidth, never window.innerWidth.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
const URL = process.env.HARNESS_URL || 'http://127.0.0.1:5199/';
(async () => {
  const browser = await chromium.launch();
  const rows = [];
  for (const width of [320, 390, 430, 1280]) for (const theme of ['dark', 'light']) for (const accent of ['lila', 'blau', 'tuerkis', 'gruen', 'orange', 'rosa']) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(URL);
    await page.evaluate(([t, a]) => { document.documentElement.dataset.theme = t; document.documentElement.dataset.accent = a; }, [theme, accent]);
    await page.waitForSelector('input');
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const controls = [...document.querySelectorAll('input, button[type=submit]')].map(e => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), right: Math.round(r.right) }; });
      const clipped = [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > root.clientWidth + 0.5).length;
      return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, minHeight: Math.min(...controls.map(c => c.h)), clipped, controls: controls.length };
    });
    rows.push({ width, theme, accent, ...m, errors });
    if (outDir && ((accent === 'lila' && theme !== 'light') || (accent === 'orange' && theme === 'light'))) await page.screenshot({ path: `${outDir}/${width}-${theme}-${accent}.png`, fullPage: true });
    await ctx.close();
  }
  // keyboard contract in a real browser: Tab order follows the config order; Enter moves on; focus ring is visible
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL);
  const section = page.locator('[data-case=default]');
  await section.locator('input').first().focus();
  await page.keyboard.type('Köln');
  const ring = await section.locator('input').first().evaluate(e => getComputedStyle(e).outlineStyle + ' ' + getComputedStyle(e).outlineWidth);
  await page.keyboard.press('Enter');
  const afterEnter = await page.evaluate(() => document.activeElement && document.activeElement.id.endsWith('beta'));
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => document.activeElement && document.activeElement.id.endsWith('gamma'));
  const readOnly = await page.locator('[data-case=pending] input').first().getAttribute('readonly');
  await browser.close();
  const bad = rows.filter(r => r.scrollWidth > r.clientWidth || r.clipped || r.errors.length || r.minHeight < 44);
  console.log(JSON.stringify({ combos: rows.length, problems: bad.length, keyboard: { ring, enterMovesToNext: afterEnter, tabReachesNext: afterTab, pendingReadOnly: readOnly !== null } }));
  if (bad.length) console.log(JSON.stringify(bad.slice(0, 3)));
  process.exit(bad.length ? 1 : 0);
})();
