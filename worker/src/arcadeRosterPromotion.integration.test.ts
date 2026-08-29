import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/0034_promote_rosalia_v2.sql',
);

const runtimes: Miniflare[] = [];

function migrationStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

async function database(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: `arcade-roster-promotion-${runtimes.length}`,
        compatibilityDate: '2026-08-27',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: `arcade-roster-promotion-${runtimes.length}` } },
      },
    }],
  });
  runtimes.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare(`CREATE TABLE fighters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_flag INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE arcade_fighters (
      fighter_id TEXT PRIMARY KEY REFERENCES fighters(id),
      slug TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE sprites (
      id TEXT PRIMARY KEY,
      fighter_id TEXT NOT NULL REFERENCES fighters(id),
      animation_name TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY,
      fighter_id TEXT NOT NULL REFERENCES fighters(id),
      status TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE provider_cost_events (
      id TEXT PRIMARY KEY,
      fighter_id TEXT NOT NULL REFERENCES fighters(id),
      estimated_cost_micros INTEGER NOT NULL
    )`),
  ]);
  return { mf, db };
}

async function applyPromotion(db: D1Database): Promise<void> {
  for (const statement of migrationStatements(readFileSync(migrationPath, 'utf8'))) {
    await db.prepare(statement).run();
  }
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('0034 Rosalía V2 promotion migration', () => {
  it('promotes the replacement and preserves every legacy asset and job row', async () => {
    const { db } = await database();
    await db.batch([
      db.prepare("INSERT INTO fighters VALUES ('legacy', 'Rosalía', 1, 'legacy-before')"),
      db.prepare("INSERT INTO fighters VALUES ('replacement', 'Rosalía V2', 1, 'replacement-before')"),
      db.prepare("INSERT INTO arcade_fighters VALUES ('legacy', 'rosalia', 5, 'active', 'legacy-arcade-before')"),
      db.prepare("INSERT INTO arcade_fighters VALUES ('replacement', 'rosalia-v2', 14, 'active', 'replacement-arcade-before')"),
      db.prepare("INSERT INTO sprites VALUES ('legacy-idle', 'legacy', 'idle')"),
      db.prepare("INSERT INTO sprites VALUES ('replacement-idle', 'replacement', 'idle')"),
      db.prepare("INSERT INTO generation_jobs VALUES ('legacy-job', 'legacy', 'succeeded')"),
      db.prepare("INSERT INTO generation_jobs VALUES ('replacement-job', 'replacement', 'succeeded')"),
      db.prepare("INSERT INTO provider_cost_events VALUES ('legacy-cost', 'legacy', 123000)"),
      db.prepare("INSERT INTO provider_cost_events VALUES ('replacement-cost', 'replacement', 456000)"),
    ]);

    await applyPromotion(db);
    await applyPromotion(db);

    const { results: arcadeRows } = await db.prepare(`
      SELECT af.fighter_id, af.slug, af.status, af.sort_order, f.name, f.public_flag
      FROM arcade_fighters af
      JOIN fighters f ON f.id = af.fighter_id
      ORDER BY af.slug
    `).all();
    expect(arcadeRows).toEqual([
      {
        fighter_id: 'legacy',
        slug: 'rosalia',
        status: 'retired',
        sort_order: 14,
        name: 'Rosalía',
        public_flag: 0,
      },
      {
        fighter_id: 'replacement',
        slug: 'rosalia-v2',
        status: 'active',
        sort_order: 5,
        name: 'Rosalía',
        public_flag: 1,
      },
    ]);

    const sprites = await db.prepare('SELECT id, fighter_id FROM sprites ORDER BY id').all();
    expect(sprites.results).toEqual([
      { id: 'legacy-idle', fighter_id: 'legacy' },
      { id: 'replacement-idle', fighter_id: 'replacement' },
    ]);
    const jobs = await db.prepare('SELECT id, fighter_id, status FROM generation_jobs ORDER BY id').all();
    expect(jobs.results).toEqual([
      { id: 'legacy-job', fighter_id: 'legacy', status: 'succeeded' },
      { id: 'replacement-job', fighter_id: 'replacement', status: 'succeeded' },
    ]);
    const costs = await db.prepare(`
      SELECT id, fighter_id, estimated_cost_micros FROM provider_cost_events ORDER BY id
    `).all();
    expect(costs.results).toEqual([
      { id: 'legacy-cost', fighter_id: 'legacy', estimated_cost_micros: 123000 },
      { id: 'replacement-cost', fighter_id: 'replacement', estimated_cost_micros: 456000 },
    ]);
  });

  it('does not retire the legacy fighter until an active replacement exists', async () => {
    const { db } = await database();
    await db.batch([
      db.prepare("INSERT INTO fighters VALUES ('legacy', 'Rosalía', 1, 'legacy-before')"),
      db.prepare("INSERT INTO fighters VALUES ('replacement', 'Rosalía V2', 0, 'replacement-before')"),
      db.prepare("INSERT INTO arcade_fighters VALUES ('legacy', 'rosalia', 5, 'active', 'legacy-arcade-before')"),
      db.prepare("INSERT INTO arcade_fighters VALUES ('replacement', 'rosalia-v2', 14, 'draft', 'replacement-arcade-before')"),
    ]);

    await applyPromotion(db);

    const legacy = await db.prepare(`
      SELECT af.status, af.sort_order, f.public_flag
      FROM arcade_fighters af JOIN fighters f ON f.id = af.fighter_id
      WHERE af.slug = 'rosalia'
    `).first();
    expect(legacy).toEqual({ status: 'active', sort_order: 5, public_flag: 1 });
  });
});
