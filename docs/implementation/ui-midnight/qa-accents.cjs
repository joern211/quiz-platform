const { chromium } = require('playwright');
const out = process.argv[2];
const ACC = ['lila','blau','tuerkis','gruen','orange','rosa'];
(async () => { const b = await chromium.launch();
  for (const theme of ['dark','light']) for (const accent of ACC) {
    const c = await b.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    await c.addInitScript(([t,a]) => localStorage.setItem('quiz-appearance', JSON.stringify({v:1,theme:t,accent:a})), [theme, accent]);
    const p = await c.newPage(); await p.goto('http://localhost:5173/'); await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/home-${theme}-${accent}.png`, clip: { x: 0, y: 0, width: 1100, height: 560 } });
    await p.getByRole('button', { name: /Darstellung/ }).click(); await p.waitForTimeout(300);
    await p.keyboard.press('Tab'); // Fokusring sichtbar
    await p.screenshot({ path: `${out}/settings-${theme}-${accent}.png` });
    await c.close();
  } await b.close(); })();
