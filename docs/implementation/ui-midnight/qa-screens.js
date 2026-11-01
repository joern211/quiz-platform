// QA-Hilfsskript (nicht Teil von CI). Erwartet laufende Dev-Server (3001/5173) mit isolierter Seed-DB.
// Aufruf: node docs/implementation/ui-midnight/qa-screens.js <ausgabe> [dark|light] [lila|…] [desktop|laptop|tablet|mobile|w430|w320] [static,wd,jp,wid]
// Visual QA: real rooms, real roles, synthetic data. Usage:
//   node screens.cjs <outDir> [theme=dark|light] [accent=lila] [viewport=desktop|mobile|tablet|w320] [flows=static,wd,jp,wid]
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'http://localhost:5173';
const [outDir, theme = 'dark', accent = 'lila', vpName = 'desktop', flowArg = 'static,wd,jp,wid'] = process.argv.slice(2);
const flows = new Set(flowArg.split(','));
const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  laptop: { viewport: { width: 1280, height: 800 } },
  tablet: { viewport: { width: 768, height: 1024 }, hasTouch: true },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  w430: { viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  w320: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
fs.mkdirSync(outDir, { recursive: true });
const problems = [];

async function ctx(browser) {
  const c = await browser.newContext({ ...VIEWPORTS[vpName], reducedMotion: 'reduce' });
  await c.addInitScript(([t, a]) => {
    try {
      localStorage.setItem('quiz-theme', t);
      localStorage.setItem('quiz-appearance', JSON.stringify({ v: 1, theme: t, accent: a }));
    } catch { /* ignore */ }
  }, [theme, accent]);
  return c;
}
async function shot(page, name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) problems.push(`${name}: horizontal overflow ${overflow}px`);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: opts.full ?? true });
}
async function login(c) {
  const r = await c.request.post(`${BASE}/api/v1/auth/e2e-token`, { data: { userId: 'mod-1' } });
  if (r.status() !== 200) throw new Error('login ' + r.status());
}
async function join(page, code, name) {
  await page.goto(`${BASE}/beitreten`);
  await page.getByLabel('Anzeigename').fill(name);
  await page.getByLabel('Raumcode').fill(code);
  await page.getByRole('button', { name: 'Beitreten' }).click();
  await page.waitForURL(new RegExp(`/raum/${code}/lobby$`));
}
async function ready(page) {
  await page.getByRole('button', { name: 'Ich bin bereit!' }).click();
  await page.getByRole('button', { name: 'Nicht mehr bereit' }).waitFor();
}

async function staticPages(browser) {
  const c = await ctx(browser); const p = await c.newPage();
  for (const [name, url] of [['home', '/'], ['kategorien', '/kategorien'], ['kategorie-wissen', '/kategorie/wissen'], ['spiel-wissensduell', '/spiel/wissensduell'], ['beitreten', '/beitreten'], ['zuschauen', '/zuschauen'], ['anmelden', '/moderator/anmelden'], ['404', '/gibt-es-nicht']]) {
    await p.goto(BASE + url); await shot(p, `static-${name}`);
  }
  // mobile menu
  const toggle = p.getByRole('button', { name: /Menü öffnen/ });
  if (await toggle.isVisible().catch(() => false)) { await p.goto(BASE + '/'); await toggle.click(); await shot(p, 'static-menu-open', { full: false }); }
  // settings dialog if present
  await p.goto(BASE + '/');
  const settings = p.getByRole('button', { name: /Darstellung/ }).first();
  if (await settings.isVisible().catch(() => false)) { await settings.click(); await shot(p, 'static-settings', { full: false }); await p.keyboard.press('Escape'); }
  else if (await toggle.isVisible().catch(() => false)) {
    await toggle.click(); const s2 = p.getByRole('button', { name: /Darstellung/ }).first();
    if (await s2.isVisible().catch(() => false)) { await s2.click(); await shot(p, 'static-settings', { full: false }); await p.keyboard.press('Escape'); }
  }
  await login(c);
  for (const [name, url] of [['raeume', '/moderator/raeume'], ['setup-wissensduell', '/moderator/vorbereitung/wissensduell'], ['setup-jeopardy', '/moderator/vorbereitung/jeopardy'], ['setup-wer-ist-das', '/moderator/vorbereitung/wer-ist-das'], ['schnellstart', '/moderator/schnellstart/wissensduell'], ['inhalte', '/inhalte'], ['profil', '/spieler/profil'], ['admin', '/admin']]) {
    await p.goto(BASE + url); await p.waitForTimeout(500); await shot(p, `static-${name}`);
  }
  await c.close();
}

