/** Capture actual Aura gameplay without replacing rules, results or scores.
 * Requires local Vite, Playwright Chromium, ffmpeg/ffprobe and cwebp.
 * AURA_PREVIEW_BASE=http://127.0.0.1:5173 CAPTURE_VARIANT=portrait node scripts/capture-aura-gameplay-preview.mjs
 * Repeat with CAPTURE_VARIANT=landscape. Use --encode-only to reuse raw frames.
 * Optional AURA_PREVIEW_SOURCE_SHA pins the exact committed gameplay revision.
 * The browser plays ordinary free quickplay. We retain the real scene reference
 * to READ chart/clock/score and press actual UI controls as notes arrive.
 * No authenticated or remote mutation/provider request may leave the context.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const inputBase = new URL(process.env.AURA_PREVIEW_BASE ?? 'http://127.0.0.1:5173');
assert(inputBase.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(inputBase.hostname), 'This capture harness only supports local Vite');
assert(inputBase.pathname === '/' && !inputBase.search && !inputBase.hash && !inputBase.username && !inputBase.password);
const base = inputBase.origin;
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.AURA_PREVIEW_SOURCE_SHA) assert.equal(sourceSha, process.env.AURA_PREVIEW_SOURCE_SHA, 'Capture source revision differs');
const gameplayChanges = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src/game', 'src/ui/routes/GamePage.tsx', 'src/ui/components/AuraControls.tsx', 'src/ui/styles.css', 'src/ui/App.tsx', 'src/ui/shared/auraTrialMatch.ts', 'public/assets/aura', 'public/assets/stages/aura', 'src/services/AuraBuiltinPerformers.ts'], { encoding: 'utf8' }).trim();
assert.equal(gameplayChanges, '', 'Commit gameplay changes before capturing so source provenance is exact');
const variant = process.env.CAPTURE_VARIANT ?? 'portrait';
assert(['portrait', 'mobile', 'landscape'].includes(variant));
const mobile = variant !== 'landscape';
const viewport = mobile ? { width: 432, height: 768 } : { width: 1280, height: 720 };
const output = resolve(`.artifacts/aura-gameplay-${variant}`);
mkdirSync(join(output, 'frames'), { recursive: true });

function encode(capture) {
  assert(capture.passed && capture.frames.length > 300, 'A validated real capture is required');
  const size = mobile ? { width: 432, height: 768 } : { width: 1024, height: 576 };
  const assetVariant = mobile ? 'portrait' : 'landscape';
  const video = `public/assets/play-mode-aura-${assetVariant}-v2.mp4`;
  const poster = `public/assets/play-mode-aura-${assetVariant}-poster-v2.webp`;
  const encodedVideo = join(output, 'encoded.mp4');
  const encodedPoster = join(output, 'encoded.webp');
  const crop = capture.crop;
  const filter = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${size.width}:${size.height}:in_range=full:out_range=tv,fps=30,format=yuv420p`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-safe', '0', '-i', join(output, 'frames.ffconcat'), '-an', '-vf', filter, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-maxrate', mobile ? '950k' : '1000k', '-bufsize', mobile ? '1900k' : '2000k', '-color_range', 'tv', '-movflags', '+faststart', encodedVideo], { stdio: 'inherit' });
  const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate,duration', '-show_entries', 'format=size,duration', '-of', 'json', encodedVideo], { encoding: 'utf8' }));
  assert.equal(metadata.streams.length, 1, 'The marketing preview must have no audio track');
  assert.equal(metadata.streams[0].codec_name, 'h264');
  assert.equal(metadata.streams[0].pix_fmt, 'yuv420p');
  assert.equal(metadata.streams[0].r_frame_rate, '30/1');
  assert.equal(metadata.streams[0].width, size.width);
  assert.equal(metadata.streams[0].height, size.height);
  assert(Number(metadata.format.size) < 3 * 1024 * 1024);
  assert(Number(metadata.format.duration) >= 16 && Number(metadata.format.duration) <= 24);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', encodedVideo, '-frames:v', '1', '-update', '1', join(output, 'poster.png')]);
  execFileSync('cwebp', ['-quiet', '-q', '88', join(output, 'poster.png'), '-o', encodedPoster]);
  const videoBytes = readFileSync(encodedVideo);
  assert(videoBytes.indexOf(Buffer.from('moov')) < videoBytes.indexOf(Buffer.from('mdat')), 'MP4 metadata must precede media for fast start');
  mkdirSync(resolve('public/assets'), { recursive: true });
  renameSync(encodedVideo, resolve(video));
  renameSync(encodedPoster, resolve(poster));
  const result = { sourceSha: capture.sourceSha, video, poster, posterTimeSeconds: 1, metadata,
    videoSha256: createHash('sha256').update(videoBytes).digest('hex'),
    posterSha256: createHash('sha256').update(readFileSync(poster)).digest('hex') };
  writeFileSync(join(output, 'encoding.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv.includes('--encode-only')) {
  encode(JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')));
  process.exit(0);
}
const report = { sourceSha, variant, viewport, startedAt: new Date().toISOString(),
  method: 'CDP viewport screencast of real free quickplay; automatic actual UI inputs read from current chart. No fabricated gameplay, score or animation.',
  pageErrors: [], blocked: [], screenshots: [], frames: [] };
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, serviceWorkers: 'block' });
await context.routeWebSocket(`ws://${inputBase.host}/**`, socket => socket.close());
const page = await context.newPage();
page.on('pageerror', error => report.pageErrors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  const font = decodeURIComponent(url.pathname).match(/\/node_modules\/@fontsource\/(press-start-2p|space-grotesk)\/files\/([a-z0-9-]+\.woff2?)$/);
  if (url.origin === base && font) return route.fulfill({ status: 200, contentType: font[2].endsWith('woff2') ? 'font/woff2' : 'font/woff', body: readFileSync(resolve('node_modules', '@fontsource', font[1], 'files', font[2])) });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
    || /(^|\.)(fal\.ai|fal\.run|fal\.media|replicate\.com|api\.openai\.com|api\.x\.ai)$/.test(url.hostname)
    || /\/(sign_ins|sign_ups|sessions|tokens)(\/|$)/.test(url.pathname)) {
    report.blocked.push({ method: request.method(), url: `${url.origin}${url.pathname}` });
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
await context.addInitScript(() => {
  // An established local player avoids the optional first-game tutorial.
  localStorage.setItem('ip:aura-first-battle:v1', 'done');
  window.__capture = { events: [], inputs: [] };
  for (const type of ['asf:aura-startup', 'asf:aura-presentation-turn']) {
    window.addEventListener(type, event => window.__capture.events.push({ type, at: performance.now(), ...event.detail }));
  }
});
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  console.log(`${variant}: page ready`);
  await page.evaluate(async () => {
    const { AuraScene } = await import('/src/game/scenes/AuraScene.ts');
    const create = AuraScene.prototype.create;
    AuraScene.prototype.create = function (...args) {
      window.__capture.scene = this;
      return create.apply(this, args);
    };
  });
  console.log(`${variant}: scene observation installed`);
  await page.getByRole('button', { name: 'Play Aura', exact: true }).first().click();
  console.log(`${variant}: quickplay clicked`);
  await page.getByRole('button', { name: 'Start duel', exact: true }).waitFor({ timeout: 90000 });
  report.readyText = await page.locator('.aura-start-ready').innerText();
  console.log(`${variant}: duel assets ready`);
  assert(await page.evaluate(() => Boolean(window.__capture.scene)), 'Restart Vite after committing gameplay changes, then capture again; the observer must match the live scene module');
  assert.match(report.readyText, /DONALD TRUMP/);
  assert.match(report.readyText, /LAMINE YAMAL/);
  await page.evaluate(({ mobile }) => {
    const state = window.__capture, pressed = new Set();
    const keys = ['d', 'f', 'j', 'k'], codes = [68, 70, 74, 75];
    const step = () => {
      const scene = state.scene;
      if (scene?.clockStartedAt !== null && scene?.battle && scene?.startup?.snapshot.phase === 'playing') {
        const now = scene.clockMs();
        for (const note of scene.chart.notes) {
          if (note.slot !== 0 || pressed.has(note.id) || scene.battle.isJudged(note.id)
            || note.atMs > now + 12 || note.atMs < now - 90) continue;
          pressed.add(note.id);
          const before = scene.battle.scoreFor(0);
          if (mobile) {
            const pad = document.querySelectorAll('.aura-touch-controls__lane')[note.lane];
            if (!pad || pad.disabled) throw new Error('A real human note had no enabled touch pad');
            pad.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch', buttons: 1 }));
            pad.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch', buttons: 0 }));
          } else {
            const event = { bubbles: true, key: keys[note.lane], code: `Key${keys[note.lane].toUpperCase()}`, keyCode: codes[note.lane], which: codes[note.lane] };
            window.dispatchEvent(new KeyboardEvent('keydown', event));
            setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', event)), 40);
          }
          state.inputs.push({ noteId: note.id, lane: note.lane, noteAtMs: note.atMs, inputAtMs: now, before });
        }
      }
      state.raf = requestAnimationFrame(step);
    };
    step();
  }, { mobile });
  await page.getByRole('button', { name: 'Start duel', exact: true }).click();
  await page.waitForFunction(() => window.__capture.scene?.clockMs() > window.__capture.scene?.chart.turns[0].firstNoteMs + 1200, {}, { timeout: 30000 });
  report.initial = await page.evaluate(() => {
    const scene = window.__capture.scene;
    return { clockMs: scene.clockMs(), chart: scene.chart, match: scene.matchData, scores: [scene.battle.scoreFor(0), scene.battle.scoreFor(1)] };
  });
  assert(report.initial.scores[0].score > 0, 'Automatic UI input must earn actual Aura');
  report.crop = await page.locator('.game-shell__aura-frame').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', event => {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    const index = report.frames.length;
    const filename = `${String(index).padStart(5, '0')}.jpg`;
    writeFileSync(join(output, 'frames', filename), Buffer.from(event.data, 'base64'));
    report.frames.push({ filename, timestamp: event.metadata.timestamp });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 91, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  console.log(`${variant}: recording real match, score ${report.initial.scores[0].score}, crop ${JSON.stringify(report.crop)}`);
  for (const point of [3, 9, 16, 23]) {
    await page.waitForFunction(({ start, point }) => window.__capture.scene.clockMs() >= start + point * 1000, { start: report.initial.clockMs, point }, { timeout: 15000 });
    const filename = `game-${point}s.png`;
    await page.screenshot({ path: join(output, filename), clip: report.crop });
    report.screenshots.push({ filename, ...(await page.evaluate(() => {
      const scene = window.__capture.scene;
      return { clockMs: scene.clockMs(), activeSlot: scene.activePerformerSlot, scores: [scene.battle.scoreFor(0), scene.battle.scoreFor(1)], pads: [...document.querySelectorAll('.aura-touch-controls__lane')].map(pad => ({ disabled: pad.disabled, label: pad.getAttribute('aria-label') })) };
    })) });
  }
  await cdp.send('Page.stopScreencast');
  report.final = await page.evaluate(() => {
    const state = window.__capture, scene = state.scene;
    cancelAnimationFrame(state.raf);
    return { clockMs: scene.clockMs(), scores: [scene.battle.scoreFor(0), scene.battle.scoreFor(1)], events: state.events, inputs: state.inputs, recording: scene.actionRecorder?.toRecording() ?? null };
  });
  assert(report.final.scores[0].score > report.initial.scores[0].score);
  assert(report.final.scores[1].score > 0);
  assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n'));
  assert(report.final.events.some(event => event.type === 'asf:aura-presentation-turn' && event.playerIndex === 1));
  const durations = report.frames.slice(0, -1).map((frame, index) => report.frames[index + 1].timestamp - frame.timestamp);
  report.durationSeconds = report.frames.at(-1).timestamp - report.frames[0].timestamp;
  report.averageFramesPerSecond = (report.frames.length - 1) / report.durationSeconds;
  report.maxFrameInterval = Math.max(...durations);
  writeFileSync(join(output, 'frames.ffconcat'), 'ffconcat version 1.0\n' + report.frames.map((frame, index) => `file 'frames/${frame.filename}'\noption framerate 60\nduration ${durations[index] ?? (1 / 30)}\n`).join(''));
  report.passed = true;
  console.log(`${variant}: ${report.frames.length} frames, ${report.durationSeconds.toFixed(2)}s, ${report.averageFramesPerSecond.toFixed(1)}fps, scores ${report.final.scores.map(score => score.score)}`);
} catch (error) {
  report.error = error.stack;
  await page.screenshot({ path: join(output, 'error.png') }).catch(() => {});
  console.error(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  await context.close(); await browser.close();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
encode(report);
