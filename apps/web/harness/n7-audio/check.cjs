/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- CommonJS test tool: Node `require`/`process` and browser globals inside page.evaluate */
// TEST-ONLY browser check for the N7 ServerAudioPlayer harness: REAL Chromium, REAL HTMLAudioElements, deterministic tones (440 / 660 Hz)
// normalised by the real server audio pipeline (ffmpeg). It is NOT a Safari / iPhone / production-network test.
// Usage: node apps/web/harness/n7-audio/check.cjs [outDir]       (starts the harness backend and vite itself; HARNESS_EXTERNAL=1 uses running ones)
// Every expectation is ASSERTED: any miss is collected in `failures` and the process exits with status 1.
//
// What is measured (never a label alone): media.paused / currentTime / readyState of the live audio elements, the signal level and
// frequency at the output of an AnalyserNode, and the server plan (server helpers) evaluated at the same server instant.
//
// Autoplay: Playwright's page.evaluate carries a user gesture, so the context that must meet the autoplay block never runs evaluate or
// click before the block was observed (it is observed with locator reads and by waiting in Node).
const { spawn } = require('node:child_process');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('@playwright/test')); }
const outDir = process.argv[2];
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:5197';
/** Position tolerance (ms) for "the media is where the server plan is" / "two contexts agree": see acceptance.md for the measured values. */
const TOL_MS = Number(process.env.N7_TOL_MS || 500);
const failures = [];
const measured = { maxPlanDeviationMs: 0, maxCrossContextMs: 0, samples: 0 };
const expect = (cond, message, detail) => { if (!cond) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cmd = body => fetch(`${BASE}/api/cmd`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const stats = () => fetch(`${BASE}/api/stats`).then(r => r.json());
const serverNow = () => fetch(`${BASE}/api/time`).then(r => r.json()).then(j => j.serverMs);

/** The plan evaluated by the same rule as the shared helper (RUNNING: clamp(pos + max(0, now - anchor)); frozen otherwise). */
function planTarget(state, now) {
  if (state.status === 'RUNNING') return Math.min(state.durationMs, Math.max(0, state.positionMs + Math.max(0, now - state.anchorServerMs)));
  return state.status === 'ENDED' ? state.durationMs : state.positionMs;
}
async function waitUntil(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) { failures.push(`timeout: ${label}`); return false; }
    await sleep(60);
  }
}
const live = entries => entries.filter(e => e.src !== null);
const statusOf = page => page.locator('[data-status]').getAttribute('data-status');
async function probe(page) { return page.evaluate(() => window.__probe()); }
/** Probe + plan target at the SAME server instant (midpoint of the evaluate round trip). */
async function measure(page) {
  const t0 = await serverNow();
  const entries = live(await probe(page));
  const t1 = await serverNow();
  const s = (await stats()).state;
  return { entries, target: planTarget(s, Math.round((t0 + t1) / 2)), state: s, jitter: t1 - t0 };
}
/** The analyser window is ~85 ms: right after playback began it can still be (nearly) silent, so the signal is polled for up to 2 s. */
async function expectSignal(label, page, freq = 440) {
  let last = null;
  const ok = await waitUntil(async () => { last = live(await probe(page))[0]; return last && last.rms !== null && last.rms > 0.02 && last.freqHz !== null && Math.abs(last.freqHz - freq) < 40; }, 2000, `${label}: audible ~${freq} Hz signal (last ${JSON.stringify(last)})`);
  return ok;
}
function checkOnPlan(label, m, extra = {}) {
  const e = m.entries[0];
  if (!e) { failures.push(`${label}: no live audio element`); return null; }
  const dev = Math.abs(e.currentTimeMs - m.target);
  measured.maxPlanDeviationMs = Math.max(measured.maxPlanDeviationMs, dev); measured.samples++;
  expect(dev <= TOL_MS, `${label}: media position ${e.currentTimeMs} ms is ${dev} ms from the plan target ${m.target} ms (tolerance ${TOL_MS})`);
  expect(e.paused === false, `${label}: element must be playing`, e);
  expect(e.readyState >= 3, `${label}: element needs data to play`, e.readyState);
  if (extra.signal !== false) {
    expect(e.rms !== null && e.rms > 0.02, `${label}: no audible signal at the analyser`, e.rms);
    const f = extra.freq ?? 440;
    expect(e.freqHz !== null && Math.abs(e.freqHz - f) < 40, `${label}: expected ~${f} Hz`, e.freqHz);
  }
  return e;
}
async function newPage(browser, query, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 480, height: 800 } });
  if (opts.theme) await ctx.addInitScript(([t, a]) => localStorage.setItem('quiz-appearance', JSON.stringify({ v: 1, theme: t, accent: a })), [opts.theme, opts.accent || 'lila']);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(`${BASE}/?${query}`);
  return page;
}

