/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N5 SecretInfoCard harness (Chromium emulation; NOT a real iPhone/Safari). ARTIFICIAL data only.
// Usage: start the harness (pnpm --filter @quiz/web exec vite --config harness/n5-secret-info/vite.config.ts),
// then: node apps/web/harness/n5-secret-info/check.cjs [outDir]
// Overflow is measured against documentElement.clientWidth/scrollWidth, never window.innerWidth.
// Every expectation below is ASSERTED: any miss is collected in `failures` and the process exits with status 1.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
const URL = process.env.HARNESS_URL || 'http://127.0.0.1:5199/';
const failures = [];
const expect = (cond, message, detail) => { if (!cond) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`); };
const MARKERS = /DEFAULT_TEXT|DEFAULT_TITLE|ONE_TEXT|ONE_TITLE|MARKUP_TEXT|MARKUP_TITLE|SWITCH_OLD|SWITCH_NEW|Zeile 1:|Donaudampf/;

(async () => {
  const browser = await chromium.launch();
  let combos = 0;
  for (const width of [320, 390, 430, 1280]) for (const theme of ['dark', 'light']) for (const accent of ['lila', 'blau', 'tuerkis', 'gruen', 'orange', 'rosa']) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(URL);
    await page.evaluate(([t, a]) => { document.documentElement.dataset.theme = t; document.documentElement.dataset.accent = a; }, [theme, accent]);
    await page.waitForSelector('[data-case=default] button');
    const measure = () => page.evaluate(() => {
      const root = document.documentElement;
      const rects = els => [...els].map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      const buttons = rects([...document.querySelectorAll('[data-case] section button')]);
      const clipped = [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > root.clientWidth + 0.5 && !e.className.toString().includes('srOnly')).length;
      return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, minBtnW: Math.min(...buttons.map(c => c.w)), minBtnH: Math.min(...buttons.map(c => c.h)), clipped };
    });
    const tag = `${width}/${theme}/${accent}`;
    // closed: no marker text anywhere in the visible text or the markup
    const closedHtml = await page.evaluate(() => document.body.innerHTML + '\n' + document.body.innerText);
    expect(!MARKERS.test(closedHtml), `${tag}: a fragment text is in the DOM / visible text while collapsed`);
    const closed = await measure();
    expect(closed.scrollWidth <= closed.clientWidth && closed.clipped === 0, `${tag}: overflow / clipping while collapsed`, closed);
    expect(closed.minBtnH >= 44 && closed.minBtnW >= 44, `${tag}: toggle smaller than 44 px`, closed);
    // open every card (long, multi-line, markup) and measure again
    const collapsed = page.locator('[data-case] button[aria-expanded=false]');
    for (let guard = 0; guard < 20 && (await collapsed.count()) > 0; guard++) await collapsed.first().click(); // the list shrinks with every click
    const open = await measure();
    expect(open.scrollWidth <= open.clientWidth, `${tag}: horizontal overflow with long content open`, open);
    expect(open.clipped === 0, `${tag}: clipped elements with long content open`, open.clipped);
    expect(open.minBtnH >= 44 && open.minBtnW >= 44, `${tag}: toggle smaller than 44 px (open)`, open);
    expect(errors.length === 0, `${tag}: console/page errors`, errors);
    combos++;
    if (outDir && ((accent === 'lila' && theme !== 'light') || (accent === 'orange' && theme === 'light'))) await page.screenshot({ path: `${outDir}/${width}-${theme}-${accent}.png`, fullPage: true });
    await ctx.close();
  }

  // ── Real keyboard / disclosure / context-switch contract in Chromium (390 px) ──
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('[data-case=default] button');
  const text = sel => page.locator(sel).evaluate(e => e.innerText);
  const html = sel => page.locator(sel).evaluate(e => e.innerHTML);
  const keyboard = {};

  // 1) keyboard: Tab reaches the first toggle, visible focus ring, Enter shows, Space hides, text leaves the DOM
  await page.keyboard.press('Tab');
  keyboard.focus = await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, expanded: e.getAttribute('aria-expanded'), inCase: e.closest('[data-case]')?.getAttribute('data-case'), outline: `${cs.outlineStyle} ${cs.outlineWidth}` }; });
  expect(keyboard.focus.tag === 'BUTTON' && keyboard.focus.inCase === 'default' && keyboard.focus.expanded === 'false', 'default: first Tab should reach the collapsed toggle', keyboard.focus);
  expect(/solid 3px/.test(keyboard.focus.outline), 'default: no visible 3px focus ring on the toggle', keyboard.focus);
  expect(!/DEFAULT_TEXT/.test(await html('[data-case=default]')), 'default: text in the DOM before opening');
  await page.keyboard.press('Enter');
  expect(/DEFAULT_TEXT_A/.test(await text('[data-case=default]')) && /DEFAULT_TEXT_B/.test(await text('[data-case=default]')), 'default: Enter did not show both fragments');
  expect((await page.evaluate(() => document.activeElement.getAttribute('aria-expanded'))) === 'true', 'default: focus left the toggle or aria-expanded not true');
  await page.keyboard.press('Space');
  expect(!/DEFAULT_TEXT|DEFAULT_TITLE/.test(await html('[data-case=default]')), 'default: Space did not remove the text from the DOM');
  expect((await page.evaluate(() => document.activeElement.getAttribute('aria-expanded'))) === 'false', 'default: aria-expanded not false after hiding');

  // 2) zero / one fragments behind the same toggle
  await page.locator('[data-case=zero] button').click();
  expect(/keine Informationen/.test(await text('[data-case=zero]')), 'zero: neutral text missing after opening');
  await page.locator('[data-case=one] button').click();
  expect(/ONE_TEXT/.test(await text('[data-case=one]')) && (await page.locator('[data-case=one] li').count()) === 1, 'one: single fragment missing');

  // 3) markup stays plain text and nothing executes
  await page.locator('[data-case=markup] button').click();
  const markup = await page.locator('[data-case=markup]').evaluate(e => ({ nodes: e.querySelectorAll('img, script, b, a').length, text: e.innerText }));
  expect(markup.nodes === 0 && /<img src=x/.test(markup.text) && /<b>MARKUP_TITLE<\/b>/.test(markup.text), 'markup: tags were interpreted instead of shown as text', markup);
  expect(await page.evaluate(() => window.__xss === undefined), 'markup: injected code ran');
  expect(/MARKUP_TEXT/.test(markup.text) && (await page.locator('[data-case=markup] p').last().evaluate(e => getComputedStyle(e).whiteSpace)) === 'pre-wrap', 'markup: line breaks are not preserved (pre-wrap expected)');

  // 4) viewer-like projection: no card content, no toggle
  expect((await page.locator('[data-case=viewer] button').count()) === 0 && !/PUBLIC_MARK/.test(await html('[data-case=viewer]')), 'viewer: private control or public marker rendered in the card');

  // 5) context switching with a late old payload, withdrawal, regain — recorded at every commit
  const sw = page.locator('[data-case=switch]');
  await sw.locator('button[aria-expanded]').click();
  expect(/SWITCH_OLD_TEXT/.test(await text('[data-case=switch]')), 'switch: old text not shown after opening');
  const mark = () => page.evaluate(() => window.__log.length);
  const afterOpen = await mark();
  await sw.locator('[data-action=late]').click(); // context changed, old payload still in hand
  expect(!/SWITCH_OLD/.test(await html('[data-case=switch]')), 'switch: old payload rendered in the new context');
  await sw.locator('[data-action=fresh]').click();
  const freshState = await sw.locator('button[aria-expanded]').getAttribute('aria-expanded');
  expect(freshState === 'false' && !/SWITCH_/.test(await html('[data-case=switch]')), 'switch: new context did not start hidden', freshState);
  const log1 = await page.evaluate(i => window.__log.slice(i), afterOpen);
  expect(!log1.some(t => /SWITCH_OLD/.test(t)), 'switch: the old text was present in at least one commit after the context change', log1.length);
  await sw.locator('button[aria-expanded]').click();
  expect(/SWITCH_NEW_TEXT/.test(await text('[data-case=switch]')), 'switch: new text not shown after opening');
  await sw.locator('[data-action=back]').click();
  expect(!/SWITCH_NEW/.test(await html('[data-case=switch]')) && (await sw.locator('button[aria-expanded]').getAttribute('aria-expanded')) === 'false', 'switch: going back resurrected an old open state or text');
  await sw.locator('button[aria-expanded]').click();
  await sw.locator('[data-action=withdraw]').click();
  expect(!/SWITCH_/.test(await html('[data-case=switch]')) && (await sw.locator('button[aria-expanded]').count()) === 0, 'switch: withdrawn projection still rendered content or a toggle');
  await sw.locator('[data-action=regain]').click();
  expect((await sw.locator('button[aria-expanded]').getAttribute('aria-expanded')) === 'false' && !/SWITCH_OLD/.test(await html('[data-case=switch]')), 'switch: regained projection did not start hidden');
  await sw.locator('button[aria-expanded]').click();
  await sw.locator('[data-action=viewer]').click();
  expect(!/SWITCH_/.test(await html('[data-case=switch]')) && (await sw.locator('button[aria-expanded]').count()) === 0, 'switch: viewer-like projection kept private content or a toggle');
  expect(pageErrors.length === 0, 'page errors during the interaction run', pageErrors);

  await browser.close();
  const summary = { combos, problems: failures.length, keyboard };
  console.log(JSON.stringify(summary));
  if (failures.length) { console.log('FAILURES:\n' + failures.slice(0, 20).join('\n')); process.exit(1); }
  process.exit(0);
})();
