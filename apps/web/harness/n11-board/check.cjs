/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N11 BoardView harness: REAL Chromium, SEVERAL separate browser contexts (one per recipient), the REAL server domain (boardState.ts,
// diceTurn.ts, turnSequence.ts) behind a tiny HTTP backend whose authoritative state lives in a REAL SQLite file (real receipts, real CAS, real state events). It is NOT a
// Safari / iPhone / production-network test, and it is NOT an engine consumer. The geometry is an EXPLICIT TEST GEOMETRY.
// Usage: node apps/web/harness/n11-board/check.cjs [outDir]       (starts the harness backend and vite itself; HARNESS_EXTERNAL=1 uses running ones)
// Every expectation is ASSERTED: any miss is collected in `failures` and the process exits with status 1.
//
// What is measured (never a label alone): the server's own stored state (/api/state READS THE DATABASE: positions, board version, spent roll, sequence version, revision,
// receipts, events, the log of what the server really applied or refused), what each context actually RECEIVED (window.__harness.received) and what it actually RENDERED.
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:5217';
const failures = [];
const notes = [];
const expect = (cond, message, detail) => { if (!cond) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, body) => fetch(`${BASE}${p}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const host = body => api('/api/host', body);
const state = () => api('/api/state');
const projectionOf = recipient => api(`/api/projection?recipient=${recipient}`);
/** The ORIGIN of an intent as a client that looked at the CURRENT stored state would build it; `over` replaces single parts. */
const origin = (s, over = {}) => ({ scope: s.scope, boardId: s.board.boardId, turnNumber: s.turnNumber, sequenceVersion: s.sequenceVersion, boardVersion: s.board.version, diceId: s.dice.diceId, diceVersion: s.dice.version, rollCount: s.dice.rollCount, ...over });
const sendIntent = (recipient, commandId, intent) => api('/api/intent', { recipient, commandId, intent });
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
const sameTarget = (a, b) => a && b && a.runIndex === b.runIndex && a.sequenceId === b.sequenceId && a.rosterRevision === b.rosterRevision && a.unit === b.unit;
const stepsOf = dice => (dice.values === null ? 0 : dice.values.reduce((a, b) => a + b, 0));
const spentOf = s => s.board.lastMove !== null && s.board.lastMove.diceId === s.dice.diceId && s.board.lastMove.rollCount === s.dice.rollCount;
/** The status line the view must show for a stored stand (derived from the DATABASE row, independently of the component). */
const statusFor = s => {
  const live = s.dice.phase !== 'CLOSED' && s.dice.rollCount >= 1 && s.dice.binding.turnNumber === s.turnNumber;
  if (!live) return 'Im Moment gibt es keinen Wurf für einen Zug.';
  const n = stepsOf(s.dice);
  return spentOf(s) ? `Der Wurf (${n} Schritte) ist verbraucht.` : `Wurf: ${n} ${n === 1 ? 'Schritt' : 'Schritte'}.`;
};
const statusText = page => page.getByRole('status').first().innerText();
const bodyText = page => page.locator('body').innerText();
const calls = page => page.evaluate(() => window.__harness.calls);
const settled = page => page.evaluate(() => window.__harness.settled);
const figureBtn = (page, id) => page.getByRole('button', { name: new RegExp(`^Figur ${id}\\b`) });
const targetBtn = (page, to) => page.getByRole('button', { name: new RegExp(`^Nach Feld ${to}\\b`) });
/** Positions as RENDERED: field -> figures listed under it. */
const rendered = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('ul[aria-label="Felder"] > li')].flatMap(li => {
  const field = (li.querySelector('span')?.textContent || '').replace(/^Feld /, '');
  return [...li.querySelectorAll('ul li')].map(f => [/^Figur (\w+)/.exec(f.textContent)[1], field]);
})));
const positionsOf = s => s.positions;

/** Waits until THIS page has RECEIVED the stored stand (all counters) AND has RENDERED it (status line and figure positions). */
async function delivered(page, label) {
  const s = await state();
  await waitUntil(() => page.evaluate(() => ({ r: window.__harness.received, c: window.__harness.context })).then(({ r, c }) => r && c && sameTarget(c, s.scope) && c.boardId === s.board.boardId && sameTarget(r.scope, s.scope) && r.boardId === s.board.boardId
    && r.turnNumber === s.turnNumber && r.sequenceVersion === s.sequenceVersion && r.boardVersion === s.board.version && r.stateVersion === s.revision), 8000, `${label}: page received turn ${s.turnNumber} / seq ${s.sequenceVersion} / board v${s.board.version} / rev ${s.revision}`);
  await waitUntil(async () => (await statusText(page)) === statusFor(s), 8000, `${label}: page rendered "${statusFor(s)}"`);
  await waitUntil(async () => JSON.stringify(Object.entries(await rendered(page)).sort()) === JSON.stringify(Object.entries(positionsOf(s)).sort()), 8000, `${label}: page rendered the stored positions`);
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
const pick = async (page, figure, to) => { await figureBtn(page, figure).click(); await targetBtn(page, to).click(); };

let children = [];
let backendChild = null;
let harnessDir;
const root = path.resolve(__dirname, '../../../..');
function startBackend() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/web/harness/n11-board/server.ts', '5216'], { cwd: root, env: { ...process.env, HARNESS_DIR: harnessDir }, stdio: 'ignore', detached: true });
  children.push(child);
  backendChild = child;
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
  harnessDir = mkdtempSync(path.join(tmpdir(), 'quiz-n11-check-'));
  startBackend();
  const vite = spawn('pnpm', ['--filter', '@quiz/web', 'exec', 'vite', '--config', 'harness/n11-board/vite.config.ts'], { cwd: root, env: process.env, stdio: 'ignore', detached: true });
  children.push(vite);
  await waitBackend();
}
const killAll = () => { for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } } };

const allPages = [];
/** Every scenario starts with clean page-side measurement state (a leftover hold / freeze / call list of the previous scenario would be a measurement error). */
async function cleanPages() {
  for (const page of allPages) {
    try { await page.evaluate(() => { window.__harness.holdSends = false; window.__harness.releaseSends(); window.__harness.freeze(false); window.__harness.failNext = 0; window.__harness.ackDelayMs = 0; window.__harness.calls.length = 0; window.__harness.settled.length = 0; }); } catch { /* page gone */ }
  }
}
async function scenario(name, fn) {
  await host({ type: 'pause', on: false }).catch(() => undefined);
  await cleanPages();
  const before = failures.length;
  try { await fn(); } catch (error) { failures.push(`${name} threw: ${String(error && error.stack || error).split('\n').slice(0, 4).join(' | ')}`); }
  notes.push(`${failures.length === before ? 'ok  ' : 'FAIL'} ${name}`);
}
const rgb = c => { const m = /rgba?\(([^)]+)\)/.exec(c) || /color\(srgb ([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].replace(/\//g, ' ').split(/[ ,]+/).filter(Boolean).map(Number); return p.slice(0, 3).map(v => (v <= 1 && /srgb/.test(c) ? v * 255 : v)); };
const lum = ([r, g, b]) => { const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const lastLog = s => s.log[s.log.length - 1];

(async () => {
  await startChildren();
  process.on('exit', killAll);
  const browser = await chromium.launch();
  const t0 = Date.now();
  const pages = [];
  const track = p => { pages.push(p); allPages.push(p); return p; };
  let P1, P2, V;

  // ── S1: three separate contexts, one board: each recipient gets ITS projection, built from what the DATABASE holds ─────────────────────────
  await scenario('S1 contexts: holder, other player, viewer', async () => {
    await host({ type: 'reset', face: 3 });
    const s0 = await state();
    expect(s0.turnNumber === 1 && s0.holder === 'P1' && s0.board.version === 0 && s0.dice.rollCount === 1 && s0.revision === 4 && spentOf(s0) === false, 'S1: the database starts with turn 1, a rolled 3 and an untouched board', s0);
    P1 = track(await newPage(browser, 'recipient=P1')); P2 = track(await newPage(browser, 'recipient=P2')); V = track(await newPage(browser, 'recipient=VIEWER'));
    for (const [page, name] of [[P1, 'P1'], [P2, 'P2'], [V, 'VIEWER']]) await delivered(page, `S1 ${name}`);
    expect((await figureBtn(P1, 'a1').count()) === 1 && (await figureBtn(P1, 'a2').count()) === 1 && (await figureBtn(P1, 'b1').count()) === 0, 'S1: the holder is offered exactly her own figures that can move');
    expect((await P2.getByRole('group').count()) === 0 && (await V.getByRole('group').count()) === 0, 'S1: another player and the viewer have NO controls');
    const viewer = await projectionOf('VIEWER');
    const other = await projectionOf('P2');
    expect(viewer.you === null && viewer.targets.length === 0 && other.you && other.you.canMove === false && other.targets.length === 0, 'S1: the packets of viewer / other player carry no `you.canMove` and no target', { viewer: viewer.you, other: other.you });
    expect(JSON.stringify((await projectionOf('P1')).targets) === JSON.stringify([{ figureId: 'a1', to: 't3', captures: [] }, { figureId: 'a2', to: 't3', captures: [] }]), 'S1: the server offers the holder the targets derived from the stored roll 3');
    await shot(P1, 's1-P1');
  });

  // ── S2: a move by mouse is stored once and reaches every context ──────────────────────────────────────────────────────────────────────────
  await scenario('S2 move by mouse', async () => {
    const s0 = await state();
    await pick(P1, 'a1', 't3');
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S2: the server stored the move');
    const s1 = await state();
    expect(JSON.stringify(s1.positions) === JSON.stringify({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' }) && s1.revision === s0.revision + 1 && s1.receipts === s0.receipts + 1 && s1.events === s0.events + 1
      && spentOf(s1) && s1.board.lastMove.steps === 3 && JSON.stringify(s1.dice) === JSON.stringify(s0.dice), 'S2: the DATABASE holds the move, the spent roll, ONE revision step, one receipt, one event — the dice state is untouched', s1);
    for (const [page, name] of [[P1, 'P1'], [P2, 'P2'], [V, 'VIEWER']]) await delivered(page, `S2 ${name}`);
    expect((await P1.getByRole('group').count()) === 0 && (await P1.getByText('Der Wurf (3 Schritte) ist verbraucht.').count()) === 1, 'S2: the holder has no controls any more (the roll is spent)');
    expect((await V.getByText(/Letzter Zug/).count()) === 1 && (await bodyText(V)).includes('Figur a1 (Ada) von sa nach t3'), 'S2: the viewer sees the last move as text');
    const sent = await calls(P1);
    expect(sent.length === 1 && JSON.stringify(sent[0].intent) === JSON.stringify({ ...origin(s0), figureId: 'a1', to: 't3' }), 'S2: the callback ran once with the ORIGIN of the SHOWN stand — and carried no step count, capture or reset', { sent, expected: origin(s0) });
    await shot(P1, 's2-P1-after');
  });

  // ── S3: no optimistic move; a double click sends ONE intent ───────────────────────────────────────────────────────────────────────────────
  await scenario('S3 no optimistic move, double click', async () => {
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S3 P1');
    const s0 = await state();
    await P1.evaluate(() => { window.__harness.holdSends = true; });
    await figureBtn(P1, 'a1').click();
    await targetBtn(P1, 't3').dblclick();
    await sleep(300);
    expect((await calls(P1)).length === 1, 'S3: a double click sent ONE intent', await calls(P1));
    await host({ type: 'reset', face: 3 }); await delivered(P1, 'S3b P1'); await P1.evaluate(() => { window.__harness.calls.length = 0; });
    await figureBtn(P1, 'a1').click();
    await P1.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^Nach Feld t3/.test(x.textContent || '')); b.click(); b.click(); }); // TWO presses inside ONE task (one render closure)
    await sleep(300);
    expect((await calls(P1)).length === 1, 'S3b: two presses inside ONE task sent ONE intent (the lock is decided on the ref, not the render closure)', await calls(P1));
    await P1.evaluate(() => window.__harness.releaseSends());
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S3b: applied once');
    await host({ type: 'reset', face: 3 }); await delivered(P1, 'S3 reset'); await P1.evaluate(() => { window.__harness.holdSends = true; window.__harness.calls.length = 0; });
    await figureBtn(P1, 'a1').click(); await targetBtn(P1, 't3').click(); await sleep(150);
    expect((await rendered(P1)).a1 === 'sa' && !(await bodyText(P1)).includes('verbraucht') && JSON.stringify((await state()).positions) === JSON.stringify(s0.positions), 'S3: while the request is pending NOTHING moved — not on screen, not in the database');
    expect((await targetBtn(P1, 't3').getAttribute('aria-disabled')) === 'true' && (await P1.getByText('Der Zug wird gesendet').count()) === 1, 'S3: the lock is shown (aria-disabled) with words');
    await figureBtn(P1, 'a2').click({ force: true }); // another figure while the request is pending (aria-disabled: Playwright would wait for 'enabled', a real user can press it)
    expect((await calls(P1)).length === 1, 'S3: a second figure shares the lock of the binding');
    await P1.evaluate(() => window.__harness.releaseSends());
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S3: the single intent was applied once');
    const s1 = await state();
    expect(s1.board.version === 1 && s1.events === s0.events + 1 && s1.receipts === s0.receipts + 1, 'S3: one move, one event, one receipt', s1);
    await delivered(P1, 'S3 P1 after');
  });

  // ── S4: capture is one stored state change ───────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S4 capture', async () => {
    await host({ type: 'reset', face: 3 });
    await host({ type: 'place', at: { b1: 't3' } });
    await delivered(P1, 'S4 P1');
    const s0 = await state();
    await figureBtn(P1, 'a1').click();
    expect((await targetBtn(P1, 't3').innerText()).includes('schlägt b1'), 'S4: the offered target announces the capture in words', await targetBtn(P1, 't3').innerText());
    await targetBtn(P1, 't3').click();
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S4: stored');
    const s1 = await state();
    expect(JSON.stringify(s1.positions) === JSON.stringify({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' }) && JSON.stringify(s1.board.lastMove.captured) === '["b1"]' && s1.revision === s0.revision + 1 && s1.events === s0.events + 1,
      'S4: mover on t3, victim back on ITS start, in ONE revision step and ONE event', s1);
    for (const [page, name] of [[P1, 'P1'], [P2, 'P2'], [V, 'VIEWER']]) await delivered(page, `S4 ${name}`);
    expect((await bodyText(P2)).includes('schlägt b1'), 'S4: the other player sees that her figure was captured');
    await host({ type: 'reset', face: 3 }); await host({ type: 'place', at: { b1: 't3' } }); await host({ type: 'policy', capture: 'FORBIDDEN' });
    await delivered(P1, 'S4 forbidden');
    expect((await P1.getByRole('group').count()) === 0 || (await figureBtn(P1, 'a1').count()) === 0, 'S4: with capture FORBIDDEN the capturing move is not offered');
  });

  // ── S5: the same roll cannot move a second figure; a refused move spends nothing ───────────────────────────────────────────────────────
  await scenario('S5 spent roll', async () => {
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S5 P1');
    const s0 = await state();
    const bad = await sendIntent('P1', FRESH(), { ...origin(s0), figureId: 'a1', to: 't4' }); // illegal target
    expect(bad.ok === false && bad.code === 'BOARD_TARGET_ILLEGAL', 'S5: an illegal target is refused', bad);
    const s1 = await state();
    expect(s1.revision === s0.revision && s1.events === s0.events && s1.board.version === 0 && !spentOf(s1), 'S5: the refusal changed nothing and did not spend the roll');
    const first = await sendIntent('P1', FRESH(), { ...origin(s0), figureId: 'a1', to: 't3' });
    expect(first.ok === true, 'S5: the legal move works afterwards', first);
    const s2 = await state();
    const second = await sendIntent('P1', FRESH(), { ...origin(s2), figureId: 'a2', to: 't3' }); // bound to the NEW board version: only the spent roll can refuse it
    expect(second.ok === false && second.code === 'BOARD_ROLL_SPENT', 'S5: the SAME roll for a second figure is refused', second);
    const stale = await sendIntent('P1', FRESH(), { ...origin(s0), figureId: 'a2', to: 't3' });
    expect(stale.ok === false && stale.code === 'BOARD_VERSION_STALE', 'S5: the old binding is stale', stale);
    const s3 = await state();
    expect(s3.revision === s2.revision && s3.events === s2.events && s3.board.version === 1, 'S5: both refusals left revision, events and board alone');
  });

  // ── S6: keyboard only, focus stays on the locked control ───────────────────────────────────────────────────────────────────────────────
  await scenario('S6 keyboard', async () => {
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S6 P1');
    await P1.evaluate(() => { window.__harness.holdSends = true; document.body.focus(); });
    for (let i = 0; i < 12 && !/^Figur a1/.test(await P1.evaluate(() => document.activeElement.textContent || '')); i++) await P1.keyboard.press('Tab');
    expect(/^Figur a1/.test(await P1.evaluate(() => document.activeElement.textContent || '')), 'S6: Tab reaches the figure button');
    await P1.keyboard.press('Enter');
    expect((await figureBtn(P1, 'a1').getAttribute('aria-pressed')) === 'true', 'S6: Enter selects the figure');
    for (let i = 0; i < 4 && !/^Nach Feld t3/.test(await P1.evaluate(() => document.activeElement.textContent || '')); i++) await P1.keyboard.press('Tab');
    await P1.keyboard.press('Space');
    await sleep(200);
    expect(/^Nach Feld t3/.test(await P1.evaluate(() => document.activeElement.textContent || '')) && (await calls(P1)).length === 1, 'S6: the locked target keeps keyboard focus and exactly one intent was sent');
    await P1.evaluate(() => window.__harness.releaseSends());
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S6: stored');
  });

  // ── S7: rejection before the commit, retry with the SAME commandId; lost answer after the commit ───────────────────────────────────────
  await scenario('S7 retry and lost answer', async () => {
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S7 P1');
    const s0 = await state();
    await host({ type: 'pause', on: true });
    await pick(P1, 'a1', 't3');
    await waitUntil(async () => (await settled(P1)).length === 1, 8000, 'S7: the refusal came back');
    expect((await settled(P1))[0].ok === false && lastLog(await state()).code === 'TURN_SEQ_ACTION_BLOCKED', 'S7: the server refused (paused)', lastLog(await state()));
    expect((await P1.getByText('Der Zug wurde nicht angenommen').count()) === 1, 'S7: the user is told in words');
    const s1 = await state();
    expect(s1.revision === s0.revision && s1.events === s0.events && s1.board.version === 0, 'S7: nothing was stored by the refused attempt');
    await host({ type: 'pause', on: false });
    await pick(P1, 'a1', 't3'); // the retry: same intent, same commandId
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S7: the retry was applied');
    const sent = await calls(P1);
    expect(sent.length === 2 && sent[0].commandId === sent[1].commandId && sent[0].attemptId !== sent[1].attemptId, 'S7: the retry reuses the commandId (a new attempt, the same intent)', sent);
    // lost answer AFTER the commit: freeze the page so the controls of the old stand stay, make the answer fail, press again
    await host({ type: 'reset', face: 3 });
    await cleanPages(); // part b measures its own calls
    await delivered(P1, 'S7b P1');
    await P1.evaluate(() => { window.__harness.freeze(true); window.__harness.failNext = 1; });
    await pick(P1, 'a1', 't3');
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S7b: stored although the answer failed');
    await waitUntil(async () => (await settled(P1)).length === 1, 8000, 'S7b: the failure reached the view');
    const s2 = await state();
    await pick(P1, 'a1', 't3'); // the retry of the SAME intent with the SAME commandId
    await waitUntil(async () => (await state()).log.length === s2.log.length + 1, 8000, 'S7b: the retry reached the server');
    const s3 = await state();
    expect(lastLog(s3).replayed === true && s3.board.version === 1 && s3.revision === s2.revision && s3.events === s2.events, 'S7b: the retry was answered from the receipt — ONE move, no new revision, no new event', lastLog(s3));
    const conflict = await sendIntent('P1', (await calls(P1))[0].commandId, { ...(await calls(P1))[0].intent, to: 't4' });
    expect(conflict.ok === false && conflict.code === 'COMMAND_CONFLICT', 'S7b: the same commandId with a CHANGED intent is a conflict, never a replay', conflict);
    await P1.evaluate(() => window.__harness.freeze(false));
  });

  // ── S8: a late intent of an OLD target, delivered for the FIRST time into a NEW world with the same counters ──────────────────────────────
  await scenario('S8 late first delivery after a new world', async () => {
    const cases = [['another board', { boardId: 'board-2' }, 'BOARD_SCOPE_STALE'], ['another run', { runIndex: 2 }, 'TURN_SEQ_RUN_STALE'], ['another roster', { rosterRevision: 'roster-2' }, 'TURN_SEQ_ROSTER_STALE']];
    for (const [name, over, code] of cases) {
      await host({ type: 'reset', face: 3, sequenceId: 'seq-fixed', runIndex: 1, rosterRevision: 'roster-1', boardId: 'board-1' });
      await delivered(P1, `S8 ${name} before`);
      await P1.evaluate(() => { window.__harness.holdSends = true; });
      await pick(P1, 'a1', 't3'); // built with the OLD origin, NOT sent yet
      await sleep(150);
      const fresh = await host({ type: 'reset', face: 3, sequenceId: 'seq-fixed', runIndex: 1, rosterRevision: 'roster-1', boardId: 'board-1', ...over });
      const s0 = await state();
      expect(fresh.ok === true, `S8 ${name}: the new world exists`, fresh);
      await P1.evaluate(() => window.__harness.releaseSends());
      await waitUntil(async () => (await settled(P1)).length >= 1, 8000, `S8 ${name}: the late intent was answered`);
      const s1 = await state();
      expect(lastLog(s1).ok === false && lastLog(s1).code === code, `S8 ${name}: refused with ${code} although no receipt existed`, lastLog(s1));
      expect(s1.revision === s0.revision && s1.events === s0.events && s1.board.version === 0 && JSON.stringify(s1.positions) === JSON.stringify(s0.positions), `S8 ${name}: the new world was not touched`);
      await P1.evaluate(() => { window.__harness.calls.length = 0; window.__harness.settled.length = 0; });
      await delivered(P1, `S8 ${name} after`);
    }
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S8 restore');
  });

  // ── S9: foreign recipient / empty / older packets delivered into a real context ────────────────────────────────────────────────────────
  await scenario('S9 foreign, empty and older packets', async () => {
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S9 P1'); await delivered(P2, 'S9 P2');
    const p1Old = await projectionOf('P1');
    const p2Old = await projectionOf('P2');
    await P2.evaluate(() => window.__harness.freeze(true));
    await P2.evaluate(raw => window.__harness.deliver(raw), p1Old); // the holder's packet (targets!) arrives at the other player
    await sleep(250);
    expect((await P2.getByRole('region').innerText()).includes('nicht verfügbar') && (await P2.getByRole('group').count()) === 0, 'S9: a packet made for P1 shows nothing at P2');
    const none = await (async () => { await host({ type: 'release', recipient: 'P1', release: 'NONE' }); const p = await projectionOf('P1'); await host({ type: 'release', recipient: 'P1', release: 'FIGURES' }); return p; })();
    await P2.evaluate(raw => window.__harness.deliver(raw), none);
    await sleep(200);
    expect((await P2.getByRole('region').innerText()).includes('nicht verfügbar'), 'S9: an empty NONE packet of P1 shows nothing at P2');
    await P2.evaluate(() => window.__harness.freeze(false));
    await delivered(P2, 'S9 P2 own packet accepted again');
    // a move raises the stand; then an OLDER own packet is delivered late
    await pick(P1, 'a1', 't3');
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S9: stored');
    await delivered(P2, 'S9 P2 newer');
    await P2.evaluate(() => window.__harness.freeze(true));
    await P2.evaluate(raw => window.__harness.deliver(raw), p1Old); // a FOREIGN packet withdraws the view …
    await sleep(200);
    await P2.evaluate(raw => window.__harness.deliver(raw), p2Old); // … and an OLDER packet of the right recipient follows: the version floor must have survived the withdrawal
    await sleep(250);
    expect((await P2.getByRole('region').innerText()).includes('nicht verfügbar') && !(await bodyText(P2)).includes('Wurf: 3 Schritte.'), 'S9: foreign view, then an older own packet: nothing is shown (the floor survived the withdrawal)');
    await P2.evaluate(() => window.__harness.freeze(false));
    await delivered(P2, 'S9 P2 recovered');
    await P2.evaluate(() => window.__harness.freeze(true));
    await P2.evaluate(raw => window.__harness.deliver(raw), p2Old);
    await sleep(250);
    expect(!(await bodyText(P2)).includes('Wurf: 3 Schritte.') && (await bodyText(P2)).includes('verbraucht') && (await rendered(P2)).a1 === 't3', 'S9: an OLDER own packet after the newer one changes nothing: the newer view stays and the unspent roll is NOT resurrected');
    await P2.evaluate(() => window.__harness.freeze(false));
    await delivered(P2, 'S9 P2 back');
  });

  // ── S10: turn change — old intents stay refused although the loaded revision is current ───────────────────────────────────────────────
  await scenario('S10 turn change and old roll', async () => {
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S10 P1'); await delivered(P2, 'S10 P2');
    const s0 = await state();
    const turnOne = { ...origin(s0), figureId: 'a1', to: 't3' };
    await P1.evaluate(() => window.__harness.freeze(true)); // P1's page keeps its (now outdated) controls
    await host({ type: 'endTurn', face: 2 });
    const s1 = await state();
    expect(s1.turnNumber === 2 && s1.holder === 'P2' && s1.dice.binding.turnNumber === 2, 'S10: turn 2 belongs to P2 with a NEW dice process');
    await targetBtn(P1, 't3').count();
    await figureBtn(P1, 'a1').click(); await targetBtn(P1, 't3').click();
    await waitUntil(async () => (await state()).log.length === 1, 8000, 'S10: the outdated page really sent its old intent');
    expect(lastLog(await state()).code === 'TURN_SEQ_VERSION_STALE', 'S10: the outdated intent is refused', lastLog(await state()));
    const s2 = await state();
    expect(s2.revision === s1.revision && s2.board.version === 0, 'S10: nothing changed');
    await P1.evaluate(() => window.__harness.freeze(false));
    await delivered(P1, 'S10 P1 after'); await delivered(P2, 'S10 P2 after');
    expect((await P1.getByRole('group').count()) === 0 && (await figureBtn(P2, 'b1').count()) === 1, 'S10: the controls moved with the turn');
    await pick(P2, 'b1', 't4'); // roll 2 from sb → t4
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S10: P2 moved');
    expect((await state()).positions.b1 === 't4', 'S10: P2\'s figure is on t4 in the database');
    await host({ type: 'endTurn', face: 3 }); await host({ type: 'endTurn', face: 1 }); // P3 (no figure), then P1 again
    const s3 = await state();
    expect(s3.turnNumber === 4 && s3.holder === 'P1', 'S10: P1 again — the SAME person in a LATER turn');
    const old = await sendIntent('P1', FRESH(), turnOne);
    expect(old.ok === false && old.code === 'TURN_SEQ_VERSION_STALE', 'S10: the old turn-1 intent stays refused', old);
    const oldTurn = await sendIntent('P1', FRESH(), { ...origin(s3), turnNumber: 1, figureId: 'a1', to: 't1' });
    expect(oldTurn.ok === false && oldTurn.code === 'TURN_SEQ_TURN_STALE', 'S10: right version, old turn: refused', oldTurn);
    await delivered(P1, 'S10 P1 turn 4');
    await pick(P1, 'a2', 't1'); // roll 1
    await waitUntil(async () => (await state()).board.version === 2, 8000, 'S10: the new turn moves with its own roll');
    expect((await state()).positions.a2 === 't1' && (await state()).positions.b1 === 't4', 'S10: the board kept its figures across turns');
    // a consumer that forgets the dice: the sequence moves on, the stored roll of the old turn is refused anyway
    await host({ type: 'endTurnN8Only' });
    const s4 = await state();
    const forgotten = await sendIntent('P2', FRESH(), { ...origin(s4), figureId: 'b2', to: 't4' });
    expect(forgotten.ok === false && forgotten.code === 'BOARD_TURN_STALE', 'S10: a stored dice process of the OLD turn is refused by the board', forgotten);
  });

  // ── S11: BASIS update without a move ────────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S11 basis update', async () => {
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S11 P1');
    const s0 = await state();
    await host({ type: 'basis' });
    const s1 = await state();
    expect(s1.sequenceVersion === s0.sequenceVersion + 1 && s1.board.version === 0 && JSON.stringify(s1.positions) === JSON.stringify(s0.positions) && JSON.stringify(s1.dice) === JSON.stringify(s0.dice) && s1.turnNumber === s0.turnNumber, 'S11: the basis step moved the sequence version only');
    const old = await sendIntent('P1', FRESH(), { ...origin(s0), figureId: 'a1', to: 't3' });
    expect(old.ok === false && old.code === 'TURN_SEQ_VERSION_STALE', 'S11: the old binding is stale', old);
    await delivered(P1, 'S11 P1 new binding');
    await pick(P1, 'a1', 't3');
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S11: the new binding moves');
    expect(JSON.stringify((await calls(P1)).at(-1).intent.sequenceVersion) === String(s1.sequenceVersion), 'S11: the view built its intent from the NEW sequence version');
  });

  // ── S12: no legal target, rights, pause ────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S12 no target, rights, pause', async () => {
    await host({ type: 'reset', face: 6 });
    await delivered(P1, 'S12 P1');
    expect((await P1.getByRole('group').count()) === 0 && (await bodyText(P1)).includes('kein Zug möglich'), 'S12: with a 6 nothing can move: the holder is told so and has no controls');
    const s0 = await state();
    const none = await sendIntent('P1', FRESH(), { ...origin(s0), figureId: 'a1', to: 'ha' });
    expect(none.ok === false && none.code === 'BOARD_TARGET_ILLEGAL', 'S12: any target is refused', none);
    expect((await state()).revision === s0.revision && !spentOf(await state()), 'S12: the roll is NOT spent');
    await host({ type: 'reset', face: 3 });
    const s1 = await state();
    const results = {
      foreignFigure: await sendIntent('P1', FRESH(), { ...origin(s1), figureId: 'b1', to: 't3' }),
      notHolder: await sendIntent('P2', FRESH(), { ...origin(s1), figureId: 'b1', to: 't3' }),
      viewer: await sendIntent('VIEWER', FRESH(), { ...origin(s1), figureId: 'a1', to: 't3' }),
      host: await sendIntent('HOST', FRESH(), { ...origin(s1), figureId: 'a1', to: 't3' }),
      claimed: await sendIntent('P1', FRESH(), { ...origin(s1), figureId: 'a1', to: 't3', steps: 3, captured: ['b1'], ownerId: 'P1' }),
    };
    expect(results.foreignFigure.code === 'BOARD_FIGURE_NOT_OWNED' && results.notHolder.code === 'TURN_SEQ_NOT_CURRENT_ACTOR' && results.viewer.code === 'TURN_SEQ_ROLE_NOT_ALLOWED'
      && results.host.code === 'TURN_SEQ_ROLE_NOT_ALLOWED' && results.claimed.code === 'BOARD_ARGS_INVALID', 'S12: foreign figure, non-holder, viewer, host and client-claimed results are all refused', results);
    await host({ type: 'pause', on: true });
    const paused = await sendIntent('P1', FRESH(), { ...origin(s1), figureId: 'a1', to: 't3' });
    await host({ type: 'pause', on: false });
    expect(paused.code === 'TURN_SEQ_ACTION_BLOCKED', 'S12: a paused game refuses', paused);
    const s2 = await state();
    expect(s2.board.version === 0 && s2.events === s1.events && s2.revision === s1.revision, 'S12: not one of the refusals changed anything');
  });

  // ── S13: process restart on the same database ───────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S13 restart', async () => {
    if (process.env.HARNESS_EXTERNAL === '1') return;
    await host({ type: 'reset', face: 3 });
    await host({ type: 'place', at: { b1: 't3' } });
    await delivered(P1, 'S13 P1');
    await pick(P1, 'a1', 't3');
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S13: stored');
    const before = await state();
    const pBefore = await projectionOf('P1');
    killBackend();
    await sleep(500);
    startBackend();
    await waitBackend();
    const after = await state();
    expect(JSON.stringify(after.board) === JSON.stringify(before.board) && JSON.stringify(after.dice) === JSON.stringify(before.dice) && after.revision === before.revision && after.events === before.events && after.receipts === before.receipts,
      'S13: after the restart the stored board, dice, revision, events and receipts are exactly the same (nothing re-rolled, re-moved or re-captured)');
    expect(JSON.stringify(await projectionOf('P1')) === JSON.stringify(pBefore), 'S13: the projection is reproduced exactly');
    await delivered(P1, 'S13 P1 after');
    expect(JSON.stringify(after.positions) === JSON.stringify({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' }), 'S13: the capture survived the restart');
    await host({ type: 'endTurn', face: 2 });
    const s = await state();
    const next = await sendIntent('P2', FRESH(), { ...origin(s), figureId: 'b2', to: 't4' });
    expect(next.ok === true, 'S13: the game continues from the stored state after the restart', next);
  });

  // ── S16: a DAMAGED snapshot (N11-01): a last move that contradicts N8 / N9 is refused before anything is shown or moved ─────────────────────────────────
  await scenario('S16 damaged snapshot', async () => {
    await host({ type: 'reset', face: 1 });
    await delivered(P1, 'S16 P1');
    await pick(P1, 'a1', 't1');
    await waitUntil(async () => (await state()).board.version === 1, 8000, 'S16: the regular move is stored');
    await delivered(P1, 'S16 P1 after the move');
    const kinds = [['a roll the stored process has not made yet', { rollCount: 2 }], ['a move from a turn the sequence has not reached', { turnNumber: 2 }], ['steps that contradict the route', { steps: 3 }], ['another process in this turn', { diceId: 'dice-other' }]];
    for (const [name, patch] of kinds) {
      await host({ type: 'reset', face: 1 });
      await delivered(P1, `S16 ${name} fresh`);
      await pick(P1, 'a1', 't1');
      await waitUntil(async () => (await state()).board.version === 1, 8000, `S16 ${name}: regular move stored`);
      await delivered(P1, `S16 ${name} after the move`);
      await host({ type: 'damage', lastMove: patch });
      const s0 = await state();
      const refused = await sendIntent('P1', FRESH(), { ...origin(s0), figureId: 'a1', to: 't2' });
      expect(refused.ok === false && refused.code === 'BOARD_STATE_INVALID', `S16 ${name}: the move is refused as a damaged state`, refused);
      const s1 = await state();
      expect(s1.revision === s0.revision && s1.events === s0.events && s1.positions.a1 === 't1', `S16 ${name}: position, revision and events are unchanged`, { before: s0.positions, after: s1.positions });
      const projection = await projectionOf('VIEWER');
      expect(projection.error === 'BOARD_STATE_INVALID' && projection.figures === undefined, `S16 ${name}: the projection endpoint refuses (code only, no board data)`, projection);
      await waitUntil(async () => (await P1.getByRole('region').innerText()).includes('nicht verfügbar'), 8000, `S16 ${name}: the view shows nothing instead of a board`);
      expect((await P1.getByRole('group').count()) === 0 && (await figureBtn(P1, 'a2').count()) === 0, `S16 ${name}: no control is offered`);
    }
    await host({ type: 'reset', face: 3 });
    await delivered(P1, 'S16 restored');
    expect((await P1.getByRole('group').count()) === 1, 'S16: after a regular new world the controls are back (positive control)');
  });

  // ── S14: layout, themes, touch targets ─────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S14 layout and themes', async () => {
    await host({ type: 'reset', face: 3 });
    const variants = [['320-light', 'recipient=P1', { width: 320, theme: 'light' }], ['320-dark', 'recipient=P1', { width: 320, theme: 'dark' }], ['1100-light', 'recipient=P1', { width: 1100, theme: 'light' }],
      ['1100-dark', 'recipient=P1', { width: 1100, theme: 'dark' }], ['320-long', 'recipient=P1&long=1', { width: 320, theme: 'light' }], ['320-viewer', 'recipient=VIEWER', { width: 320, theme: 'dark' }]];
    for (const [name, query, opts] of variants) {
      const page = track(await newPage(browser, query, { ...opts, height: 900 }));
      await delivered(page, `S14 ${name}`);
      if (!/VIEWER/.test(query)) await figureBtn(page, 'a1').click();
      const m = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('button')].map(e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; });
        const pickEl = document.querySelector('button');
        const fieldEl = document.querySelector('ul[aria-label="Felder"] > li');
        const st = pickEl ? getComputedStyle(pickEl) : null;
        const fs = fieldEl ? getComputedStyle(fieldEl) : null;
        return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, boxes, pickText: st && st.color, pickBg: st && st.backgroundColor, fieldText: fs && fs.color, fieldBg: fs && fs.backgroundColor, fieldBorder: fs && fs.borderTopWidth };
      });
      expect(m.scrollW <= m.innerW, `S14 ${name}: no horizontal page scroll`, { scrollW: m.scrollW, innerW: m.innerW });
      expect(m.boxes.every(b => b.l >= -0.5 && b.r <= m.innerW + 0.5), `S14 ${name}: every control lies inside the viewport`, m.boxes);
      if (!/VIEWER/.test(query)) expect(m.boxes.length >= 3 && m.boxes.every(b => b.w >= 44 && b.h >= 44), `S14 ${name}: every control is at least 44×44 px`, m.boxes.map(b => [Math.round(b.w), Math.round(b.h)]));
      if (m.pickText && rgb(m.pickText) && rgb(m.pickBg)) expect(contrast(rgb(m.pickText), rgb(m.pickBg)) >= 4.5, `S14 ${name}: control text has at least 4.5:1 contrast`, { t: m.pickText, b: m.pickBg });
      if (m.fieldText && rgb(m.fieldText) && rgb(m.fieldBg)) expect(contrast(rgb(m.fieldText), rgb(m.fieldBg)) >= 4.5, `S14 ${name}: field text has at least 4.5:1 contrast`, { t: m.fieldText, b: m.fieldBg });
      expect(page.errors.length === 0, `S14 ${name}: no console errors`, page.errors);
      if (!/VIEWER/.test(query)) expect((await page.getByText('Mögliches Ziel').count()) === 1 && parseFloat((await page.evaluate(() => getComputedStyle(document.querySelector('ul[aria-label="Felder"] li:has(> span:last-child)') || document.body).borderTopWidth))) >= 0, `S14 ${name}: an offered target is marked by words`);
      await shot(page, `s14-${name}`);
    }
    const dark = track(await newPage(browser, 'recipient=P1', { theme: 'dark' })); const light = track(await newPage(browser, 'recipient=P1', { theme: 'light' }));
    const bgs = [await dark.evaluate(() => getComputedStyle(document.body).backgroundColor), await light.evaluate(() => getComputedStyle(document.body).backgroundColor)];
    expect(bgs[0] !== bgs[1], 'S14: dark and light really are different themes in this harness', bgs);
  });

  // ── S15: no page ever errored ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('S15 console', async () => {
    for (const [i, page] of pages.entries()) expect(page.errors.length === 0, `S15: page ${i} had no console / page errors`, page.errors);
  });

  await browser.close();
  killAll();
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(notes.join('\n'));
  if (failures.length) {
    console.log(`\nN11 harness check FAILED (${failures.length} misses, ${seconds}s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`\nN11 harness check passed (${notes.length} scenarios, ${seconds}s).`);
  process.exit(0);
})().catch(error => { console.error(error); killAll(); process.exit(2); });
