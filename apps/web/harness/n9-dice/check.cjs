/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N9 DiceTray harness: REAL Chromium, SEVERAL separate browser contexts (one per recipient), the REAL server domain (diceTurn.ts,
// turnSequence.ts) behind a tiny HTTP backend whose authoritative state lives in a REAL SQLite file (real receipts, real CAS, real state events). It is NOT a
// Safari / iPhone / production-network test, and it is NOT an engine consumer.
// Usage: node apps/web/harness/n9-dice/check.cjs [outDir]       (starts the harness backend and vite itself; HARNESS_EXTERNAL=1 uses running ones)
// Every expectation is ASSERTED: any miss is collected in `failures` and the process exits with status 1.
//
// What is measured (never a label alone): the server's own stored state (/api/state READS THE DATABASE: values, hold assignment, roll number, versions, sequence
// version, revision, receipts, events, the log of what the server really applied or refused, the number of random draws), what each context actually RECEIVED
// (window.__harness.received) and what it actually RENDERED. A delivery is awaited per recipient with its expected counters AND a rendered effect — a successful
// send, a sender ACK or a visible name somewhere proves nothing about the other browsers.
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:5197';
const BACKEND = process.env.HARNESS_BACKEND || 'http://127.0.0.1:5196';
const failures = [];
const notes = [];
const expect = (cond, message, detail) => { if (!cond) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, body) => fetch(`${BASE}${p}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const host = body => api('/api/host', body);
const state = () => api('/api/state');
const projectionOf = recipient => api(`/api/projection?recipient=${recipient}`);
const sendIntent = (recipient, kind, commandId, intent) => api('/api/intent', { kind, recipient, commandId, intent });
const FRESH = () => `cmd-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function waitUntil(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) { failures.push(`timeout: ${label}`); return false; }
    await sleep(60);
  }
}
const faces = dice => (dice.values === null ? '' : dice.values.join(', '));
/** The status line the tray must show for a stored process (derived from the DATABASE row, independently of the component). */
const statusFor = dice => {
  if (dice.phase === 'PREPARED') return 'Noch nicht gewürfelt.';
  if (dice.phase === 'IN_PROGRESS') return `Wurf ${dice.rollCount} von ${dice.config.maxRolls}: ${faces(dice)}.`;
  if (dice.phase === 'EXHAUSTED') return `Wurf ${dice.rollCount} von ${dice.config.maxRolls}, kein weiterer Wurf: ${faces(dice)}.`;
  return dice.values === null ? 'Beendet.' : `Beendet. Ergebnis: ${faces(dice)}.`;
};
const statusText = page => page.getByRole('status').innerText();
const rollButton = page => page.getByRole('button', { name: /^(Würfeln|Gesendet)$/ });
const dieButtons = page => page.getByRole('button', { name: /^Würfel \d/ });
const calls = page => page.evaluate(() => window.__harness.calls);
const settled = page => page.evaluate(() => window.__harness.settled);
const received = page => page.evaluate(() => window.__harness.received);
const tumbling = page => page.evaluate(() => [...document.querySelectorAll('ul li')].flatMap((li, i) => (li.querySelector('[data-tumble="true"]') ? [i] : [])));
const bodyText = page => page.locator('body').innerText();

/** Waits until THIS recipient's page has RECEIVED the stored stand (all counters) AND has RENDERED it (status line); `effect` adds a recipient-specific rendered check. */
async function delivered(page, label, effect) {
  const s = await state();
  await waitUntil(() => received(page).then(r => r && r.turnNumber === s.dice.binding.turnNumber && r.sequenceVersion === s.sequenceVersion && r.diceVersion === s.dice.version && r.rollCount === s.dice.rollCount), 8000, `${label}: page received turn ${s.dice.binding.turnNumber} / seq ${s.sequenceVersion} / dice v${s.dice.version} / roll ${s.dice.rollCount}`);
  await waitUntil(async () => (await statusText(page)) === statusFor(s.dice), 8000, `${label}: page rendered "${statusFor(s.dice)}"`);
  if (effect) await waitUntil(async () => effect(page, s), 8000, `${label}: rendered effect`);
  return s;
}
async function newPage(browser, query, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 480, height: opts.height || 900 }, reducedMotion: opts.reducedMotion || 'no-preference' });
  if (opts.theme) await ctx.addInitScript(([t, a]) => localStorage.setItem('quiz-appearance', JSON.stringify({ v: 1, theme: t, accent: a })), [opts.theme, opts.accent || 'lila']);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(`${BASE}/?${query}`);
  await page.waitForSelector('section');
  return page;
}
const shot = async (page, name) => { if (outDir) await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true }); };

let children = [];
let backendChild = null;
let harnessDir;
function startBackend() {
  const root = path.resolve(__dirname, '../../../..');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/web/harness/n9-dice/server.ts', '5196'], { cwd: root, env: { ...process.env, HARNESS_DIR: harnessDir }, stdio: 'ignore', detached: true });
  children.push(child);
  backendChild = child;
  return child;
}
const killBackend = () => { try { process.kill(-backendChild.pid, 'SIGTERM'); } catch { /* already gone */ } };
async function waitBackend() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('harness backend did not start');
}
async function startChildren() {
  if (process.env.HARNESS_EXTERNAL === '1') return;
  const root = path.resolve(__dirname, '../../../..');
  harnessDir = mkdtempSync(path.join(tmpdir(), 'quiz-n9-check-'));
  startBackend();
  const vite = spawn('pnpm', ['--filter', '@quiz/web', 'exec', 'vite', '--config', 'harness/n9-dice/vite.config.ts'], { cwd: root, env: process.env, stdio: 'ignore', detached: true });
  children.push(vite);
  await waitBackend();
}
const killAll = () => { for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } } }; // the whole process group (pnpm starts further processes)

