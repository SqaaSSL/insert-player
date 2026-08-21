import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { reportCommunityFighter } from './fighters';
import { listCommunityReports, moderateCommunityReport } from './moderation';
import type { AuthContext, Env, User } from './types';

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    clerk_user_id TEXT,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    email TEXT,
    plan_tier TEXT NOT NULL DEFAULT 'free',
    credits_balance INTEGER NOT NULL DEFAULT 0,
    free_rookie_generations_used INTEGER NOT NULL DEFAULT 0,
    elo_rating INTEGER NOT NULL DEFAULT 1200,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    total_kos INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Fighter',
    photo_hash TEXT NOT NULL,
    quality_tier TEXT NOT NULL DEFAULT 'contender',
    public_flag INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_user_id, photo_hash)
  );

  CREATE TABLE community_reports (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL,
    fighter_owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    fighter_name TEXT NOT NULL,
    reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL CHECK (reason IN (
      'non_consensual_person',
      'sexual_content',
      'hate_or_harassment',
      'graphic_violence',
      'copyright_or_trademark',
      'personal_information',
      'spam',
      'other'
    )),
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'dismissed', 'actioned')),
    submission_count INTEGER NOT NULL DEFAULT 1 CHECK (submission_count >= 1),
    reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    moderation_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fighter_id, reporter_user_id)
  );
