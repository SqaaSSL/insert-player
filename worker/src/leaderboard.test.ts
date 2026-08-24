import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { getLeaderboard, getPlayerStats } from './leaderboard';
import type { Env } from './types';

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    oauth_provider TEXT NOT NULL,
    oauth_id TEXT NOT NULL,
    elo_rating INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    total_kos INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE matches (
    id TEXT PRIMARY KEY,
    player1_id TEXT NOT NULL,
    player2_id TEXT NOT NULL,
    winner_id TEXT,
    rounds_won_p1 INTEGER NOT NULL DEFAULT 0,
    rounds_won_p2 INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_ranked INTEGER NOT NULL DEFAULT 0
  );
`;

const runtimes: Miniflare[] = [];

async function createEnv(): Promise<{ db: D1Database; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: `leaderboard-privacy-${runtimes.length}`,
        compatibilityDate: '2026-08-24',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: `leaderboard-${runtimes.length}` } },
      },
    }],
  });
  runtimes.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  return { db, env: { DB: db } as Env };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('leaderboard privacy', () => {
  it('publishes rank aliases without account identity or stable ids', async () => {
    const { db, env } = await createEnv();
    await db.batch([
      db.prepare(`
        INSERT INTO users (id, display_name, avatar_url, oauth_provider, oauth_id, elo_rating, wins, losses)
        VALUES (?, ?, ?, 'clerk', ?, 1400, 8, 2)
      `).bind('internal-user-a', 'Real Full Name', 'https://img.clerk.com/private-a.png', 'user_clerk_a'),
      db.prepare(`
        INSERT INTO users (id, display_name, avatar_url, oauth_provider, oauth_id, elo_rating, wins, losses)
        VALUES (?, ?, ?, 'clerk', ?, 1300, 4, 1)
      `).bind('internal-user-b', 'Another Real Name', 'https://img.clerk.com/private-b.png', 'user_clerk_b'),
    ]);

    const response = await getLeaderboard(env);
    const body = await response.json() as { leaderboard: Array<Record<string, unknown>> };

    expect(body.leaderboard).toEqual([
      expect.objectContaining({ id: 'rank:1', display_name: 'Player 1', avatar_url: null }),
      expect.objectContaining({ id: 'rank:2', display_name: 'Player 2', avatar_url: null }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Real Full Name');
    expect(serialized).not.toContain('Another Real Name');
    expect(serialized).not.toContain('img.clerk.com');
    expect(serialized).not.toContain('internal-user');
    expect(serialized).not.toContain('user_clerk');
  });

  it('keeps the signed-in player profile private but available to its owner', async () => {
    const { db, env } = await createEnv();
    await db.prepare(`
      INSERT INTO users (id, display_name, avatar_url, oauth_provider, oauth_id, wins, losses)
      VALUES (?, ?, ?, 'clerk', ?, 1, 0)
    `).bind('internal-user-a', '  Real   Full Name  ', 'https://img.clerk.com/private-a.png', 'user_clerk_a').run();

    const response = await getPlayerStats(env, 'internal-user-a');
    const body = await response.json() as { player: Record<string, unknown> };

    expect(body.player).toMatchObject({
      id: 'internal-user-a',
      display_name: 'Real Full Name',
      avatar_url: 'https://img.clerk.com/private-a.png',
    });
  });
});
