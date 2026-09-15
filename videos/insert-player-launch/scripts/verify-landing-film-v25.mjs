import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5189';
assert(['localhost', '127.0.0.1', 'insertplayer.ai'].includes(new URL(base).hostname));
const out = resolve(import.meta.dirname, `../assets/captures/landing-qa-v25-${new URL(base).hostname}`);
await mkdir(out, { recursive: true });
const server = process.argv.includes('--serve-build')
  ? await (await import('vite')).preview({ root: resolve(import.meta.dirname, '../../..'),
    preview: { host: '127.0.0.1', port: 5189, strictPort: true } })
  : process.argv.includes('--serve-dev')
    ? await (await import('vite')).createServer({ root: resolve(import.meta.dirname, '../../..'),
      server: { host: '127.0.0.1', port: 5189, strictPort: true } })
    : null;
if (process.argv.includes('--serve-dev')) await server.listen();
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    for (const route of ['/', '/menu']) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const mediaRequests = [];
      page.on('request', req => { if (req.url().includes('insert-player-launch-aura-v25.mp4')) mediaRequests.push(req.url()); });
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
      console.log(`Checking ${route} at ${viewport.width}px`);
      const video = page.locator('.product-entry__film-video');
      await video.waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await video.count(), 1);
      assert.equal(mediaRequests.length, 0, 'Film must not download before playback');
      const before = await video.evaluate(el => ({ poster: el.poster, controls: el.controls, preload: el.preload,
        width: el.clientWidth, height: el.clientHeight, source: el.querySelector('source').src,
        previousClass: el.closest('section').previousElementSibling.className }));
      assert.equal(before.controls, true);
      assert.equal(before.preload, 'none');
      assert.match(before.source, /insert-player-launch-aura-v25\.mp4$/);
      assert.equal(before.previousClass, route === '/menu' ? 'product-entry__game-list' : 'product-entry__other-games');
      assert(Math.abs(before.width / before.height - 16 / 9) < 0.02);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
      const poster = await context.request.get(before.poster);
      assert(poster.ok());
      assert.match(poster.headers()['content-type'], /image\/webp/);
      await video.scrollIntoViewIfNeeded();
      const label = `${route === '/' ? 'landing' : 'play'}-${viewport.width}`;
      await page.screenshot({ path: resolve(out, `${label}.png`), fullPage: true });
      await video.evaluate(el => { el.muted = true; return el.play(); });
      await page.waitForFunction(() => document.querySelector('.product-entry__film-video').currentTime > 0.3);
      await video.evaluate(async el => {
        el.pause();
        const seeked = new Promise(resolve => el.addEventListener('seeked', resolve, { once: true }));
        el.currentTime = 12.9;
        await seeked;
      });
      const playback = await video.evaluate(el => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 36;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(el, 0, 0, 64, 36);
        const data = ctx.getImageData(0, 0, 64, 36).data;
        el.textTracks[0].mode = 'hidden';
        return { duration: el.duration, width: el.videoWidth, height: el.videoHeight, error: el.error?.message,
          uniqueChannels: new Set(data).size, tracks: el.textTracks.length };
      });
      assert(Math.abs(playback.duration - 27.7) < 0.04);
      assert.equal(playback.width, 1920);
      assert.equal(playback.height, 1080);
      assert.equal(playback.error, undefined);
      assert(playback.uniqueChannels > 100, 'Decoded video must be nonblank');
      assert.equal(playback.tracks, 1);
      await page.waitForFunction(() => document.querySelector('.product-entry__film-video').textTracks[0].cues?.length === 6);
      await video.screenshot({ path: resolve(out, `${label}-playback.png`) });
      results.push({ route, viewport, initialVideoRequests: 0, previousClass: before.previousClass, ...playback });
      await context.close();
    }
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  if (server?.close) await server.close();
  else if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
