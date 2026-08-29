import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const projectRoot = resolve(import.meta.dirname, '..');
const baseUrl = String(process.env.INSERT_PLAYER_CAPTURE_URL ?? 'https://insertplayer.ai').replace(/\/$/, '');
const opponentName = String(process.env.INSERT_PLAYER_CAPTURE_OPPONENT ?? 'Elon Musk').trim();
const captureId = String(process.env.INSERT_PLAYER_CAPTURE_ID ?? opponentName)
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
const captureDir = resolve(projectRoot, 'assets/captures');
const masterPath = resolve(captureDir, `${captureId}-master.webm`);
const eventsPath = resolve(captureDir, `${captureId}-events.json`);

await mkdir(captureDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: {
    dir: captureDir,
    size: { width: 1920, height: 1080 },
  },
});
const page = await context.newPage();
const video = page.video();
const videoStartedAt = Date.now();

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

  const fighterCard = (name) => page.locator('.roster-fighter-card').filter({ hasText: name });
  const playerOne = fighterCard('Player One');
  await playerOne.waitFor({ timeout: 30_000 });
  await playerOne.getByRole('button', { name: /CPU 1/ }).click();

  let opponent = fighterCard(opponentName);
  if (await opponent.count() === 0) {
    opponent = page.locator('.roster-fighter-card').filter({ hasNotText: 'Player One' }).first();
  }
  const resolvedOpponent = (await opponent.locator('.roster-fighter-card__title strong').textContent())?.trim()
    || opponentName;
  await opponent.getByRole('button', { name: /CPU 2/ }).click();

  await page.getByRole('group', { name: 'CPU 1 CPU personality' })
    .getByRole('button', { name: /BRAWLER/ })
    .click();
  await page.getByRole('group', { name: 'CPU 2 CPU personality' })
    .getByRole('button', { name: /SHOWBOAT/ })
    .click();

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

  await page.getByRole('button', { name: /Start Match/ }).click();
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
      `Fight canvas did not appear for ${resolvedOpponent}. Status: ${status.join(' | ') || 'none'}`,
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
  await writeFile(eventsPath, `${JSON.stringify({
    baseUrl,
    captureId,
    fighter: 'Player One',
    opponent: resolvedOpponent,
    personalities: { playerOne: 'brawler', opponent: 'showboat' },
    captureDurationMs,
    readyTimeoutMs,
    videoStartedAt,
    capturedAt: new Date().toISOString(),
    events,
  }, null, 2)}\n`);
} finally {
  await context.close();
  if (video) await video.saveAs(masterPath);
  await browser.close();
}

console.log(JSON.stringify({ masterPath, eventsPath }, null, 2));
