/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N4 VoteForm harness (Chromium emulation; NOT a real iPhone/Safari).
// Usage: start the harness (pnpm --filter @quiz/web exec vite --config harness/n4-voting/vite.config.ts),
// then: node apps/web/harness/n4-voting/check.cjs [outDir]
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
    await page.waitForSelector('fieldset input[type=radio]');
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const rects = els => [...els].map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      const buttons = rects(document.querySelectorAll('button'));
      const rows = rects(document.querySelectorAll('label[data-option-id], label[data-abstain]'));
      const clipped = [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > root.clientWidth + 0.5 && !e.className.toString().includes('srOnly')).length;
      const unreachable = [...document.querySelectorAll('[data-case] form')].filter(f => { const b = f.querySelector('button[type=submit]'); const r = b.getBoundingClientRect(); return r.right > root.clientWidth + 0.5 || r.left < -0.5; }).length;
      return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, minBtnW: Math.min(...buttons.map(c => c.w)), minBtnH: Math.min(...buttons.map(c => c.h)), minRowH: Math.min(...rows.map(c => c.h)), clipped, unreachable };
    });
    const tag = `${width}/${theme}/${accent}`;
    expect(m.scrollWidth <= m.clientWidth, `${tag}: horizontal overflow`, m);
    expect(m.clipped === 0, `${tag}: clipped elements`, m.clipped);
    expect(m.unreachable === 0, `${tag}: submit button not reachable`, m.unreachable);
    expect(m.minBtnH >= 44 && m.minBtnW >= 44, `${tag}: button smaller than 44 px`, m);
    expect(m.minRowH >= 44, `${tag}: option row smaller than 44 px`, m.minRowH);
    expect(errors.length === 0, `${tag}: console/page errors`, errors);
    combos++;
    if (outDir && ((accent === 'lila' && theme !== 'light') || (accent === 'orange' && theme === 'light'))) await page.screenshot({ path: `${outDir}/${width}-${theme}-${accent}.png`, fullPage: true });
    await ctx.close();
  }

  // ── Real keyboard / selection / submit contract in Chromium (390 px) ──
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForSelector('fieldset input[type=radio]');
  const submits = () => page.evaluate(() => window.__submits);
  const checked = sec => sec.locator('input[type=radio]').evaluateAll(rs => rs.filter(r => r.checked).map(r => r.value));
  const active = () => page.evaluate(() => { const e = document.activeElement; return e ? { tag: e.tagName, type: e.type || null, value: e.value ?? null, role: e.getAttribute('role') } : null; });
  const keyboard = {};

  // 1) default: nothing pre-selected, Tab enters the group at the first radio, arrows/Space change selection only, Enter on a radio sends nothing
  const def = page.locator('[data-case=default]');
  expect((await checked(def)).length === 0, 'default: a radio is pre-selected', await checked(def));
  await def.locator('input[type=radio]').first().focus();
  keyboard.ring = await page.evaluate(() => { const r = document.activeElement; const cs = getComputedStyle(r); const row = getComputedStyle(r.closest('label')); return { radio: `${cs.outlineStyle} ${cs.outlineWidth}`, row: `${row.outlineStyle} ${row.outlineWidth}` }; });
  expect(/solid 3px/.test(keyboard.ring.radio) || /solid 3px/.test(keyboard.ring.row), 'default: no visible 3px focus ring on the focused radio/row', keyboard.ring);
  await page.keyboard.press('ArrowDown');
  keyboard.afterArrowDown = await checked(def);
  expect(keyboard.afterArrowDown.join() === 'bb', 'default: ArrowDown did not select bb', keyboard.afterArrowDown);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  keyboard.afterThree = await checked(def);
  expect(keyboard.afterThree.join() === 'dd', 'default: three ArrowDown should select dd', keyboard.afterThree);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  keyboard.afterUpSpace = await checked(def);
  expect(keyboard.afterUpSpace.join() === 'cc', 'default: ArrowUp+Space should leave cc selected', keyboard.afterUpSpace);
  await page.keyboard.press('Enter');
  expect((await submits()).length === 0, 'default: arrows, Space or Enter on a radio sent a vote', await submits());
  await page.keyboard.press('Tab');
  keyboard.tabFromGroup = await active();
  expect(keyboard.tabFromGroup && keyboard.tabFromGroup.type === 'submit', 'default: Tab from the group should reach the submit button', keyboard.tabFromGroup);

  // 2) empty submit: error, focus on the first CHOOSABLE radio, nothing sent
  const restricted = page.locator('[data-case=restricted]');
  await restricted.locator('button[type=submit]').click();
  expect((await restricted.locator('[role=alert]').count()) === 1, 'restricted: no error for an empty selection');
  keyboard.focusAfterEmpty = await active();
  expect(keyboard.focusAfterEmpty && keyboard.focusAfterEmpty.value === 'aa', 'restricted: focus should be on the first choosable radio', keyboard.focusAfterEmpty);
  expect((await submits()).length === 0, 'restricted: an empty submit sent something', await submits());
  const disabledIds = await restricted.locator('input[type=radio]').evaluateAll(rs => rs.filter(r => r.disabled).map(r => r.value));
  expect(disabledIds.join() === 'bb,dd', 'restricted: only the voter\'s own options may be enabled', disabledIds);

  // 3) a vote: keyboard selection, ONE explicit send with Enter on the button; afterwards locked and focus on the status line
  await page.keyboard.press('ArrowDown'); // aa -> cc (bb is disabled and skipped by the browser)
  keyboard.restrictedChoice = await checked(restricted);
  expect(keyboard.restrictedChoice.join() === 'cc', 'restricted: ArrowDown should skip the disabled option and select cc', keyboard.restrictedChoice);
  await restricted.locator('button[type=submit]').focus();
  await page.keyboard.press('Enter');
  const sent = await submits();
  keyboard.submits = sent;
  expect(sent.length === 1 && sent[0].case === 'restricted' && JSON.stringify(sent[0].ballot) === JSON.stringify({ schemaVersion: 1, kind: 'OPTION', optionId: 'cc' }), 'restricted: exactly one complete OPTION ballot expected', sent);
  keyboard.focusAfterSubmit = await active();
  expect(keyboard.focusAfterSubmit && keyboard.focusAfterSubmit.role === 'status', 'restricted: focus should move to the status line after sending', keyboard.focusAfterSubmit);
  expect(await restricted.locator('input[type=radio]').evaluateAll(rs => rs.every(r => r.disabled)), 'restricted: radios should be locked after sending');
  expect(await restricted.locator('button[type=submit]').isDisabled(), 'restricted: submit should be locked after sending');
  await page.keyboard.press('Enter');
  expect((await submits()).length === 1, 'restricted: a second send happened');

  // 4) explicit abstention is its own, deliberate choice and sends the ABSTAIN ballot
  const abstain = page.locator('[data-case=abstain]');
  expect((await checked(abstain)).length === 0, 'abstain: nothing should be pre-selected', await checked(abstain));
  await abstain.locator('button[type=submit]').click();
  expect((await submits()).length === 1, 'abstain: an empty submit became an abstention/vote', await submits());
  await abstain.locator('input[value=""]').check();
  await abstain.locator('button[type=submit]').click();
  const afterAbstain = await submits();
  expect(afterAbstain.length === 2 && afterAbstain[1].case === 'abstain' && JSON.stringify(afterAbstain[1].ballot) === JSON.stringify({ schemaVersion: 1, kind: 'ABSTAIN' }), 'abstain: expected one ABSTAIN ballot', afterAbstain);

  // 5) read-only and confirmed states
  const states = {};
  for (const state of ['pending', 'confirmed', 'confirmed-abstain', 'locked', 'locked-unconfirmed', 'fatal']) {
    const sec = page.locator(`[data-case=${state}]`);
    states[state] = { allDisabled: await sec.locator('input[type=radio]').evaluateAll(rs => rs.every(r => r.disabled)), submitDisabled: await sec.locator('button[type=submit]').isDisabled(),
      checked: await checked(sec), status: (await sec.locator('[role=status]').allTextContents()).join('|') };
    expect(states[state].allDisabled && states[state].submitDisabled, `${state}: radios and submit must be disabled`, states[state]);
  }
  expect(states.confirmed.checked.join() === 'cc' && /Stimme abgegeben/.test(states.confirmed.status), 'confirmed: the confirmed option cc must be shown', states.confirmed);
  expect(states['confirmed-abstain'].checked.join() === '' && /Enthaltung abgegeben/.test(states['confirmed-abstain'].status), 'confirmed-abstain: the abstention radio must be the checked one', states['confirmed-abstain']);
  expect(states.locked.checked.join() === 'cc' && /geschlossen/.test(states.locked.status), 'locked: the confirmed ballot must stay visible', states.locked);
  expect(states['locked-unconfirmed'].checked.length === 0 && /nicht als abgegebene Stimme bestätigt/.test(states['locked-unconfirmed'].status), 'locked-unconfirmed: must not claim a cast vote', states['locked-unconfirmed']);
  const abstainChecked = await page.locator('[data-case=confirmed-abstain] input[value=""]').isChecked();
  expect(abstainChecked, 'confirmed-abstain: the abstention radio is not checked');
  const errorSec = page.locator('[data-case=error]');
  expect(await errorSec.locator('button[type=submit]').isEnabled() && /Erneut senden/.test(await errorSec.locator('button[type=submit]').innerText()), 'error: a retryable error should offer a retry button');

  await browser.close();
  const summary = { combos, problems: failures.length, keyboard, states };
  console.log(JSON.stringify(summary));
  if (failures.length) { console.log('FAILURES:\n' + failures.slice(0, 20).join('\n')); process.exit(1); }
  process.exit(0);
})();