async function wissensduell(browser) {
  const hc = await ctx(browser), ac = await ctx(browser), bc = await ctx(browser), vc = await ctx(browser);
  await login(hc);
  const created = await hc.request.post(`${BASE}/api/v1/rooms`, { data: { gameSlug: 'wissensduell', roomName: 'Midnight QA Wissensduell', viewerRequiresPin: false, idempotencyKey: crypto.randomUUID(), setupSnapshotJson: { questionCount: 3 } } });
  const code = (await created.json()).data.code;
  const h = await hc.newPage(), a = await ac.newPage(), b = await bc.newPage(), v = await vc.newPage();
  await h.goto(`${BASE}/moderator/raum/${code}/lobby`);
  await join(a, code, 'Alexandra Mustermann-Langname'); await join(b, code, 'Bo');
  await v.goto(`${BASE}/zuschauen/${code}/lobby`);
  await shot(a, 'wd-player-lobby');
  await ready(a); await ready(b);
  await shot(h, 'wd-host-lobby'); await shot(v, 'wd-viewer-lobby');
  let d = null;
  try {
    const media = h.getByRole('region', { name: 'Live-Medien' });
    await media.getByRole('button', { name: 'Display-Link erzeugen', exact: true }).click();
    const link = await media.getByLabel('Display-Link (12 Stunden)', { exact: true }).inputValue();
    d = await (await ctx(browser)).newPage(); await d.goto(link);
  } catch (e) { problems.push('display link: ' + e.message.split('\n')[0]); }
  await Promise.all([h.waitForURL(/\/spiel$/), a.waitForURL(/\/spiel$/), h.getByRole('button', { name: 'Spiel starten' }).click()]);
  await h.getByRole('button', { name: /Auflösen/ }).waitFor();
  await a.waitForTimeout(800);
  await shot(a, 'wd-player-question'); await shot(h, 'wd-host-question'); await shot(v, 'wd-viewer-question');
  if (d) { await d.waitForTimeout(2500); await shot(d, 'wd-display-question'); }
  const opt = a.getByRole('button', { name: /Antwort A|^A\b/ }).first();
  if (await opt.isVisible().catch(() => false)) { await opt.click(); await a.waitForTimeout(500); await shot(a, 'wd-player-answered'); }
  await h.getByRole('button', { name: /Auflösen/ }).click(); await h.waitForTimeout(800);
  await shot(h, 'wd-host-reveal'); await shot(a, 'wd-player-reveal'); await shot(b, 'wd-player2-reveal'); await shot(v, 'wd-viewer-reveal');
  await h.getByRole('button', { name: 'Spiel beenden' }).click();
  const confirm = h.getByRole('alertdialog').getByRole('button', { name: 'Spiel beenden' });
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) { await shot(h, 'wd-host-end-confirm', { full: false }); await confirm.click(); }
  await h.waitForURL(/ergebnis$/); await h.waitForTimeout(1200);
  await a.waitForURL(/ergebnis$/).catch(() => {}); await a.waitForTimeout(800);
  await shot(h, 'wd-host-result'); await shot(a, 'wd-player-result'); await shot(v, 'wd-viewer-result');
  await Promise.allSettled([hc.close(), ac.close(), bc.close(), vc.close()]);
}

