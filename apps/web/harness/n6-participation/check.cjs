/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N6 ParticipationStatusCard harness (Chromium emulation; NOT a real iPhone/Safari). ARTIFICIAL data only.
// Usage: start the harness (pnpm --filter @quiz/web exec vite --config harness/n6-participation/vite.config.ts),
// then: node apps/web/harness/n6-participation/check.cjs [outDir]
// Overflow is measured against documentElement.clientWidth/scrollWidth, never window.innerWidth.
// Every expectation below is ASSERTED: any miss is collected in `failures` and the process exits with status 1.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
const URL = process.env.HARNESS_URL || 'http://127.0.0.1:5199/';
const failures = [];
const expect = (cond, message, detail) => { if (!cond) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`); };

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
    await page.waitForSelector('[data-case=active] dl');
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const clipped = [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > root.clientWidth + 0.5).length;
      const cards = [...document.querySelectorAll('[data-case] section')].map(e => Math.round(e.getBoundingClientRect().width));
      return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, clipped, minCard: Math.min(...cards), maxCard: Math.max(...cards) };
    });
    const tag = `${width}/${theme}/${accent}`;
    expect(m.scrollWidth <= m.clientWidth, `${tag}: horizontal overflow`, m);
    expect(m.clipped === 0, `${tag}: clipped elements`, m.clipped);
    expect(m.maxCard <= m.clientWidth, `${tag}: a card is wider than the viewport`, m);
    expect(errors.length === 0, `${tag}: console/page errors`, errors);
    combos++;
    if (outDir && ((accent === 'lila' && theme !== 'light') || (accent === 'orange' && theme === 'light'))) await page.screenshot({ path: `${outDir}/${width}-${theme}-${accent}.png`, fullPage: true });
    await ctx.close();
  }

  // ── Content, no-leak and context-switch contract in Chromium (390 px) ──
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('[data-case=active] dl');
  const text = sel => page.locator(sel).evaluate(e => e.innerText);
  const html = sel => page.locator(sel).evaluate(e => e.innerHTML);
  const card = '[data-case=switch] > section'; // the card itself, without the test controls
  const rows = sel => page.locator(sel).evaluate(e => [...e.querySelectorAll('dl > div')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));

  expect((await rows('[data-case=active]')).join('|') === 'Status Aktiv|Leben 3', 'active: expected "Status Aktiv" and "Leben 3"', await rows('[data-case=active]'));
  expect((await rows('[data-case=zero]')).join('|') === 'Status Aktiv|Leben 0', 'zero: 0 lives must be a real value next to "Aktiv"', await rows('[data-case=zero]'));
  expect((await rows('[data-case=eliminated-lives]')).join('|') === 'Status Ausgeschieden|Leben 3', 'eliminated-lives: status must not be derived from lives', await rows('[data-case=eliminated-lives]'));
  expect((await rows('[data-case=eliminated-zero]')).join('|') === 'Status Ausgeschieden|Leben 0', 'eliminated-zero', await rows('[data-case=eliminated-zero]'));
  expect((await rows('[data-case=nomodel]')).join('|') === 'Status Aktiv', 'nomodel: no lives row, no 0', await rows('[data-case=nomodel]'));
  expect((await rows('[data-case=hidden]')).join('|') === 'Status Ausgeschieden' && !/777/.test(await html('[data-case=hidden]')), 'hidden: p2 shows status only and never the own lives 777 of p1', await html('[data-case=hidden]'));
  expect(/nicht verfügbar/.test(await text('[data-case=unavailable]')) && !/Aktiv|Ausgeschieden|\d/.test(await text('[data-case=unavailable]')), 'unavailable: must be neutral');
  expect(/nicht verfügbar/.test(await text('[data-case=stale]')) && !/Aktiv|3/.test(await text('[data-case=stale]').then(t => t.replace('Veralteter Snapshot', ''))), 'stale: a snapshot older than the expected one must not be shown');
  const all = await page.evaluate(() => document.body.innerText);
  expect(!/Gewonn|Sieger|Gewinner|❤|♥|♡|💔/.test(all), 'no winner wording and no heart symbols anywhere');
  expect(await page.evaluate(() => document.querySelectorAll('meter, progress, [role=progressbar], button[data-case], [data-case] form, [data-case=active] button').length === 0), 'a card must not contain a bar, a form or a button');
  const long = await page.locator('[data-case=long] section').evaluate(e => ({ w: e.getBoundingClientRect().width, sw: e.scrollWidth, cw: e.clientWidth }));
  expect(long.sw <= long.cw + 1, 'long label overflows its card', long);

  // context switching with a late old snapshot, another run / actor, withdrawal, regain, viewer-like projection — recorded at every commit
  const sw = page.locator('[data-case=switch]');
  const act = name => sw.locator(`[data-action=${name}]`).click();
  const logFrom = i => page.evaluate(n => window.__log.slice(n), i);
  const mark = () => page.evaluate(() => window.__log.length);
  const R = () => rows(card), T = () => text(card);
  expect(/Aktiv/.test(await T()) && /2/.test(await T()), 'switch: initial v4 must show Aktiv / 2');
  await act('newer');
  expect((await R()).join('|') === 'Status Ausgeschieden|Leben 0', 'switch: v6 must show Ausgeschieden / 0', await R());
  const afterNewer = await mark();
  await act('late'); // the late OLD snapshot (v4) while the minimum expected stand was not raised: the card keeps the newer view
  expect((await R()).join('|') === 'Status Ausgeschieden|Leben 0', 'switch: a late v4 snapshot must not revive Aktiv / 2', await R());
  const lateLog = await logFrom(afterNewer);
  expect(!lateLog.some(t => /Aktiv/.test(t.replace('Wechselnder Kontext', ''))), 'switch: "Aktiv" was present in at least one commit after the late old snapshot', lateLog.length);
  await act('raise'); // the caller now knows snapshot 6 independently: v4 is stale by the EXPECTED stand, not only by the card's memory
  expect(/nicht verfügbar/.test(await T()) && !/Aktiv|Ausgeschieden|[0-9]/.test((await T()).replace('Wechselnder Kontext', '')), 'switch: v4 below the expected minimum 6 must show nothing', await T());
  await act('newer');
  expect((await R()).join('|') === 'Status Ausgeschieden|Leben 0', 'switch: v6 at the expected minimum is accepted again', await R());
  await act('other-actor');
  expect((await R()).join('|') === 'Status Ausgeschieden', 'switch: p2 must show only its public status, no lives', await R());
  await act('back');
  expect((await R()).join('|') === 'Status Ausgeschieden|Leben 0', 'switch: back to p1 shows the v6 record of p1', await R());
  const beforeRun = await mark();
  await act('new-run'); // another run while the old projection is still in hand
  expect(/nicht verfügbar/.test(await T()) && !/Aktiv|Ausgeschieden/.test((await T()).replace('Wechselnder Kontext', '')), 'switch: another run must show nothing of the old projection', await T());
  const runLog = await logFrom(beforeRun);
  expect(!runLog.some(t => /Ausgeschieden|Aktiv/.test(t.replace('Wechselnder Kontext', ''))), 'switch: old values were present in a commit after the run change', runLog.length);
  await act('back');
  await act('withdraw');
  expect(/nicht verfügbar/.test(await T()) && !/Aktiv|Ausgeschieden|[0-9]/.test((await T()).replace('Wechselnder Kontext', '')), 'switch: a withdrawn projection must show nothing', await T());
  await act('regain'); // v3 is below the raised minimum 6: not accepted
  expect(/nicht verfügbar/.test(await T()), 'switch: a regained projection older than the expected stand must stay rejected', await T());
  await act('viewer'); // v7, viewer-like: released status only
  expect((await R()).join('|') === 'Status Ausgeschieden' && !/Leben/.test(await T()), 'switch: viewer-like projection shows the released status only', await R());
  expect(pageErrors.length === 0, 'page errors during the interaction run', pageErrors);

  await browser.close();
  const summary = { combos, problems: failures.length };
  console.log(JSON.stringify(summary));
  if (failures.length) { console.log('FAILURES:\n' + failures.slice(0, 20).join('\n')); process.exit(1); }
  process.exit(0);
})();
