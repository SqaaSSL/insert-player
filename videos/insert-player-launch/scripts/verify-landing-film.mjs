import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5189';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const out = resolve(import.meta.dirname, '../assets/captures/landing-qa-v19');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const mediaRequests = [];
    page.on('request', req => { if (req.url().includes('insert-player-launch-aura-v19.mp4')) mediaRequests.push(req.url()); });
    await page.goto(`${base}/games/aura`, { waitUntil: 'networkidle' });
    const video = page.locator('.product-entry__film-video');
    await video.waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(mediaRequests.length, 0, 'Film must not download before playback');
    const before = await video.evaluate(el => ({ poster: el.poster, controls: el.controls, preload: el.preload, width: el.clientWidth, height: el.clientHeight }));
    assert.equal(before.controls, true);
    assert.equal(before.preload, 'none');
    assert(Math.abs(before.width / before.height - 16 / 9) < 0.02);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
    const poster = await context.request.get(before.poster);
    assert(poster.ok());
    assert.match(poster.headers()['content-type'], /image\/webp/);
    await video.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(out, `landing-${viewport.width}.png`), fullPage: true });
    await video.evaluate(el => { el.muted = true; return el.play(); });
    await page.waitForFunction(() => document.querySelector('.product-entry__film-video').currentTime > 0.3);
    await video.evaluate(async el => {
      el.pause();
      const seeked = new Promise(resolve => el.addEventListener('seeked', resolve, { once: true }));
      el.currentTime = 24;
      await seeked;
    });
    const playback = await video.evaluate(el => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 36;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(el, 0, 0, 64, 36);
      const data = ctx.getImageData(0, 0, 64, 36).data;
      return { duration: el.duration, width: el.videoWidth, height: el.videoHeight, error: el.error?.message,
        uniqueChannels: new Set(data).size, tracks: el.textTracks.length };
    });
    assert(playback.duration > 36 && playback.duration < 36.3);
    assert.equal(playback.width, 1920);
    assert.equal(playback.height, 1080);
    assert.equal(playback.error, undefined);
    assert(playback.uniqueChannels > 100, 'Decoded video must be nonblank');
    assert.equal(playback.tracks, 1);
    await video.screenshot({ path: resolve(out, `playback-${viewport.width}.png`) });
    results.push({ viewport, initialVideoRequests: 0, ...playback });
    await context.close();
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