`;

function fakeUser(id: string): User {
  return {
    id,
    clerk_user_id: id,
    display_name: id === 'user-reporter' ? 'Reporter' : 'Owner',
    avatar_url: null,
    email: `${id}@example.com`,
    plan_tier: id === 'user-admin' ? 'admin' : 'free',
    credits_balance: 0,
    free_rookie_generations_used: 0,
    stripe_customer_id: null,
    elo_rating: 1200,
    wins: 0,
    losses: 0,
    win_streak: 0,
    best_streak: 0,
    total_kos: 0,
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
  };
}

function authFor(id: string): AuthContext {
  return { userId: id, user: fakeUser(id), claims: {} };
}

function reportRequest(reason: string, details?: unknown): Request {
  return new Request('https://api.insertplayer.ai/api/community/fighter-public/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, details }),
  });
}

function moderationRequest(
  status: 'reviewing' | 'dismissed' | 'actioned',
  moderationNote?: string,
  unpublishFighter = false,
): Request {
  return new Request('https://api.insertplayer.ai/api/admin/community-reports/report-id', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, moderationNote, unpublishFighter }),
  });
}

async function createBindings(): Promise<{ mf: Miniflare; db: D1Database; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'community-report-test',
        compatibilityDate: '2026-08-17',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: 'test-db' } },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  await db.batch([
    db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
      .bind('user-owner', 'user-owner', 'Owner'),
    db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
      .bind('user-reporter', 'user-reporter', 'Reporter'),
    db.prepare(`
      INSERT INTO users (id, clerk_user_id, display_name, plan_tier)
      VALUES (?, ?, ?, ?)
    `).bind('user-admin', 'user-admin', 'Moderator', 'admin'),
    db.prepare(`
      INSERT INTO fighters (id, owner_user_id, name, photo_hash, public_flag)
      VALUES (?, ?, ?, ?, ?)
    `).bind('fighter-public', 'user-owner', 'Public Hero', 'public-photo', 1),
    db.prepare(`
      INSERT INTO fighters (id, owner_user_id, name, photo_hash, public_flag)
      VALUES (?, ?, ?, ?, ?)
    `).bind('fighter-private', 'user-owner', 'Private Hero', 'private-photo', 0),
  ]);
  return {
    mf,
    db,
    env: { DB: db, ENVIRONMENT: 'development' } as unknown as Env,
  };
}

describe('community reports against real D1 bindings', () => {
  it('persists one report per reporter and reopens it without duplicating the queue', async () => {
    const { mf, db, env } = await createBindings();
    try {
      const first = await reportCommunityFighter(
        reportRequest('non_consensual_person', '  A real person\u0000 asked for removal.  '),
        env,
        authFor('user-reporter'),
        'fighter-public',
      );
      expect(first.status).toBe(201);
      const firstBody = await first.json() as { report: { id: string; duplicate: boolean } };
      expect(firstBody.report.duplicate).toBe(false);

      await db.prepare(`
        UPDATE community_reports SET status = 'dismissed', moderation_note = 'Reviewed'
        WHERE id = ?
      `).bind(firstBody.report.id).run();

      const second = await reportCommunityFighter(
        reportRequest('personal_information', 'A home address is visible.'),
        env,
        authFor('user-reporter'),
        'fighter-public',
      );
      expect(second.status).toBe(200);
      const secondBody = await second.json() as { report: { id: string; duplicate: boolean } };
      expect(secondBody.report).toMatchObject({ id: firstBody.report.id, duplicate: true });

      const reports = await db.prepare('SELECT * FROM community_reports').all<{
        fighter_name: string;
        reason: string;
        details: string;
        status: string;
        submission_count: number;
        moderation_note: string | null;
      }>();
      expect(reports.results).toHaveLength(1);
      expect(reports.results[0]).toMatchObject({
        fighter_name: 'Public Hero',
        reason: 'personal_information',
        details: 'A home address is visible.',
        status: 'open',
        submission_count: 2,
        moderation_note: null,
      });
    } finally {
      await mf.dispose();
    }
  });

  it('rejects unsupported reasons and oversized detail text', async () => {
    const { mf, db, env } = await createBindings();
    try {
      const invalidReason = await reportCommunityFighter(
        reportRequest('not-a-real-reason'),
        env,
        authFor('user-reporter'),
        'fighter-public',
      );
      const oversizedDetails = await reportCommunityFighter(
        reportRequest('other', 'x'.repeat(501)),
        env,
        authFor('user-reporter'),
        'fighter-public',
      );

      expect(invalidReason.status).toBe(400);
      expect(oversizedDetails.status).toBe(400);
      const count = await db.prepare('SELECT COUNT(*) AS count FROM community_reports')
        .first<{ count: number }>();
      expect(count?.count).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it('does not expose private targets and directs owners to unpublish their own fighter', async () => {
    const { mf, env } = await createBindings();
    try {
      const privateTarget = await reportCommunityFighter(
        reportRequest('other'),
        env,
        authFor('user-reporter'),
        'fighter-private',
      );
      const ownTarget = await reportCommunityFighter(
        reportRequest('other'),
        env,
        authFor('user-owner'),
        'fighter-public',
      );

      expect(privateTarget.status).toBe(404);
      expect(ownTarget.status).toBe(409);
    } finally {
      await mf.dispose();
    }
  });

  it('keeps the queue admin-only and requires an audited note for closing actions', async () => {
    const { mf, db, env } = await createBindings();
    try {
      const created = await reportCommunityFighter(
        reportRequest('hate_or_harassment', 'Targeted slur in the fighter name.'),
        env,
        authFor('user-reporter'),
        'fighter-public',
      );
      const createdBody = await created.json() as { report: { id: string } };

      const denied = await listCommunityReports(
        new Request('https://api.insertplayer.ai/api/admin/community-reports'),
        env,
        authFor('user-reporter'),
      );
      expect(denied.status).toBe(403);

      const queue = await listCommunityReports(
        new Request('https://api.insertplayer.ai/api/admin/community-reports?status=open'),
        env,
        authFor('user-admin'),
      );
      expect(queue.status).toBe(200);
      const queueBody = await queue.json() as { reports: Array<{ id: string; fighterPublic: boolean }> };
      expect(queueBody.reports).toEqual([
        expect.objectContaining({ id: createdBody.report.id, fighterPublic: true }),
      ]);

      const missingNote = await moderateCommunityReport(
        moderationRequest('actioned', undefined, true),
        env,
        authFor('user-admin'),
        createdBody.report.id,
      );
      expect(missingNote.status).toBe(400);

      const actioned = await moderateCommunityReport(
        moderationRequest('actioned', 'Removed after manual review.', true),
        env,
        authFor('user-admin'),
        createdBody.report.id,
      );
      expect(actioned.status).toBe(200);
      const actionedBody = await actioned.json() as {
        report: { status: string; fighterPublic: boolean; reviewedByUserId: string; moderationNote: string };
      };
      expect(actionedBody.report).toMatchObject({
        status: 'actioned',
        fighterPublic: false,
        reviewedByUserId: 'user-admin',
        moderationNote: 'Removed after manual review.',
      });
      const fighter = await db.prepare('SELECT public_flag FROM fighters WHERE id = ?')
        .bind('fighter-public').first<{ public_flag: number }>();
      expect(fighter?.public_flag).toBe(0);
    } finally {
      await mf.dispose();
    }
  });
});
