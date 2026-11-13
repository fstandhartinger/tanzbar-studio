// Runs on LeChonk: renders one page area before/after a DOM patch. stdin: {url, selector, js, device}; stdout: {images:[{label,b64}]}.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const job = JSON.parse(fs.readFileSync(0, 'utf8'));
const exe = process.env.CHROME_PATH;
const mobile = job.device === 'mobile';
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const p = await b.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: mobile ? 2 : 1 });
  await p.goto(job.url, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(4200); // entrance animations
  const box = async () => p.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : null;
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + scrollY, w: r.width, h: r.height };
  }, job.selector || '');
  const shot = async () => {
    const r = await box();
    const W = mobile ? 390 : 1440;
    let clip;
    if (r && r.h > 10) {
      const pad = 36, y = Math.max(0, r.y - pad), h = Math.min(Math.max(r.h + pad * 2, 260), mobile ? 1400 : 1100);
      await p.evaluate((yy) => window.scrollTo(0, Math.max(0, yy - 40)), y);
      await p.waitForTimeout(500);
      const sy = await p.evaluate(() => scrollY);
      clip = { x: 0, y: y - sy, width: W, height: h };
    } else {
      await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(400);
      clip = { x: 0, y: 0, width: W, height: mobile ? 844 : 900 };
    }
    return (await p.screenshot({ type: 'jpeg', quality: 82, clip })).toString('base64');
  };
  const images = [{ label: job.js ? 'Jetzt' : 'So sieht es jetzt aus', b64: await shot() }];
  if (job.js) {
    await p.evaluate(job.js);
    await p.waitForTimeout(900);
    images.push({ label: 'Mit Änderung', b64: await shot() });
  }
  process.stdout.write(JSON.stringify({ images }));
} finally { await b.close(); }
