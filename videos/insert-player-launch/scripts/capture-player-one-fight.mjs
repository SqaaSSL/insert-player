import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const projectRoot = resolve(import.meta.dirname, '..');
const baseUrl = String(process.env.INSERT_PLAYER_CAPTURE_URL ?? 'https://insertplayer.ai').replace(/\/$/, '');
const opponentName = String(process.env.INSERT_PLAYER_CAPTURE_OPPONENT ?? 'Elon Musk').trim();
const captureDir = resolve(projectRoot, 'assets/captures');
const masterPath = resolve(captureDir, 'player-one-fight-master.webm');
const eventsPath = resolve(captureDir, 'player-one-fight-events.json');

await mkdir(captureDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  recordVideo: {
    dir: captureDir,
    size: { width: 1280, height: 720 },
  },
});
const page = await context.newPage();
const video = page.video();
const videoStartedAt = Date.now();

try {
  await page.goto(`${baseUrl}/roster/watch`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Attract Mode' }).waitFor({ timeout: 20_000 });

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
  await page.locator('#game-container canvas').waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () => window.__INSERT_PLAYER_CAPTURE_EVENTS__?.some(
      (event) => event.type === 'asf-announce' && event.detail?.kind === 'fight',
    ),
    undefined,
    { timeout: 60_000 },
  );

  await page.waitForTimeout(18_000);

  const events = await page.evaluate(() => window.__INSERT_PLAYER_CAPTURE_EVENTS__ ?? []);
  await writeFile(eventsPath, `${JSON.stringify({
    baseUrl,
    fighter: 'Player One',
    opponent: resolvedOpponent,
    personalities: { playerOne: 'brawler', opponent: 'showboat' },
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
