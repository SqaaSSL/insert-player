import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  authorizeGenerationPurchase,
  completeGenerationPurchase,
  handleStripeWebhook,
  settleGenerationPurchase,
} from './billing';
import { CURRENT_LEGAL_VERSION } from './legal';
import type { AuthContext, Env, PublicAuthContext } from './types';

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    clerk_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    credits_balance INTEGER NOT NULL DEFAULT 0,
    free_rookie_generations_used INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    fighter_id TEXT,
    stripe_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_credit_ledger_stripe_session
    ON credit_ledger(stripe_session_id);

  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE generation_charges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier TEXT NOT NULL,
    creation_flow TEXT NOT NULL DEFAULT 'original',
    credit_cost INTEGER NOT NULL DEFAULT 0,
    free_quota_delta INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    fighter_id TEXT REFERENCES fighters(id) ON DELETE SET NULL,
    ledger_id TEXT REFERENCES credit_ledger(id) ON DELETE SET NULL,
    refund_ledger_id TEXT REFERENCES credit_ledger(id) ON DELETE SET NULL,
    continuation_run_id TEXT,
    resumed_from_job_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    rate_limit_key TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL DEFAULT 'rookie',
    creation_flow TEXT NOT NULL DEFAULT 'original',
    purpose TEXT NOT NULL DEFAULT 'fighter_generation',
    charge_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    provider_calls_used INTEGER NOT NULL DEFAULT 0,
    provider_call_limit INTEGER NOT NULL DEFAULT 0,
    provider_cost_used_cents INTEGER NOT NULL DEFAULT 0,
    provider_cost_limit_cents INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL DEFAULT (datetime('now', '+12 hours')),
    legal_version TEXT NOT NULL DEFAULT 'legacy',
    age_confirmed INTEGER NOT NULL DEFAULT 0,
    photo_rights_confirmed INTEGER NOT NULL DEFAULT 0,
    ai_processing_confirmed INTEGER NOT NULL DEFAULT 0,
    immediate_performance_confirmed INTEGER NOT NULL DEFAULT 0,
    withdrawal_loss_acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    fighter_id TEXT,
    charge_id TEXT,
    artifact_run_id TEXT,
    tier TEXT,
    creation_flow TEXT NOT NULL DEFAULT 'original',
    operation TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    review_status TEXT NOT NULL DEFAULT 'none',
    resumed_from_job_id TEXT
  );

  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fighter_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    creation_flow TEXT NOT NULL DEFAULT 'original',
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE video_sprite_candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    fighter_id TEXT NOT NULL,
    action TEXT NOT NULL,
    sequence_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_review',
    current_revision INTEGER NOT NULL DEFAULT 1,
    approved_revision INTEGER
  );

  CREATE TABLE video_sprite_candidate_revisions (
    candidate_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    report_sha256 TEXT NOT NULL,
    PRIMARY KEY(candidate_id, revision)
  );

  CREATE TABLE provider_cost_events (
    id TEXT PRIMARY KEY,
    artifact_run_id TEXT,
    estimated_cost_cents INTEGER NOT NULL
  );

  CREATE TABLE legal_acceptances (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    subject_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    context_id TEXT NOT NULL,
    legal_version TEXT NOT NULL,
    age_confirmed INTEGER NOT NULL,
    terms_accepted INTEGER NOT NULL,
    photo_rights_confirmed INTEGER NOT NULL,
    ai_processing_confirmed INTEGER NOT NULL,
    immediate_performance_confirmed INTEGER NOT NULL,
    refund_policy_acknowledged INTEGER NOT NULL,
    immediate_delivery_confirmed INTEGER NOT NULL,
    withdrawal_loss_acknowledged INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(action, context_id)
  );

  CREATE TABLE checkout_sessions (
    id TEXT PRIMARY KEY,
    stripe_session_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    legal_version TEXT NOT NULL,
    terms_accepted INTEGER NOT NULL,
    immediate_delivery_confirmed INTEGER NOT NULL,
    withdrawal_loss_acknowledged INTEGER NOT NULL,
    stripe_customer_id TEXT,
    stripe_payment_intent_id TEXT,
    refunded_amount_cents INTEGER NOT NULL DEFAULT 0,
    refunded_credits INTEGER NOT NULL DEFAULT 0,
    disputed_amount_cents INTEGER NOT NULL DEFAULT 0,
    disputed_credits INTEGER NOT NULL DEFAULT 0,
    reversed_credits INTEGER NOT NULL DEFAULT 0,
    dispute_event_created INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_checkout_sessions_payment_intent
    ON checkout_sessions(stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

  CREATE TABLE stripe_credit_adjustments (
    id TEXT PRIMARY KEY,
    stripe_event_id TEXT NOT NULL UNIQUE,
    checkout_session_id TEXT NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    stripe_object_id TEXT,
    amount_cents INTEGER NOT NULL,
    credits_delta INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const webhookSecret = 'whsec_insert_player_integration';
const stripeAccountId = 'acct_insertplayer';

function metadata(sessionToken: string, userId: string) {
  return {
    user_id: userId,
    pack_id: 'starter',
    credits: '11',
    session_token: sessionToken,
    stripe_account_id: stripeAccountId,
    legal_version: CURRENT_LEGAL_VERSION,
    terms_accepted: 'true',
    immediate_delivery_confirmed: 'true',
    withdrawal_loss_acknowledged: 'true',
  };
}

async function signedWebhookRequest(event: Record<string, unknown>): Promise<Request> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const signature = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://api.insertplayer.ai/api/billing/stripe-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': `t=${timestamp},v1=${signature}`,
    },
    body,
  });
}

