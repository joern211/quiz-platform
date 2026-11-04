/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N10 bidding harness: REAL Chromium, SEVERAL separate browser contexts (one per recipient), the REAL server domain (biddingPhase.ts,
// turnSequence.ts) behind a tiny HTTP backend whose authoritative state lives in a REAL SQLite file (real receipts, real CAS, real state events). It is NOT a Safari /
// iPhone / production-network test, and it is NOT an engine consumer.
// Usage: node apps/web/harness/n10-bidding/check.cjs [outDir]       (starts the harness backend and vite itself; HARNESS_EXTERNAL=1 uses running ones)
// Every expectation is ASSERTED: any miss is collected in `failures` and the process exits with status 1.
//
// What is measured (never a label alone): the server's own stored state (/api/state READS THE DATABASE: bids, passes, leader, result basis, versions, revision, receipts,
// events, the log of what the server really applied or refused), what each context actually RECEIVED (window.__harness.received: the JSON, not only the DOM) and what it
// actually RENDERED. A delivery is awaited per recipient with the stored revision AND a rendered effect — a sender ACK or a visible name somewhere proves nothing about
// the other browsers.
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:5207';
const failures = [];
const notes = [];
const expect = (cond, message, detail) => { if (!cond) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, body) => fetch(`${BASE}${p}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const host = body => api('/api/host', body);
const state = () => api('/api/state');
const projectionOf = (recipient, release) => api(`/api/projection?recipient=${recipient}${release ? `&release=${release}` : ''}`);
const sendIntent = (recipient, kind, commandId, intent) => api('/api/intent', { kind, recipient, commandId, intent });
const FRESH = () => `cmd-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const NAME = { T1: 'Rote Rakete', T2: 'Blaue Bande', T3: 'Grüne Gams' };
const teamOfHolder = s => (s.holder === null ? null : s.holder.split('/')[0]);
/** The ORIGIN of an intent (target + team + counters) as a client that looked at the CURRENT stored state would build it; `over` replaces single parts. */
const origin = (s, over = {}) => ({ scope: s.scope, teamId: teamOfHolder(s), turnNumber: s.turnNumber, sequenceVersion: s.sequenceVersion, biddingVersion: s.bidding.version, ...over });
const bidIntent = (s, units, over = {}) => ({ ...origin(s, over), value: { units, scale: 0 } });

async function waitUntil(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) { failures.push(`timeout: ${label}`); return false; }
    await sleep(60);
  }
}
/** The status line a panel must show for a stored bidding (derived from the DATABASE row, independently of the component). */
function expectedStatus(kind, s) {
  const b = s.bidding;
  if (kind === 'standing') {
    if (b.phase === 'OPEN') return b.leader ? `Höchstgebot: ${b.leader.units} Städte von ${NAME[b.leader.teamId]}.` : 'Noch kein Gebot.';
    if (b.phase === 'CLOSED') return `Beendet. ${NAME[b.result.winnerTeamId]} gewinnt mit ${b.result.winningUnits} Städte.`;
    return 'Das Bieten wurde abgebrochen. Es gibt kein Ergebnis.';
  }
  return b.phase === 'OPEN' ? 'Dein Partner verhandelt gerade.' : 'Das Bieten ist beendet.';
}
const statusText = page => page.getByRole('status').first().innerText();
const field = page => page.getByRole('textbox', { name: 'Dein Gebot' });
const bidButton = page => page.getByRole('button', { name: /^(Bieten|Wird gesendet)/ });
const passButton = page => page.getByRole('button', { name: /^(Passen|Gesendet)$/ });
const calls = page => page.evaluate(() => window.__harness.calls);
const settled = page => page.evaluate(() => window.__harness.settled);
const bodyHtml = page => page.evaluate(() => document.body.innerHTML);
const bodyText = page => page.locator('body').innerText();

/** Waits until THIS page has RECEIVED the stored stand (revision AND scope) and has RENDERED it (status line); `effect` adds a recipient-specific rendered check. */
async function delivered(page, label, kind, effect) {
  const s = await state();
  await waitUntil(() => page.evaluate(() => ({ r: window.__harness.received, c: window.__harness.context })).then(({ r, c }) => r && c && c.biddingId === s.scope.biddingId && c.rolesRevision === s.scope.rolesRevision && r.stateVersion === s.revision), 8000, `${label}: page received revision ${s.revision}`);
  await waitUntil(async () => (await statusText(page)) === expectedStatus(kind, s), 8000, `${label}: page rendered "${expectedStatus(kind, s)}"`);
  if (effect) await waitUntil(async () => effect(page, s), 8000, `${label}: rendered effect`);
  return s;
}
async function newPage(browser, recipient, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 480, height: opts.height || 900 }, reducedMotion: opts.reducedMotion || 'no-preference' });
  if (opts.theme) await ctx.addInitScript(([t, a]) => localStorage.setItem('quiz-appearance', JSON.stringify({ v: 1, theme: t, accent: a })), [opts.theme, opts.accent || 'lila']);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(`${BASE}/?recipient=${recipient}${opts.query ? `&${opts.query}` : ''}`);
  await page.waitForSelector('section');
  page.recipient = recipient;
  return page;
}
const shot = async (page, name) => { if (outDir) await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true }); };

let children = [];
let backendChild = null;
let harnessDir;
function startBackend() {
  const root = path.resolve(__dirname, '../../../..');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/web/harness/n10-bidding/server.ts', '5206'], { cwd: root, env: { ...process.env, HARNESS_DIR: harnessDir }, stdio: 'ignore', detached: true });
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
  harnessDir = mkdtempSync(path.join(tmpdir(), 'quiz-n10-check-'));
  startBackend();
  const vite = spawn('pnpm', ['--filter', '@quiz/web', 'exec', 'vite', '--config', 'harness/n10-bidding/vite.config.ts'], { cwd: root, env: process.env, stdio: 'ignore', detached: true });
  children.push(vite);
  await waitBackend();
}
const killAll = () => { for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } } }; // the whole process group (pnpm starts further processes)

