import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const projectRoot = resolve(import.meta.dirname, '..');
const baseUrl = String(process.env.INSERT_PLAYER_CAPTURE_URL ?? 'https://insertplayer.ai').replace(/\/$/, '');
const fighterOneName = String(process.env.INSERT_PLAYER_CAPTURE_FIGHTER_1 ?? 'Player One').trim();
const fighterTwoName = String(
  process.env.INSERT_PLAYER_CAPTURE_FIGHTER_2
  ?? process.env.INSERT_PLAYER_CAPTURE_OPPONENT
  ?? 'Elon Musk',
).trim();
const stageName = String(process.env.INSERT_PLAYER_CAPTURE_STAGE ?? '').trim();
const captureId = String(
  process.env.INSERT_PLAYER_CAPTURE_ID ?? `${fighterOneName}-vs-${fighterTwoName}`,
)
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'fight';
const captureDurationMs = Math.max(
  4_000,
  Number(process.env.INSERT_PLAYER_CAPTURE_DURATION_MS ?? 18_000),
);
const readyTimeoutMs = Math.max(
  60_000,
  Number(process.env.INSERT_PLAYER_CAPTURE_READY_TIMEOUT_MS ?? 120_000),
);
const requestedDeviceMemoryGb = Number(
  process.env.INSERT_PLAYER_CAPTURE_DEVICE_MEMORY_GB ?? 8,
);
const captureDeviceMemoryGb = Number.isFinite(requestedDeviceMemoryGb)
  && requestedDeviceMemoryGb > 0
  ? requestedDeviceMemoryGb
  : 8;
const loaderScreenshotDelayMs = Math.max(
  100,
  Number(process.env.INSERT_PLAYER_CAPTURE_LOADER_SCREENSHOT_DELAY_MS ?? 450),
);
const captureUserDataDir = String(process.env.INSERT_PLAYER_CAPTURE_USER_DATA_DIR ?? '').trim();
const allowCrossOrigin = process.env.INSERT_PLAYER_CAPTURE_ALLOW_CROSS_ORIGIN === '1';
const captureDir = resolve(projectRoot, 'assets/captures');
const masterPath = resolve(captureDir, `${captureId}-master.webm`);
const eventsPath = resolve(captureDir, `${captureId}-events.json`);
const loaderScreenshotPath = resolve(captureDir, `${captureId}-loader.png`);

await mkdir(captureDir, { recursive: true });

const contextOptions = {
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: {
    dir: captureDir,
    size: { width: 1920, height: 1080 },
  },
};
const launchArgs = allowCrossOrigin ? ['--disable-web-security'] : [];
const browser = captureUserDataDir
  ? null
  : await chromium.launch({ headless: true, args: launchArgs });
const context = captureUserDataDir
  ? await chromium.launchPersistentContext(captureUserDataDir, {
    ...contextOptions,
    channel: 'chrome',
    headless: true,
    args: launchArgs,
  })
  : await browser.newContext(contextOptions);
const page = context.pages()[0] ?? await context.newPage();
const video = page.video();
const videoStartedAt = Date.now();
const rendererLogs = [];
let matchStartedAt = null;

page.on('console', (message) => {
  const value = message.text();
  if (value.includes('[AiSpriteLoader]')) {
    rendererLogs.push({
      at: Date.now(),
      level: message.type(),
      message: value,
    });
  }
});

// Headless Chromium hides deviceMemory; pin promo captures to a real desktop profile.
await page.addInitScript((deviceMemoryGb) => {
  Object.defineProperty(Navigator.prototype, 'deviceMemory', {
    configurable: true,
    get: () => deviceMemoryGb,
  });
  window.localStorage.setItem('asf:debug', '1');
}, captureDeviceMemoryGb);

