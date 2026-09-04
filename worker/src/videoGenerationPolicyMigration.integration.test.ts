import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/0035_video_generation_policies.sql',
);

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
        name: 'video-generation-policy-migration-test',
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
        env: { DB: { type: 'd1', id: 'video-generation-policy-migration-db' } },
      },
    }],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

describe('0034 Video generation policy migration', () => {
  it('freezes existing Video rows as Studio Curated and admits explicit new policies', async () => {
    const { mf, db } = await database();
    try {
      await db.prepare(`
        CREATE TABLE generation_artifact_runs (
          id TEXT PRIMARY KEY,
          fighter_id TEXT NOT NULL,
          creation_flow TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `).run();
      await db.batch([
        db.prepare(`INSERT INTO generation_artifact_runs
          (id, fighter_id, creation_flow, status) VALUES
          ('legacy-video', 'fighter', 'video', 'partial')`),
        db.prepare(`INSERT INTO generation_artifact_runs
          (id, fighter_id, creation_flow, status) VALUES
          ('legacy-original', 'fighter', 'original', 'succeeded')`),
      ]);

      for (const statement of migrationStatements(readFileSync(migrationPath, 'utf8'))) {
        await db.prepare(statement).run();
      }

      expect(await db.prepare(`
        SELECT id, video_generation_policy FROM generation_artifact_runs ORDER BY id
      `).all()).toMatchObject({ results: [
        { id: 'legacy-original', video_generation_policy: null },
        { id: 'legacy-video', video_generation_policy: 'studio_curated_v1' },
      ] });
      await db.prepare(`INSERT INTO generation_artifact_runs
        (id, fighter_id, creation_flow, video_generation_policy, status) VALUES
        ('guided-video', 'fighter', 'video', 'self_service_v1', 'active')`).run();
      await expect(db.prepare(`INSERT INTO generation_artifact_runs
        (id, fighter_id, creation_flow, video_generation_policy, status) VALUES
        ('invalid-video', 'fighter', 'video', 'assistant_decides', 'active')`).run())
        .rejects.toThrow(/CHECK constraint failed/);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
