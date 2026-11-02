/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N8 TurnStatusCard harness: REAL Chromium, SEVERAL separate browser contexts (one per recipient), the REAL server
// domain (turnSequence.ts) behind a tiny HTTP backend. It is NOT a Safari / iPhone / production-network test, and it is NOT an engine consumer.
// Usage: node apps/web/harness/n8-turn/check.cjs [outDir]       (starts the harness backend and vite itself; HARNESS_EXTERNAL=1 uses running ones)
// Every expectation is ASSERTED: any miss is collected in `failures` and the process exits with status 1.
//
// What is measured (never a label alone): the server's own state (/api/state: turn number, sequence version, holder, inner cursors, the log of
// what the server really applied or refused), what each context actually RECEIVED (window.__harness.received) and what it actually RENDERED.
// A delivery is awaited per recipient with its expected turn and version — a successful send or a visible name somewhere proves nothing.
const { spawn } = require('node:child_process');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:5195';
const failures = [];
const expect = (cond, message, detail) => { if (!cond) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, body) => fetch(`${BASE}${p}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const host = body => api('/api/host', body);
const state = () => api('/api/state');
const projectionOf = recipient => api(`/api/projection?recipient=${recipient}`);

async function waitUntil(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) { failures.push(`timeout: ${label}`); return false; }
    await sleep(60);
  }
}
/** Waits until THIS recipient's page has RECEIVED (and the card has had the chance to render) the expected turn, and the server really is at that turn. */
async function delivered(page, turnNumber, label) {
  await waitUntil(async () => (await state()).turnNumber === turnNumber, 6000, `${label}: server at turn ${turnNumber}`);
  const sv = (await state()).version;
  return waitUntil(() => page.evaluate(([t, v]) => { const r = window.__harness.received; return r && r.turnNumber === t && r.sequenceVersion === v; }, [turnNumber, sv]), 6000, `${label}: page received turn ${turnNumber} / version ${sv}`);
}
const buttonOf = page => page.getByRole('button', { name: 'Zug beenden' });
const statusText = page => page.getByRole('status').innerText();
const calls = page => page.evaluate(() => window.__harness.calls);
async function newPage(browser, query, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 480, height: 800 } });
  if (opts.theme) await ctx.addInitScript(([t, a]) => localStorage.setItem('quiz-appearance', JSON.stringify({ v: 1, theme: t, accent: a })), [opts.theme, opts.accent || 'lila']);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(`${BASE}/?${query}`);
  await page.waitForSelector('section');
  return page;
}

async function startChildren() {
  if (process.env.HARNESS_EXTERNAL === '1') return [];
  const root = path.resolve(__dirname, '../../../..');
  const backend = spawn(process.execPath, ['--import', 'tsx', 'apps/web/harness/n8-turn/server.ts', '5194'], { cwd: root, env: process.env, stdio: 'ignore', detached: true });
  const vite = spawn('pnpm', ['--filter', '@quiz/web', 'exec', 'vite', '--config', 'harness/n8-turn/vite.config.ts'], { cwd: root, env: process.env, stdio: 'ignore', detached: true });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) return [backend, vite]; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('harness did not start');
}

(async () => {
  const children = await startChildren();
  const killChildren = () => { for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } } }; // the whole process group (pnpm starts further processes)
  process.on('exit', killChildren);
  const browser = await chromium.launch();
  const t0 = Date.now();
  const pages = [];
  const track = p => { pages.push(p); return p; };

  // ── S1: four separate contexts, one sequence: each recipient gets ITS projection; a turn change reaches every one of them ─────────────────
  await host({ type: 'reset' });
  const first = await state();
  expect(first.turnNumber === 1 && first.holder === 'T1/A' && first.phase === 'ACTIVE', 'server starts at turn 1 with T1/A', first);
  const pA1 = await projectionOf('A'); // A's own packet of the FIRST turn, kept for the late-delivery story below
  const A = track(await newPage(browser, 'recipient=A'));
  const B = track(await newPage(browser, 'recipient=B'));
  const C = track(await newPage(browser, 'recipient=C'));
  const V = track(await newPage(browser, 'recipient=VIEWER'));
  for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER']]) await delivered(page, 1, `S1 ${name}`);
  await A.getByText('Du bist am Zug.').waitFor({ timeout: 5000 });
  expect(await buttonOf(A).isEnabled(), 'S1: the holder A is offered the action');
  expect((await B.getByText('Dein Team ist am Zug. Du kannst beraten.').count()) === 1 && (await buttonOf(B).count()) === 0, 'S1: teammate B only advises, no action');
  expect((await buttonOf(C).count()) === 0 && (await C.getByText('Rote Rakete').count()) > 0, 'S1: the other team sees the holder team, no action');
  expect((await buttonOf(V).count()) === 0 && (await V.getByRole('listitem').allInnerTexts()).join('|') === 'Rote Rakete (am Zug)|Blaue Bande', 'S1: the viewer sees the released order, no action', await V.getByRole('listitem').allInnerTexts());
  expect(!(await V.locator('body').innerText()).includes('Bo') && !(await V.locator('body').innerText()).includes('Eli'), 'S1: no team member list for the viewer');
  expect(!(await C.locator('body').innerText()).match(/\bBo\b/) && (await C.getByText('Ada', { exact: true }).count()) === 1, 'S1: the other team sees the RELEASED current holder (Ada) but no other member of team 1', (await C.locator('body').innerText()).slice(0, 300));
  expect(!(await C.locator('body').innerText()).match(/\b(Di|Eli)\b/), 'S1: and not even its own team mates (nobody lists members)');

  await buttonOf(A).click();
  await waitUntil(async () => (await state()).turnNumber === 2, 6000, 'S1: server advanced to turn 2');
  const s2 = await state();
  expect(s2.holder === 'T2/C' && s2.cursors.join() === '1,0' && s2.completedTurns === 1 && s2.version === first.version + 1, 'S1: server truth after the first send (holder, cursors, one completion, one version step)', s2);
  for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER']]) await delivered(page, 2, `S1 ${name} (turn 2)`);
  await buttonOf(C).waitFor({ timeout: 5000 });
  expect((await buttonOf(A).count()) === 0 && (await A.getByText('Du bist am Zug.').count()) === 0, 'S1: the former holder lost the action in ITS context');
  expect((await B.getByText('Dein Team ist am Zug. Du kannst beraten.').count()) === 0, 'S1: the former team no longer advises');
  expect((await V.getByRole('listitem').allInnerTexts()).join('|') === 'Rote Rakete|Blaue Bande (am Zug)', 'S1: the viewer\'s order marks the new current team');
  expect(JSON.stringify(await calls(A)) === '[{"turnNumber":1,"sequenceVersion":1}]', 'S1: A\'s callback ran once with the binding of the SHOWN turn', await calls(A));

  // ── S2: duplicate send — one real double click, then the same intent straight at the server ───────────────────────────────────────────
  await buttonOf(C).dblclick();
  await waitUntil(async () => (await state()).turnNumber === 3, 6000, 'S2: server advanced to turn 3');
  await sleep(400); // the guard would show here if a second send had slipped through
  const s3 = await state();
  expect(s3.turnNumber === 3 && s3.holder === 'T1/B' && s3.completedTurns === 2, 'S2: exactly ONE advance for a double click (turn 3, not 4)', s3);
  expect((await calls(C)).length === 1, 'S2: the card called the callback once for the double click', await calls(C));
  expect(s3.log.filter(l => l.kind === 'advance').length === 2 && s3.log.every(l => l.ok), 'S2: the server applied two sends in total (A, C) and refused none', s3.log);
  const replay = await api('/api/advance', { recipient: 'C', turnNumber: 2, sequenceVersion: 2 }); // the SAME intent again (a client that retries after a lost confirmation)
  expect(replay.ok === false && replay.code === 'TURN_SEQ_VERSION_STALE', 'S2: the same intent again is refused by the real domain', replay);
  const afterReplay = await state();
  expect(afterReplay.turnNumber === 3 && afterReplay.version === s3.version && afterReplay.stateVersion === s3.stateVersion, 'S2: a refused repetition changed nothing (turn, version, snapshot version)', afterReplay);
  const foreign = await api('/api/advance', { recipient: 'A', turnNumber: 3, sequenceVersion: afterReplay.version }); // right binding, wrong person
  expect(foreign.ok === false && foreign.code === 'TURN_SEQ_NOT_CURRENT_ACTOR', 'S2: a recipient who does not hold the turn cannot advance it even with the right binding', foreign);
  const viewer = await api('/api/advance', { recipient: 'VIEWER', turnNumber: 3, sequenceVersion: afterReplay.version });
  expect(viewer.ok === false && viewer.code === 'TURN_SEQ_ROLE_NOT_ALLOWED', 'S2: a viewer cannot advance', viewer);

  // ── S3: the SAME player again after a full cycle: A's feedback from turn 1 must not come back as an action in turn 5 ────────────────────
  await host({ type: 'complete' }); await host({ type: 'complete' });
  const s5 = await state();
  expect(s5.turnNumber === 5 && s5.holder === 'T1/A', 'S3: A holds again, in turn 5', s5);
  await delivered(A, 5, 'S3 A');
  await buttonOf(A).waitFor({ timeout: 5000 });
  await A.evaluate(() => window.__harness.freeze(true)); // from here on A receives only what the test delivers
  await A.evaluate(raw => window.__harness.deliver(raw), pA1);
  await sleep(250);
  expect((await buttonOf(A).count()) === 1 && (await buttonOf(A).isEnabled()), 'S3: A\'s old packet of turn 1 changes nothing: the action of turn 5 is still the shown one');
  expect((await A.locator('dt:text-is("Zug") + dd').innerText()) === '5', 'S3: the rendered turn number is still 5', await A.locator('dt:text-is("Zug") + dd').innerText());
  await A.evaluate(() => window.__harness.deliver(null)); // an empty intermediate view
  await sleep(150);
  expect((await buttonOf(A).count()) === 0 && (await A.getByRole('region').innerText()).includes('nicht verfügbar'), 'S3: a withdrawal shows the neutral state');
  await A.evaluate(raw => window.__harness.deliver(raw), pA1);
  await sleep(250);
  expect((await buttonOf(A).count()) === 0 && (await A.getByRole('region').innerText()).includes('nicht verfügbar'), 'S3: after the empty view the old turn-1 packet still restores NO action');
  await A.evaluate(() => window.__harness.freeze(false)); // the real, current packet arrives again
  await delivered(A, 5, 'S3 A (resumed)');
  await buttonOf(A).waitFor({ timeout: 5000 });
  await buttonOf(A).click();
  await waitUntil(async () => (await state()).turnNumber === 6, 6000, 'S3: server advanced to turn 6');
  const aCalls = await calls(A);
  expect(aCalls.length === 2 && aCalls[1].turnNumber === 5 && aCalls[1].sequenceVersion === s5.version, 'S3: the second send carries the binding of turn 5, never that of turn 1', aCalls);
  expect((await state()).holder === 'T2/E', 'S3: server holder after the send', await state());

  // ── S4: an entitlement loss between two actions: block at once, explicit hold, explicit next actor; an old "active" view cannot undo it ──
  const E = track(await newPage(browser, 'recipient=E'));
  await delivered(E, 6, 'S4 E');
  await buttonOf(E).waitFor({ timeout: 5000 });
  const pE6 = await projectionOf('E'); // E's packet while E may still act
  await host({ type: 'eligibility', teams: ['T1', 'T2'], members: ['A', 'B', 'C', 'D'] }); // E is no longer eligible (explicit, e.g. an N6 elimination)
  const blocked = await api('/api/advance', { recipient: 'E', turnNumber: 6, sequenceVersion: (await state()).version });
  expect(blocked.ok === false && blocked.code === 'TURN_SEQ_ACTOR_NOT_ELIGIBLE', 'S4: the server refuses E at once, before anything was stored', blocked);
  expect((await state()).phase === 'ACTIVE', 'S4: nothing was stored by the refusal: still ACTIVE until the host acts explicitly');
  const held = await host({ type: 'withhold' });
  expect(held.ok && held.phase === 'HELD' && held.turnNumber === 6, 'S4: the hold is an explicit server action', held);
  await waitUntil(() => E.evaluate(() => window.__harness.received && window.__harness.received.sequenceVersion >= 0 && document.querySelector('[role=status]') && document.querySelector('[role=status]').textContent.includes('angehalten')), 6000, 'S4: E sees the held turn');
  expect((await buttonOf(E).count()) === 0 && (await E.getByText('Dein Zug ist angehalten.').count()) === 1, 'S4: no action for the held holder, own hint instead');
  await E.evaluate(() => window.__harness.freeze(true));
  await E.evaluate(raw => window.__harness.deliver(raw), pE6); // the OLD "you may act" packet arrives late
  await sleep(250);
  expect((await buttonOf(E).count()) === 0 && (await statusText(E)).includes('angehalten'), 'S4: the older active view neither shows the action nor un-holds the turn');
  await E.evaluate(() => window.__harness.freeze(false));
  const beforeSkip = await state();
  const skipped = await host({ type: 'skip' });
  expect(skipped.ok && skipped.holder === 'T1/B' && skipped.turnNumber === 7 && skipped.completedTurns === beforeSkip.completedTurns && skipped.cursors.join() === beforeSkip.cursors.join(),
    'S4: only the explicit skip chooses the next actor and moves no cursor and no completion', { beforeSkip: [beforeSkip.completedTurns, beforeSkip.cursors], skipped: [skipped.completedTurns, skipped.cursors, skipped.holder] });
  await delivered(B, 7, 'S4 B');
  await buttonOf(B).waitFor({ timeout: 5000 });

  // ── S5: pause blocks the server action; a refused send unlocks the same binding; release withdrawal stays withdrawn ──────────────────────
  await host({ type: 'eligibility', teams: ['T1', 'T2'], members: ['A', 'B', 'C', 'D', 'E'] });
  await host({ type: 'pause', on: true });
  await buttonOf(B).click();
  await waitUntil(async () => (await state()).log.some(l => l.kind === 'advance' && l.code === 'TURN_SEQ_ACTION_BLOCKED'), 6000, 'S5: the server refused the send during the pause');
  expect((await state()).turnNumber === 7, 'S5: the refused send did not move the turn');
  await waitUntil(() => buttonOf(B).isEnabled(), 4000, 'S5: the card unlocked the same binding after the refusal');
  await host({ type: 'pause', on: false });
  await buttonOf(B).click();
  await waitUntil(async () => (await state()).turnNumber === 8, 6000, 'S5: after the pause the send goes through');
  const bCalls = await calls(B);
  expect(bCalls.length === 2 && bCalls[0].turnNumber === 7 && bCalls[1].turnNumber === 7, 'S5: the retry was the SAME binding', bCalls);

  await delivered(C, 8, 'S5 C');
  const pC8 = await projectionOf('C');
  await host({ type: 'release', recipient: 'C', release: 'NONE' });
  await waitUntil(async () => (await C.getByRole('region').innerText()).includes('nicht verfügbar'), 6000, 'S5: C shows the neutral state after the release was withdrawn');
  await C.evaluate(() => window.__harness.freeze(true));
  await C.evaluate(raw => window.__harness.deliver(raw), pC8);
  await sleep(250);
  expect((await C.getByRole('region').innerText()).includes('nicht verfügbar') && (await buttonOf(C).count()) === 0, 'S5: an older packet from before the withdrawal does not bring the view back');
  await C.evaluate(() => window.__harness.freeze(false));
  await host({ type: 'release', recipient: 'C', release: 'CURRENT' });
  await waitUntil(async () => (await buttonOf(C).count()) === 0 && (await C.getByText('Dein Team ist am Zug. Du kannst beraten.').count()) === 1, 6000, 'S5: a NEWER release shows the view again (E of C\'s team holds the turn: C only advises)');
  // the independent minimum comes from the page's own snapshot channel
  await C.evaluate(() => window.__harness.setMin(1_000_000));
  await waitUntil(async () => (await C.getByRole('region').innerText()).includes('nicht verfügbar'), 4000, 'S5: a raised independent minimum hides every packet below it');
  await C.evaluate(() => window.__harness.setMin(1));
  await waitUntil(async () => (await C.getByText('Dein Team ist am Zug. Du kannst beraten.').count()) === 1, 4000, 'S5: lowering it shows the current packet again');

  // ── S6: keyboard: Tab to the action, Enter once; Space on the locked button does nothing more ─────────────────────────────────────────
  const stBefore = await state();
  expect(stBefore.holder === 'T2/E' && stBefore.turnNumber === 8, 'S6: E holds turn 8 (restored eligibility, T2 cursor still on E)', stBefore);
  await delivered(E, stBefore.turnNumber, 'S6 E');
  await buttonOf(E).waitFor({ timeout: 5000 });
  await E.keyboard.press('Tab');
  expect(await E.evaluate(() => document.activeElement && document.activeElement.textContent) === 'Zug beenden', 'S6: Tab reaches the action');
  await E.keyboard.press('Enter'); await E.keyboard.press('Space'); await E.keyboard.press('Enter');
  await waitUntil(async () => (await state()).turnNumber === stBefore.turnNumber + 1, 6000, 'S6: keyboard advance');
  await sleep(300);
  expect((await state()).turnNumber === stBefore.turnNumber + 1, 'S6: exactly one advance from the keyboard', await state());

  // ── S7: close is terminal for every context ───────────────────────────────────────────────────────────────────────────────────────────
  await host({ type: 'close' });
  for (const [page, name] of [[V, 'viewer'], [A, 'A'], [B, 'B'], [C, 'C'], [E, 'E']]) await waitUntil(async () => (await statusText(page)).includes('Beendet'), 6000, `S7: ${name} has RECEIVED and rendered the end`); // per recipient, not only the first
  expect((await buttonOf(A).count()) + (await buttonOf(B).count()) + (await buttonOf(C).count()) + (await buttonOf(E).count()) === 0, 'S7: no action in any context after the close');
  const afterClose = await api('/api/advance', { recipient: 'B', turnNumber: (await state()).turnNumber, sequenceVersion: (await state()).version });
  expect(afterClose.ok === false && afterClose.code === 'TURN_SEQ_CLOSED', 'S7: the server refuses everything after the close', afterClose);

  // ── S8: no errors in any context ─────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER'], [E, 'E']]) {
    const harnessErrors = await page.evaluate(() => window.__harness.errors);
    expect(page.errors.length === 0 && harnessErrors.length === 0, `page ${name}: console/page errors`, [...page.errors, ...harnessErrors]);
  }
  for (const p of pages) await p.context().close();

  // ── S9: layout at 320 px and desktop, light and dark, with very long names ──────────────────────────────────────────────────────────────
  let combos = 0;
  for (const width of [320, 1280]) for (const theme of ['light', 'dark']) {
    await host({ type: 'reset' });
    const La = await newPage(browser, 'recipient=A&long=1', { width, theme, accent: theme === 'dark' ? 'lila' : 'orange' });
    const Lv = await newPage(browser, 'recipient=VIEWER&long=1', { width, theme, accent: theme === 'dark' ? 'lila' : 'orange' });
    await delivered(La, 1, `layout A ${width}/${theme}`); await delivered(Lv, 1, `layout V ${width}/${theme}`);
    await buttonOf(La).waitFor({ timeout: 5000 });
    for (const [page, name] of [[La, 'holder'], [Lv, 'viewer']]) {
      const m = await page.evaluate(() => {
        const root = document.documentElement, sec = document.querySelector('section'), btn = document.querySelector('button');
        const r = btn ? btn.getBoundingClientRect() : null, status = document.querySelector('[role=status]');
        return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, secScroll: sec.scrollWidth, secClient: sec.clientWidth, secRight: sec.getBoundingClientRect().right,
          clipped: [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > root.clientWidth + 0.5).length, theme: root.dataset.theme,
          btn: r && { right: r.right, width: r.width, height: r.height }, statusColor: status && getComputedStyle(status).color, bg: getComputedStyle(document.body).backgroundColor,
          overflowing: [...document.querySelectorAll('main *')].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').length };
      });
      const tag = `${width}/${theme}/${name}`;
      expect(m.theme === theme, `${tag}: theme applied`, m.theme);
      expect(m.scrollWidth <= m.clientWidth, `${tag}: horizontal overflow`, m);
      expect(m.clipped === 0, `${tag}: clipped elements`, m.clipped);
      expect(m.secScroll <= m.secClient + 1 && m.secRight <= m.clientWidth, `${tag}: card content overflows`, m);
      expect(m.overflowing === 0, `${tag}: a long name is hidden by an overflow rule instead of wrapping`, m.overflowing);
      expect(m.statusColor !== m.bg, `${tag}: text and background must differ`, [m.statusColor, m.bg]);
      if (name === 'holder') expect(m.btn !== null && m.btn.right <= m.clientWidth && m.btn.height >= 36 && m.btn.width >= 36, `${tag}: the action must be fully visible and a usable target`, m.btn);
      expect(page.errors.length === 0, `${tag}: page errors`, page.errors);
    }
    const names = await Lv.getByRole('listitem').allInnerTexts();
    expect(names.length === 2 && names[0].includes('Donaudampfschifffahrtsgesellschaftskapitänsmütze'), `${width}/${theme}: the long team name is present in full (wrapped, not cut)`, names.map(n => n.slice(0, 40)));
    if (outDir && ((width === 320 && theme === 'dark') || (width === 1280 && theme === 'light'))) { await La.screenshot({ path: `${outDir}/n8-holder-${width}-${theme}.png`, fullPage: true }); await Lv.screenshot({ path: `${outDir}/n8-viewer-${width}-${theme}.png`, fullPage: true }); }
    combos++;
    await La.context().close(); await Lv.context().close();
  }

  await browser.close();
  killChildren();
  const summary = { seconds: Math.round((Date.now() - t0) / 1000), contexts: 5, layoutCombos: combos, problems: failures.length };
  console.log(JSON.stringify(summary));
  if (failures.length) { console.log('FAILURES:\n' + failures.slice(0, 40).join('\n')); process.exit(1); }
  process.exit(0);
})().catch(error => {
  console.error(error);
  if (failures.length) console.log('FAILURES BEFORE THE ERROR:\n' + failures.slice(0, 40).join('\n'));
  process.exit(2);
});