try {
  await page.goto(`${baseUrl}/roster/watch`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Attract Mode' }).waitFor({ timeout: 20_000 });

  await page.addStyleTag({
    content: `
      .fight-keys,
      .game-shell__gallery-link {
        display: none !important;
      }
    `,
  });

  const allFilter = page.getByRole('button', { name: /^ALL\s+\d+$/i });
  if (await allFilter.count() > 0) await allFilter.click();

  const fighterCard = (name) => page.locator('.roster-fighter-card').filter({ hasText: name });
  const fighterOne = fighterCard(fighterOneName);
  await fighterOne.waitFor({ timeout: 30_000 });
  const resolvedFighterOne = (await fighterOne.locator('.roster-fighter-card__title strong').textContent())?.trim()
    || fighterOneName;
  await fighterOne.getByRole('button', { name: /CPU 1/ }).click();

  const fighterTwo = fighterCard(fighterTwoName);
  await fighterTwo.waitFor({ timeout: 30_000 });
  const resolvedFighterTwo = (await fighterTwo.locator('.roster-fighter-card__title strong').textContent())?.trim()
    || fighterTwoName;
  await fighterTwo.getByRole('button', { name: /CPU 2/ }).click();

  await page.getByRole('group', { name: 'CPU 1 CPU personality' })
    .getByRole('button', { name: /BRAWLER/ })
    .click();
  await page.getByRole('group', { name: 'CPU 2 CPU personality' })
    .getByRole('button', { name: /SHOWBOAT/ })
    .click();

  if (stageName) {
    const stageButton = page.locator('.roster-stage-list button').filter({ hasText: stageName });
    await stageButton.waitFor({ timeout: 20_000 });
    await stageButton.click();
  }

  await page.evaluate(() => {
    const events = [];
    Object.defineProperty(window, '__INSERT_PLAYER_CAPTURE_EVENTS__', {
      value: events,
      configurable: true,
    });
    for (const type of ['asf-announce', 'asf-hud-state', 'asf-intro', 'asf-match-complete']) {
      window.addEventListener(type, (event) => {
        events.push({
          at: Date.now(),
          type,
          detail: event instanceof CustomEvent ? event.detail : null,
        });
      });
    }
  });

  matchStartedAt = Date.now();
  await page.getByRole('button', { name: /Start Match/ }).click();
  await page.locator('.fight-loader').waitFor({ timeout: readyTimeoutMs });
  await page.waitForTimeout(loaderScreenshotDelayMs);
  await page.screenshot({ path: loaderScreenshotPath });
  try {
    await page.locator('#game-container canvas').waitFor({ timeout: readyTimeoutMs });
  } catch (error) {
    const status = (await page.locator('[role="status"]').allTextContents())
      .map((value) => value.trim())
      .filter(Boolean);
    await page.screenshot({
      path: resolve(captureDir, `${captureId}-failed.png`),
      fullPage: true,
    });
    throw new Error(
      `Fight canvas did not appear for ${resolvedFighterOne} vs ${resolvedFighterTwo}. Status: ${status.join(' | ') || 'none'}`,
      { cause: error },
    );
  }
  await page.waitForFunction(
    () => window.__INSERT_PLAYER_CAPTURE_EVENTS__?.some(
      (event) => event.type === 'asf-announce' && event.detail?.kind === 'fight',
    ),
    undefined,
    { timeout: 60_000 },
  );

  await page.waitForTimeout(captureDurationMs);

  const events = await page.evaluate(() => window.__INSERT_PLAYER_CAPTURE_EVENTS__ ?? []);
  const renderCapabilities = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const maxTextureSize = gl
      ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0
      : 0;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();

    return {
      deviceMemoryGb: typeof navigator.deviceMemory === 'number'
        ? navigator.deviceMemory
        : null,
      maxTextureSize,
      saveData: navigator.connection?.saveData === true,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    };
  });
  await writeFile(eventsPath, `${JSON.stringify({
    baseUrl,
    captureId,
    fighter: resolvedFighterOne,
    opponent: resolvedFighterTwo,
    stage: stageName || 'auto',
    personalities: { fighterOne: 'brawler', fighterTwo: 'showboat' },
    captureDurationMs,
    readyTimeoutMs,
    renderCapabilities,
    rendererLogs,
    videoStartedAt,
    matchStartedAt,
    loaderScreenshotDelayMs,
    loaderScreenshotFile: loaderScreenshotPath.split('/').pop(),
    capturedAt: new Date().toISOString(),
    events,
  }, null, 2)}\n`);
} finally {
  const saveVideo = video?.saveAs(masterPath);
  await page.close();
  await saveVideo;
  await context.close();
  await browser?.close();
}

console.log(JSON.stringify({ masterPath, eventsPath }, null, 2));
