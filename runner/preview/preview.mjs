// Runs on LeChonk: renders one page area as it is now and (optionally) after a DOM patch.
// stdin: {url, selector, focus, js, device}; stdout: {images:[{label,b64}]}.
// The "after" page is rendered first so the clip can follow the changed element (focus); the "before" shot then uses
// the same page region, so both images line up.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const job = JSON.parse(fs.readFileSync(0, 'utf8'));
const mobile = job.device === 'mobile';
const W = mobile ? 390 : 1440, VH = mobile ? 844 : 900, MAXH = mobile ? 1500 : 1300;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
async function open() {
  const p = await b.newPage({ viewport: { width: W, height: VH }, deviceScaleFactor: mobile ? 2 : 1 });
  await p.goto(job.url, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(4200); // entrance animations
  return p;
}
const rect = (p, sel) => p.evaluate((s) => { const el = s ? document.querySelector(s) : null; if (!el) return null; const r = el.getBoundingClientRect(); return { y: r.top + scrollY, h: r.height }; }, sel || '');
async function shoot(p, y0, h) {
  await p.evaluate((y) => window.scrollTo(0, Math.max(0, y - 40)), y0);
  await p.waitForTimeout(450);
  const sy = await p.evaluate(() => scrollY);
  const total = await p.evaluate(() => document.documentElement.scrollHeight);
  const hh = Math.max(200, Math.min(h, total - y0));
  return (await p.screenshot({ type: 'jpeg', quality: 82, fullPage: true, clip: { x: 0, y: y0, width: W, height: hh } })).toString('base64');
  void sy;
}
try {
  const images = [];
  let region;
  if (job.js) {
    const after = await open();
    await after.evaluate(job.js);
    await after.waitForTimeout(900);
    const area = await rect(after, job.selector);
    const focus = await rect(after, job.focus);
    if (area) {
      let y = Math.max(0, area.y - 36), h = Math.min(area.h + 72, MAXH);
      if (focus && (focus.y + focus.h > y + h || focus.y < y)) { y = Math.max(0, focus.y + focus.h - h * 0.75); }
      region = { y, h: Math.max(h, 260) };
    } else if (focus) region = { y: Math.max(0, focus.y - MAXH / 3), h: MAXH };
    else region = { y: 0, h: VH };
    const shot = await shoot(after, region.y, region.h);
    await after.close();
    const before = await open();
    images.push({ label: 'Jetzt', b64: await shoot(before, region.y, region.h) });
    images.push({ label: 'Mit Änderung', b64: shot });
  } else {
    const p = await open();
    const area = await rect(p, job.selector);
    region = area ? { y: Math.max(0, area.y - 36), h: Math.max(260, Math.min(area.h + 72, MAXH)) } : { y: 0, h: VH };
    images.push({ label: 'So sieht es jetzt aus', b64: await shoot(p, region.y, region.h) });
  }
  process.stdout.write(JSON.stringify({ images }));
} finally { await b.close(); }
