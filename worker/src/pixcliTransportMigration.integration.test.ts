import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = '';
  let trigger = false;
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || (!statement && !line.trim())) continue;
    statement += `${line}\n`;
    if (/^\s*CREATE\s+TRIGGER\b/i.test(line)) trigger = true;
    const complete = trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line);
    if (complete) {
      statements.push(statement.trim());
      statement = '';
      trigger = false;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

async function applyMigration(db: D1Database, migration: string): Promise<void> {
  for (const statement of migrationStatements(
    readFileSync(join(migrationsDirectory, migration), 'utf8'),
  )) {
    await db.prepare(statement).run();
  }
}

async function applyMigrations(db: D1Database, through: string): Promise<void> {
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name <= through)
    .sort()) {
    await applyMigration(db, migration);
  }
}

async function database(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'pixcli-transport-migration-test',
        compatibilityDate: '2026-08-22',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: 'pixcli-transport-migration-db' } },
      },
    }],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

describe('0030 PixCLI transport migration', () => {
  it('preserves the durable ledger and admits only the new PixCLI provider', async () => {
    const { mf, db } = await database();
    try {
      await applyMigrations(db, '0028_sprite_animation_format.sql');
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, display_name, oauth_provider, oauth_id)
          VALUES ('user-pixcli', 'PixCLI User', 'clerk', 'clerk-pixcli')
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
          VALUES ('fighter-pixcli', 'user-pixcli', 'Video Fighter', 'photo-pixcli', 'champion')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, status, reason, fighter_id, expires_at
          ) VALUES (
            'charge-pixcli', 'user-pixcli', 'champion', 'committed',
            'fighter_generation', 'fighter-pixcli', datetime('now', '+1 day')
          )
        `),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, root_job_id,
            original_charge_id, status
          ) VALUES (
            'run-pixcli', 'user-pixcli', 'fighter-pixcli', 'champion',
            'fighter_generation', 'job-pixcli', 'charge-pixcli', 'active'
          )
        `),
        db.prepare(`
          INSERT INTO provider_request_cache (
            id, artifact_run_id, provider, method, request_path, request_hash,
            request_key, status, owner_attempt_id
          ) VALUES (
            'cache-gemini', 'run-pixcli', 'gemini', 'POST', '/proxy/gemini',
            'hash-gemini', 'job:scope', 'failed', 'attempt-gemini'
          )
        `),
        db.prepare(`
          INSERT INTO provider_cost_events (
            id, tier, purpose, billing_operation, provider, model_path,
            estimated_cost_cents, outcome, artifact_run_id
          ) VALUES (
            'cost-gemini', 'champion', 'fighter_generation',
            'fighter_generation', 'gemini', '/proxy/gemini', 8,
            'succeeded', 'run-pixcli'
          )
        `),
      ]);

      await applyMigration(db, '0030_pixcli_transport.sql');

      expect(await db.prepare(`
        SELECT provider, status FROM provider_request_cache WHERE id = 'cache-gemini'
      `).first()).toEqual({ provider: 'gemini', status: 'failed' });
      expect(await db.prepare(`
        SELECT provider, estimated_cost_cents FROM provider_cost_events WHERE id = 'cost-gemini'
      `).first()).toEqual({ provider: 'gemini', estimated_cost_cents: 8 });

      await db.batch([
        db.prepare(`
          INSERT INTO provider_request_cache (
            id, artifact_run_id, provider, method, request_path, request_hash,
            request_key, status, owner_attempt_id
          ) VALUES (
            'cache-pixcli', 'run-pixcli', 'pixcli', 'POST',
            '/proxy/pixcli/api/v1/video/advanced', 'hash-pixcli',
            'job:scope', 'pending', 'attempt-pixcli'
          )
        `),
        db.prepare(`
          INSERT INTO provider_cost_events (
            id, tier, purpose, billing_operation, provider, model_path,
            estimated_cost_cents, outcome, artifact_run_id
          ) VALUES (
            'cost-pixcli', 'champion', 'fighter_generation',
            'fighter_generation', 'pixcli',
            '/proxy/pixcli/api/v1/video/advanced', 33, 'reserved', 'run-pixcli'
          )
        `),
      ]);

      await expect(db.prepare(`
        INSERT INTO provider_cost_events (
          id, tier, purpose, provider, model_path, estimated_cost_cents
        ) VALUES ('cost-unknown', 'champion', 'fighter_generation',
          'unknown-provider', '/unknown', 1)
      `).run()).rejects.toThrow(/CHECK constraint failed/);

      await expect(db.prepare(`
        INSERT INTO provider_request_cache (
          id, artifact_run_id, provider, method, request_path, request_hash,
          request_key, status, owner_attempt_id
        ) VALUES (
          'cache-pixcli-duplicate', 'run-pixcli', 'pixcli', 'POST',
          '/proxy/pixcli/api/v1/video/advanced', 'different-payload-hash',
          'job:scope', 'pending', 'attempt-pixcli-retry'
        )
      `).run()).rejects.toThrow(/UNIQUE constraint failed/);

      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
      expect(await db.prepare(`
        SELECT COUNT(*) AS count FROM provider_request_cache
      `).first()).toEqual({ count: 2 });
      expect(await db.prepare(`
        SELECT COUNT(*) AS count FROM provider_cost_events
      `).first()).toEqual({ count: 2 });
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
