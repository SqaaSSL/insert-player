import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const mode = process.env.CAPTURE_MODE ?? 'aura';
const baseUrl = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5189';
if (!['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname)) throw new Error('Local capture build required.');
const p1 = process.env.CAPTURE_P1 ?? (mode === 'aura' ? 'Donald Trump' : 'Player One');
const p2 = process.env.CAPTURE_P2 ?? (mode === 'aura' ? 'Lamine Yamal' : 'Donald Trump');
const duration = Number(process.env.CAPTURE_SECONDS ?? 48);
const id = process.env.CAPTURE_ID ?? `${mode}-${p1}-${p2}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
const dir = resolve(import.meta.dirname, '../assets/captures', id);
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const screenFrames = [];
const screenWrites = [];
const cdp = mode === 'fight' ? await context.newCDPSession(page) : null;
if (cdp) cdp.on('Page.screencastFrame', frame => {
  const file = `screen-${String(screenFrames.length).padStart(6, '0')}.jpg`;
  screenFrames.push({ file, time: frame.metadata.timestamp });
  screenWrites.push(writeFile(resolve(dir, file), Buffer.from(frame.data, 'base64')));
  void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
});
const logs = [];
page.on('console', msg => { if (/SpriteLoader|Error|error/.test(msg.text())) logs.push(msg.text()); });
page.on('pageerror', error => logs.push(error.message));
// The capture browser has no credentials; deny all remote mutations, including inference.
await page.route('**/*', async route => {
  const req = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && new URL(req.url()).origin !== baseUrl) return route.abort();
  return route.continue();
});
// Browser-only capture instrumentation: never edit or ship a CPU player mode.
if (mode === 'rush') {
  for (const [path, before, after] of [
    ['src/game/scenes/RushScene.ts', 'const p1Input = this.inputManager.readPlayer1();', "const p1Input = getBrawlCompanionInput(this.sim, 0, 'attack');"],
    ['src/ui/routes/RosterPage.tsx', 'includeHighResolutionAssets: false', 'includeHighResolutionAssets: true'],
  ]) {
    await page.route(`**/${path}*`, async route => {
      const response = await route.fetch();
      let body = await response.text();
      if (body.split(before).length !== 2) throw new Error(`Capture hook changed: ${path}`);
      if (path.endsWith('RushScene.ts')) {
        const jump = 'jump: this.consumeQueuedJump() || p1Input.uppercut';
        if (body.split(jump).length !== 2) throw new Error('Rush jump capture hook changed.');
        body = body.replace(jump, 'jump: p1Input.jump || this.consumeQueuedJump() || p1Input.uppercut');
      }
      await route.fulfill({ response, body: body.replace(before, after) });
    });
  }
}
await page.addInitScript(captureMode => {
  Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 8 });
  localStorage.setItem('asf:debug', '1');
  window.__promoEvents = [];
  for (const type of ['asf-announce', 'asf-hud-state', 'asf-aura-state', 'asf-aura-feedback', 'asf-rush-hud', 'asf-intro']) {
    window.addEventListener(type, event => window.__promoEvents.push({ at: performance.now(), type, detail: event.detail }));
  }
}, mode);
try {
  const route = mode === 'aura' ? '/roster/aura-watch' : mode === 'fight' ? '/roster/watch' : '/roster/rush';
  await page.goto(baseUrl + route, { waitUntil: 'domcontentloaded' });
  const card = name => page.locator('.roster-fighter-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`, 'i') }) });
  await card(p1).waitFor({ timeout: 30000 });
  await card(p1).getByRole('button', { name: mode === 'rush' ? /Player 1/ : /CPU 1/ }).click();
  await card(p2).getByRole('button', { name: mode === 'rush' ? /CPU Ally/ : /CPU 2/ }).click();
  if (process.env.CAPTURE_STAGE) {
    await page.getByText('Match settings', { exact: false }).first().click();
    await page.locator('.roster-stage-list button').filter({ hasText: new RegExp(`^${process.env.CAPTURE_STAGE}`, 'i') }).click();
  }
  await page.getByRole('button', { name: mode === 'aura' ? /^Watch Aura/ : mode === 'fight' ? /^Start Match/ : /^Start Rush/ }).click();
  await page.locator('#game-container canvas').waitFor({ timeout: 180000 });
  console.log(`Canvas ready: ${mode} ${p1} / ${p2}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(3000);
  if (cdp) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 2 });
  // Record the genuine full-resolution game canvas, not a lossy browser-tab recording.
  await page.evaluate(() => {
    const canvas = document.querySelector('#game-container canvas');
    window.__promoChunks = [];
    window.__promoStart = performance.now();
    window.__promoRecorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 18000000 });
    window.__promoRecorder.ondataavailable = e => { if (e.data.size) window.__promoChunks.push(e.data); };
    window.__promoRecorder.start(1000);
  });
  for (let i = 0; i < duration; i++) {
    if (mode === 'fight' && i < 4) await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    if ([5, 12, 20, 32, 44].includes(i)) await page.screenshot({ path: resolve(dir, `shot-${i}.png`) });
  }
  const bytes = await page.evaluate(async () => {
    await new Promise(resolve => { window.__promoRecorder.onstop = resolve; window.__promoRecorder.stop(); });
    const data = new Uint8Array(await new Blob(window.__promoChunks).arrayBuffer());
    let binary = '';
    for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768));
    return btoa(binary);
  });
  if (cdp) {
    await cdp.send('Page.stopScreencast');
    await Promise.all(screenWrites);
    const concat = screenFrames.map((frame, index) => `file '${frame.file}'\nduration ${Math.max(0.001, (screenFrames[index + 1]?.time ?? frame.time + 1 / 30) - frame.time)}`).join('\n');
    await writeFile(resolve(dir, 'screen.ffconcat'), concat + '\n');
    await writeFile(resolve(dir, 'screen-timing.json'), JSON.stringify(screenFrames));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', resolve(dir, 'screen.ffconcat'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-movflags', '+faststart', resolve(dir, 'screen.mp4')]);
  }
  await writeFile(resolve(dir, 'master.webm'), Buffer.from(bytes, 'base64'));
  const state = await page.evaluate(() => ({ start: window.__promoStart, events: window.__promoEvents, rush: window.__ASF_RUSH_STATE__?.(), canvas: { width: document.querySelector('#game-container canvas').width, height: document.querySelector('#game-container canvas').height } }));
  await writeFile(resolve(dir, 'capture.json'), JSON.stringify({ mode, p1, p2, duration, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), logs, ...state }, null, 2));
  if (mode === 'rush' && duration >= 12 && !(state.rush?.progressX > 900)) throw new Error('Rush capture did not clear the opening obstacle; do not use it.');
  console.log(JSON.stringify({ dir, canvas: state.canvas, logs: logs.slice(-8) }));
} catch (error) {
  await page.screenshot({ path: resolve(dir, 'failed.png') });
  console.log((await page.locator('body').innerText()).slice(0,10000));
  throw error;
} finally { await context.close(); await browser.close(); }