async function startChildren() {
  if (process.env.HARNESS_EXTERNAL === '1') return [];
  const root = path.resolve(__dirname, '../../../..');
  const env = { ...process.env, SESSION_SECRET: process.env.SESSION_SECRET || 'n7-harness-secret-n7-harness-secret-1' };
  const backend = spawn(process.execPath, ['--import', 'tsx', 'apps/web/harness/n7-audio/server.ts', '5196'], { cwd: root, env, stdio: 'ignore' });
  const vite = spawn('pnpm', ['--filter', '@quiz/web', 'exec', 'vite', '--config', 'harness/n7-audio/vite.config.ts'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/api/stats`)).ok) return [backend, vite]; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('harness did not start');
}

(async () => {
  const children = await startChildren();
  const browser = await chromium.launch();
  const t0 = Date.now();

  // ── S1: two contexts, one plan: scheduled start, late join, pause, resume, withdrawal, stop ───────────────────────────────
  await cmd({ type: 'reset' });
  const clipMs = (await stats()).clips['clip-a'].durationMs;
  expect(clipMs === 12000, 'the real pipeline reported a trusted 12 s duration', clipMs);
  const A = await newPage(browser, 'role=PLAYER&gate=1&analyse=1');
  await A.click('[data-action=join]');
  await waitUntil(async () => (await statusOf(A)) === 'NOT_STARTED', 5000, 'A: NOT_STARTED before the start');
  expect((await A.locator('[data-status]').innerText()).includes('noch nicht begonnen'), 'A: neutral text before the start');
  const startIssued = await serverNow();
  await cmd({ type: 'start', leadMs: 3000 });
  const anchor = (await stats()).state.anchorServerMs;
  // nothing audible before the anchor (sampled every ~120 ms)
  let early = 0, earlySamples = 0;
  while ((await serverNow()) < anchor - 150) {
    const e = live(await probe(A)); earlySamples++;
    if (e.some(x => !x.paused || x.currentTimeMs > 0 && x.rms > 0.01)) early++;
    await sleep(120);
  }
  expect(earlySamples >= 10 && early === 0, 'A: audible or running before the anchor', { early, earlySamples });
  expect(['WAITING_FOR_START', 'LOADING'].includes(await statusOf(A)), 'A: status before the anchor', await statusOf(A));
  await waitUntil(async () => (await statusOf(A)) === 'PLAYING', 4000, 'A: PLAYING after the anchor');
  checkOnPlan('A at start', await measure(A), { signal: false });
  await expectSignal('A at start', A);
  expect((await measure(A)).entries[0].currentTimeMs < 1500, 'A: started from the beginning of the clip, not from a later position');
  expect(startIssued > 0, 'sanity');

  // late join: B arrives 2.5 s after the anchor and must land on the CURRENT position, not on 0
  await sleep(Math.max(0, anchor + 2500 - await serverNow()));
  const B = await newPage(browser, 'role=VIEWER&gate=1&analyse=1');
  await B.click('[data-action=join]');
  await waitUntil(async () => (await statusOf(B)) === 'PLAYING', 6000, 'B: PLAYING after late join');
  const bFirst = await measure(B);
  expect(bFirst.entries[0] && bFirst.entries[0].currentTimeMs > 2000, 'B: a late join must jump to the current position, not start at 0', bFirst.entries[0] && bFirst.entries[0].currentTimeMs);
  // let drift correction settle, then compare both against the plan and against each other
  await sleep(1500);
  for (let i = 0; i < 6; i++) {
    const [ma, mb] = [await measure(A), await measure(B)];
    const ea = checkOnPlan('A playing', ma), eb = checkOnPlan('B playing', mb);
    if (ea && eb) { const d = Math.abs(ea.currentTimeMs - eb.currentTimeMs - (ma.target - mb.target)); measured.maxCrossContextMs = Math.max(measured.maxCrossContextMs, d); expect(d <= TOL_MS, `A and B disagree by ${d} ms`); }
    await sleep(350);
  }

  // pause: both elements stop and hold the plan position
  await cmd({ type: 'pause' });
  const pausedPos = (await stats()).state.positionMs;
  await waitUntil(async () => (await Promise.all([A, B].map(async p => live(await probe(p)).every(e => e.paused)))).every(Boolean), 3000, 'A and B paused');
  await waitUntil(async () => (await statusOf(A)) === 'PAUSED' && (await statusOf(B)) === 'PAUSED', 3000, 'PAUSED status');
  const frozen = [await measure(A), await measure(B)];
  await sleep(1500);
  const frozen2 = [await measure(A), await measure(B)];
  for (let i = 0; i < 2; i++) {
    const a = frozen[i].entries[0].currentTimeMs, b = frozen2[i].entries[0].currentTimeMs;
    expect(Math.abs(a - b) < 60, `context ${i}: position moved while paused`, [a, b]);
    expect(Math.abs(b - pausedPos) <= TOL_MS, `context ${i}: paused position ${b} is not the plan's ${pausedPos}`);
  }

  // resume after a pause: scheduled 1.5 s ahead; nothing audible early, then continues FROM the stored position (never 0)
  await cmd({ type: 'resume', leadMs: 1500 });
  const resumeAnchor = (await stats()).state.anchorServerMs;
  await sleep(600);
  const quiet = (await Promise.all([A, B].map(async p => live(await probe(p)).every(e => e.paused)))).every(Boolean);
  expect(quiet, 'resume: an element is audible/running before the new anchor');
  await sleep(Math.max(0, resumeAnchor + 800 - await serverNow()));
  await waitUntil(async () => (await statusOf(A)) === 'PLAYING' && (await statusOf(B)) === 'PLAYING', 4000, 'PLAYING after resume');
  await sleep(800);
  for (const [name, p] of [['A resumed', A], ['B resumed', B]]) { const m = await measure(p); const e = checkOnPlan(name, m); if (e) expect(e.currentTimeMs > pausedPos - 200, `${name}: restarted before the stored position ${pausedPos}`, e.currentTimeMs); }

  // withdrawal for the player only: its media is silenced and released at once, the viewer keeps playing; re-release plays the CURRENT position
  await cmd({ type: 'release', role: 'PLAYER', release: 'NONE' });
  await waitUntil(async () => live(await probe(A)).length === 0, 3000, 'A: element released after withdrawal');
  expect((await A.locator('section').innerText()).includes('nicht verfügbar'), 'A: neutral text after withdrawal');
  expect(!(await A.content()).match(/harness-media|tok=/), 'A: no source in the DOM after withdrawal');
  expect((await probe(A)).every(e => e.paused), 'A: no element keeps playing after withdrawal', await probe(A));
  checkOnPlan('B during A withdrawal', await measure(B));
  await cmd({ type: 'release', role: 'PLAYER', release: 'PLAY' });
  await waitUntil(async () => (await statusOf(A)) === 'PLAYING', 6000, 'A: PLAYING after re-release');
  await sleep(1000);
  checkOnPlan('A after re-release', await measure(A));

  // stop: terminal; both stay silent and do not restart
  await cmd({ type: 'stop' });
  await waitUntil(async () => (await statusOf(A)) === 'STOPPED' && (await statusOf(B)) === 'STOPPED', 3000, 'STOPPED status');
  await sleep(1500);
  for (const p of [A, B]) expect(live(await probe(p)).every(e => e.paused), 'stopped: an element is playing', await probe(p));
  const s1 = await stats();
  expect(s1.resolverCalls.PLAYER > 0 && s1.resolverCalls.VIEWER > 0, 'resolver used for released audiences', s1.resolverCalls);
  expect(A.errors.length === 0 && B.errors.length === 0, 'S1 page errors', [A.errors, B.errors]);
  await A.context().close(); await B.context().close();

  // ── S1b: host-private audio is not delivered to a blind host; no URL is resolved for it; it plays once the sound is public ────
  await cmd({ type: 'reset' });
  await cmd({ type: 'visibility', scope: 'HOST_PRIVATE' });
  const H = await newPage(browser, 'role=HOST&gate=1&analyse=1'), BH = await newPage(browser, 'role=BLIND_HOST&gate=1&analyse=1');
  await H.click('[data-action=join]'); await BH.click('[data-action=join]');
  await cmd({ type: 'start', leadMs: 800 });
  await waitUntil(async () => (await statusOf(H)) === 'PLAYING', 6000, 'HOST plays the host-private clip');
  await sleep(1200);
  expect((await BH.evaluate(() => window.__recs.length)) === 0, 'BLIND_HOST: not even an audio object was created');
  expect((await statusOf(BH)) === 'UNAVAILABLE', 'BLIND_HOST: neutral state', await statusOf(BH));
  const s2 = await stats();
  expect(!s2.resolverCalls.BLIND_HOST && s2.resolverCalls.HOST > 0, 'no URL was resolved for the blind host', s2.resolverCalls);
  expect(!(await BH.content()).match(/harness-media|tok=/), 'BLIND_HOST: no source in the DOM');
  await cmd({ type: 'visibility', scope: 'PUBLIC' }); // the reveal phase: now everybody may hear it
  await waitUntil(async () => (await statusOf(BH)) === 'PLAYING', 6000, 'BLIND_HOST plays once the sound is public');
  checkOnPlan('BLIND_HOST after reveal', await measure(BH), { signal: false });
  await expectSignal('BLIND_HOST after reveal', BH);
  expect(H.errors.length === 0 && BH.errors.length === 0, 'S1b page errors', [H.errors, BH.errors]);
  await H.context().close(); await BH.context().close();

  // ── S2: autoplay refusal, understood and answered by a REAL keyboard gesture ────────────────────────────────────────────────
  await cmd({ type: 'reset' });
  const P = await newPage(browser, 'role=VIEWER&analyse=0'); // no gate, no click, no evaluate before the block is observed
  await sleep(1200);
  await cmd({ type: 'start', leadMs: 800 });
  await sleep(3200); // Node waits; the page meets its start time alone
  const blockedStatus = await statusOf(P);
  expect(blockedStatus === 'AUTOPLAY_BLOCKED', 'autoplay: Chromium must refuse play() without user activation and the UI must say so', blockedStatus);
  if (blockedStatus === 'AUTOPLAY_BLOCKED') {
    const text = await P.locator('section').innerText();
    expect(/blockiert das automatische Abspielen/.test(text) && /Audio aktivieren/.test(text), 'autoplay: understandable text and action', text);
    expect(live(await probe(P)).every(e => e.paused), 'autoplay: the element must not play while blocked');
    await P.keyboard.press('Tab'); // the action is the only focusable element on this page
    const focused = await P.evaluate(() => document.activeElement && document.activeElement.textContent);
    expect(focused === 'Audio aktivieren', 'autoplay: the action is reachable by keyboard', focused);
    await P.keyboard.press('Enter'); // a real key press is a user activation
    await waitUntil(async () => (await statusOf(P)) === 'PLAYING', 4000, 'autoplay: PLAYING after the user action');
    const m = await measure(P);
    const e = checkOnPlan('autoplay after activation', m, { signal: false });
    if (e) expect(e.currentTimeMs > 1500, 'autoplay: the gesture must not restart the clip; it joins the current plan position', e.currentTimeMs);
  }
  expect(P.errors.length === 0, 'S2 page errors', P.errors);
  await P.context().close();

  // ── S3: URL renewal for the same clip keeps the plan (new resource, continues at the current position) ───────────────────────
  await cmd({ type: 'reset' });
  const R = await newPage(browser, 'role=VIEWER&gate=1&analyse=1');
  await R.click('[data-action=join]');
  await cmd({ type: 'start', leadMs: 500 });
  await waitUntil(async () => (await statusOf(R)) === 'PLAYING', 6000, 'S3: PLAYING');
  await sleep(2500);
  const before = live(await probe(R))[0], versionBefore = (await stats()).state.version;
  await cmd({ type: 'renew' });
  await waitUntil(async () => { const l = live(await probe(R)); return l.length === 1 && l[0].index !== before.index && /tok=2/.test(l[0].src); }, 4000, 'S3: element swapped for the renewed URL');
  expect(live(await probe(R)).length === 1, 'S3: exactly one live element');
  expect((await probe(R)).find(e => e.index === before.index).paused, 'S3: the old element is silent');
  await waitUntil(async () => (await statusOf(R)) === 'PLAYING', 4000, 'S3: PLAYING again');
  await sleep(800);
  const renewed = checkOnPlan('S3 after renewal', await measure(R));
  if (renewed) expect(renewed.currentTimeMs > before.currentTimeMs, 'S3: renewal must not restart the clip', [before.currentTimeMs, renewed.currentTimeMs]);
  expect((await stats()).state.version === versionBefore, 'S3: a renewed URL creates no new plan version');
  expect(R.errors.length === 0, 'S3 page errors', R.errors);
  await R.context().close();

  // ── S4: a media failure is local; retry reloads the same plan and asks for a fresh URL ──────────────────────────────────────
  await cmd({ type: 'reset' });
  await cmd({ type: 'break' });
  const E = await newPage(browser, 'role=VIEWER&gate=1&analyse=1');
  await E.click('[data-action=join]');
  await cmd({ type: 'start', leadMs: 300 });
  await waitUntil(async () => (await statusOf(E)) === 'ERROR', 6000, 'S4: ERROR for the unavailable media');
  const errText = await E.locator('section').innerText();
  expect(/nicht geladen werden/.test(errText) && !/404|harness-media|tok=|http/.test(errText), 'S4: neutral error text', errText);
  const versionAtError = (await stats()).state.version;
  await sleep(2200); // the plan keeps running while the user hesitates; the retry must join it, not restart
  await E.getByRole('button', { name: 'Erneut laden' }).click();
  await waitUntil(async () => (await statusOf(E)) === 'PLAYING', 8000, 'S4: PLAYING after retry');
  await sleep(800);
  const retried = checkOnPlan('S4 after retry', await measure(E));
  if (retried) expect(retried.currentTimeMs > 2200, 'S4: retry continues at the plan position, not at 0', retried.currentTimeMs);
  expect((await E.evaluate(() => window.__renewCalls)) >= 1, 'S4: the application was asked for a fresh URL');
  expect((await stats()).state.version === versionAtError, 'S4: a local failure and retry changed nothing in the server plan');
  await E.context().close();

  // ── S5: layout in the blocked state and the error state: desktop and 320 px, dark and light, long German text, keyboard ────────
  const label = 'Ein sehr langer Titel für das Audio zur aktuellen Runde ohne jede Leerstelle: Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichen';
  let combos = 0;
  for (const width of [320, 390, 1280]) for (const theme of ['dark', 'light']) {
    await cmd({ type: 'reset' });
    const L = await newPage(browser, `role=VIEWER&label=${encodeURIComponent(label)}`, { width, theme, accent: theme === 'dark' ? 'lila' : 'orange' });
    await sleep(900);
    await cmd({ type: 'start', leadMs: 500 });
    await sleep(2600);
    const st = await statusOf(L);
    expect(st === 'AUTOPLAY_BLOCKED', `layout ${width}/${theme}: blocked state expected`, st);
    const m = await L.evaluate(() => {
      const root = document.documentElement, btn = document.querySelector('button'), sec = document.querySelector('section');
      const r = btn ? btn.getBoundingClientRect() : null, s = sec.getBoundingClientRect();
      return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, btnRight: r && r.right, btnWidth: r && r.width, btnHeight: r && r.height, secRight: s.right, secScroll: sec.scrollWidth, secClient: sec.clientWidth,
        clipped: [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > root.clientWidth + 0.5).length, theme: root.dataset.theme };
    });
    const tag = `${width}/${theme}`;
    expect(m.theme === theme, `${tag}: theme applied`, m.theme);
    expect(m.scrollWidth <= m.clientWidth, `${tag}: horizontal overflow`, m);
    expect(m.clipped === 0, `${tag}: clipped elements`, m.clipped);
    expect(m.btnRight !== null && m.btnRight <= m.clientWidth && m.btnHeight >= 44 && m.btnWidth >= 44, `${tag}: the action must be fully visible and at least 44 px`, m);
    expect(m.secScroll <= m.secClient + 1, `${tag}: card content overflows`, m);
    expect(L.errors.length === 0, `${tag}: page errors`, L.errors);
    if (outDir && ((width === 320 && theme === 'dark') || (width === 1280 && theme === 'light'))) await L.screenshot({ path: `${outDir}/n7-blocked-${width}-${theme}.png`, fullPage: true });
    combos++;
    await L.context().close();
  }
  // error state at 320 px, light
  await cmd({ type: 'reset' }); await cmd({ type: 'break' });
  const LE = await newPage(browser, `role=VIEWER&gate=1&label=${encodeURIComponent(label)}`, { width: 320, theme: 'light' });
  await LE.click('[data-action=join]'); await cmd({ type: 'start', leadMs: 300 });
  await waitUntil(async () => (await statusOf(LE)) === 'ERROR', 6000, 'layout: ERROR state');
  const me = await LE.evaluate(() => { const r = document.documentElement; const b = [...document.querySelectorAll('button')].find(x => /Erneut laden/.test(x.textContent)); const br = b.getBoundingClientRect(); return { sw: r.scrollWidth, cw: r.clientWidth, right: br.right, h: br.height }; });
  expect(me.sw <= me.cw && me.right <= me.cw && me.h >= 44, 'layout error state at 320 px', me);
  if (outDir) await LE.screenshot({ path: `${outDir}/n7-error-320-light.png`, fullPage: true });
  await LE.context().close();

  await browser.close();
  for (const c of children) c.kill('SIGTERM');
  const summary = { seconds: Math.round((Date.now() - t0) / 1000), toleranceMs: TOL_MS, measured, layoutCombos: combos, problems: failures.length };
  console.log(JSON.stringify(summary));
  if (failures.length) { console.log('FAILURES:\n' + failures.slice(0, 30).join('\n')); process.exit(1); }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(2); });
