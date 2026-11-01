/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N3 OrderingForm harness (Chromium emulation; NOT a real iPhone/Safari).
// Usage: start the harness (pnpm --filter @quiz/web exec vite --config harness/n3-ordering/vite.config.ts),
// then: node apps/web/harness/n3-ordering/check.cjs [outDir]
// Overflow is measured against documentElement.clientWidth/scrollWidth, never window.innerWidth.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
const URL = process.env.HARNESS_URL || 'http://127.0.0.1:5198/';
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
    await page.waitForSelector('ol li');
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const controls = [...document.querySelectorAll('button')].map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      const clipped = [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > root.clientWidth + 0.5).length;
      const unreachable = [...document.querySelectorAll('[data-case] form')].filter(f => { const b = f.querySelector('button[type=submit]'); const r = b.getBoundingClientRect(); return r.right > root.clientWidth + 0.5 || r.left < -0.5; }).length;
      return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, minW: Math.min(...controls.map(c => c.w)), minH: Math.min(...controls.map(c => c.h)), clipped, unreachable, controls: controls.length };
    });
    rows.push({ width, theme, accent, ...m, errors });
    if (outDir && ((accent === 'lila' && theme !== 'light') || (accent === 'orange' && theme === 'light'))) await page.screenshot({ path: `${outDir}/${width}-${theme}-${accent}.png`, fullPage: true });
    await ctx.close();
  }
  // Real keyboard contract in Chromium: moves keep the focus on the used button even though the node is re-inserted;
  // Enter/Space on a move button never submits; boundaries do not wrap; the explicit submit sends the visible order once.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL);
  const section = page.locator('[data-case=default]');
  const names = () => section.locator('ol li').evaluateAll(lis => lis.map(li => li.querySelector('span[class*=label]').textContent + '#' + li.dataset.itemId));
  const activeLabel = () => page.evaluate(() => document.activeElement && (document.activeElement.getAttribute('aria-label') || document.activeElement.tagName));
  const keyboard = {};
  await section.getByRole('button', { name: /^Alpha nach unten/ }).focus();
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  keyboard.afterThreeMoves = await names();
  keyboard.focusAfterMoves = await activeLabel();
  await page.keyboard.press('Enter'); // Alpha is last now: no wrap
  keyboard.afterEdge = await names();
  keyboard.focusAtEdge = await activeLabel();
  await page.keyboard.press('Shift+Tab'); // natural order inside the row: from "down" back to "up"
  keyboard.focusAfterShiftTab = await activeLabel();
  keyboard.submitsAfterMoves = await page.evaluate(() => window.__submits.length);
  await section.getByRole('button', { name: 'Abgeben' }).focus();
  await page.keyboard.press('Enter');
  keyboard.submits = await page.evaluate(() => window.__submits);
  keyboard.focusAfterSubmit = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('role'));
  const lockedMoveDisabled = await section.getByRole('button', { name: /nach oben/ }).first().isDisabled();
  keyboard.lockedAfterSubmit = lockedMoveDisabled;
  const readOnlyStates = {};
  for (const state of ['pending', 'confirmed', 'locked']) {
    const sec = page.locator(`[data-case=${state}]`);
    readOnlyStates[state] = { movesDisabled: await sec.locator('ol button').evaluateAll(bs => bs.every(b => b.disabled)), submitDisabled: await sec.locator('button[type=submit]').isDisabled(),
      order: await sec.locator('ol li').evaluateAll(lis => lis.map(li => li.dataset.itemId).join(',')) };
  }
  await browser.close();
  const bad = rows.filter(r => r.scrollWidth > r.clientWidth || r.clipped || r.unreachable || r.errors.length || r.minH < 44 || r.minW < 44);
  const summary = { combos: rows.length, problems: bad.length, keyboard: { ring, ...keyboard }, readOnlyStates };
  console.log(JSON.stringify(summary));
  if (bad.length) console.log(JSON.stringify(bad.slice(0, 3)));
  process.exit(bad.length ? 1 : 0);
})();