function board() {
  const cats = ['Geschichte', 'Wissenschaft', 'Geografie', 'Sport', 'Kunst', 'Musik'];
  const mk = f => ({ categories: cats.map((title, ci) => ({ title, clues: [100, 200, 300, 400, 500].map((base, vi) => ({ value: base * f, question: `Frage ${ci + 1}-${vi + 1}: Welche Stadt liegt am längsten Fluss dieser Kategorie?`, answer: `Antwort ${ci + 1}-${vi + 1}`, type: 'text' })) })) });
  return { meta: { version: 1, exportedAt: new Date().toISOString() }, board1: mk(1), board2: mk(2) };
}
async function jeopardy(browser) {
  const hc = await ctx(browser), ac = await ctx(browser), bc = await ctx(browser), vc = await ctx(browser);
  await login(hc);
  const h = await hc.newPage(), a = await ac.newPage(), b = await bc.newPage(), v = await vc.newPage();
  await h.goto(`${BASE}/moderator/vorbereitung/jeopardy`);
  await h.locator('input[type="file"]').setInputFiles({ name: 'qa.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(board())) });
  await h.getByRole('button', { name: 'Geschichte' }).waitFor();
  await shot(h, 'jp-host-setup-filled');
  await h.getByRole('button', { name: 'Raum erstellen' }).click();
  await h.waitForURL(/\/lobby$/, { timeout: 20000 });
  const code = h.url().match(/(\d{3}-\d{3})\/lobby$/)[1];
  await join(a, code, 'Alexandra Mustermann-Langname'); await join(b, code, 'Bo');
  await ready(a); await ready(b);
  await v.goto(`${BASE}/zuschauen/${code}/lobby`);
  await shot(h, 'jp-host-lobby');
  await h.getByRole('button', { name: 'Spiel starten' }).click();
  await h.waitForURL(/jeopardy$/, { timeout: 20000 });
  await h.getByRole('gridcell', { name: /100 Punkte/ }).first().waitFor();
  await a.waitForTimeout(1200); await v.waitForTimeout(500);
  await shot(h, 'jp-host-board'); await shot(a, 'jp-player-board'); await shot(v, 'jp-viewer-board');
  await h.locator('[data-category-index="0"][data-value="200"]').click(); await h.waitForTimeout(800);
  await shot(h, 'jp-host-question'); await shot(a, 'jp-player-question'); await shot(v, 'jp-viewer-question');
  const buzz = a.getByRole('button', { name: /JETZT BUZZEN|BUZZ/i }).first();
  if (await buzz.isVisible({ timeout: 4000 }).catch(() => false)) { await buzz.click(); await a.waitForTimeout(800); await shot(a, 'jp-player-buzzed'); await shot(h, 'jp-host-judge'); await shot(b, 'jp-player2-locked'); }
  const right = h.getByRole('button', { name: /RICHTIG/i });
  if (await right.isVisible({ timeout: 4000 }).catch(() => false)) { await right.click(); await h.waitForTimeout(800); await shot(h, 'jp-host-after-judge'); await shot(a, 'jp-player-after-judge'); }
  await Promise.allSettled([hc.close(), ac.close(), bc.close(), vc.close()]);
}

const PNG = ['iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP8zwAFTAyYLAAdWwEFNX6VDAAAAABJRU5ErkJggg==', 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAF0lEQVR4nGNkYPjPwMDAwMDAxAADCBYAG10BBdmz9y8AAAAASUVORK5CYII='];
async function wid(browser) {
  const hc = await ctx(browser), ac = await ctx(browser), bc = await ctx(browser), vc = await ctx(browser);
  await login(hc);
  const h = await hc.newPage(), a = await ac.newPage(), b = await bc.newPage(), v = await vc.newPage();
  await h.goto(`${BASE}/moderator/vorbereitung/wer-ist-das`);
  await h.getByRole('button', { name: 'Runde hinzufügen' }).click();
  for (let i = 0; i < 2; i++) {
    await h.locator('input[type="file"]').nth(i * 2).setInputFiles({ name: `a${i}.png`, mimeType: 'image/png', buffer: Buffer.from(PNG[i % 2], 'base64') });
    await h.locator('input[type="file"]').nth(i * 2 + 1).setInputFiles({ name: `b${i}.png`, mimeType: 'image/png', buffer: Buffer.from(PNG[(i + 1) % 2], 'base64') });
    await h.getByText(`Bild B: b${i}.png`).waitFor();
  }
  await h.getByLabel('Name A').nth(0).fill('Testperson Eins'); await h.getByLabel('Name B').nth(0).fill('Testperson Zwei');
  await h.getByLabel('Name A').nth(1).fill('Testperson Drei'); await h.getByLabel('Name B').nth(1).fill('Testperson Vier');
  for (let i = 0; i < 2; i++) { await h.getByRole('button', { name: 'Spielbild aus beiden Bildern erzeugen' }).first().click(); await h.getByRole('img', { name: 'Vorschau des Spielbilds' }).nth(i).waitFor(); }
  await shot(h, 'wid-host-setup-filled');
  await h.getByRole('button', { name: 'Raum erstellen' }).click(); await h.waitForURL(/\/lobby$/);
  const code = h.url().match(/(\d{3}-\d{3})\/lobby$/)[1];
  await join(a, code, 'Alexandra Mustermann-Langname'); await join(b, code, 'Bo'); await ready(a); await ready(b);
  await v.goto(`${BASE}/zuschauen/${code}/lobby`);
  await h.getByRole('button', { name: 'Spiel starten' }).click();
  await h.waitForURL(/wer-ist-das$/); await a.waitForURL(/wer-ist-das\/spiel/); await v.waitForURL(/zuschauer/).catch(() => {});
  await a.waitForTimeout(1000);
  await shot(h, 'wid-host-round'); await shot(a, 'wid-player-round'); await shot(v, 'wid-viewer-round');
  await h.getByRole('button', { name: 'Buzzer öffnen' }).click(); await a.waitForTimeout(600);
  await shot(a, 'wid-player-buzzer-open');
  await a.getByRole('button', { name: 'BUZZERN' }).click(); await a.waitForTimeout(600);
  await shot(a, 'wid-player-buzzed'); await shot(b, 'wid-player2-waiting'); await shot(h, 'wid-host-judge');
  await h.getByRole('button', { name: 'Falsch · −1' }).click(); await a.waitForTimeout(600); await shot(a, 'wid-player-locked');
  await h.getByRole('button', { name: 'Buzzer öffnen' }).click(); await b.getByRole('button', { name: 'BUZZERN' }).click();
  await h.getByRole('button', { name: 'Hinweis aktivieren' }).click(); await h.waitForTimeout(400);
  await h.getByRole('button', { name: 'Eine richtig · +1' }).click(); await h.waitForTimeout(800);
  await shot(v, 'wid-viewer-reveal'); await shot(h, 'wid-host-reveal');
  await h.getByRole('button', { name: 'Nächste Runde' }).click(); await h.getByRole('button', { name: 'Buzzer öffnen' }).click();
  await a.getByRole('button', { name: 'BUZZERN' }).click(); await h.getByRole('button', { name: 'Beide richtig · +3' }).click();
  await h.getByRole('button', { name: 'Ergebnis anzeigen' }).click(); await v.waitForTimeout(1200);
  await shot(v, 'wid-viewer-result'); await shot(a, 'wid-player-result'); await shot(h, 'wid-host-result');
  await Promise.allSettled([hc.close(), ac.close(), bc.close(), vc.close()]);
}

(async () => {
  const browser = await chromium.launch();
  const run = async (n, f) => { if (!flows.has(n)) return; try { await f(browser); } catch (e) { problems.push(`${n} FAILED: ${e.message.split('\n')[0]}`); } };
  await run('static', staticPages); await run('wd', wissensduell); await run('jp', jeopardy); await run('wid', wid);
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'problems.txt'), problems.join('\n'));
  console.log(problems.length ? problems.join('\n') : 'no problems');
})();
