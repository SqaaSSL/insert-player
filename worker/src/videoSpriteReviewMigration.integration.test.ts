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

async function applyMigrations(db: D1Database): Promise<void> {
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name <= '0031_video_sprite_review.sql')
    .sort()) {
    for (const statement of migrationStatements(
      readFileSync(join(migrationsDirectory, migration), 'utf8'),
    )) await db.prepare(statement).run();
  }
}

async function database(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'video-review-migration-test',
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
        env: { DB: { type: 'd1', id: 'video-review-migration-db' } },
      },
    }],
  });
  return { mf, db: await mf.getD1Database('DB') };
}

async function seedJob(
  db: D1Database,
  suffix: string,
  options: { flow?: 'original' | 'video'; resumedFrom?: string | null; runId?: string } = {},
): Promise<void> {
  const flow = options.flow ?? 'video';
  const runId = options.runId ?? `run-${suffix}`;
  await db.batch([
    db.prepare(`
      INSERT INTO generation_charges (
        id, user_id, tier, status, reason, fighter_id, expires_at, creation_flow
      ) VALUES (?, 'user-video-review', 'champion', 'committed',
        'fighter_generation', 'fighter-video-review', datetime('now', '+1 day'), ?)
    `).bind(`charge-${suffix}`, flow),
    db.prepare(`
      INSERT INTO provider_sessions (
        id, user_id, rate_limit_key, tier, purpose, charge_id, status,
        provider_call_limit, provider_cost_limit_cents, expires_at, creation_flow
      ) VALUES (?, 'user-video-review', 'user:user-video-review', 'champion',
        'fighter_generation', ?, 'completed', 320, 1800, datetime('now', '+1 day'), ?)
    `).bind(`session-${suffix}`, `charge-${suffix}`, flow),
    db.prepare(`
      INSERT OR IGNORE INTO generation_artifact_runs (
        id, user_id, fighter_id, tier, operation, root_job_id,
        original_charge_id, status, creation_flow
      ) VALUES (?, 'user-video-review', 'fighter-video-review', 'champion',
        'fighter_generation', ?, ?, 'partial', ?)
    `).bind(runId, `job-${suffix}`, `charge-${suffix}`, flow),
    db.prepare(`
      INSERT INTO generation_jobs (
        id, workflow_instance_id, user_id, fighter_id, charge_id,
        provider_session_id, tier, operation, artifact_run_id,
        resumed_from_job_id, status, creation_flow
      ) VALUES (?, ?, 'user-video-review', 'fighter-video-review', ?, ?,
        'champion', 'fighter_generation', ?, ?, 'succeeded', ?)
    `).bind(
      `job-${suffix}`, `workflow-${suffix}`, `charge-${suffix}`, `session-${suffix}`,
      runId, options.resumedFrom ?? null, flow,
    ),
  ]);
}

describe('0031 video sprite review migration', () => {
  it('applies additively and enforces one review gate and one paid video dispatch per job', async () => {
    const { mf, db } = await database();
    try {
      await applyMigrations(db);
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, display_name, oauth_provider, oauth_id)
          VALUES ('user-video-review', 'Video Review', 'clerk', 'clerk-video-review')
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
          VALUES ('fighter-video-review', 'user-video-review', 'Video Fighter', 'photo', 'champion')
        `),
      ]);
      await seedJob(db, 'root', { runId: 'run-shared' });
      await seedJob(db, 'first', { runId: 'run-shared', resumedFrom: 'job-root' });

      await expect(seedJob(db, 'second', {
        runId: 'run-shared',
        resumedFrom: 'job-root',
      })).rejects.toThrow(/UNIQUE constraint failed/);

      await seedJob(db, 'original-root', { flow: 'original', runId: 'run-original' });
      await seedJob(db, 'original-first', {
        flow: 'original', runId: 'run-original', resumedFrom: 'job-original-root',
      });
      await seedJob(db, 'original-second', {
        flow: 'original', runId: 'run-original', resumedFrom: 'job-original-root',
      });

      await db.prepare(`
        INSERT INTO provider_request_cache (
          id, job_id, artifact_run_id, provider, method, request_path,
          request_hash, request_key, status, owner_attempt_id
        ) VALUES (
          'cache-video-idle', 'job-first', 'run-shared', 'pixcli', 'POST',
          '/proxy/pixcli/api/v1/video/advanced', 'hash-idle',
          'run:run-shared:sprite:idle', 'pending', 'attempt-idle'
        )
      `).run();
      await expect(db.prepare(`
        INSERT INTO provider_request_cache (
          id, job_id, artifact_run_id, provider, method, request_path,
          request_hash, request_key, status, owner_attempt_id
        ) VALUES (
          'cache-video-walk', 'job-first', 'run-shared', 'pixcli', 'POST',
          '/proxy/pixcli/api/v1/video/advanced', 'hash-walk',
          'run:run-shared:sprite:walk', 'pending', 'attempt-walk'
        )
      `).run()).rejects.toThrow(/UNIQUE constraint failed/);

      await db.prepare(`
        INSERT INTO video_sprite_candidates (
          id, run_id, job_id, user_id, fighter_id, action, sequence_order
        ) VALUES (
          'candidate-idle', 'run-shared', 'job-first', 'user-video-review',
          'fighter-video-review', 'idle', 0
        )
      `).run();
      await expect(db.prepare(`
        INSERT INTO video_sprite_candidates (
          id, run_id, job_id, user_id, fighter_id, action, sequence_order
        ) VALUES (
          'candidate-root', 'run-shared', 'job-root', 'user-video-review',
          'fighter-video-review', 'walk', 1
        )
      `).run()).rejects.toThrow(/UNIQUE constraint failed/);

      expect(await db.prepare(`
        SELECT review_status FROM generation_jobs WHERE id = 'job-root'
      `).first()).toEqual({ review_status: 'none' });
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