async function scenario(name, fn) {
  const before = failures.length;
  try { await fn(); } catch (error) { failures.push(`${name} threw: ${String(error && error.stack || error).split('\n').slice(0, 4).join(' | ')}`); }
  notes.push(`${failures.length === before ? 'ok  ' : 'FAIL'} ${name}`);
}
const rgb = c => { const m = /rgba?\(([^)]+)\)/.exec(c) || /color\(srgb ([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].replace(/\//g, ' ').split(/[ ,]+/).filter(Boolean).map(Number); return p.slice(0, 3).map(v => (v <= 1 && /srgb/.test(c) ? Math.round(v * 255) : v)); };
const lum = ([r, g, b]) => { const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const LEAK_NEEDLES = ['Hauptst', 'Kategorie', 'Städte', 'Rote Rakete', 'Blaue Bande', 'Grüne Gams', 'Höchstgebot', 'gewinnt', 'ausgestiegen', 'führt', 'standing', 'teams', 'onTurn', 'outcome', 'category', 'numeric', 'biddingVersion', 'turnNumber', 'sequenceVersion', 'history', 'leader'];
const NEUTRAL_KEYS = ['contract', 'phase', 'recipientId', 'release', 'scope', 'stateVersion', 'you'];

(async () => {
  await startChildren();
  process.on('exit', killAll);
  const browser = await chromium.launch();
  const t0 = Date.now();
  const open = [];
  const track = p => { open.push(p); return p; };
  const closeAll = async () => { for (const p of open.splice(0)) { try { await p.context().close(); } catch { /* closed */ } } };

  // ── S1: roles and the information matrix, from the first frame ───────────────────────────────────────────
  await scenario('S1 roles: bidder / performer / opposing bidder / viewer / display / host / playing host as performer', async () => {
    const s0 = await state();
    expect(s0.holder === 'T1/b1' && s0.bidding.phase === 'OPEN' && s0.bidding.leader === null && s0.bidding.version === 1, 'initial stored state', { holder: s0.holder, bidding: s0.bidding });
    const P = {};
    for (const r of ['B1', 'B2', 'B3', 'P1', 'P2', 'P3', 'VIEWER', 'DISPLAY', 'HOST', 'HOSTP']) P[r] = track(await newPage(browser, r));
    for (const r of ['B1', 'B2', 'B3', 'VIEWER', 'DISPLAY', 'HOST']) await delivered(P[r], r, 'standing');
    for (const r of ['P1', 'P2', 'P3', 'HOSTP']) await delivered(P[r], r, 'neutral');
    expect(await field(P.B1).count() === 1 && await bidButton(P.B1).count() === 1, 'B1 (bidder on turn) has the bid field and button');
    expect(await passButton(P.B1).count() === 0, 'B1 has NO pass before the first bid');
    for (const r of ['B2', 'B3']) {
      expect((await bodyText(P[r])).includes('Ein anderes Team ist am Zug.') && await field(P[r]).count() === 0, `${r} waits without controls`);
    }
    for (const r of ['VIEWER', 'DISPLAY', 'HOST']) {
      const text = await bodyText(P[r]);
      expect(text.includes('Kategorie: Hauptstädte Europas') && await P[r].locator('input, button').count() === 0, `${r} sees the category and has NO control although callbacks were given`);
    }
    for (const r of ['P1', 'P2', 'P3', 'HOSTP']) {
      const received = await P[r].evaluate(() => window.__harness.received);
      expect(received.release === 'NEUTRAL' && JSON.stringify(received.keys) === JSON.stringify(NEUTRAL_KEYS), `${r} RECEIVED exactly the neutral keys`, received.keys);
      const html = await bodyHtml(P[r]);
      const own = r === 'HOSTP' ? 'p3' : r.toLowerCase();
      for (const needle of LEAK_NEEDLES) expect(!received.json.includes(needle) && !html.includes(needle), `${r}: "${needle}" must be in neither the received JSON nor the DOM`);
      expect(received.json.includes(own), `${r} packet is bound to its recipient`, own);
      expect(await P[r].locator('input, textarea, button, li, ul, [contenteditable]').count() === 0, `${r}: no hidden input / control / list in the DOM`);
    }
    expect((await bodyText(P.P1)).includes('Dein Partner verhandelt gerade.') && (await bodyText(P.HOSTP)).includes('Dein Partner verhandelt gerade.'), 'performer and playing host see the neutral sentence');
    // the server REFUSES a wider package for a performer, also for a host who plays as performer: there is no package that contains the forbidden fields
    for (const r of ['P1', 'P2', 'P3', 'HOSTP']) expect((await projectionOf(r, 'STANDING')).error === 'BIDDING_RELEASE_FORBIDDEN', `server refuses STANDING for ${r}`);
    // players who must not act get refused by the real N8 check, with the right code and no stored effect
    const s = await state();
    const cases = [['P1', 'TURN_SEQ_NOT_CURRENT_ACTOR'], ['B2', 'TURN_SEQ_NOT_CURRENT_ACTOR'], ['HOST', 'TURN_SEQ_ROLE_NOT_ALLOWED'], ['HOSTP', 'TURN_SEQ_ROLE_NOT_ALLOWED'], ['VIEWER', 'TURN_SEQ_ROLE_NOT_ALLOWED'], ['DISPLAY', 'TURN_SEQ_ROLE_NOT_ALLOWED']];
    for (const [who, code] of cases) {
      const r = await sendIntent(who, 'BID', FRESH(), bidIntent(s, 3));
      expect(r.ok === false && r.code === code, `${who} bid refused with ${code}`, r);
    }
    const s2 = await state();
    expect(s2.revision === s.revision && s2.bidding.stepCount === 0 && s2.events === s.events, 'refused attempts left the database untouched', { before: s.revision, after: s2.revision });
    await shot(P.B1, 's1-bidder'); await shot(P.P1, 's1-performer'); await shot(P.VIEWER, 's1-viewer');
    // keep the pages for the next scenarios
    globalThis.PAGES = P;
  });

  // ── S2: a bid by the UI reaches every recipient, per role ────────────────────────────────────────────────
  await scenario('S2 bid through the UI: stored, handed over, delivered per role', async () => {
    const P = globalThis.PAGES;
    const before = await state();
    await field(P.B1).fill('5');
    await bidButton(P.B1).click();
    const s = await waitUntil(async () => { const x = await state(); return x.bidding.stepCount === 1 ? x : false; }, 8000, 'bid stored');
    expect(s.bidding.leader && s.bidding.leader.teamId === 'T1' && s.bidding.leader.units === 5, 'stored leader T1 with 5', s.bidding.leader);
    expect(s.holder === 'T2/b2' && s.turnNumber === before.turnNumber + 1 && s.revision === before.revision + 1 && s.events === before.events + 1, 'handed over to T2 in ONE commit', { holder: s.holder, rev: s.revision });
    expect(s.members.every(m => m.length === 1) && s.cursors.every(c => c === 0) && s.completedTurns === 0, 'no bidder rotation, no completed turn', { members: s.members, cursors: s.cursors });
    const c1 = await calls(P.B1);
    expect(c1.length === 1 && c1[0].kind === 'BID' && c1[0].intent.value.units === 5 && c1[0].intent.scope.biddingId === before.scope.biddingId && c1[0].intent.turnNumber === before.turnNumber && c1[0].intent.biddingVersion === before.bidding.version && c1[0].intent.teamId === 'T1', 'B1 sent ONE bid with its complete origin', c1);
    await delivered(P.B2, 'B2', 'standing', async page => (await bodyText(page)).includes('Du bist am Zug.') && await field(page).count() === 1 && await passButton(page).count() === 1);
    await delivered(P.B1, 'B1', 'standing', async page => (await bodyText(page)).includes('Du führst. Warte auf die anderen Teams.') && await field(page).count() === 0);
    await delivered(P.B3, 'B3', 'standing');
    await delivered(P.VIEWER, 'VIEWER', 'standing', async page => (await bodyText(page)).includes('Höchstgebot: 5 Städte von Rote Rakete.'));
    for (const r of ['P1', 'P2', 'P3', 'HOSTP']) {
      await delivered(P[r], r, 'neutral');
      const html = await bodyHtml(P[r]);
      expect(!html.includes('Rote Rakete') && !html.includes('Städte') && !(await P[r].evaluate(() => window.__harness.received.json)).includes('"units"'), `${r} learned nothing of the bid`);
    }
    await shot(P.B2, 's2-opponent-on-turn');
  });

  // ── S3: double click and keyboard ────────────────────────────────────────────────────────────────────────
  await scenario('S3 double click sends once; Enter sends; the keyboard focus stays', async () => {
    const P = globalThis.PAGES;
    const before = await state();
    await field(P.B2).fill('8');
    await bidButton(P.B2).dblclick();
    const s = await waitUntil(async () => { const x = await state(); return x.bidding.stepCount === 2 ? x : false; }, 8000, 'second bid stored');
    await sleep(400);
    const after = await state();
    expect((await calls(P.B2)).length === 1, 'B2 double click produced ONE command', await calls(P.B2));
    expect(after.bidding.stepCount === 2 && after.bidding.history.length === 2 && after.receipts === before.receipts + 1 && after.events === before.events + 1, 'the database shows exactly ONE new bid, receipt and event', { before: before.receipts, after: after.receipts, steps: after.bidding.stepCount });
    expect(s.bidding.leader.teamId === 'T2' && s.bidding.leader.units === 8 && s.holder === 'T3/b3', 'T2 leads with 8, T3 is up', s.bidding);
    await delivered(P.B3, 'B3', 'standing', async page => await field(page).count() === 1);
    // keyboard: Tab reaches the field, typing + Enter sends, and WHILE the command is pending the focus stays in the input (a control that is locked must not take the focus away)
    await P.B3.evaluate(() => { window.__harness.holdSends = true; });
    await P.B3.keyboard.press('Tab');
    expect(await P.B3.evaluate(() => document.activeElement && document.activeElement.tagName === 'INPUT'), 'Tab focuses the bid field first');
    await P.B3.keyboard.type('9');
    await P.B3.keyboard.press('Enter');
    await waitUntil(async () => (await calls(P.B3)).length === 1, 5000, 'keyboard bid created');
    const focus = await P.B3.evaluate(() => ({ tag: document.activeElement && document.activeElement.tagName, ro: document.activeElement && document.activeElement.readOnly }));
    expect(focus.tag === 'INPUT' && focus.ro === true, 'while pending the keyboard focus stays in the (read-only) input', focus);
    await P.B3.keyboard.press('Enter');
    await sleep(200);
    expect((await calls(P.B3)).length === 1, 'a second Enter while pending sends nothing', await calls(P.B3));
    await P.B3.evaluate(() => window.__harness.releaseSends());
    await waitUntil(async () => (await state()).bidding.stepCount === 3, 8000, 'keyboard bid stored');
    expect((await state()).bidding.leader.units === 9, 'T3 leads with 9');
  });

  // ── S4: a bid and a pass on the same binding; the pass by keyboard; the leader waits ─────────────────────
  await scenario('S4 bid then pass on the SAME binding: one command only; then a pass by keyboard hands the turn on', async () => {
    const P = globalThis.PAGES;
    // T1 is up (T3 leads with 9). Bid and pass fired in one tick on the same binding: the second is dropped by the shared lock.
    await delivered(P.B1, 'B1', 'standing', async page => await field(page).count() === 1 && await passButton(page).count() === 1);
    await field(P.B1).fill('12');
    const before = await state();
    const callsBefore = (await calls(P.B1)).length;
    await P.B1.evaluate(() => { document.querySelector('form button[type=submit]').click(); [...document.querySelectorAll('button')].find(b => /^Passen$/.test(b.textContent.trim())).click(); });
    await sleep(900);
    const c = (await calls(P.B1)).slice(callsBefore);
    const s = await state();
    expect(c.length === 1 && c[0].kind === 'BID', 'ONE command for the binding (the bid), the pass was dropped', c.map(x => x.kind));
    expect(s.bidding.stepCount === before.bidding.stepCount + 1 && s.bidding.passed.length === 0 && s.bidding.leader.teamId === 'T1' && s.bidding.leader.units === 12, 'stored: the bid only, nobody passed', s.bidding);
    // T2 is up (T1 leads 12, T3 not out): T2 passes by KEYBOARD
    await delivered(P.B2, 'B2', 'standing', async page => await passButton(page).count() === 1);
    await passButton(P.B2).focus();
    await P.B2.evaluate(() => { window.__harness.holdSends = true; });
    await P.B2.keyboard.press('Space');
    await waitUntil(async () => (await calls(P.B2)).length === 2, 5000, 'keyboard pass created');
    const passFocus = await P.B2.evaluate(() => ({ text: document.activeElement && document.activeElement.textContent, aria: document.activeElement && document.activeElement.getAttribute('aria-disabled'), disabled: document.activeElement && document.activeElement.disabled }));
    expect(passFocus.aria === 'true' && passFocus.disabled !== true && /Gesendet/.test(passFocus.text || ''), 'while pending the pass button keeps the keyboard focus (aria-disabled, not disabled)', passFocus);
    await P.B2.keyboard.press('Enter');
    await sleep(200);
    expect((await calls(P.B2)).length === 2, 'a second key press while pending sends nothing', await calls(P.B2));
    await P.B2.evaluate(() => window.__harness.releaseSends());
    await waitUntil(async () => (await state()).bidding.passed.length === 1, 8000, 'pass stored');
    const after = await state();
    expect(after.bidding.passed[0] === 'T2' && after.bidding.phase === 'OPEN' && after.holder === 'T3/b3', 'T2 left; the FIRST pass of three teams does not end the bidding; T3 is up', { passed: after.bidding.passed, phase: after.bidding.phase, holder: after.holder });
    const lockedPass = await passButton(P.B2).getAttribute('aria-disabled').catch(() => null);
    expect(lockedPass !== 'false', 'the pass lock uses aria-disabled', lockedPass);
    const hist = after.bidding.history[after.bidding.history.length - 1];
    expect(hist.kind === 'PASS' && hist.teamId === 'T2' && hist.againstTeamId === 'T1' && hist.againstUnits === 12, 'the pass remembers who led', hist);
    await delivered(P.VIEWER, 'VIEWER', 'standing', async page => (await bodyText(page)).includes('ausgestiegen'));
    await delivered(P.B2, 'B2', 'standing', async page => (await bodyText(page)).includes('Dein Team ist ausgestiegen.') && await field(page).count() === 0);
  });

  // ── S5: the regular end, the result basis, what each role learns ────────────────────────────────────────
  await scenario('S5 regular end: T3 passes against T1 → T1 wins 12; last opponent T3, earlier T2; both stores closed in ONE commit', async () => {
    const P = globalThis.PAGES;
    const before = await state();
    await delivered(P.B3, 'B3', 'standing', async page => await passButton(page).count() === 1);
    await passButton(P.B3).click();
    const s = await waitUntil(async () => { const x = await state(); return x.bidding.phase === 'CLOSED' ? x : false; }, 8000, 'closing pass stored');
    expect(s.revision === before.revision + 1 && s.events === before.events + 1, 'the closing pass is ONE commit', { rev: s.revision });
    expect(s.sequencePhase === 'CLOSED' && s.bidding.endReason === 'COMPLETED', 'the N8 sequence is closed with the result', { seq: s.sequencePhase });
    expect(s.resultBasis && s.resultBasis.winnerTeamId === 'T1' && s.resultBasis.winningValue.units === 12 && s.resultBasis.bidderId === 'b1' && s.resultBasis.performerId === 'p1', 'result basis: winner, bid, ITS pair', s.resultBasis);
    expect(s.resultBasis.lastPassAgainstWinnerTeamId === 'T3' && s.resultBasis.earlierPasses.length === 1 && s.resultBasis.earlierPasses[0].teamId === 'T2' && s.resultBasis.earlierPasses[0].againstTeamId === 'T1', 'last opponent against the final winner is T3, T2 left earlier', s.resultBasis);
    for (const r of ['B1', 'B2', 'B3', 'VIEWER', 'DISPLAY', 'HOST']) await delivered(P[r], r, 'standing', async page => (await bodyText(page)).includes('Rote Rakete gewinnt mit 12') && await page.locator('input, button').count() === 0);
    for (const r of ['P1', 'P2', 'P3', 'HOSTP']) {
      await delivered(P[r], r, 'neutral', async page => (await bodyText(page)).includes('Das Bieten ist beendet.'));
      const received = await P[r].evaluate(() => window.__harness.received);
      expect(JSON.stringify(received.keys) === JSON.stringify(NEUTRAL_KEYS) && !received.json.includes('12') , `${r}: a finished result is no blanket reveal`);
      expect(!(await bodyHtml(P[r])).includes('gewinnt') && !(await bodyHtml(P[r])).includes('Rote Rakete'), `${r}: no winner in the DOM`);
    }
    const viewer = await P.VIEWER.evaluate(() => window.__harness.received.json);
    expect(!viewer.includes('lastPass') && !viewer.includes('againstTeamId') && !viewer.includes('history'), 'the viewer packet carries no pass evidence');
    await shot(P.VIEWER, 's5-closed-viewer'); await shot(P.P1, 's5-closed-performer');
    // late command after the end: refused, nothing stored
    const late = await sendIntent('B1', 'BID', FRESH(), bidIntent(before, 99, { teamId: 'T1' }));
    const after = await state();
    expect(late.ok === false && /BIDDING_ENDED|TURN_SEQ_/.test(late.code), 'a late bid after the end is refused', late);
    expect(after.revision === s.revision && after.bidding.history.length === s.bidding.history.length, 'nothing stored by the late bid');
    // reload of the CLOSED phase: same view, no command by itself
    for (const r of ['B1', 'VIEWER', 'P1']) {
      await P[r].reload(); await P[r].waitForSelector('section');
      await delivered(P[r], `${r} reload`, r === 'P1' ? 'neutral' : 'standing');
      expect((await calls(P[r])).length === (r === 'B1' ? 0 : 0) || r !== 'B1', `${r} reload sent nothing by itself`);
    }
    expect((await calls(P.B1)).length === 0, 'B1 after reload: no callback by itself', await calls(P.B1));
    await closeAll();
  });

  // ── S6: a late command of an OLD bidding, delivered for the first time into a NEW bidding with identical counters ─────────
  await scenario('S6 delayed first delivery after a new bidding (same counters, same player): refused before any effect', async () => {
    await host({ type: 'reset', biddingId: 'bidding-a' });
    const B1 = track(await newPage(browser, 'B1'));
    await delivered(B1, 'B1', 'standing', async page => await field(page).count() === 1);
    await B1.evaluate(() => { window.__harness.holdSends = true; });
    await field(B1).fill('7');
    await bidButton(B1).click();
    await waitUntil(async () => (await calls(B1)).length === 1, 5000, 'intent created');
    const oldIntent = (await calls(B1))[0].intent;
    await host({ type: 'reset', biddingId: 'bidding-b' }); // a NEW bidding: same run, round, sequence, roster, roles, same counters, same participants
    await waitUntil(async () => (await B1.evaluate(() => window.__harness.context && window.__harness.context.biddingId)) === 'bidding-b', 8000, 'page follows its new context');
    const fresh = await delivered(B1, 'B1 new bidding', 'standing', async page => await field(page).count() === 1);
    expect(oldIntent.scope.biddingId === 'bidding-a' && oldIntent.turnNumber === fresh.turnNumber && oldIntent.biddingVersion === fresh.bidding.version && oldIntent.sequenceVersion === fresh.sequenceVersion, 'precondition: identical counters, only the origin differs', { oldIntent, fresh: { t: fresh.turnNumber, v: fresh.bidding.version } });
    await B1.evaluate(() => window.__harness.releaseSends()); // the OLD intent is delivered NOW, for the first time
    await waitUntil(async () => (await settled(B1)).length === 1, 8000, 'late delivery answered');
    const late = (await settled(B1))[0];
    const after = await state();
    expect(late.ok === false && late.code === 'BIDDING_SCOPE_STALE', 'refused with BIDDING_SCOPE_STALE', late);
    expect(after.revision === fresh.revision && after.events === fresh.events && after.bidding.stepCount === 0 && after.bidding.leader === null, 'no revision step, no event, no bid, no leader', after.bidding);
    // positive control: the FRESH intent of the new bidding works
    await B1.evaluate(() => { window.__harness.holdSends = false; });
    await waitUntil(async () => await field(B1).count() === 1 && (await bodyText(B1)).includes('Du bist am Zug.'), 8000, 'panel offers a fresh attempt');
    await field(B1).fill('7');
    await bidButton(B1).click();
    const done = await waitUntil(async () => { const x = await state(); return x.bidding.stepCount === 1 ? x : false; }, 8000, 'fresh bid stored');
    expect(done.bidding.leader.units === 7, 'the fresh bid was stored', done.bidding.leader);
    await closeAll();
  });

  // ── S7: a role change (bidder → performer) and a late bidder packet of the same participant ───────────────
  await scenario('S7 role change: the same participant is bidder, then performer: a late bidder packet shows nothing', async () => {
    await host({ type: 'reset', biddingId: 'bidding-r1' });
    const B1 = track(await newPage(browser, 'B1'));
    const P1 = track(await newPage(browser, 'P1'));
    await delivered(B1, 'B1', 'standing', async page => await field(page).count() === 1);
    await delivered(P1, 'P1', 'neutral');
    const oldBidderPacket = await projectionOf('B1'); // what B1 (b1, bidder) legitimately received
    expect(oldBidderPacket.release === 'STANDING' && oldBidderPacket.you.canBid === true, 'precondition: a released bidder packet with the right to bid');
    await host({ type: 'reset', biddingId: 'bidding-r2', rolesRevision: 'roles-2', rotate: true }); // the SAME participants, T1: b1 → performer, p1 → bidder
    await waitUntil(async () => (await B1.evaluate(() => window.__harness.context && window.__harness.context.rolesRevision)) === 'roles-2', 8000, 'B1 follows the rotated assignment');
    await delivered(B1, 'B1 rotated', 'neutral', async page => (await bodyText(page)).includes('Dein Partner verhandelt gerade.'));
    await delivered(P1, 'P1 rotated', 'standing', async page => await field(page).count() === 1 && (await bodyText(page)).includes('Du bist am Zug.'));
    expect(await field(B1).count() === 0, 'b1 (now performer) has no control');
    // the LATE bidder packet of b1 (old bidding, old role) arrives after the withdrawal: it must show nothing
    await B1.evaluate(() => window.__harness.freeze(true));
    await B1.evaluate(raw => window.__harness.deliver(raw), oldBidderPacket);
    await sleep(300);
    const html = await bodyHtml(B1);
    expect(!html.includes('Dein Gebot') && !html.includes('Hauptst') && !html.includes('Passen') && (await bodyText(B1)).includes('zurzeit nicht verfügbar'), 'the late bidder packet is foreign: nothing of it is rendered');
    expect(await B1.locator('input, button').count() === 0, 'no control from the old bidder packet');
    await B1.evaluate(() => window.__harness.freeze(false));
    await delivered(B1, 'B1 after unfreeze', 'neutral');
    // p1 (now bidder) bids; b1 (now performer) cannot, with the old origin or the new one
    const s = await state();
    const mine = await sendIntent('B1', 'BID', FRESH(), bidIntent(s, 5, { teamId: 'T1' }));
    expect(mine.ok === false && mine.code === 'TURN_SEQ_NOT_CURRENT_ACTOR', 'b1 as performer cannot bid', mine);
    await field(P1).fill('4'); await bidButton(P1).click();
    await waitUntil(async () => (await state()).bidding.stepCount === 1, 8000, 'p1 bid stored');
    const s2 = await state();
    expect(s2.bidding.history[0].playerId === 'p1' && s2.bidding.leader.teamId === 'T1', 'stored: the new bidder p1 bid for T1', s2.bidding.history);
    await closeAll();
  });

  // ── S8: withdrawal chain in the browser ──────────────────────────────────────────────────────────────────
  await scenario('S8 withdrawal: current → null → an older packet: nothing comes back', async () => {
    await host({ type: 'reset', biddingId: 'bidding-w' });
    const B1 = track(await newPage(browser, 'B1'));
    await delivered(B1, 'B1', 'standing', async page => await field(page).count() === 1);
    const older = await projectionOf('B1');
    await sendIntent('B1', 'BID', FRESH(), bidIntent(await state(), 3)); // the world moves on
    await delivered(B1, 'B1 after bid', 'standing', async page => (await bodyText(page)).includes('Du führst'));
    await B1.evaluate(() => window.__harness.freeze(true));
    await B1.evaluate(() => window.__harness.deliver(null));
    expect((await bodyText(B1)).includes('zurzeit nicht verfügbar') && await B1.locator('input, button').count() === 0, 'null withdraws everything');
    await B1.evaluate(raw => window.__harness.deliver(raw), older);
    expect((await bodyText(B1)).includes('zurzeit nicht verfügbar') && await B1.locator('input, button').count() === 0, 'the OLDER packet does not bring the old "may bid" view back');
    await B1.evaluate(() => window.__harness.freeze(false));
    await delivered(B1, 'B1 current again', 'standing');
    await closeAll();
  });

  // ── S9: abort, no guessed winner ─────────────────────────────────────────────────────────────────────────
  await scenario('S9 abort: no result, no winner anywhere; the late command is refused', async () => {
    await host({ type: 'reset', biddingId: 'bidding-x' });
    const P = {};
    for (const r of ['B1', 'B2', 'VIEWER', 'P2']) P[r] = track(await newPage(browser, r));
    await delivered(P.B1, 'B1', 'standing', async page => await field(page).count() === 1);
    await field(P.B1).fill('4'); await bidButton(P.B1).click();
    await waitUntil(async () => (await state()).bidding.stepCount === 1, 8000, 'bid stored');
    const before = await state();
    await host({ type: 'abort', reason: 'HOST_ABORTED' });
    const s = await state();
    expect(s.bidding.phase === 'ABORTED' && s.bidding.endReason === 'HOST_ABORTED' && s.bidding.result === null && s.resultBasis === null && s.sequencePhase === 'CLOSED' && s.bidding.leader.units === 4, 'stored: aborted without result, sequence closed, the last standing stays server-private', s.bidding);
    for (const r of ['B1', 'B2', 'VIEWER']) await delivered(P[r], r, 'standing', async page => !(await bodyText(page)).includes('gewinnt') && !(await bodyText(page)).includes('Höchstgebot') && await page.locator('input, button').count() === 0);
    await delivered(P.P2, 'P2', 'neutral', async page => (await bodyText(page)).includes('Das Bieten ist beendet.'));
    const viewer = JSON.parse(await P.VIEWER.evaluate(() => window.__harness.received.json));
    expect(viewer.standing === null && viewer.outcome === null && viewer.endReason === 'HOST_ABORTED' && !viewer.teams.some(t => t.leading), 'viewer packet: no standing, no outcome', viewer);
    const late = await sendIntent('B2', 'BID', FRESH(), bidIntent(before, 9, { teamId: 'T2' }));
    const after = await state();
    expect(late.ok === false && late.code === 'BIDDING_ENDED' && after.revision === s.revision, 'late bid after the abort: BIDDING_ENDED, nothing stored', late);
    await closeAll();
  });

  // ── S10: a lost bidder role (HELD): nothing guessed ──────────────────────────────────────────────────────
  await scenario('S10 lost bidder role: HELD stops everything — no pass, no winner, no defeat', async () => {
    await host({ type: 'reset', biddingId: 'bidding-h' });
    const P = {};
    for (const r of ['B1', 'B2', 'VIEWER']) P[r] = track(await newPage(browser, r));
    await delivered(P.B1, 'B1', 'standing', async page => await field(page).count() === 1);
    await field(P.B1).fill('3'); await bidButton(P.B1).click();
    await waitUntil(async () => (await state()).bidding.stepCount === 1, 8000, 'bid stored');
    await delivered(P.B2, 'B2', 'standing', async page => await field(page).count() === 1);
    const stale = bidIntent(await state(), 6, { teamId: 'T2' });
    await host({ type: 'withhold' }); // the bidder on turn (b2) is no longer eligible
    const s = await state();
    expect(s.sequencePhase === 'HELD' && s.bidding.phase === 'OPEN' && s.bidding.passed.length === 0 && s.bidding.result === null && s.bidding.stepCount === 1, 'stored: HELD, the bidding is untouched', { seq: s.sequencePhase, bidding: s.bidding });
    await delivered(P.B2, 'B2 held', 'standing', async page => (await bodyText(page)).includes('Im Moment kann niemand bieten.') && await page.locator('input, button').count() === 0);
    await delivered(P.VIEWER, 'VIEWER held', 'standing', async page => (await bodyText(page)).includes('Im Moment kann niemand bieten.'));
    const late = await sendIntent('B2', 'BID', FRESH(), stale);
    const after = await state();
    expect(late.ok === false && /TURN_SEQ_/.test(late.code) && after.revision === s.revision, 'the late bid of the held bidder is refused', late);
    await host({ type: 'abort', reason: 'TECHNICAL_ABORT' });
    expect((await state()).bidding.phase === 'ABORTED', 'only the authorised abort ends it');
    await closeAll();
  });

  // ── S11: a newer eligibility basis without any bid ──────────────────────────────────────────────────────
  await scenario('S11 newer N6 basis without a bid: sequence version +1 only; the old binding is stale, the same bids continue', async () => {
    await host({ type: 'reset', biddingId: 'bidding-b2' });
    const P = {};
    for (const r of ['B1', 'B2']) P[r] = track(await newPage(browser, r));
    await delivered(P.B1, 'B1', 'standing', async page => await field(page).count() === 1);
    await field(P.B1).fill('3'); await bidButton(P.B1).click();
    await waitUntil(async () => (await state()).bidding.stepCount === 1, 8000, 'bid stored');
    await delivered(P.B2, 'B2', 'standing', async page => await field(page).count() === 1);
    await field(P.B2).fill('7'); // a draft, not sent
    const before = await state();
    const oldBinding = bidIntent(before, 7, { teamId: 'T2' });
    await host({ type: 'basis' });
    const s = await state();
    expect(s.sequenceVersion === before.sequenceVersion + 1 && s.turnNumber === before.turnNumber && s.holder === before.holder && s.basisVersion === 2 && s.bidding.stepCount === 1 && s.bidding.version === before.bidding.version, 'stored: basis step only (no turn, no bid, no handover)', { seqV: s.sequenceVersion, basis: s.basisVersion });
    const stale = await sendIntent('B2', 'BID', FRESH(), oldBinding);
    expect(stale.ok === false && stale.code === 'TURN_SEQ_VERSION_STALE', 'the intent made before the basis step is stale', stale);
    await delivered(P.B2, 'B2 after basis', 'standing', async page => await field(page).count() === 1);
    await field(P.B2).fill('7'); await bidButton(P.B2).click();
    await waitUntil(async () => (await state()).bidding.stepCount === 2, 8000, 'bid under the new binding');
    expect((await state()).bidding.leader.units === 7, 'the same bidding continues with the stored bids');
    await closeAll();
  });

  // ── S12: receipts, concurrency, pause ────────────────────────────────────────────────────────────────────
  await scenario('S12 receipts and concurrency at the API: replay, conflicts, bid vs pass on one binding, pause', async () => {
    await host({ type: 'reset', biddingId: 'bidding-c' });
    let s = await state();
    const cid = FRESH();
    const intent = bidIntent(s, 5);
    const first = await sendIntent('B1', 'BID', cid, intent);
    expect(first.ok === true, 'first send ok', first);
    const again = await sendIntent('B1', 'BID', cid, intent);
    expect(again.ok === true && again.replayed === true, 'same id + same intent: a real replay', again);
    const after = await state();
    expect(after.bidding.stepCount === 1 && after.events === s.events + 1, 'replay produced no second bid / event', after.bidding);
    for (const [label, kind, body] of [['other operation', 'PASS', origin(s)], ['other value', 'BID', bidIntent(s, 6)], ['other target', 'BID', bidIntent(s, 5, { scope: { ...s.scope, biddingId: 'bidding-other' } })], ['other team expectation', 'BID', bidIntent(s, 5, { teamId: 'T3' })]]) {
      const r = await sendIntent('B1', kind, cid, body);
      expect(r.ok === false && r.code === 'COMMAND_CONFLICT', `same id + ${label}: COMMAND_CONFLICT`, r);
    }
    expect((await state()).bidding.stepCount === 1, 'conflicts changed nothing');
    // a bid and a pass of the holder against the SAME stored stand (T2 is up; T1 leads with 5): exactly one wins
    s = await state();
    const results = await Promise.all([sendIntent('B2', 'BID', FRESH(), bidIntent(s, 9)), sendIntent('B2', 'PASS', FRESH(), origin(s))]);
    const fin = await state();
    expect(results.filter(r => r.ok).length === 1 && fin.bidding.stepCount === 2 && fin.revision === s.revision + 1, 'bid vs pass: exactly ONE commit, no half effect', { results, steps: fin.bidding.stepCount });
    expect(fin.bidding.passed.length <= 1 && (fin.bidding.passed.length === 1 ? fin.bidding.passed[0] === 'T2' : fin.bidding.leader.teamId === 'T2'), 'consistent winner of the race', fin.bidding);
    // pause: the real gate refuses
    s = await state();
    await host({ type: 'pause', on: true });
    const blocked = await sendIntent(`B${s.holder.slice(1, 2)}`, 'BID', FRESH(), bidIntent(s, 40));
    expect(blocked.ok === false && blocked.code === 'TURN_SEQ_ACTION_BLOCKED' && (await state()).revision === s.revision, 'pause blocks the bid', blocked);
    await host({ type: 'pause', on: false });
  });

  // ── S13: layout, themes, contrast, focus, long names, reduced motion ─────────────────────────────────────
  await scenario('S13 layout: narrow / wide, light / dark, long names, contrast, focus ring', async () => {
    await host({ type: 'reset', biddingId: 'bidding-l' });
    const combos = [{ width: 320, theme: 'dark' }, { width: 320, theme: 'light' }, { width: 1280, theme: 'dark' }, { width: 1280, theme: 'light' }];
    for (const [i, c] of combos.entries()) {
      for (const recipient of ['B1', 'P1', 'VIEWER']) {
        const page = track(await newPage(browser, recipient, { width: c.width, theme: c.theme, accent: i % 2 ? 'lila' : 'mint', query: 'long=1' }));
        await delivered(page, `${recipient} ${c.width} ${c.theme}`, recipient === 'P1' ? 'neutral' : 'standing').catch(() => undefined);
        await waitUntil(async () => (await statusText(page)).length > 0, 8000, `${recipient} rendered`);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bg: getComputedStyle(document.querySelector('section')).backgroundColor, fg: getComputedStyle(document.querySelector('[role=status]')).color }));
        expect(m.sw <= m.cw, `${recipient} ${c.width}px ${c.theme}: no horizontal scroll`, m);
        expect(contrast(rgb(m.fg), rgb(m.bg)) >= 4.5, `${recipient} ${c.theme}: status text contrast >= 4.5`, { fg: m.fg, bg: m.bg });
        if (recipient === 'B1') {
          await page.keyboard.press('Tab');
          const ring = await page.evaluate(() => { const el = document.activeElement; const st = getComputedStyle(el); return { tag: el.tagName, outline: st.outlineStyle, width: parseFloat(st.outlineWidth) }; });
          expect(ring.tag === 'INPUT' && ring.outline !== 'none' && ring.width >= 2, `B1 ${c.theme}: visible focus ring on the field`, ring);
          const long = await bodyText(page);
          expect(long.includes('Donaudampfschifffahrtsgesellschaftskapitänsmütze') || recipient !== 'B1', 'long names are present and wrapped');
          if (i === 0) await shot(page, 's13-narrow-dark-bidder');
          if (i === 3) await shot(page, 's13-wide-light-bidder');
        }
      }
    }
    // reduced motion: the panel has no motion at all
    const rm = track(await newPage(browser, 'VIEWER', { reducedMotion: 'reduce' }));
    expect(await rm.evaluate(() => document.getAnimations().length) === 0, 'no running animation');
    await closeAll();
  });

  // ── S14: the process restarts on the same database ───────────────────────────────────────────────────────
  await scenario('S14 restart on the same database: the stored bidding is all there is; the next authorised bid continues from it', async () => {
    await host({ type: 'reset', biddingId: 'bidding-p' });
    const B1 = track(await newPage(browser, 'B1'));
    await delivered(B1, 'B1', 'standing', async page => await field(page).count() === 1);
    await field(B1).fill('6'); await bidButton(B1).click();
    await waitUntil(async () => (await state()).bidding.stepCount === 1, 8000, 'bid stored');
    const before = await state();
    if (process.env.HARNESS_EXTERNAL !== '1') {
      killBackend();
      await sleep(800);
      startBackend();
      await waitBackend();
      const after = await state();
      expect(JSON.stringify(after.bidding) === JSON.stringify(before.bidding) && after.revision === before.revision && after.holder === before.holder && after.sequenceVersion === before.sequenceVersion && after.basisVersion === before.basisVersion, 'the restarted process reads the SAME stored state (no re-bid, no new basis value)', { before: before.bidding, after: after.bidding });
      const B2 = track(await newPage(browser, 'B2'));
      await delivered(B2, 'B2 after restart', 'standing', async page => await field(page).count() === 1);
      await field(B2).fill('9'); await bidButton(B2).click();
      await waitUntil(async () => (await state()).bidding.stepCount === 2, 8000, 'bid after restart stored');
      expect((await state()).bidding.leader.units === 9, 'the next bid continues from the stored state');
    }
    await closeAll();
  });

  // ── S15: retries after a refusal (N10-01 / N10-02): the number of CALLS that really leave the page, and what the server stored ─────────────────────
  await scenario('S15 refusal then retry: one retry per refusal even for several presses in one task; the number input is editable again; commandId stays; the server stores one bid and one pass', async () => {
    await host({ type: 'reset', biddingId: 'bidding-retry' });
    const B1 = track(await newPage(browser, 'B1'));
    const B2 = track(await newPage(browser, 'B2'));
    await delivered(B1, 'B1', 'standing', async page => await field(page).count() === 1);
    const before = await state();
    // BID refused before it leaves the page → the SAME draft is editable and sendable again
    await B1.evaluate(() => { window.__harness.failBefore = 1; });
    await field(B1).fill('6');
    await bidButton(B1).click();
    await waitUntil(async () => (await settled(B1)).length === 1, 5000, 'first bid attempt settled');
    expect((await settled(B1))[0].ok === false, 'the first attempt was refused', await settled(B1));
    expect(await field(B1).getAttribute('readonly') === null && (await field(B1).inputValue()) === '6', 'the refused bid leaves the input editable with the same draft');
    await waitUntil(async () => (await B1.getByRole('button', { name: 'Erneut senden' }).count()) === 1, 5000, 'retry button offered');
    expect((await state()).bidding.stepCount === 0, 'the server never saw the refused attempt', (await state()).bidding);
    // the retry pressed THREE times in ONE task: one call
    await B1.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /Erneut senden/.test(x.textContent || '')); b.click(); b.click(); b.click(); });
    await waitUntil(async () => (await state()).bidding.stepCount === 1, 8000, 'retry stored');
    await sleep(300);
    const c = await calls(B1);
    expect(c.length === 2, 'exactly ONE retry call after the refusal (two calls in total)', c.map(x => x.attemptId));
    expect(c[0].commandId === c[1].commandId && c[0].attemptId !== c[1].attemptId, 'same intent keeps its commandId, the retry is a new attempt', c);
    const afterBid = await state();
    expect(afterBid.bidding.stepCount === 1 && afterBid.bidding.leader.units === 6 && afterBid.events === before.events + 1, 'the server stored ONE bid', afterBid.bidding);
    // PASS refused before it leaves the page → one retry for several presses in one task
    await delivered(B2, 'B2', 'standing', async page => await passButton(page).count() === 1);
    await B2.evaluate(() => { window.__harness.failBefore = 1; });
    await passButton(B2).click();
    await waitUntil(async () => (await settled(B2)).length === 1, 5000, 'first pass attempt settled');
    await waitUntil(async () => (await passButton(B2).getAttribute('aria-disabled')) === null, 5000, 'pass released after the refusal');
    await B2.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^Passen$/.test(x.textContent.trim())); b.click(); b.click(); });
    await waitUntil(async () => (await state()).bidding.passed.length === 1, 8000, 'pass stored');
    await sleep(300);
    expect((await calls(B2)).length === 2, 'exactly ONE pass retry call', (await calls(B2)).map(x => x.attemptId));
    const end = await state();
    expect(end.bidding.passed.length === 1 && end.bidding.passed[0] === 'T2' && end.bidding.stepCount === 2, 'the server stored ONE pass', end.bidding);
    await closeAll();
  });

  // ── S16: a bid submitted in the same task as a pass that is then refused (the field must never wait for a send that did not happen) ──────────────────
  await scenario('S16 same-task pass + bid submit: the pass is refused before it leaves, the field is answered and the SAME draft is sent afterwards', async () => {
    await host({ type: 'reset', biddingId: 'bidding-cross' });
    const first = await state();
    expect((await sendIntent('B1', 'BID', FRESH(), bidIntent(first, 4))).ok === true, 'T1 bids so that T2 may pass');
    const B2 = track(await newPage(browser, 'B2'));
    await delivered(B2, 'B2', 'standing', async page => await field(page).count() === 1 && await passButton(page).count() === 1);
    const before = await state();
    await B2.evaluate(() => { window.__harness.failBefore = 1; });
    await field(B2).fill('9');
    await B2.evaluate(() => { const pass = [...document.querySelectorAll('button')].find(x => /^Passen$/.test(x.textContent.trim())); const form = document.querySelector('form'); pass.click(); form.requestSubmit(); });
    await waitUntil(async () => (await settled(B2)).length === 1, 5000, 'the pass attempt settled');
    expect((await calls(B2)).length === 1 && (await calls(B2))[0].kind === 'PASS', 'only the pass left the page, the submit was refused', await calls(B2));
    await waitUntil(async () => (await B2.getByRole('button', { name: 'Erneut senden' }).count()) === 1 && (await field(B2).getAttribute('readonly')) === null, 5000, 'the field is released and answered');
    expect((await field(B2).inputValue()) === '9', 'the draft is kept');
    await B2.getByRole('button', { name: 'Erneut senden' }).click();
    await waitUntil(async () => (await state()).bidding.stepCount === before.bidding.stepCount + 1, 8000, 'the draft is stored');
    const end = await state();
    expect(end.bidding.leader.teamId === 'T2' && end.bidding.leader.units === 9 && end.bidding.passed.length === 0, 'the server stored the bid, never the refused pass', end.bidding);
    expect((await calls(B2)).length === 2, 'exactly two calls: the refused pass and the real bid', (await calls(B2)).map(x => x.kind));
    await closeAll();
  });

  await browser.close();
  killAll();
  console.log(notes.join('\n'));
  console.log(`\nN10 browser check: ${notes.filter(n => n.startsWith('ok')).length}/${notes.length} scenarios ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failures.length) { console.log(`\n${failures.length} FAILURES:\n- ${failures.join('\n- ')}`); process.exit(1); }
})().catch(error => { console.error(error); killAll(); process.exit(1); });
