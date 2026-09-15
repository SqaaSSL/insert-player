import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const base = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5190';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const mode = process.env.CAPTURE_MODE ?? 'aura';
assert(['aura', 'fight', 'rush'].includes(mode));
const p1 = process.env.CAPTURE_P1 ?? 'Donald Trump';
const p2 = process.env.CAPTURE_P2 ?? 'Rosalía';
const id = process.env.CAPTURE_ID;
assert(id && /^[a-z0-9-]+$/.test(id), 'An immutable capture ID is required');
const seconds = Number(process.env.CAPTURE_SECONDS ?? 24);
assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 90);
const [width, height] = (process.env.CAPTURE_VIEWPORT ?? '1920x1080').split('x').map(Number);
const gameDir = resolve(process.env.CAPTURE_GAME_DIR ?? '../player-identity-hud');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gameDir, encoding: 'utf8' }).trim();
const gameDiff = execFileSync('git', ['diff', 'HEAD'], { cwd: gameDir, encoding: 'utf8' });
const dir = resolve(import.meta.dirname, '../assets/captures', id);
assert(!existsSync(dir), 'Never overwrite captured footage.');
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width, height }, hasTouch: process.env.CAPTURE_TOUCH === '1' || width < 600, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
const logs = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', msg => { if (/SpriteLoader|Beat clock/.test(msg.text())) logs.push(msg.text()); });
await page.route('**/*', async route => {
  const request = route.request();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && new URL(request.url()).origin !== new URL(base).origin) return route.abort();
  return route.continue();
});