async function createBindings(): Promise<{ mf: Miniflare; db: D1Database; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'billing-adjustment-test',
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
  const env = {
    DB: db,
    ENVIRONMENT: 'production',
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_ACCOUNT_ID: stripeAccountId,
  } as unknown as Env;
  return { mf, db, env };
}

async function insertPaidCheckout(
  db: D1Database,
  userId: string,
  sessionToken: string,
  stripeSessionId: string,
  paymentIntentId: string,
  balance = 11,
): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO users (id, clerk_user_id, display_name, credits_balance, stripe_customer_id)
      VALUES (?, ?, ?, ?, 'cus_insertplayer')
    `).bind(userId, userId, userId, balance),
    db.prepare(`
      INSERT INTO checkout_sessions (
        id, stripe_session_id, stripe_payment_intent_id, user_id, pack_id,
        credits, amount_cents, currency, status, legal_version,
        terms_accepted, immediate_delivery_confirmed, withdrawal_loss_acknowledged,
        stripe_customer_id
      ) VALUES (?, ?, ?, ?, 'starter', 11, 1499, 'eur', 'paid', ?, 1, 1, 1, 'cus_insertplayer')
    `).bind(sessionToken, stripeSessionId, paymentIntentId, userId, CURRENT_LEGAL_VERSION),
  ]);
}

describe('Generation purchase fighter linkage against D1', () => {
  it('rejects video action retries before reservation and permits a fresh full restart', async () => {
    const { mf, db, env } = await createBindings();
    const userId = 'user-video-full-restart';
    const fighterId = '13131313131313131313131313131313';
    const rejectedRunId = '24242424242424242424242424242424';
    const rejectedJobId = '35353535353535353535353535353535';
    const auth = {
      userId, rateLimitKey: `user:${userId}`, claims: {}, user: { id: userId },
    } as unknown as PublicAuthContext;
    const legal = {
      legalVersion: CURRENT_LEGAL_VERSION, ageConfirmed: true, termsAccepted: true,
      photoRightsConfirmed: true, aiProcessingConfirmed: true,
      immediatePerformanceConfirmed: true, withdrawalLossAcknowledged: true,
    };
    try {
      await db.batch([
        db.prepare(`INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES (?, ?, 'Video Full Restart', 30)`).bind(userId, userId),
        db.prepare('INSERT INTO fighters (id, owner_user_id) VALUES (?, ?)').bind(fighterId, userId),
        db.prepare(`INSERT INTO generation_artifact_runs (
          id, user_id, fighter_id, tier, creation_flow, operation, status
        ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', 'failed')`)
          .bind(rejectedRunId, userId, fighterId),
        db.prepare(`INSERT INTO generation_jobs (
          id, user_id, fighter_id, artifact_run_id, tier, creation_flow,
          operation, status, review_status
        ) VALUES (?, ?, ?, ?, 'champion', 'video', 'fighter_generation',
          'succeeded', 'rejected')`).bind(rejectedJobId, userId, fighterId, rejectedRunId),
        db.prepare(`INSERT INTO video_sprite_candidates (
          id, run_id, job_id, user_id, fighter_id, action, sequence_order, status
        ) VALUES ('candidate-full-restart', ?, ?, ?, ?, 'high_kick', 3, 'rejected')`)
          .bind(rejectedRunId, rejectedJobId, userId, fighterId),
      ]);

      const retry = await authorizeGenerationPurchase(new Request(
        'https://api.insertplayer.ai/api/billing/generation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fighterId, tier: 'champion', creationFlow: 'video',
            operation: 'fighter_retry_animation', targetKind: 'animation',
            targetName: 'high_kick', legal,
          }),
        },
      ), env, auth);
      expect(retry.status).toBe(400);
      expect(await retry.json()).toMatchObject({ code: 'video_creation_operation_unsupported' });
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_charges')
        .first<{ count: number }>())?.count).toBe(0);
      expect((await db.prepare('SELECT COUNT(*) AS count FROM provider_sessions')
        .first<{ count: number }>())?.count).toBe(0);

      const restart = await authorizeGenerationPurchase(new Request(
        'https://api.insertplayer.ai/api/billing/generation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fighterId, tier: 'champion', creationFlow: 'video',
            operation: 'fighter_generation', legal,
          }),
        },
      ), env, auth);
      expect(restart.status).toBe(200);
      expect(await restart.json()).toMatchObject({
        mode: 'credits', creationFlow: 'video', creditsCharged: 18,
      });
      expect((await db.prepare('SELECT COUNT(*) AS count FROM generation_charges')
        .first<{ count: number }>())?.count).toBe(1);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('resumes a local video failure on the same run but starts a fresh paid run after terminal abandonment', async () => {
    const { mf, db, env } = await createBindings();
    const userId = 'user-video-resume';
    const fighterId = 'abababababababababababababababab';
    const localJobId = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
    const terminalJobId = 'efefefefefefefefefefefefefefefef';
    const auth = {
      userId,
      rateLimitKey: `user:${userId}`,
      claims: {},
      user: { id: userId },
    } as unknown as PublicAuthContext;
    const legal = {
      legalVersion: CURRENT_LEGAL_VERSION,
      ageConfirmed: true,
      termsAccepted: true,
      photoRightsConfirmed: true,
      aiProcessingConfirmed: true,
      immediatePerformanceConfirmed: true,
      withdrawalLossAcknowledged: true,
    };
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES (?, ?, 'Video Resume', 30)
        `).bind(userId, userId),
        db.prepare('INSERT INTO fighters (id, owner_user_id) VALUES (?, ?)')
          .bind(fighterId, userId),
        ...[localJobId, terminalJobId].flatMap((jobId, index) => [
          db.prepare(`
            INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
            VALUES (?, ?, -18, 'fighter_generation', ?)
          `).bind(`ledger-video-${index}`, userId, fighterId),
          db.prepare(`
            INSERT INTO generation_charges (
              id, user_id, tier, creation_flow, credit_cost, status, reason,
              fighter_id, ledger_id, expires_at
            ) VALUES (?, ?, 'champion', 'video', 18, 'committed',
              'fighter_generation', ?, ?, datetime('now', '+1 day'))
          `).bind(`charge-video-${index}`, userId, fighterId, `ledger-video-${index}`),
          db.prepare(`
            INSERT INTO generation_artifact_runs (
              id, user_id, fighter_id, tier, creation_flow, operation, status
            ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_generation', ?)
          `).bind(jobId, userId, fighterId, index === 0 ? 'partial' : 'failed'),
          db.prepare(`
            INSERT INTO generation_jobs (
              id, user_id, fighter_id, charge_id, artifact_run_id, tier,
              creation_flow, operation, status
            ) VALUES (?, ?, ?, ?, ?, 'champion', 'video', 'fighter_generation', 'failed')
          `).bind(jobId, userId, fighterId, `charge-video-${index}`, jobId),
        ]),
      ]);

      for (const blocked of [
        { tier: 'champion', creationFlow: 'original', operation: 'fighter_generation' },
        { tier: 'champion', creationFlow: 'video', operation: 'fighter_generation' },
        { tier: 'champion', creationFlow: 'original', operation: 'fighter_upgrade' },
        {
          tier: 'champion', creationFlow: 'original', operation: 'fighter_retry_animation',
          targetKind: 'animation', targetName: 'idle',
        },
      ]) {
        const blockedFresh = await authorizeGenerationPurchase(new Request(
          'https://api.insertplayer.ai/api/billing/generation', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fighterId, ...blocked, legal }),
          },
        ), env, auth);
        expect(blockedFresh.status).toBe(409);
        expect(await blockedFresh.json()).toMatchObject({ code: 'video_run_in_progress' });
      }

      const localResume = await authorizeGenerationPurchase(new Request(
        'https://api.insertplayer.ai/api/billing/generation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fighterId, tier: 'champion', creationFlow: 'video',
            operation: 'fighter_generation', resumeJobId: localJobId, legal,
          }),
        },
      ), env, auth);
      expect(localResume.status).toBe(200);
      expect(await localResume.json()).toMatchObject({
        mode: 'continuation', creditsCharged: 0, artifactRunId: localJobId,
      });

      await db.prepare(`
        UPDATE generation_artifact_runs SET status = 'failed' WHERE id = ?
      `).bind(localJobId).run();
      const freshRetry = await authorizeGenerationPurchase(new Request(
        'https://api.insertplayer.ai/api/billing/generation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fighterId, tier: 'champion', creationFlow: 'video',
            operation: 'fighter_generation', legal,
          }),
        },
      ), env, auth);
      expect(freshRetry.status).toBe(200);
      expect(await freshRetry.json()).toMatchObject({
        mode: 'credits', creationFlow: 'video',
      });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('never authorizes a continuation after the exact retry action is already approved', async () => {
    const { mf, db, env } = await createBindings();
    const userId = 'user-video-final-race';
    const fighterId = '12121212121212121212121212121212';
    const jobId = '34343434343434343434343434343434';
    const auth = {
      userId, rateLimitKey: `user:${userId}`, claims: {}, user: { id: userId },
    } as unknown as PublicAuthContext;
    const legal = {
      legalVersion: CURRENT_LEGAL_VERSION, ageConfirmed: true, termsAccepted: true,
      photoRightsConfirmed: true, aiProcessingConfirmed: true,
      immediatePerformanceConfirmed: true, withdrawalLossAcknowledged: true,
    };
    try {
      await db.batch([
        db.prepare(`INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES (?, ?, 'Final Race', 30)`).bind(userId, userId),
        db.prepare('INSERT INTO fighters (id, owner_user_id) VALUES (?, ?)').bind(fighterId, userId),
        db.prepare(`INSERT INTO generation_charges (
          id, user_id, tier, creation_flow, credit_cost, status, reason, fighter_id, expires_at
        ) VALUES ('charge-final-race', ?, 'champion', 'video', 18, 'committed',
          'fighter_retry_animation', ?, datetime('now', '+1 day'))`).bind(userId, fighterId),
        db.prepare(`INSERT INTO generation_artifact_runs (
          id, user_id, fighter_id, tier, creation_flow, operation, status
        ) VALUES (?, ?, ?, 'champion', 'video', 'fighter_retry_animation', 'partial')`)
          .bind(jobId, userId, fighterId),
        db.prepare(`INSERT INTO generation_jobs (
          id, user_id, fighter_id, charge_id, artifact_run_id, tier, creation_flow,
          operation, status, review_status
        ) VALUES (?, ?, ?, 'charge-final-race', ?, 'champion', 'video',
          'fighter_retry_animation', 'succeeded', 'approved')`)
          .bind(jobId, userId, fighterId, jobId),
        db.prepare(`INSERT INTO video_sprite_candidates (
          id, run_id, job_id, user_id, fighter_id, action, sequence_order,
          status, current_revision, approved_revision
        ) VALUES ('candidate-final-race', ?, ?, ?, ?, 'idle', 0, 'approved', 1, 1)`)
          .bind(jobId, jobId, userId, fighterId),
        db.prepare(`INSERT INTO video_sprite_candidate_revisions (
          candidate_id, revision, report_sha256
        ) VALUES ('candidate-final-race', 1, ?)`).bind('a'.repeat(64)),
      ]);
      const response = await authorizeGenerationPurchase(new Request(
        'https://api.insertplayer.ai/api/billing/generation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fighterId, tier: 'champion', creationFlow: 'video',
            operation: 'fighter_retry_animation', targetKind: 'animation', targetName: 'idle',
            resumeJobId: jobId, legal,
          }),
        },
      ), env, auth);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'video_creation_operation_unsupported' });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('authorizes an idempotent zero-credit continuation for committed partial work', async () => {
    const { mf, db, env } = await createBindings();
    const userId = 'user-resume';
    const fighterId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const failedJobId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const originalChargeId = 'cccccccccccccccccccccccccccccccc';
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (
            id, clerk_user_id, display_name, credits_balance, free_rookie_generations_used
          ) VALUES (?, ?, 'Resume Player', 9, 1)
        `).bind(userId, userId),
        db.prepare('INSERT INTO fighters (id, owner_user_id) VALUES (?, ?)')
          .bind(fighterId, userId),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-original', ?, -7, 'fighter_generation', ?)
        `).bind(userId, fighterId),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason,
            fighter_id, ledger_id, expires_at
          ) VALUES (?, ?, 'champion', 7, 'committed', 'fighter_generation',
            ?, 'ledger-original', datetime('now', '-1 hour'))
        `).bind(originalChargeId, userId, fighterId),
        db.prepare(`
          INSERT INTO generation_artifact_runs (
            id, user_id, fighter_id, tier, operation, status
          ) VALUES (?, ?, ?, 'champion', 'fighter_generation', 'partial')
        `).bind(failedJobId, userId, fighterId),
        db.prepare(`
          INSERT INTO generation_jobs (
            id, user_id, fighter_id, charge_id, artifact_run_id,
            tier, operation, status
          ) VALUES (?, ?, ?, ?, ?, 'champion', 'fighter_generation', 'failed')
        `).bind(failedJobId, userId, fighterId, originalChargeId, failedJobId),
        db.prepare(`
          WITH RECURSIVE sequence(value) AS (
            SELECT 1
            UNION ALL
            SELECT value + 1 FROM sequence WHERE value < 101
          )
          INSERT INTO provider_cost_events (id, artifact_run_id, estimated_cost_cents)
          SELECT
            printf('historical-call-%03d', value),
            ?,
            CASE WHEN value = 101 THEN 85 ELSE 8 END
          FROM sequence
        `).bind(failedJobId),
      ]);
      const auth = {
        userId,
        rateLimitKey: `user:${userId}`,
        claims: {},
        user: { id: userId },
      } as unknown as PublicAuthContext;
      const request = () => new Request(
        'https://api.insertplayer.ai/api/billing/generation',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fighterId,
            tier: 'champion',
            operation: 'fighter_generation',
            resumeJobId: failedJobId,
            legal: {
              legalVersion: CURRENT_LEGAL_VERSION,
              ageConfirmed: true,
              termsAccepted: true,
              photoRightsConfirmed: true,
              aiProcessingConfirmed: true,
              immediatePerformanceConfirmed: true,
              withdrawalLossAcknowledged: true,
            },
          }),
        },
      );

      const first = await authorizeGenerationPurchase(request(), env, auth);
      expect(first.status).toBe(200);
      const firstBody = await first.json() as Record<string, unknown>;
      expect(firstBody).toMatchObject({
        authorized: true,
        mode: 'continuation',
        creditsCharged: 0,
        artifactRunId: failedJobId,
        resumedFromJobId: failedJobId,
        providerCallLimit: 219,
        providerCostLimitCents: 915,
        creationFlow: 'original',
      });
      const duplicate = await authorizeGenerationPurchase(request(), env, auth);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({
        mode: 'continuation',
        purchaseId: firstBody.purchaseId,
        creditsCharged: 0,
      });

      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind(userId).first<{ credits_balance: number }>())?.credits_balance).toBe(9);
      expect((await db.prepare(`
        SELECT credit_cost, free_quota_delta, continuation_run_id, resumed_from_job_id,
               creation_flow
        FROM generation_charges
        WHERE continuation_run_id = ?
      `).bind(failedJobId).first())).toEqual({
        credit_cost: 0,
        free_quota_delta: 0,
        continuation_run_id: failedJobId,
        resumed_from_job_id: failedJobId,
        creation_flow: 'original',
      });
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM generation_charges WHERE continuation_run_id = ?
      `).bind(failedJobId).first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM credit_ledger
        WHERE user_id = ? AND reason = 'fighter_generation_continuation'
      `).bind(userId).first<{ count: number }>())?.count).toBe(1);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM provider_sessions WHERE charge_id = ?
      `).bind(firstBody.purchaseId).first<{ count: number }>())?.count).toBe(1);
      expect(await db.prepare(`
        SELECT provider_call_limit, provider_cost_limit_cents, creation_flow
        FROM provider_sessions WHERE charge_id = ?
      `).bind(firstBody.purchaseId).first()).toEqual({
        provider_call_limit: 219,
        provider_cost_limit_cents: 915,
        creation_flow: 'original',
      });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('exposes only a pre-provider reservation release and remains idempotent', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES ('user-release', 'user-release', 'Release Player', 8)
        `),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason)
          VALUES ('ledger-release', 'user-release', -2, 'fighter_generation')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, ledger_id, expires_at
          ) VALUES (
            'purchase-release', 'user-release', 'rookie', 2, 'reserved',
            'fighter_generation', 'ledger-release', datetime('now', '+1 hour')
          )
        `),
      ]);
      const auth = { userId: 'user-release' } as AuthContext;
      const request = () => new Request(
        'https://api.insertplayer.ai/api/billing/generation/complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purchaseId: 'purchase-release', success: false }),
        },
      );

      const first = await (await completeGenerationPurchase(request(), env, auth)).json() as Record<string, unknown>;
      expect(first).toMatchObject({
        purchaseId: 'purchase-release',
        status: 'released',
        reservationReleased: true,
        creditsReleased: 2,
        creditsBalance: 10,
      });
      expect(first).not.toHaveProperty('creditsRefunded');

      const duplicate = await (await completeGenerationPurchase(request(), env, auth)).json();
      expect(duplicate).toMatchObject({ status: 'released', creditsBalance: 10 });
      expect((await db.prepare(`
        SELECT status FROM generation_charges WHERE id = 'purchase-release'
      `).first<{ status: string }>())?.status).toBe('refunded');
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM credit_ledger
        WHERE user_id = 'user-release' AND reason = 'generation_reservation_release:purchase-release'
      `).first<{ count: number }>())?.count).toBe(1);
    } finally {
      await mf.dispose();
    }
  });

  it('links a committed purchase after cloud creation and remains idempotent', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES ('user-generation', 'user-generation', 'Generation Player', 0)
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id)
          VALUES ('fighter-generation', 'user-generation')
        `),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason)
          VALUES ('ledger-generation', 'user-generation', 0, 'fighter_generation')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, ledger_id, expires_at
          ) VALUES (
            'purchase-generation', 'user-generation', 'rookie', 0, 'committed',
            'fighter_generation', 'ledger-generation', datetime('now', '+1 hour')
          )
        `),
      ]);
      const auth = { userId: 'user-generation' } as AuthContext;
      const request = () => new Request(
        'https://api.insertplayer.ai/api/billing/generation/complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            purchaseId: 'purchase-generation',
            success: true,
            fighterId: 'fighter-generation',
          }),
        },
      );

      const first = await completeGenerationPurchase(request(), env, auth);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        purchaseId: 'purchase-generation',
        status: 'committed',
        fighterId: 'fighter-generation',
      });
      expect(await (await completeGenerationPurchase(request(), env, auth)).json()).toMatchObject({
        status: 'committed',
        fighterId: 'fighter-generation',
      });

      const charge = await db.prepare(`
        SELECT fighter_id FROM generation_charges WHERE id = 'purchase-generation'
      `).first<{ fighter_id: string | null }>();
      const ledger = await db.prepare(`
        SELECT fighter_id FROM credit_ledger WHERE id = 'ledger-generation'
      `).first<{ fighter_id: string | null }>();
      expect(charge?.fighter_id).toBe('fighter-generation');
      expect(ledger?.fighter_id).toBe('fighter-generation');
    } finally {
      await mf.dispose();
    }
  });

  it('commits the charge and durable job state in one batch', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES ('user-atomic', 'user-atomic', 'Atomic Player', 0)
        `),
        db.prepare(`INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-atomic', 'user-atomic')`),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-atomic', 'user-atomic', -3, 'fighter_generation', 'fighter-atomic')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (
            'purchase-atomic', 'user-atomic', 'rookie', 3, 'reserved',
            'fighter_generation', 'fighter-atomic', 'ledger-atomic', datetime('now', '+1 hour')
          )
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, status)
          VALUES ('provider-atomic', 'user-atomic', 'purchase-atomic', 'active')
        `),
        db.prepare(`INSERT INTO generation_jobs (id, status) VALUES ('job-atomic', 'running')`),
      ]);

      const settlement = await settleGenerationPurchase(
        env,
        'user-atomic',
        'purchase-atomic',
        true,
        'fighter-atomic',
        [db.prepare(`UPDATE generation_jobs SET status = 'succeeded' WHERE id = 'job-atomic'`)],
      );

      expect(settlement?.status).toBe('committed');
      expect((await db.prepare(`SELECT status FROM generation_jobs WHERE id = 'job-atomic'`)
        .first<{ status: string }>())?.status).toBe('succeeded');
      expect((await db.prepare(`SELECT status FROM provider_sessions WHERE id = 'provider-atomic'`)
        .first<{ status: string }>())?.status).toBe('completed');
    } finally {
      await mf.dispose();
    }
  });

  it('closes the provider session without refunding after paid processing has started', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES ('user-paid-failure', 'user-paid-failure', 'Paid Failure Player', 4)
        `),
        db.prepare(`
          INSERT INTO fighters (id, owner_user_id)
          VALUES ('fighter-paid-failure', 'user-paid-failure')
        `),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES (
            'ledger-paid-failure', 'user-paid-failure', -3,
            'fighter_generation', 'fighter-paid-failure'
          )
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (
            'purchase-paid-failure', 'user-paid-failure', 'champion', 3, 'committed',
            'fighter_generation', 'fighter-paid-failure', 'ledger-paid-failure',
            datetime('now', '+1 hour')
          )
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, status)
          VALUES (
            'provider-paid-failure', 'user-paid-failure',
            'purchase-paid-failure', 'active'
          )
        `),
      ]);

      const settlement = await settleGenerationPurchase(
        env,
        'user-paid-failure',
        'purchase-paid-failure',
        false,
        'fighter-paid-failure',
      );

      expect(settlement?.status).toBe('committed');
      expect((await db.prepare(`
        SELECT status FROM provider_sessions WHERE id = 'provider-paid-failure'
      `).first<{ status: string }>())?.status).toBe('cancelled');
      expect((await db.prepare(`
        SELECT credits_balance FROM users WHERE id = 'user-paid-failure'
      `).first<{ credits_balance: number }>())?.credits_balance).toBe(4);
      expect((await db.prepare(`
        SELECT COUNT(*) AS count FROM credit_ledger
        WHERE user_id = 'user-paid-failure'
          AND reason = 'generation_reservation_release:purchase-paid-failure'
      `).first<{ count: number }>())?.count).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it('rejects browser settlement after a durable job takes ownership', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES ('user-managed', 'user-managed', 'Managed Player', 4)
        `),
        db.prepare(`INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-managed', 'user-managed')`),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-managed', 'user-managed', -2, 'fighter_generation', 'fighter-managed')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (
            'purchase-managed', 'user-managed', 'rookie', 2, 'reserved',
            'fighter_generation', 'fighter-managed', 'ledger-managed', datetime('now', '+1 hour')
          )
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, status)
          VALUES ('provider-managed', 'user-managed', 'purchase-managed', 'active')
        `),
        db.prepare(`INSERT INTO generation_jobs (id, status) VALUES ('purchase-managed', 'running')`),
      ]);

      const response = await completeGenerationPurchase(new Request(
        'https://api.insertplayer.ai/api/billing/generation/complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            purchaseId: 'purchase-managed',
            success: false,
            fighterId: 'fighter-managed',
          }),
        },
      ), env, { userId: 'user-managed' } as AuthContext);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'durable_generation_settlement_managed',
        jobStatus: 'running',
      });
      expect((await db.prepare(`
        SELECT status FROM generation_charges WHERE id = 'purchase-managed'
      `).first<{ status: string }>())?.status).toBe('reserved');
      expect((await db.prepare(`
        SELECT status FROM provider_sessions WHERE id = 'provider-managed'
      `).first<{ status: string }>())?.status).toBe('active');
    } finally {
      await mf.dispose();
    }
  });

  it('keeps a reservation uncommitted when the durable completion batch fails', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance)
          VALUES ('user-rollback', 'user-rollback', 'Rollback Player', 0)
        `),
        db.prepare(`INSERT INTO fighters (id, owner_user_id) VALUES ('fighter-rollback', 'user-rollback')`),
        db.prepare(`
          INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
          VALUES ('ledger-rollback', 'user-rollback', -3, 'fighter_generation', 'fighter-rollback')
        `),
        db.prepare(`
          INSERT INTO generation_charges (
            id, user_id, tier, credit_cost, status, reason, fighter_id, ledger_id, expires_at
          ) VALUES (
            'purchase-rollback', 'user-rollback', 'rookie', 3, 'reserved',
            'fighter_generation', 'fighter-rollback', 'ledger-rollback', datetime('now', '+1 hour')
          )
        `),
        db.prepare(`
          INSERT INTO provider_sessions (id, user_id, charge_id, status)
          VALUES ('provider-rollback', 'user-rollback', 'purchase-rollback', 'active')
        `),
        db.prepare(`INSERT INTO generation_jobs (id, status) VALUES ('job-rollback', 'running')`),
      ]);

      await expect(settleGenerationPurchase(
        env,
        'user-rollback',
        'purchase-rollback',
        true,
        'fighter-rollback',
        [db.prepare(`UPDATE generation_jobs SET status = NULL WHERE id = 'job-rollback'`)],
      )).rejects.toThrow();

      expect((await db.prepare(`SELECT status FROM generation_charges WHERE id = 'purchase-rollback'`)
        .first<{ status: string }>())?.status).toBe('reserved');
      expect((await db.prepare(`SELECT status FROM generation_jobs WHERE id = 'job-rollback'`)
        .first<{ status: string }>())?.status).toBe('running');
      expect((await db.prepare(`SELECT status FROM provider_sessions WHERE id = 'provider-rollback'`)
        .first<{ status: string }>())?.status).toBe('active');
    } finally {
      await mf.dispose();
    }
  });
});