async function scenario(name, fn) {
  const before = failures.length;
  try { await fn(); } catch (error) { failures.push(`${name} threw: ${String(error && error.stack || error).split('\n').slice(0, 4).join(' | ')}`); }
  notes.push(`${failures.length === before ? 'ok  ' : 'FAIL'} ${name}`);
}
const rgb = c => { const m = /rgba?\(([^)]+)\)/.exec(c) || /color\(srgb ([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].replace(/\//g, ' ').split(/[ ,]+/).filter(Boolean).map(Number); return p.slice(0, 3).map(v => (v <= 1 && /srgb/.test(c) ? v * 255 : v)); };
const lum = ([r, g, b]) => { const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

(async () => {
  await startChildren();
  process.on('exit', killAll);
  const browser = await chromium.launch();
  const t0 = Date.now();
  const pages = [];
  const track = p => { pages.push(p); return p; };
  let A, B, C, V;
  let pA0, pA1, pA2, lastRollCommand;

  // ── S1: four separate contexts, one process: each recipient gets ITS projection, built from what the DATABASE holds ───────────────────────────
  await scenario('S1 four contexts, prepared process, no values yet', async () => {
    await host({ type: 'reset' });
    const s0 = await state();
    expect(s0.turnNumber === 1 && s0.holder === 'T1/A' && s0.dice.phase === 'PREPARED' && s0.dice.values === null && s0.dice.rollCount === 0 && s0.revision === 4, 'S1: the database starts with the prepared process of turn 1, no values', s0);
    pA0 = await projectionOf('A'); // A's own packet of the prepared stand, kept for the foreign-recipient story
    A = track(await newPage(browser, 'recipient=A'));
    B = track(await newPage(browser, 'recipient=B'));
    C = track(await newPage(browser, 'recipient=C'));
    V = track(await newPage(browser, 'recipient=VIEWER'));
    for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER']]) await delivered(page, `S1 ${name}`);
    expect((await A.getByRole('list', { name: 'Würfel' }).count()) === 0 && !/\bWürfel \d/.test(await bodyText(A)), 'S1: before the first roll there is no die on screen (no placeholder)');
    expect(await rollButton(A).isEnabled() && (await rollButton(A).innerText()) === 'Würfeln', 'S1: the holder A is offered the roll');
    expect((await B.getByText('Dein Team ist am Zug. Du kannst beraten.').count()) === 1 && (await rollButton(B).count()) === 0, 'S1: teammate B only advises, no roll');
    expect((await rollButton(C).count()) === 0 && (await C.getByText('Rote Rakete').count()) > 0, 'S1: the other team sees the holder team, no roll');
    expect((await rollButton(V).count()) === 0 && (await V.getByText('Rote Rakete').count()) > 0, 'S1: the viewer sees who throws, no roll');
    expect(!/\bBo\b|\bDi\b|\bEli\b/.test(await bodyText(V)), 'S1: no member list for the viewer');
    await shot(A, 's1-A-prepared');
  });

  // ── S1b (N8-01): a packet made for ANOTHER recipient is no packet for this context — delivered for real into separate browser contexts ───────
  await scenario('S1b foreign recipient packets', async () => {
    await B.evaluate(() => window.__harness.freeze(true));
    await B.evaluate(raw => window.__harness.deliver(raw), pA0); // A's packet (you.holdsTurn / canRoll) arrives at teammate B
    await V.evaluate(() => window.__harness.freeze(true));
    await V.evaluate(raw => window.__harness.deliver(raw), pA0); // and at the viewer
    await sleep(250);
    expect((await rollButton(B).count()) === 0 && (await B.getByText('Du bist am Zug.').count()) === 0 && (await B.getByText('Dein Team ist am Zug. Du kannst beraten.').count()) === 0
      && (await B.getByRole('region').innerText()).includes('nicht verfügbar'), 'S1b: B shows neither A\'s "you" nor a control for A\'s packet', (await bodyText(B)).slice(0, 200));
    expect((await rollButton(V).count()) === 0 && (await V.getByRole('region').innerText()).includes('nicht verfügbar'), 'S1b: the viewer shows nothing of A\'s packet');
    await B.evaluate(() => window.__harness.freeze(false)); await V.evaluate(() => window.__harness.freeze(false));
    await B.getByText('Dein Team ist am Zug. Du kannst beraten.').waitFor({ timeout: 5000 }); // B's OWN packet is accepted at once: positive control, no reset needed
    await waitUntil(async () => (await V.getByText('Rote Rakete').count()) > 0, 5000, 'S1b: the viewer\'s own packet is shown again');
    // a NONE packet made for A, carried into B: nothing either (release does not matter, the recipient does)
    await host({ type: 'release', recipient: 'A', release: 'NONE' });
    const noneForA = await projectionOf('A');
    await host({ type: 'release', recipient: 'A', release: 'VALUES' });
    expect(noneForA.release === 'NONE' && noneForA.recipientId === 'A', 'S1b: the server really made a NONE packet for A', noneForA);
    await B.evaluate(() => window.__harness.freeze(true));
    await B.evaluate(raw => window.__harness.deliver(raw), noneForA);
    await sleep(200);
    expect((await B.getByRole('region').innerText()).includes('nicht verfügbar'), 'S1b: a NONE packet of A shows nothing at B');
    await B.evaluate(() => window.__harness.freeze(false));
    await B.getByText('Dein Team ist am Zug. Du kannst beraten.').waitFor({ timeout: 5000 });
  });

  // ── S2: the first roll — values come from the server, are stored, and reach every context ──────────────────────────────────────────────────
  await scenario('S2 first roll is stored and delivered', async () => {
    const s0 = await state();
    await host({ type: 'script', values: [1, 2, 3, 4, 5] });
    await rollButton(A).click();
    await waitUntil(async () => (await state()).dice.rollCount === 1, 8000, 'S2: the server stored roll 1');
    const s1 = await state();
    expect(JSON.stringify(s1.dice.values) === '[1,2,3,4,5]' && s1.dice.version === 1 && s1.dice.phase === 'IN_PROGRESS' && s1.revision === s0.revision + 1 && s1.draws === 5 && s1.receipts === 1 && s1.events === 1,
      'S2: the DATABASE holds roll 1: values, version, ONE revision step, five draws, one receipt, one event', s1);
    pA1 = await projectionOf('A');
    for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER']]) {
      await delivered(page, `S2 ${name}`);
      expect((await statusText(page)) === 'Wurf 1 von 3: 1, 2, 3, 4, 5.', `S2: ${name} shows roll 1`, await statusText(page));
    }
    expect(JSON.stringify(await tumbling(A)) === '[0,1,2,3,4]', 'S2: A saw the five dice of the first roll tumble (decoration for a newly observed roll)', await tumbling(A));
    expect(JSON.stringify(await tumbling(V)) === '[0,1,2,3,4]', 'S2: the viewer too', await tumbling(V));
    const sent = await calls(A);
    expect(sent.length === 1 && sent[0].kind === 'ROLL' && JSON.stringify(sent[0].intent) === '{"turnNumber":1,"sequenceVersion":1,"diceVersion":0,"rollCount":0}', 'S2: A\'s callback ran once with the binding of the SHOWN stand — and carried no value', sent);
    expect((await dieButtons(A).count()) === 5 && (await dieButtons(B).count()) === 0 && (await dieButtons(C).count()) === 0 && (await dieButtons(V).count()) === 0, 'S2: only A can hold dice; B, C and the viewer only see them');
    await shot(A, 's2-A-roll1');
  });

  // ── S3: holding with the mouse: values and rolls untouched, versions step, every context shows the hold ─────────────────────────────────────
  await scenario('S3 holding', async () => {
    const before = await state();
    await dieButtons(A).nth(1).click();
    await waitUntil(async () => (await state()).dice.version === 2, 8000, 'S3: first hold stored');
    await dieButtons(A).nth(3).click();
    await waitUntil(async () => (await state()).dice.version === 3, 8000, 'S3: second hold stored');
    const s = await state();
    expect(JSON.stringify(s.dice.held) === '[false,true,false,true,false]' && JSON.stringify(s.dice.values) === '[1,2,3,4,5]' && s.dice.rollCount === 1 && s.draws === before.draws && s.revision === before.revision + 2,
      'S3: holding changed ONLY the assignment in the database (no value change, no roll, no draw, two revision steps)', s);
    pA2 = await projectionOf('A');
    for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER']]) {
      await delivered(page, `S3 ${name}`);
      const items = await page.getByRole('listitem').allInnerTexts();
      expect(items.map(t => /Gehalten/.test(t)).join() === 'false,true,false,true,false', `S3: ${name} shows exactly dice 2 and 4 as held, in words`, items);
    }
    const pressed = await dieButtons(A).evaluateAll(els => els.map(e => e.getAttribute('aria-pressed')));
    expect(pressed.join() === 'false,true,false,true,false', 'S3: aria-pressed mirrors the stored assignment', pressed);
    const roll1Tumble = await tumbling(A);
    expect(JSON.stringify(roll1Tumble) === '[0,1,2,3,4]', 'S3: a hold did not start a second animation', roll1Tumble);
    await shot(A, 's3-A-held');
  });

  // ── S4: the keyboard alone: focus, Space, Enter, visible focus ring ───────────────────────────────────────────────────────────────────────
  await scenario('S4 keyboard', async () => {
    const third = dieButtons(A).nth(2);
    await third.focus();
    await A.keyboard.press('Space');
    await waitUntil(async () => JSON.stringify((await state()).dice.held) === '[false,true,true,true,false]', 8000, 'S4: Space held die 3 (stored)');
    await delivered(A, 'S4 A after Space'); // the press that follows must meet the tray's NEW binding: wait for the delivery, not just for the server
    const focus = await A.evaluate(() => ({ tag: document.activeElement && document.activeElement.tagName, text: document.activeElement && document.activeElement.textContent.slice(0, 12) }));
    expect(focus.tag === 'BUTTON' && /^Würfel 3/.test(focus.text), 'S4: the die keeps its keyboard focus after its hold was applied (a keyboard user must not have to start over)', focus);
    await A.keyboard.press('Enter');
    await waitUntil(async () => JSON.stringify((await state()).dice.held) === '[false,true,false,true,false]', 8000, 'S4: Enter released die 3 again (stored)');
    await delivered(A, 'S4 A after Enter');
    await A.keyboard.press('Tab');
    expect(await A.evaluate(() => document.activeElement && document.activeElement.textContent.startsWith('Würfel 4')), 'S4: Tab moves to the next die');
    const outline = await A.evaluate(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
    expect(outline.style !== 'none' && outline.width >= 2, 'S4: the focus ring is visible on keyboard focus', outline);
    expect((await state()).dice.rollCount === 1 && (await state()).draws === 5, 'S4: the keyboard never rolled');
  });

  // ── S5: the second roll keeps the held dice exactly and draws only the three free positions ──────────────────────────────────────────────
  await scenario('S5 second roll keeps held dice', async () => {
    const before = await state();
    await host({ type: 'script', values: [6, 6, 6] });
    await rollButton(A).click();
    await waitUntil(async () => (await state()).dice.rollCount === 2, 8000, 'S5: roll 2 stored');
    const s = await state();
    expect(JSON.stringify(s.dice.values) === '[6,2,6,4,6]' && JSON.stringify(s.dice.held) === '[false,true,false,true,false]' && JSON.stringify(s.dice.lastRolled) === '[0,2,4]' && s.draws === before.draws + 3 && s.revision === before.revision + 1,
      'S5: the database holds [6,2,6,4,6]: held dice 2 and 4 kept, exactly THREE draws, one revision step', s);
    for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER']]) {
      await delivered(page, `S5 ${name}`);
      expect((await statusText(page)) === 'Wurf 2 von 3: 6, 2, 6, 4, 6.', `S5: ${name} shows [6,2,6,4,6]`, await statusText(page));
    }
    await waitUntil(async () => JSON.stringify(await tumbling(A)) === '[0,2,4]', 5000, 'S5: only the three re-rolled dice tumble at A');
    const heldTexts = await A.getByRole('listitem').allInnerTexts();
    expect(heldTexts.map(t => /Gehalten/.test(t)).join() === 'false,true,false,true,false', 'S5: the hold assignment survived the roll on screen', heldTexts);
    await shot(A, 's5-A-roll2');
  });

  // ── S6: a REAL double click on the last roll: one callback, one stored roll, then nothing is left to do ───────────────────────────────────
  await scenario('S6 double click and the roll limit', async () => {
    const before = await state();
    const callsBefore = (await calls(A)).length;
    await host({ type: 'script', values: [2, 2, 2] });
    await rollButton(A).dblclick();
    await waitUntil(async () => (await state()).dice.rollCount === 3, 8000, 'S6: roll 3 stored');
    await sleep(500); // a second send that slipped through would show here
    const s = await state();
    expect(s.dice.rollCount === 3 && s.dice.phase === 'EXHAUSTED' && JSON.stringify(s.dice.values) === '[2,2,2,4,2]', 'S6: roll 3 in the database (held dice 2 and 4 kept, positions 1, 3 and 5 drawn)', s.dice);
    expect(s.revision === before.revision + 1 && s.draws === before.draws + 3, 'S6: exactly ONE revision step and three draws for the double click', s);
    expect((await calls(A)).length === callsBefore + 1, 'S6: the tray called the callback once for the double click', (await calls(A)).slice(callsBefore));
    expect(s.log.filter(l => l.kind === 'roll' && l.recipient === 'A' && l.ok).length === 3, 'S6: the server applied three rolls in total and no more', s.log);
    lastRollCommand = (await calls(A)).slice(-1)[0];
    for (const [page, name] of [[A, 'A'], [B, 'B'], [C, 'C'], [V, 'VIEWER']]) {
      await delivered(page, `S6 ${name}`);
      expect((await rollButton(page).count()) === 0 && (await dieButtons(page).count()) === 0, `S6: ${name} is offered nothing any more`);
    }
    expect((await A.getByText('Im Moment ist keine Aktion möglich.').count()) === 1, 'S6: A is told in words that nothing is possible now');
    const stale = await sendIntent('A', 'ROLL', FRESH(), { turnNumber: 1, sequenceVersion: 1, diceVersion: 5, rollCount: 2 }); // the binding of the previous stand, brand-new commandId
    expect(stale.ok === false && stale.code === 'DICE_VERSION_STALE', 'S6: a new commandId with the previous binding is refused by the real domain', stale);
    const fourth = await sendIntent('A', 'ROLL', FRESH(), { turnNumber: 1, sequenceVersion: 1, diceVersion: s.dice.version, rollCount: 3 });
    expect(fourth.ok === false && fourth.code === 'DICE_ROLLS_EXHAUSTED', 'S6: a fourth roll with the CURRENT binding is refused: the limit holds', fourth);
    const after = await state();
    expect(after.revision === s.revision && after.draws === s.draws && JSON.stringify(after.dice) === JSON.stringify(s.dice), 'S6: both refusals changed nothing and drew nothing', after);
  });

  // ── S7: the receipt: the SAME commandId again returns the stored answer; a new id with the old binding gets no second roll ──────────────────
  await scenario('S7 receipt replay', async () => {
    const before = await state();
    const replay = await sendIntent('A', 'ROLL', lastRollCommand.commandId, lastRollCommand.intent);
    expect(replay.ok === true && replay.replayed === true && JSON.stringify(replay.values) === JSON.stringify(before.dice.values) && replay.rollCount === 3, 'S7: the SAME commandId again returns the STORED answer (replayed, same values)', replay);
    const after = await state();
    expect(after.revision === before.revision && after.draws === before.draws && after.receipts === before.receipts && JSON.stringify(after.dice) === JSON.stringify(before.dice), 'S7: the replay changed nothing: no revision step, no draw, no new receipt', after);
  });

  // ── S8: late delivery and withdrawal in the real component ────────────────────────────────────────────────────────────────────────────────
  await scenario('S8 late packets and withdrawal', async () => {
    const s = await state();
    await A.evaluate(() => window.__harness.freeze(true));
    await A.evaluate(raw => window.__harness.deliver(raw), pA1); // A's packet of roll 1 arrives late
    await A.evaluate(raw => window.__harness.deliver(raw), pA2); // and the one after the holds
    await sleep(250);
    expect((await statusText(A)) === statusFor(s.dice) && (await rollButton(A).count()) === 0 && (await dieButtons(A).count()) === 0, 'S8: late packets of roll 1 / the holds do not bring back an older stand or an action', await statusText(A));
    await A.evaluate(() => window.__harness.deliver(null));
    await sleep(150);
    expect((await A.getByRole('region').innerText()).includes('nicht verfügbar'), 'S8: null withdraws everything shown');
    await A.evaluate(raw => window.__harness.deliver(raw), pA1);
    await sleep(250);
    expect((await A.getByRole('region').innerText()).includes('nicht verfügbar') && (await dieButtons(A).count()) === 0 && (await rollButton(A).count()) === 0, 'S8: after the withdrawal the OLDER roll does not come back (new roll → null → older roll)');
    await A.evaluate(() => window.__harness.freeze(false));
    await delivered(A, 'S8 A back');
    expect((await statusText(A)) === statusFor(s.dice), 'S8: A\'s own newer packet is accepted at once again');
  });

  // ── S9: reload after a stored roll: the stored result is shown, nothing is rolled, nothing is sent, no animation ────────────────────────────
  await scenario('S9 reload', async () => {
    const before = await state();
    await A.reload();
    await A.waitForSelector('section');
    await delivered(A, 'S9 A after reload');
    const after = await state();
    expect(after.draws === before.draws && after.revision === before.revision && after.receipts === before.receipts && JSON.stringify(after.dice) === JSON.stringify(before.dice), 'S9: the reload changed nothing at the server', after);
    expect((await calls(A)).length === 0, 'S9: the reloaded page sent nothing by itself', await calls(A));
    expect(JSON.stringify(await tumbling(A)) === '[]', 'S9: the stored roll is shown without a new animation', await tumbling(A));
    expect((await statusText(A)) === statusFor(after.dice), 'S9: the stored result is on screen');
  });

  // ── S10: the SAME player in a LATER turn ──────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S10 later turn of the same player', async () => {
    await host({ type: 'endTurn' }); // turn 2: T2/C
    await host({ type: 'endTurn' }); // turn 3: T1/B (the teammate)
    let s = await state();
    expect(s.turnNumber === 3 && s.holder === 'T1/B' && s.dice.phase === 'PREPARED' && s.dice.rollCount === 0 && s.dice.values === null, 'S10: turn 3 belongs to teammate B with a NEW prepared process', s);
    await delivered(B, 'S10 B turn 3');
    await delivered(A, 'S10 A turn 3');
    expect((await rollButton(B).count()) === 1 && (await rollButton(A).count()) === 0 && (await A.getByText('Dein Team ist am Zug. Du kannst beraten.').count()) === 1, 'S10: B is now offered the roll and A advises');
    await host({ type: 'endTurn' }); // turn 4: T2/D
    await host({ type: 'endTurn' }); // turn 5: T1/A again
    s = await state();
    expect(s.turnNumber === 5 && s.holder === 'T1/A' && s.dice.phase === 'PREPARED' && s.dice.binding.turnNumber === 5 && s.dice.binding.playerId === 'A', 'S10: A holds again — in turn 5, with its own new process', s);
    await delivered(A, 'S10 A turn 5');
    expect((await statusText(A)) === 'Noch nicht gewürfelt.' && (await rollButton(A).isEnabled()), 'S10: A sees a fresh prepared process and is offered the roll');
    // A's packet of turn 1 (roll 1) arrives late: it must not bring back the old dice or the old action
    await A.evaluate(() => window.__harness.freeze(true));
    await A.evaluate(raw => window.__harness.deliver(raw), pA1);
    await sleep(250);
    expect((await statusText(A)) === 'Noch nicht gewürfelt.' && !/1, 2, 3, 4, 5/.test(await bodyText(A)), 'S10: the late packet of A\'s turn 1 does not come back in turn 5');
    const old = await sendIntent('A', 'ROLL', FRESH(), { turnNumber: 1, sequenceVersion: 1, diceVersion: 0, rollCount: 0 });
    expect(old.ok === false && old.code === 'TURN_SEQ_VERSION_STALE', 'S10: the intent bound to A\'s FIRST turn is refused although it names the same player', old);
    const draws = (await state()).draws;
    await A.evaluate(() => window.__harness.freeze(false));
    await delivered(A, 'S10 A unfrozen');
    await host({ type: 'script', values: [6, 5, 4, 3, 2] });
    await rollButton(A).click();
    await waitUntil(async () => (await state()).dice.rollCount === 1, 8000, 'S10: A\'s roll in turn 5 stored');
    const after = await state();
    expect(JSON.stringify(after.dice.values) === '[6,5,4,3,2]' && after.draws === draws + 5 && after.dice.binding.turnNumber === 5, 'S10: the new turn rolls with ITS binding (turn 5), five draws', after);
    const last = (await calls(A)).slice(-1)[0];
    expect(last.intent.turnNumber === 5, 'S10: the callback carried the binding of turn 5', last);
    await delivered(A, 'S10 A roll in turn 5');
    for (const [page, name] of [[B, 'B'], [C, 'C'], [V, 'VIEWER']]) await delivered(page, `S10 ${name}`);
  });

  // ── S11: an N6 basis update in the SAME turn: the dice stay, the old binding is dead, the new one continues, the limit is not reset ─────────
  await scenario('S11 basis update in the same turn', async () => {
    const before = await state();
    await host({ type: 'basis' });
    const s = await state();
    expect(s.turnNumber === before.turnNumber && s.sequenceVersion === before.sequenceVersion + 1 && s.basisVersion === before.basisVersion + 1 && JSON.stringify(s.dice) === JSON.stringify(before.dice),
      'S11: the sequence version rose by one, NO new turn, the stored dice are bit for bit the same (values, held, roll number, version)', s);
    await delivered(A, 'S11 A');
    expect((await statusText(A)) === statusFor(s.dice) && (await rollButton(A).isEnabled()), 'S11: A still shows the same dice and still has the roll');
    const old = await sendIntent('A', 'ROLL', FRESH(), { turnNumber: s.turnNumber, sequenceVersion: before.sequenceVersion, diceVersion: s.dice.version, rollCount: 1 });
    expect(old.ok === false && old.code === 'TURN_SEQ_VERSION_STALE', 'S11: the action binding from BEFORE the update is refused', old);
    const check = await state();
    expect(JSON.stringify(check.dice) === JSON.stringify(s.dice) && check.draws === s.draws && check.revision === s.revision, 'S11: the refusal changed nothing and drew nothing', check);
    await dieButtons(A).nth(0).click(); // the UI carries the NEW sequence version
    await waitUntil(async () => (await state()).dice.version === s.dice.version + 1, 8000, 'S11: A\'s hold with the new binding stored');
    const afterHold = await state();
    expect(JSON.stringify(afterHold.dice.held) === '[true,false,false,false,false]' && afterHold.dice.rollCount === 1, 'S11: the same process continues under the new binding (hold stored, still roll 1)', afterHold.dice);
    await host({ type: 'script', values: [1, 1, 1, 1] });
    await delivered(A, 'S11 A after hold');
    await rollButton(A).click();
    await waitUntil(async () => (await state()).dice.rollCount === 2, 8000, 'S11: roll 2 stored');
    const r2 = await state();
    expect(JSON.stringify(r2.dice.values) === '[6,1,1,1,1]' && r2.dice.rollCount === 2, 'S11: roll 2 continued from roll 1 (the held die kept its 6): the update did not reset the used rolls', r2.dice);
  });

  // ── S16: process restart on the SAME database ─────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S16 restart of the server process', async () => {
    if (process.env.HARNESS_EXTERNAL === '1') { notes.push('skip S16 (external backend)'); return; }
    const before = await state();
    const stored = { revision: before.revision, turn: before.turnNumber, seq: before.sequenceVersion, basis: before.basisVersion, dice: before.dice };
    killBackend(); // ONLY the server process dies (vite stays: the pages keep their module graph and just see failed polls meanwhile)
    await waitUntil(async () => { try { await fetch(`${BACKEND}/api/state`); return false; } catch { return true; } }, 15000, 'S16: the backend is really gone');
    startBackend();
    await waitBackend();
    const after = await state();
    expect(after.revision === stored.revision && after.turnNumber === stored.turn && after.sequenceVersion === stored.seq && after.basisVersion === stored.basis && JSON.stringify(after.dice) === JSON.stringify(stored.dice),
      'S16: after a REAL process restart the database yields the same values, held dice, roll number, versions, revision and basis (nothing re-drawn, nothing invented)', after);
    expect(after.draws === 0, 'S16: the new process has drawn nothing', after.draws);
    await A.reload(); await A.waitForSelector('section');
    await delivered(A, 'S16 A after restart');
    expect((await statusText(A)) === statusFor(stored.dice), 'S16: the reloaded page shows the stored roll 2');
  });

  // ── S12: pause blocks, the refusal unlocks the same binding, the SAME commandId succeeds after the pause ──────────────────────────────────
  await scenario('S12 pause', async () => {
    const before = await state();
    await host({ type: 'pause', on: true });
    const callsBefore = (await calls(A)).length;
    await rollButton(A).click();
    await waitUntil(async () => (await settled(A)).length >= 1, 8000, 'S12: the refused send settled');
    await waitUntil(async () => (await rollButton(A).innerText()) === 'Würfeln' && (await rollButton(A).isEnabled()), 8000, 'S12: the refusal unlocked the SAME binding');
    const s = await state();
    expect(s.log.filter(l => l.code === 'TURN_SEQ_ACTION_BLOCKED').length >= 1 && s.draws === before.draws && JSON.stringify(s.dice) === JSON.stringify(before.dice) && s.revision === before.revision, 'S12: the real check refused during the pause: nothing drawn, nothing changed', s);
    await host({ type: 'pause', on: false });
    await host({ type: 'script', values: [3, 3, 3, 3] });
    await rollButton(A).click(); // the same intent again: the page reuses its commandId, the receipt allows the retry of a command that failed before any mutation
    await waitUntil(async () => (await state()).dice.rollCount === 3, 8000, 'S12: the retry stored roll 3');
    const done = await state();
    expect(JSON.stringify(done.dice.values) === '[6,3,3,3,3]' && done.draws === before.draws + 4, 'S12: the retry rolled ONCE (four free positions, four draws)', done);
    const sent = (await calls(A)).slice(callsBefore);
    expect(sent.length === 2 && sent[0].commandId === sent[1].commandId, 'S12: the page did not swap the commandId for the retry', sent);
  });

  // ── S13: permissions checked directly at the server (the UI offers none of these; the server still decides) ───────────────────────────────
  await scenario('S13 permissions at the server', async () => {
    await host({ type: 'endTurn' }); await host({ type: 'endTurn' }); await host({ type: 'endTurn' }); await host({ type: 'endTurn' }); // turn 9: T1/A again, a fresh process
    const s = await state();
    expect(s.turnNumber === 9 && s.holder === 'T1/A' && s.dice.phase === 'PREPARED', 'S13: turn 9 is A\'s again', s);
    const binding = { turnNumber: 9, sequenceVersion: s.sequenceVersion, diceVersion: 0, rollCount: 0 };
    const expectations = [['B', 'TURN_SEQ_NOT_CURRENT_ACTOR'], ['C', 'TURN_SEQ_NOT_CURRENT_ACTOR'], ['VIEWER', 'TURN_SEQ_ROLE_NOT_ALLOWED'], ['DISPLAY', 'TURN_SEQ_ROLE_NOT_ALLOWED'], ['HOST', 'TURN_SEQ_ROLE_NOT_ALLOWED']];
    for (const [who, code] of expectations) {
      const r = await sendIntent(who, 'ROLL', FRESH(), binding);
      expect(r.ok === false && r.code === code, `S13: ${who} cannot roll A's dice (${code})`, r);
      const h = await sendIntent(who, 'HOLD', FRESH(), { ...binding, held: [0] });
      expect(h.ok === false && h.code === code, `S13: ${who} cannot hold either`, h);
    }
    const hostBody = await sendIntent('A', 'ROLL', FRESH(), { ...binding, values: [6, 6, 6, 6, 6] });
    expect(hostBody.ok === false && hostBody.code === 'DICE_ARGS_INVALID', 'S13: a roll intent that carries VALUES is refused at the boundary — the client has no way to name a result', hostBody);
    const seed = await sendIntent('A', 'ROLL', FRESH(), { ...binding, seed: 'x' });
    expect(seed.ok === false && seed.code === 'DICE_ARGS_INVALID', 'S13: a seed is refused as well', seed);
    const after = await state();
    expect(after.draws === s.draws && after.revision === s.revision && JSON.stringify(after.dice) === JSON.stringify(s.dice), 'S13: none of these drew or changed anything', after);
  });

  // ── S14: a late acknowledgement of an OLD turn must not unlock the pending intent of a LATER turn of the same player ─────────────────────────
  await scenario('S14 late ack of an old turn', async () => {
    // turn 9 is A's; A rolls with an ACK that arrives 2.5 s late and then FAILS (a network error after the server already applied the roll)
    await delivered(A, 'S14 A turn 9');
    await A.evaluate(() => { window.__harness.ackDelayMs = 2500; window.__harness.failNext = 1; });
    const firstCalls = (await calls(A)).length;
    await host({ type: 'script', values: [4, 4, 4, 4, 4] });
    await rollButton(A).click();
    await waitUntil(async () => (await state()).dice.rollCount === 1, 8000, 'S14: the turn-9 roll was applied by the server at once');
    // the turn moves on twice around: A is on turn again (turn 13) while the late failure of the turn-9 callback is still on its way
    for (let i = 0; i < 4; i++) await host({ type: 'endTurn' });
    const s = await state();
    expect(s.turnNumber === 13 && s.holder === 'T1/A' && s.dice.phase === 'PREPARED', 'S14: A holds again in turn 13 with a fresh process', s);
    await delivered(A, 'S14 A turn 13');
    const settledBefore = (await settled(A)).length;
    // A sends in turn 13; the server refuses (pause) but the REFUSAL is delayed by 7 s, so the turn-13 binding stays locked in the tray meanwhile
    await host({ type: 'pause', on: true });
    await A.evaluate(() => { window.__harness.ackDelayMs = 7000; window.__harness.failNext = 0; });
    await rollButton(A).click();
    expect((await calls(A)).length === firstCalls + 2, 'S14: the turn-13 click was sent', (await calls(A)).length);
    await waitUntil(async () => (await rollButton(A).innerText()) === 'Gesendet', 5000, 'S14: the turn-13 binding is locked');
    // the OLD callback (turn 9) now fails late: this happens while the turn-13 lock is pending
    await waitUntil(async () => (await settled(A)).length > settledBefore && (await settled(A)).some(x => x.ok === false), 9000, 'S14: the late failure of the old turn arrived');
    const stillLocked = (await rollButton(A).innerText()) === 'Gesendet' && !(await rollButton(A).isEnabled());
    expect(stillLocked, 'S14: the late failure of the OLD turn did NOT unlock the pending intent of the later turn');
    const stuck = (await calls(A)).length;
    await rollButton(A).click({ force: true, timeout: 1000 }).catch(() => undefined);
    expect((await calls(A)).length === stuck, 'S14: another click while locked sends nothing');
    // the refusal of the turn-13 send itself comes later and then frees exactly that binding
    await waitUntil(async () => (await rollButton(A).innerText()) === 'Würfeln' && (await rollButton(A).isEnabled()), 12000, 'S14: the refusal of the turn-13 send unlocked its own binding');
    await host({ type: 'pause', on: false });
    await A.evaluate(() => { window.__harness.ackDelayMs = 0; });
    const end = await state();
    expect(end.dice.rollCount === 0 && end.dice.binding.turnNumber === 13, 'S14: the refused turn-13 roll left the process untouched', end.dice);
  });

  // ── S10b: a consumer that moves the turn on but forgets the dice: the stored process of the OLD turn is still refused, by the UI and by the server ──
  await scenario('S10b old process after a turn change without dice handling', async () => {
    await host({ type: 'reset' });
    await host({ type: 'script', values: [1, 2, 3, 4, 5] });
    const r = await sendIntent('A', 'ROLL', FRESH(), { turnNumber: 1, sequenceVersion: 1, diceVersion: 0, rollCount: 0 });
    expect(r.ok === true, 'S10b: roll 1 stored in turn 1', r);
    for (let i = 0; i < 4; i++) await host({ type: 'endTurnN8Only' }); // turn 5: A is the holder again, but the stored process still belongs to turn 1
    const s = await state();
    expect(s.turnNumber === 5 && s.holder === 'T1/A' && s.dice.binding.turnNumber === 1 && s.dice.rollCount === 1, 'S10b: the sequence is at turn 5 (A), the stored dice process still belongs to turn 1', { turn: s.turnNumber, holder: s.holder, bound: s.dice.binding.turnNumber });
    await delivered(A, 'S10b A');
    expect((await rollButton(A).count()) === 0 && (await dieButtons(A).count()) === 0 && (await A.getByText('Im Moment ist keine Aktion möglich.').count()) === 1, 'S10b: A is offered NOTHING for the old process although A holds the turn again');
    const draws = s.draws;
    const direct = await sendIntent('A', 'ROLL', FRESH(), { turnNumber: 5, sequenceVersion: s.sequenceVersion, diceVersion: s.dice.version, rollCount: s.dice.rollCount }); // even with the CURRENT numbers of the sequence
    expect(direct.ok === false && direct.code === 'DICE_TURN_STALE', 'S10b: the server refuses a roll on the turn-1 process even with the current sequence numbers', direct);
    const held = await sendIntent('A', 'HOLD', FRESH(), { turnNumber: 5, sequenceVersion: s.sequenceVersion, diceVersion: s.dice.version, rollCount: s.dice.rollCount, held: [0] });
    expect(held.ok === false && held.code === 'DICE_TURN_STALE', 'S10b: and a hold as well', held);
    const after = await state();
    expect(after.draws === draws && after.revision === s.revision && JSON.stringify(after.dice) === JSON.stringify(s.dice), 'S10b: nothing was drawn or changed', after);
  });

  // ── S17: layout, themes, accent, reduced motion, long names, touch targets ───────────────────────────────────────────────────────────────
  await scenario('S17 layout, themes and motion', async () => {
    await host({ type: 'reset' });
    await host({ type: 'script', values: [2, 4, 6, 1, 3] });
    await sendIntent('A', 'ROLL', FRESH(), { turnNumber: 1, sequenceVersion: 1, diceVersion: 0, rollCount: 0 });
    await sendIntent('A', 'HOLD', FRESH(), { turnNumber: 1, sequenceVersion: 1, diceVersion: 1, rollCount: 1, held: [1, 3] });
    const s = await state();
    expect(JSON.stringify(s.dice.values) === '[2,4,6,1,3]' && JSON.stringify(s.dice.held) === '[false,true,false,true,false]' && s.dice.rollCount === 1, 'S17: the stored process behind the layout measurements has values and two held dice', s.dice);
    const variants = [
      ['narrow-dark-long', 'recipient=A&long=1', { width: 320, theme: 'dark', accent: 'lila' }],
      ['narrow-light-long', 'recipient=A&long=1', { width: 320, theme: 'light', accent: 'tuerkis' }],
      ['wide-dark', 'recipient=A', { width: 1100, theme: 'dark', accent: 'blau' }],
      ['wide-light', 'recipient=A', { width: 1100, theme: 'light', accent: 'lila' }],
      ['viewer-narrow', 'recipient=VIEWER&long=1', { width: 320, theme: 'dark', accent: 'lila' }],
    ];
    for (const [name, query, opts] of variants) {
      const page = track(await newPage(browser, query, { ...opts, height: 900 }));
      await delivered(page, `S17 ${name}`);
      const m = await page.evaluate(() => {
        const die = document.querySelector('ul li > *');
        const dieStyle = die ? getComputedStyle(die) : null;
        const boxes = [...document.querySelectorAll('ul li > *')].map(e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; });
        return {
          scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, boxes, text: dieStyle && dieStyle.color, bg: dieStyle && dieStyle.backgroundColor, page: getComputedStyle(document.body).backgroundColor,
          held: [...document.querySelectorAll('ul li > *')].map(e => ({ border: getComputedStyle(e).borderTopWidth, pressed: e.getAttribute('aria-pressed') })),
        };
      });
      expect(m.scrollW <= m.innerW, `S17 ${name}: no horizontal page scroll`, { scrollW: m.scrollW, innerW: m.innerW });
      expect(m.boxes.length === 5 && m.boxes.every(b => b.l >= -0.5 && b.r <= m.innerW + 0.5), `S17 ${name}: every die lies inside the viewport`, m.boxes);
      if (!/VIEWER/.test(query)) expect(m.boxes.every(b => b.w >= 44 && b.h >= 44), `S17 ${name}: every die is at least 44×44 px (touch target)`, m.boxes.map(b => [Math.round(b.w), Math.round(b.h)]));
      const ratio = rgb(m.text) && rgb(m.bg) ? contrast(rgb(m.text), rgb(m.bg)) : 0;
      expect(ratio >= 4.5, `S17 ${name}: text on a die has at least 4.5:1 contrast`, { text: m.text, bg: m.bg, ratio });
      const heldBorders = m.held.filter(h => h.pressed === 'true').map(h => h.border);
      if (!/VIEWER/.test(query)) expect(heldBorders.length === 2 && heldBorders.every(w => parseFloat(w) > 2), `S17 ${name}: held dice carry a heavier frame in addition to the word "Gehalten"`, m.held);
      expect(page.errors.length === 0, `S17 ${name}: no console errors`, page.errors);
      await shot(page, `s17-${name}`);
    }
    // theme really differs (tokens switch): body background of dark vs light
    const dark = track(await newPage(browser, 'recipient=A', { theme: 'dark' })); const light = track(await newPage(browser, 'recipient=A', { theme: 'light' }));
    const bgs = [await dark.evaluate(() => getComputedStyle(document.body).backgroundColor), await light.evaluate(() => getComputedStyle(document.body).backgroundColor)];
    expect(bgs[0] !== bgs[1], 'S17: dark and light really are different themes in this harness', bgs);
    // reduced motion vs normal motion, measured with a frame sampler installed BEFORE the roll
    for (const [name, mode] of [['normal', 'no-preference'], ['reduced', 'reduce']]) {
      const page = track(await newPage(browser, 'recipient=A', { reducedMotion: mode }));
      await delivered(page, `S17 motion ${name}`);
      await page.evaluate(() => { window.__maxAnims = 0; (function loop() { window.__maxAnims = Math.max(window.__maxAnims, document.getAnimations().length); requestAnimationFrame(loop); })(); });
      await host({ type: 'script', values: [5, 5, 5] });
      const cur = await state();
      const r = await sendIntent('A', 'ROLL', FRESH(), { turnNumber: 1, sequenceVersion: cur.sequenceVersion, diceVersion: cur.dice.version, rollCount: cur.dice.rollCount });
      expect(r.ok === true, `S17 motion ${name}: the roll that drives the animation was stored`, r);
      await delivered(page, `S17 motion ${name} after the roll`);
      await sleep(700);
      const seen = await page.evaluate(() => ({ max: window.__maxAnims, ends: window.__harness.animationEnds, marks: document.querySelectorAll('[data-tumble="true"]').length }));
      if (mode === 'reduce') expect(seen.max === 0 && seen.ends === 0, 'S17 motion: under prefers-reduced-motion NO animation runs at all', seen);
      else expect(seen.max > 0 && seen.marks === 3, 'S17 motion: without the preference the three re-rolled dice animate', seen);
      expect((await calls(page)).length === 0 && (await statusText(page)) === statusFor((await state()).dice), `S17 motion ${name}: the animation (or its end) sent nothing and the shown values are the stored ones`);
    }
  });

  // ── S18: no page ever errored ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S18 console', async () => {
    for (const [i, page] of pages.entries()) expect(page.errors.length === 0, `S18: page ${i} had no console / page errors`, page.errors);
  });

  await browser.close();
  killAll();
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(notes.join('\n'));
  if (failures.length) {
    console.log(`\nN9 harness check FAILED (${failures.length} misses, ${seconds}s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`\nN9 harness check passed (${notes.length} scenarios, ${seconds}s).`);
  process.exit(0);
})().catch(error => { console.error(error); killAll(); process.exit(2); });
