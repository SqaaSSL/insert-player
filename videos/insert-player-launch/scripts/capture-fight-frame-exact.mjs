import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const base = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5189';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const p1 = process.env.CAPTURE_P1 ?? 'Player One';
const p2 = process.env.CAPTURE_P2 ?? 'Donald Trump';
const id = process.env.CAPTURE_ID ?? 'fight-player-one-trump-v21';
assert(/^[a-z0-9-]+$/.test(id));
const dir = resolve(import.meta.dirname, '../assets/captures', id);
assert(!existsSync(dir), 'Capture IDs are immutable; choose a new version.');
await mkdir(dir, { recursive: true });
const fps = 30;
const seconds = Number(process.env.CAPTURE_SECONDS ?? 8);
const browser = await chromium.launch({ headless: true, args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const logs = [];
page.on('console', msg => { if (/AiSpriteLoader/.test(msg.text())) logs.push(msg.text()); });
page.on('pageerror', error => logs.push(`ERROR: ${error.message}`));
await page.route('**/*', async route => {
  const req = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && new URL(req.url()).origin !== new URL(base).origin) return route.abort();
  return route.continue();
});
await page.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 8 });
  localStorage.setItem('asf:debug', '1');
  window.__captureEvents = [];
  for (const type of ['asf-announce', 'asf-hud-state']) {
    window.addEventListener(type, e => window.__captureEvents.push({ at: performance.now(), type, detail: e.detail }));
  }
});
try {
  await page.clock.install();
  await page.goto(`${base}/roster/watch`, { waitUntil: 'domcontentloaded' });
  const card = name => page.locator('.roster-fighter-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`, 'i') }) });
  await card(p1).waitFor({ timeout: 60000 });
  console.log(`Roster ready: ${p1} / ${p2}`);
  await card(p1).getByRole('button', { name: /CPU 1/ }).click();
  await card(p2).getByRole('button', { name: /CPU 2/ }).click();
  await page.getByText('Match settings', { exact: false }).first().click();
  await page.locator('.roster-stage-list button').filter({ hasText: /^Executive Rumble/i }).click();
  await page.getByRole('button', { name: /^Start Match/ }).click();
  await page.locator('#game-container canvas').waitFor({ timeout: 180000 });
  console.log('Fight canvas ready');
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(500); }
  await page.waitForFunction(() => window.__captureEvents.some(e => e.type === 'asf-announce' && e.detail?.kind === 'fight'), undefined, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  const start = await page.evaluate(() => performance.now());
  const frames = [];
  // Advance the game's own RAF/timers, then wait for a complete screen capture.
  // Wall-clock rendering speed cannot drop simulation frames from this recording.
  for (let i = 0; i < fps * seconds; i++) {
    if (i > 0) await page.clock.runFor(Math.round(i * 1000 / fps) - Math.round((i - 1) * 1000 / fps));
    const time = await page.evaluate(() => performance.now());
    assert(Math.abs(time - start - Math.round(i * 1000 / fps)) < 1);
    const file = `frame-${String(i).padStart(5, '0')}.png`;
    await page.screenshot({ path: resolve(dir, file) });
    frames.push({ file, simulationTime: time - start });
    if (i % 60 === 0) console.log(`${id}: ${i}/${fps * seconds} exact frames`);
  }
  const state = await page.evaluate(() => ({ events: window.__captureEvents, canvas: { width: document.querySelector('#game-container canvas').width, height: document.querySelector('#game-container canvas').height } }));
  await writeFile(resolve(dir, 'capture.json'), JSON.stringify({ p1, p2, stage: 'Executive Rumble', fps, seconds, method: 'Playwright clock: one screenshot per 1/30s simulation, no screencast and no interpolation', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), start, frames, logs, ...state }, null, 2));
  execFileSync('ffmpeg', ['-v', 'error', '-n', '-framerate', String(fps), '-i', resolve(dir, 'frame-%05d.png'), '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', resolve(dir, 'master.mp4')]);
  console.log(`Completed ${dir}`);
} catch (error) {
  await page.screenshot({ path: resolve(dir, 'failed.png') });
  console.error((await page.locator('body').innerText()).slice(0, 2000));
  throw error;
} finally { await context.close(); await browser.close(); }
