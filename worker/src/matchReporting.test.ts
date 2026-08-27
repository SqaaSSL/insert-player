import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAttractModeMatchReport, readMatchFighterId } from './matchReporting';
import type { Env } from './types';

const runtimes: Miniflare[] = [];

async function createEnv(): Promise<{ db: D1Database; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: `match-reporting-${runtimes.length}`,
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
        env: { DB: { type: 'd1', id: `match-reporting-${runtimes.length}` } },
      },
    }],
  });
  runtimes.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare(`
      CREATE TABLE fighters (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        public_flag INTEGER NOT NULL DEFAULT 0
      )
    `),
    db.prepare(`
      CREATE TABLE arcade_fighters (
        fighter_id TEXT PRIMARY KEY REFERENCES fighters(id),
        status TEXT NOT NULL
      )
    `),
  ]);
  return { db, env: { DB: db } as Env };
}

beforeEach(() => {
  runtimes.length = 0;
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('match fighter authorization', () => {
  it('accepts owned fighters and only active, published Arcade fighters', async () => {
    const { db, env } = await createEnv();
    await db.batch([
      db.prepare("INSERT INTO fighters (id, owner_user_id, public_flag) VALUES ('owned', 'user-a', 0)"),
      db.prepare("INSERT INTO fighters (id, owner_user_id, public_flag) VALUES ('community', 'user-b', 1)"),
      db.prepare("INSERT INTO fighters (id, owner_user_id, public_flag) VALUES ('arcade-draft', 'admin', 1)"),
      db.prepare("INSERT INTO fighters (id, owner_user_id, public_flag) VALUES ('arcade-private', 'admin', 0)"),
      db.prepare("INSERT INTO fighters (id, owner_user_id, public_flag) VALUES ('arcade-live', 'admin', 1)"),
      db.prepare("INSERT INTO arcade_fighters (fighter_id, status) VALUES ('arcade-draft', 'draft')"),
      db.prepare("INSERT INTO arcade_fighters (fighter_id, status) VALUES ('arcade-private', 'active')"),
      db.prepare("INSERT INTO arcade_fighters (fighter_id, status) VALUES ('arcade-live', 'active')"),
    ]);

    await expect(readMatchFighterId(env, 'user-a', 'owned')).resolves.toBe('owned');
    await expect(readMatchFighterId(env, 'user-a', 'arcade-live')).resolves.toBe('arcade-live');
    await expect(readMatchFighterId(env, 'user-a', 'community')).resolves.toBeUndefined();
    await expect(readMatchFighterId(env, 'user-a', 'arcade-draft')).resolves.toBeUndefined();
    await expect(readMatchFighterId(env, 'user-a', 'arcade-private')).resolves.toBeUndefined();
  });

  it('rejects malformed ids before querying the database', async () => {
    const { env } = await createEnv();
    await expect(readMatchFighterId(env, 'user-a', '../fighter')).resolves.toBeUndefined();
    await expect(readMatchFighterId(env, 'user-a', '')).resolves.toBeUndefined();
  });
});

describe('Attract Mode reports', () => {
  it('recognizes only explicit CPU-vs-CPU reports', () => {
    expect(isAttractModeMatchReport({ cpuVsCpu: true })).toBe(true);
    expect(isAttractModeMatchReport({ cpuVsCpu: false })).toBe(false);
    expect(isAttractModeMatchReport({})).toBe(false);
  });
});