describe('Stripe refund and dispute reconciliation against D1', () => {
  it('reverses refunds once and restores credits after a won dispute', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await insertPaidCheckout(db, 'user-refund', 'checkout-refund', 'cs_refund', 'pi_refund', 1);
      const partialRefund = {
        id: 'evt_refund_partial',
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        livemode: true,
        data: {
          object: {
            id: 'ch_refund',
            object: 'charge',
            amount: 1499,
            amount_refunded: 750,
            currency: 'eur',
            customer: 'cus_insertplayer',
            payment_intent: 'pi_refund',
            refunded: false,
            metadata: metadata('checkout-refund', 'user-refund'),
          },
        },
      };
      const first = await handleStripeWebhook(await signedWebhookRequest(partialRefund), env);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ creditStatus: 'reversed' });

      const duplicate = await handleStripeWebhook(await signedWebhookRequest(partialRefund), env);
      expect(await duplicate.json()).toMatchObject({ duplicate: true });
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind('user-refund').first<{ credits_balance: number }>())?.credits_balance).toBe(-5);

      const fullRefund = {
        ...partialRefund,
        id: 'evt_refund_full',
        created: partialRefund.created + 1,
        data: {
          object: {
            ...partialRefund.data.object,
            amount_refunded: 1499,
            refunded: true,
          },
        },
      };
      expect(await (await handleStripeWebhook(await signedWebhookRequest(fullRefund), env)).json())
        .toMatchObject({ creditStatus: 'reversed' });
      const refundedState = await db.prepare(`
        SELECT status, refunded_credits, reversed_credits
        FROM checkout_sessions WHERE id = 'checkout-refund'
      `).first<{ status: string; refunded_credits: number; reversed_credits: number }>();
      expect(refundedState).toMatchObject({ status: 'refunded', refunded_credits: 11, reversed_credits: 11 });
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind('user-refund').first<{ credits_balance: number }>())?.credits_balance).toBe(-10);

      await insertPaidCheckout(db, 'user-dispute', 'checkout-dispute', 'cs_dispute', 'pi_dispute');
      const disputeCreated = {
        id: 'evt_dispute_created',
        type: 'charge.dispute.created',
        created: partialRefund.created + 2,
        livemode: true,
        data: {
          object: {
            id: 'du_insertplayer',
            object: 'dispute',
            amount: 1499,
            currency: 'eur',
            payment_intent: 'pi_dispute',
            status: 'needs_response',
          },
        },
      };
      expect(await (await handleStripeWebhook(await signedWebhookRequest(disputeCreated), env)).json())
        .toMatchObject({ creditStatus: 'reversed' });
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind('user-dispute').first<{ credits_balance: number }>())?.credits_balance).toBe(0);

      const disputeWon = {
        ...disputeCreated,
        id: 'evt_dispute_won',
        type: 'charge.dispute.closed',
        created: disputeCreated.created + 1,
        data: { object: { ...disputeCreated.data.object, status: 'won' } },
      };
      expect(await (await handleStripeWebhook(await signedWebhookRequest(disputeWon), env)).json())
        .toMatchObject({ creditStatus: 'restored' });
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind('user-dispute').first<{ credits_balance: number }>())?.credits_balance).toBe(11);
      expect((await db.prepare('SELECT status FROM checkout_sessions WHERE id = ?')
        .bind('checkout-dispute').first<{ status: string }>())?.status).toBe('paid');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('withholds refunded credits when refund delivery precedes checkout completion', async () => {
    const { mf, db, env } = await createBindings();
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (id, clerk_user_id, display_name, credits_balance, stripe_customer_id)
          VALUES ('user-ordered', 'user-ordered', 'Ordered', 0, 'cus_insertplayer')
        `),
        db.prepare(`
          INSERT INTO checkout_sessions (
            id, stripe_session_id, user_id, pack_id, credits, amount_cents, currency,
            status, legal_version, terms_accepted, immediate_delivery_confirmed,
            withdrawal_loss_acknowledged, stripe_customer_id
          ) VALUES (
            'checkout-ordered', 'pending:checkout-ordered', 'user-ordered', 'starter',
            11, 1499, 'eur', 'open', ?, 1, 1, 1, 'cus_insertplayer'
          )
        `).bind(CURRENT_LEGAL_VERSION),
      ]);
      const created = Math.floor(Date.now() / 1000);
      const refund = {
        id: 'evt_ordered_refund',
        type: 'charge.refunded',
        created,
        livemode: true,
        data: {
          object: {
            id: 'ch_ordered',
            object: 'charge',
            amount: 1499,
            amount_refunded: 1499,
            currency: 'eur',
            customer: 'cus_insertplayer',
            payment_intent: 'pi_ordered',
            refunded: true,
            metadata: metadata('checkout-ordered', 'user-ordered'),
          },
        },
      };
      await handleStripeWebhook(await signedWebhookRequest(refund), env);
      const completion = {
        id: 'evt_ordered_completion',
        type: 'checkout.session.completed',
        created: created + 1,
        livemode: true,
        data: {
          object: {
            id: 'cs_ordered',
            object: 'checkout.session',
            amount_total: 1499,
            currency: 'eur',
            customer: 'cus_insertplayer',
            client_reference_id: 'user-ordered',
            payment_intent: 'pi_ordered',
            payment_status: 'paid',
            metadata: metadata('checkout-ordered', 'user-ordered'),
          },
        },
      };
      expect(await (await handleStripeWebhook(await signedWebhookRequest(completion), env)).json())
        .toMatchObject({ creditStatus: 'credited' });
      expect((await db.prepare('SELECT credits_balance FROM users WHERE id = ?')
        .bind('user-ordered').first<{ credits_balance: number }>())?.credits_balance).toBe(0);
      const checkout = await db.prepare(`
        SELECT status, stripe_session_id, stripe_payment_intent_id, reversed_credits
        FROM checkout_sessions WHERE id = 'checkout-ordered'
      `).first<{
        status: string;
        stripe_session_id: string;
        stripe_payment_intent_id: string;
        reversed_credits: number;
      }>();
      expect(checkout).toMatchObject({
        status: 'refunded',
        stripe_session_id: 'cs_ordered',
        stripe_payment_intent_id: 'pi_ordered',
        reversed_credits: 11,
      });
    } finally {
      await mf.dispose();
    }
  });
});