async function instrument(path, edits) {
  await page.route(`**/${path}*`, async route => {
    const response = await route.fetch();
    let body = await response.text();
    for (const [from, to] of edits) {
      assert.equal(body.split(from).length, 2, `Capture-only hook changed: ${path}: ${from}`);
      body = body.replace(from, to);
    }
    await route.fulfill({ response, body });
  });
}
// Hooks exist solely in this anonymous capture browser, never in a shipped build.
await instrument('src/game/createGame.ts', [['const game = new Phaser.Game(config);', 'const game = new Phaser.Game(config); window.__identityCaptureGame = game;']]);
if (mode === 'rush') await instrument('src/game/scenes/RushScene.ts', [
  ['const p1Input = this.inputManager.readPlayer1();', 'const p1Input = getBrawlCompanionInput(this.sim, 0, "attack");'],
  ['jump: this.consumeQueuedJump() || p1Input.uppercut', 'jump: p1Input.jump || this.consumeQueuedJump() || p1Input.uppercut'],
]);
await page.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 8 });
  localStorage.removeItem('asf:debug');
});
const sceneKey = { aura: 'AuraScene', fight: 'FightScene', rush: 'RushScene' }[mode];
try {
  await page.clock.install();
  const route = { aura: '/roster/aura-watch', fight: '/roster/watch', rush: '/roster/rush' }[mode];
  await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  const card = name => page.locator('.roster-fighter-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`, 'i') }) });
  await card(p1).waitFor({ timeout: 60000 });
  await card(p1).getByRole('button', { name: mode === 'rush' ? /Player 1/ : /CPU 1/ }).click();
  await card(p2).getByRole('button', { name: mode === 'rush' ? /CPU Ally/ : /CPU 2/ }).click();
  if (mode === 'fight') {
    await page.getByText('Match settings', { exact: false }).first().click();
    await page.locator('.roster-stage-list button').filter({ hasText: /^Executive Rumble/i }).click();
  }
  await page.getByRole('button', { name: { aura: /^Watch Aura/, fight: /^Start Match/, rush: /^Start Rush/ }[mode] }).click();
  await page.locator('#game-container canvas').waitFor({ timeout: 180000 });
  if (mode === 'fight') {
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(500); }
    await page.locator('.fight-hud').waitFor({ timeout: 60000 });
  } else if (mode === 'aura') {
    await page.waitForFunction(() => window.__identityCaptureGame.scene.getScene('AuraScene').startup?.snapshot.phase === 'playing', undefined, { timeout: 60000 });
    // Silent capture advances the same documented fallback clock as a muted
    // match. WebAudio wall time cannot race our frame-exact screenshot clock.
    await page.evaluate(() => { window.__identityCaptureGame.scene.getScene('AuraScene').silentStartup = true; });
  } else {
    await page.waitForTimeout(3000);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  console.log(`${id}: ready for ${seconds}s at ${width}x${height}`);
  const frames = [];
  const start = await page.evaluate(() => performance.now());
  for (let i = 0; i < Math.max(1, 30 * seconds); i++) {
    if (i) await page.clock.runFor(Math.round(i * 1000 / 30) - Math.round((i - 1) * 1000 / 30));
    const state = await page.evaluate(({ sceneKey, mode }) => {
      const scene = window.__identityCaptureGame.scene.getScene(sceneKey);
      const box = text => { const b = text.getBounds(); return { text: text.text, x: b.x, y: b.y, width: b.width, height: b.height }; };
      if (mode === 'aura') return {
        t: performance.now(), musicMs: scene.clockMs(), slot: scene.activePerformerSlot,
        actors: scene.auraPerformanceViews.map(view => view ? { animation: view.activeName, frame: view.sprite.frame.name, resting: view.resting, elapsed: view.elapsedMs } : null),
        names: [box(scene.p1NameText), box(scene.p2NameText)],
        scores: [scene.p1ScoreText.text, scene.p2ScoreText.text],
        portraits: scene.hudPortraits.map(view => view.container.list.length === 3),
      };
      if (mode === 'rush') return {
        t: performance.now(), progress: scene.sim.progressX,
        names: [box(scene.hudP1), box(scene.hudP2)],
        actors: scene.sim.players.map(player => ({ action: player.state, x: player.x, health: player.health })),
      };
      return { t: performance.now(), names: Array.from(document.querySelectorAll('.fight-hud__name')).map(node => ({ text: node.textContent, width: node.clientWidth, height: node.clientHeight, scrollWidth: node.scrollWidth })) };
    }, { sceneKey, mode });
    assert(Math.abs(state.t - start - Math.round(i * 1000 / 30)) < 1);
    const file = `frame-${String(i).padStart(5, '0')}.png`;
    await page.screenshot({ path: resolve(dir, file) });
    frames.push({ file, ...state });
    if (i % 120 === 0) console.log(`${id}: ${i}/${30 * seconds} frames`);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  if (mode === 'fight') for (const frame of frames) for (const name of frame.names) {
    assert(name.width >= 100 && name.scrollWidth <= name.width + 1 && name.height <= 110, `Unreadable HUD name: ${JSON.stringify(name)}`);
  }
  if (mode === 'aura' && seconds > 5) {
    const poses = new Set(frames.map(frame => {
      const actor = frame.actors[frame.slot];
      return JSON.stringify([frame.slot, actor.animation, actor.frame, actor.resting]);
    }));
    assert(poses.size > 30, 'Static Aura take; do not use.');
    assert(frames.at(-1).musicMs > frames[0].musicMs + (seconds - 1) * 1000, 'Aura clock stalled');
  }
  await writeFile(resolve(dir, 'capture.json'), JSON.stringify({ mode, p1, p2, sourceCommit, gameDiffHash: createHash('sha256').update(gameDiff).digest('hex'), width, height, fps: 30, seconds, method: 'frame-exact real gameplay, no interpolation; anonymous browser-only clock/CPU instrumentation', errors, logs, frames }, null, 2));
  if (seconds > 0) execFileSync('ffmpeg', ['-v', 'error', '-n', '-framerate', '30', '-i', resolve(dir, 'frame-%05d.png'), '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(dir, 'master.mp4')]);
  console.log(`Complete: ${dir}`);
} catch (error) {
  await page.screenshot({ path: resolve(dir, 'failed.png') });
  console.error((await page.locator('body').innerText()).slice(0, 2500));
  throw error;
} finally {
  await context.close(); await browser.close();
}
