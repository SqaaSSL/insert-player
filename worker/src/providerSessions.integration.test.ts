import { Miniflare } from 'miniflare';
import { describe, expect, it, vi } from 'vitest';
import {
  createProviderRequestState,
  finalizeProviderRequest,
  PROVIDER_SESSION_HEADER,
  requireProviderSession,
} from './providerSessions';
import { createBoundedByteStream } from './streamLimits';
import { proxyRequest } from './proxy';
import type { Env, PublicAuthContext } from './types';

const USER_ID = 'user-provider-cache';
const CHARGE_ID = '11111111111111111111111111111111';
const SESSION_ID = '22222222222222222222222222222222';
const JOB_ID = CHARGE_ID;
const CONTINUATION_CHARGE_ID = '33333333333333333333333333333333';
const CONTINUATION_SESSION_ID = '44444444444444444444444444444444';
const CONTINUATION_JOB_ID = CONTINUATION_CHARGE_ID;
const PROVIDER_KEY_HEADER = 'X-Insert-Player-Provider-Request-Key';
const ROUTE = {
  provider: 'gemini' as const,
  path: '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
};

const SCHEMA = `
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE generation_charges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE provider_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    rate_limit_key TEXT NOT NULL,
    tier TEXT NOT NULL,
    purpose TEXT NOT NULL,
    charge_id TEXT,
    status TEXT NOT NULL,
    provider_calls_used INTEGER NOT NULL DEFAULT 0,
    provider_call_limit INTEGER NOT NULL,
    provider_cost_used_cents INTEGER NOT NULL DEFAULT 0,
    provider_cost_limit_cents INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider_session_id TEXT NOT NULL,
    artifact_run_id TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE generation_artifact_runs (
    id TEXT PRIMARY KEY
  );
  CREATE TABLE provider_request_cache (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    artifact_run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    method TEXT NOT NULL,
    request_path TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    request_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    response_blob_key TEXT,
    response_status INTEGER,
    response_content_type TEXT,
    owner_attempt_id TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(artifact_run_id, provider, method, request_path, request_hash)
  );
  CREATE TABLE provider_spend_months (
    period TEXT PRIMARY KEY,
    estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
    provider_calls INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE provider_cost_events (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    charge_id TEXT,
    tier TEXT NOT NULL,
    purpose TEXT NOT NULL,
    billing_operation TEXT,
    provider TEXT NOT NULL,
    model_path TEXT NOT NULL,
    estimated_cost_cents INTEGER NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'reserved',
    http_status INTEGER,
    job_id TEXT,
    artifact_run_id TEXT,
    request_key TEXT,
    call_kind TEXT NOT NULL DEFAULT 'unclassified',
    stage TEXT,
    upstream_outcome TEXT NOT NULL DEFAULT 'pending',
    stage_outcome TEXT NOT NULL DEFAULT 'pending',
    job_outcome TEXT NOT NULL DEFAULT 'in_progress',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finalized_at TEXT
  );
`;

async function bindings(): Promise<{ mf: Miniflare; db: D1Database; bucket: R2Bucket; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: 'provider-cache-test',
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
        env: {
          DB: { type: 'd1', id: 'provider-cache-db' },
          SPRITES: { type: 'r2', name: 'provider-cache-assets' },
        },
      },
    }],
  });
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  await db.batch([
    db.prepare('INSERT INTO users (id) VALUES (?)').bind(USER_ID),
    db.prepare(`
      INSERT INTO generation_charges (id, user_id, tier, status, reason)
      VALUES (?, ?, 'rookie', 'reserved', 'fighter_generation')
    `).bind(CHARGE_ID, USER_ID),
    db.prepare(`
      INSERT INTO provider_sessions (
        id, user_id, rate_limit_key, tier, purpose, charge_id, status,
        provider_call_limit, provider_cost_limit_cents, expires_at
      ) VALUES (?, ?, ?, 'rookie', 'fighter_generation', ?, 'active', 48, 300, datetime('now', '+2 days'))
    `).bind(SESSION_ID, USER_ID, `user:${USER_ID}`, CHARGE_ID),
    db.prepare(`
      INSERT INTO generation_artifact_runs (id) VALUES (?)
    `).bind(JOB_ID),
    db.prepare(`
      INSERT INTO generation_jobs (id, user_id, provider_session_id, artifact_run_id, status)
      VALUES (?, ?, ?, ?, 'running')
    `).bind(JOB_ID, USER_ID, SESSION_ID, JOB_ID),
  ]);
  return {
    mf,
    db,
    bucket,
    env: {
      DB: db,
      SPRITES: bucket,
      ENVIRONMENT: 'development',
      CORS_ORIGIN: 'https://insertplayer.ai',
    } as Env,
  };
}

const auth: PublicAuthContext = {
  userId: USER_ID,
  rateLimitKey: `user:${USER_ID}`,
  user: null,
  claims: { generation_job_id: JOB_ID },
};

function providerRequest(
  key: string,
  prompt = 'one intentional provider call',
  sessionId = SESSION_ID,
): Request {
  return new Request(`https://api.insertplayer.ai${ROUTE.path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [PROVIDER_SESSION_HEADER]: sessionId,
      [PROVIDER_KEY_HEADER]: key,
    },
    body: JSON.stringify({ prompt }),
  });
}

async function usage(
  db: D1Database,
  sessionId = SESSION_ID,
): Promise<{ calls: number; cost: number; events: number }> {
  const session = await db.prepare(`
    SELECT provider_calls_used AS calls, provider_cost_used_cents AS cost
    FROM provider_sessions WHERE id = ?
  `).bind(sessionId).first<{ calls: number; cost: number }>();
  const event = await db.prepare('SELECT COUNT(*) AS count FROM provider_cost_events')
    .first<{ count: number }>();
  return { calls: session?.calls ?? -1, cost: session?.cost ?? -1, events: event?.count ?? -1 };
}

async function chargeStatus(db: D1Database): Promise<string | null> {
  return (await db.prepare('SELECT status FROM generation_charges WHERE id = ?')
    .bind(CHARGE_ID).first<{ status: string }>())?.status ?? null;
}

describe('durable provider request cache against D1 and R2', () => {
  it('rejects a declared oversized durable request before reserving provider spend', async () => {
    const { mf, db, env } = await bindings();
    try {
      const request = providerRequest('job:source:side:oversized-request');
      request.headers.set('Content-Length', String(48 * 1024 * 1024 + 1));
      const response = await requireProviderSession(
        request,
        env,
        auth,
        ROUTE,
        createProviderRequestState(),
      );

      expect(response?.status).toBe(413);
      expect(await usage(db)).toEqual({ calls: 0, cost: 0, events: 0 });
      expect(await chargeStatus(db)).toBe('reserved');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('blocks generation dispatch when its durable artifact run is missing', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.prepare('UPDATE generation_jobs SET artifact_run_id = NULL WHERE id = ?')
        .bind(JOB_ID).run();

      const response = await requireProviderSession(
        providerRequest(`job:${JOB_ID}:source:side`),
        env,
        auth,
        ROUTE,
        createProviderRequestState(),
      );

      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({
        code: 'durable_generation_context_missing',
      });
      expect(await usage(db)).toEqual({ calls: 0, cost: 0, events: 0 });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('blocks a charged generation session outside its signed durable job', async () => {
    const { mf, db, env } = await bindings();
    try {
      const response = await requireProviderSession(
        providerRequest(`job:${JOB_ID}:source:side`),
        env,
        { ...auth, claims: {} },
        ROUTE,
        createProviderRequestState(),
      );

      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({
        code: 'durable_generation_context_missing',
      });
      expect(await usage(db)).toEqual({ calls: 0, cost: 0, events: 0 });
      expect((await db.prepare('SELECT COUNT(*) AS count FROM provider_request_cache')
        .first<{ count: number }>())?.count).toBe(0);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('records spend without blocking a valid session after high aggregate usage', async () => {
    const { mf, db, env } = await bindings();
    try {
      const period = new Date().toISOString().slice(0, 7);
      await db.prepare(`
        INSERT INTO provider_spend_months (period, estimated_cost_cents, provider_calls)
        VALUES (?, 99999999, 999999)
      `).bind(period).run();

      const state = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest('job:source:side:high-aggregate'),
        env,
        auth,
        ROUTE,
        state,
      )).toBeNull();
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
      expect(await db.prepare(`
        SELECT estimated_cost_cents AS cost, provider_calls AS calls
        FROM provider_spend_months WHERE period = ?
      `).bind(period).first<{ cost: number; calls: number }>()).toEqual({
        cost: 100000007,
        calls: 1000000,
      });
      await finalizeProviderRequest(env, Response.json({ result: 'generated' }), state);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('derives Meterkey idempotency per durable dispatch instead of per animation scope', async () => {
    const { mf, env } = await bindings();
    try {
      const scope = `job:${JOB_ID}:sprite:high_kick`;
      const frameOne = createProviderRequestState();
      const frameTwo = createProviderRequestState();

      expect(await requireProviderSession(
        providerRequest(scope, 'high kick frame 1'),
        env,
        auth,
        ROUTE,
        frameOne,
      )).toBeNull();
      expect(await requireProviderSession(
        providerRequest(scope, 'high kick frame 2'),
        env,
        auth,
        ROUTE,
        frameTwo,
      )).toBeNull();

      expect(frameOne.upstreamAttemptKey).toMatch(/^ip:[a-f0-9]{32}:[a-f0-9]{32}$/);
      expect(frameTwo.upstreamAttemptKey).toMatch(/^ip:[a-f0-9]{32}:[a-f0-9]{32}$/);
      expect(frameTwo.upstreamAttemptKey).not.toBe(frameOne.upstreamAttemptKey);

      const firstAttemptKey = frameOne.upstreamAttemptKey;
      await finalizeProviderRequest(
        env,
        Response.json({ error: 'known failure' }, { status: 429 }),
        frameOne,
      );

      const retry = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest(scope, 'high kick frame 1'),
        env,
        auth,
        ROUTE,
        retry,
      )).toBeNull();
      expect(retry.upstreamAttemptKey).toMatch(/^ip:[a-f0-9]{32}:[a-f0-9]{32}$/);
      expect(retry.upstreamAttemptKey).not.toBe(firstAttemptKey);

      await finalizeProviderRequest(env, Response.json({ result: 'frame 2' }), frameTwo);
      await finalizeProviderRequest(env, Response.json({ result: 'frame 1 retry' }), retry);
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('replays a completed provider response without another call reservation', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const state = createProviderRequestState();
      expect(await requireProviderSession(providerRequest('job:source:side:0001'), env, auth, ROUTE, state)).toBeNull();
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
      expect(await chargeStatus(db)).toBe('committed');

      const upstream = Response.json({ candidates: [{ result: 'generated' }] });
      const delivered = await finalizeProviderRequest(env, upstream, state);
      expect(delivered.headers.get('X-Insert-Player-Provider-Cache')).toBe('stored');
      expect(await delivered.json()).toEqual({ candidates: [{ result: 'generated' }] });

      await db.prepare(`
        UPDATE provider_request_cache
        SET status = 'pending', updated_at = datetime('now')
      `).run();

      const replayState = createProviderRequestState();
      const replay = await requireProviderSession(
        providerRequest('job:source:side:0001'),
        env,
        auth,
        ROUTE,
        replayState,
      );
      expect(replay).toBeInstanceOf(Response);
      expect(replay?.status).toBe(200);
      expect(replay?.headers.get('X-Insert-Player-Provider-Cache')).toBe('hit');
      expect(await replay?.json()).toEqual({ candidates: [{ result: 'generated' }] });
      expect(replayState.upstreamAttemptKey).toBeNull();
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });

      const cacheRow = await db.prepare(`
        SELECT response_blob_key, status FROM provider_request_cache
      `).first<{ response_blob_key: string; status: string }>();
      expect(cacheRow?.status).toBe('succeeded');
      expect(await bucket.head(cacheRow!.response_blob_key)).not.toBeNull();
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('keeps the committed charge and provider spend after an upstream failure', async () => {
    const { mf, db, env } = await bindings();
    try {
      const state = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest('job:source:side:provider-failure'),
        env,
        auth,
        ROUTE,
        state,
      )).toBeNull();

      const delivered = await finalizeProviderRequest(
        env,
        Response.json({ error: 'busy' }, { status: 429 }),
        state,
      );

      expect(delivered.status).toBe(429);
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
      expect(await chargeStatus(db)).toBe('committed');
      expect(await db.prepare('SELECT outcome, http_status FROM provider_cost_events')
        .first<{ outcome: string; http_status: number }>())
        .toEqual({ outcome: 'failed', http_status: 429 });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('fails closed without cost residue when the charge was released concurrently', async () => {
    const { mf, db, env } = await bindings();
    try {
      await db.prepare(`
        UPDATE generation_charges SET status = 'refunded' WHERE id = ?
      `).bind(CHARGE_ID).run();

      const response = await requireProviderSession(
        providerRequest('job:source:side:released-race'),
        env,
        auth,
        ROUTE,
        createProviderRequestState(),
      );

      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({
        error: 'Provider cost accounting is temporarily unavailable',
      });
      expect(await usage(db)).toEqual({ calls: 0, cost: 0, events: 0 });
      expect(await chargeStatus(db)).toBe('refunded');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('fails an oversized response without buffering it or releasing incurred provider spend', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const state = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest('job:source:side:oversized'),
        env,
        auth,
        ROUTE,
        state,
      )).toBeNull();

      const source = new Response(new Uint8Array(9)).body;
      expect(source).not.toBeNull();
      const response = new Response(createBoundedByteStream(source!, 8), {
        headers: { 'Content-Type': 'application/json' },
      });
      const delivered = await finalizeProviderRequest(env, response, state);

      expect(delivered.status).toBe(502);
      expect(await delivered.json()).toMatchObject({ code: 'provider_response_too_large' });
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
      const cacheRow = await db.prepare(`
        SELECT status, response_blob_key FROM provider_request_cache
      `).first<{ status: string; response_blob_key: string | null }>();
      expect(cacheRow).toEqual({ status: 'uncertain', response_blob_key: null });
      const costEvent = await db.prepare(`
        SELECT outcome, upstream_outcome, http_status FROM provider_cost_events
      `).first<{ outcome: string; upstream_outcome: string; http_status: number }>();
      expect(costEvent).toEqual({
        outcome: 'succeeded',
        upstream_outcome: 'http_succeeded',
        http_status: 200,
      });
      expect((await bucket.list()).objects).toHaveLength(0);

      const replay = await requireProviderSession(
        providerRequest('job:source:side:oversized'),
        env,
        auth,
        ROUTE,
        createProviderRequestState(),
      );
      expect(replay?.status).toBe(409);
      expect(await replay?.json()).toMatchObject({ code: 'provider_request_outcome_unknown' });
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('reuses a completed response across continuation jobs in the same artifact run', async () => {
    const { mf, db, env } = await bindings();
    try {
      const requestKey = `job:${JOB_ID}:sprite:low_punch`;
      const firstState = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest(requestKey, 'same durable low punch request'),
        env,
        auth,
        ROUTE,
        firstState,
      )).toBeNull();
      await finalizeProviderRequest(
        env,
        Response.json({ candidates: [{ result: 'preserved-low-punch-frame' }] }),
        firstState,
      );

      await db.batch([
        db.prepare(`
          INSERT INTO generation_charges (id, user_id, tier, status, reason)
          VALUES (?, ?, 'rookie', 'reserved', 'fighter_generation')
        `).bind(CONTINUATION_CHARGE_ID, USER_ID),
        db.prepare(`
          INSERT INTO provider_sessions (
            id, user_id, rate_limit_key, tier, purpose, charge_id, status,
            provider_call_limit, provider_cost_limit_cents, expires_at
          ) VALUES (?, ?, ?, 'rookie', 'fighter_generation', ?, 'active', 48, 300, datetime('now', '+2 days'))
        `).bind(
          CONTINUATION_SESSION_ID,
          USER_ID,
          `user:${USER_ID}`,
          CONTINUATION_CHARGE_ID,
        ),
        db.prepare(`
          INSERT INTO generation_jobs (id, user_id, provider_session_id, artifact_run_id, status)
          VALUES (?, ?, ?, ?, 'running')
        `).bind(CONTINUATION_JOB_ID, USER_ID, CONTINUATION_SESSION_ID, JOB_ID),
      ]);
      const continuationAuth: PublicAuthContext = {
        ...auth,
        claims: { generation_job_id: CONTINUATION_JOB_ID },
      };
      const replay = await requireProviderSession(
        providerRequest(requestKey, 'same durable low punch request', CONTINUATION_SESSION_ID),
        env,
        continuationAuth,
        ROUTE,
        createProviderRequestState(),
      );

      expect(replay?.status).toBe(200);
      expect(replay?.headers.get('X-Insert-Player-Provider-Cache')).toBe('hit');
      expect(await replay?.json()).toEqual({
        candidates: [{ result: 'preserved-low-punch-frame' }],
      });
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
      expect(await usage(db, CONTINUATION_SESSION_ID)).toEqual({ calls: 0, cost: 0, events: 1 });
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('fails closed when a completed response loses its durable R2 object', async () => {
    const { mf, db, bucket, env } = await bindings();
    try {
      const requestKey = `job:${JOB_ID}:sprite:low_punch`;
      const state = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest(requestKey, 'durable object loss'),
        env,
        auth,
        ROUTE,
        state,
      )).toBeNull();
      await finalizeProviderRequest(env, Response.json({ result: 'generated' }), state);
      const cache = await db.prepare(`
        SELECT response_blob_key FROM provider_request_cache
      `).first<{ response_blob_key: string }>();
      await bucket.delete(cache!.response_blob_key);

      const replay = await requireProviderSession(
        providerRequest(requestKey, 'durable object loss'),
        env,
        auth,
        ROUTE,
        createProviderRequestState(),
      );
      expect(replay?.status).toBe(409);
      expect(await replay?.json()).toMatchObject({ code: 'provider_request_outcome_unknown' });
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
      expect((await db.prepare('SELECT status FROM provider_request_cache')
        .first<{ status: string }>())?.status).toBe('uncertain');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('never automatically replays an ambiguous upstream dispatch', async () => {
    const { mf, db, env } = await bindings();
    try {
      const state = createProviderRequestState();
      const requestKey = `job:${JOB_ID}:sprite:low_punch`;
      const firstRequest = providerRequest(requestKey, 'ambiguous dispatch');
      firstRequest.headers.set('X-Insert-Player-Provider-Call-Kind', 'quality_review');
      expect(await requireProviderSession(
        firstRequest,
        env,
        auth,
        ROUTE,
        state,
      )).toBeNull();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
        { error: { code: 'service_unavailable', message: 'upstream provider request failed' } },
        { status: 503, headers: { 'X-Meterkey-Upstream-Outcome': 'unknown' } },
      )));
      const ambiguous = await proxyRequest(
        firstRequest,
        'https://meter.hilo.cx/google-ai-studio/v1beta/models/gemini-3.1-flash-image:generateContent',
        { Authorization: 'Bearer mk-test' },
        1024 * 1024,
      );
      expect(ambiguous.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('unknown');
      expect((await finalizeProviderRequest(env, ambiguous, state)).status).toBe(503);

      const replay = await requireProviderSession(
        providerRequest(requestKey, 'ambiguous dispatch'),
        env,
        auth,
        ROUTE,
        createProviderRequestState(),
      );
      expect(replay?.status).toBe(409);
      expect(await replay?.json()).toMatchObject({ code: 'provider_request_outcome_unknown' });
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });
      expect(await db.prepare(`
        SELECT outcome, upstream_outcome, job_outcome, call_kind, stage, request_key
        FROM provider_cost_events
      `).first()).toEqual({
        outcome: 'failed',
        upstream_outcome: 'unknown',
        job_outcome: 'in_progress',
        call_kind: 'quality_review',
        stage: 'sprite:low_punch',
        request_key: requestKey,
      });
    } finally {
		vi.unstubAllGlobals();
      await mf.dispose();
    }
  }, 15_000);

  it('releases local provider spend when Meterkey proves the request was not dispatched', async () => {
    const { mf, db, env } = await bindings();
    try {
      const state = createProviderRequestState();
      const requestKey = `job:${JOB_ID}:sprite:low_punch:meterkey-cap`;
      expect(await requireProviderSession(
        providerRequest(requestKey, 'not dispatched by Meterkey'),
        env,
        auth,
        ROUTE,
        state,
      )).toBeNull();

      const rejected = Response.json(
        { error: { code: 'daily_cap_exceeded', message: 'rejected before provider dispatch' } },
        {
          status: 429,
          headers: { 'X-Insert-Player-Upstream-Outcome': 'not-dispatched' },
        },
      );
      expect((await finalizeProviderRequest(env, rejected, state)).status).toBe(429);

      expect(await usage(db)).toEqual({ calls: 0, cost: 0, events: 1 });
      expect(await db.prepare(`
        SELECT outcome, upstream_outcome, http_status, estimated_cost_cents
        FROM provider_cost_events
      `).first()).toEqual({
        outcome: 'failed',
        upstream_outcome: 'not_dispatched',
        http_status: 429,
        estimated_cost_cents: 0,
      });
      expect(await db.prepare(`
        SELECT estimated_cost_cents, provider_calls FROM provider_spend_months
      `).first()).toEqual({ estimated_cost_cents: 0, provider_calls: 0 });
      expect((await db.prepare('SELECT status FROM provider_request_cache')
        .first<{ status: string }>())?.status).toBe('failed');
    } finally {
      await mf.dispose();
    }
  }, 15_000);

  it('keys parallel calls by semantic scope plus body and blocks exact concurrent duplicates', async () => {
    const { mf, db, env } = await bindings();
    try {
      const firstState = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest('job:sprite:idle', 'frame-a'),
        env,
        auth,
        ROUTE,
        firstState,
      )).toBeNull();

      const duplicate = await requireProviderSession(
        providerRequest('job:sprite:idle', 'frame-a'),
        env,
        auth,
        ROUTE,
        createProviderRequestState(),
      );
      expect(duplicate?.status).toBe(425);
      expect(duplicate?.headers.get('Retry-After')).toBe('5');
      expect(await usage(db)).toEqual({ calls: 1, cost: 8, events: 1 });

      await finalizeProviderRequest(env, Response.json({ result: 'first' }), firstState);

      const distinctFrame = createProviderRequestState();
      expect(await requireProviderSession(
        providerRequest('job:sprite:idle', 'frame-b'),
        env,
        auth,
        ROUTE,
        distinctFrame,
      )).toBeNull();
      expect(await usage(db)).toEqual({ calls: 2, cost: 16, events: 2 });
      await finalizeProviderRequest(env, Response.json({ result: 'second' }), distinctFrame);

      const rows = await db.prepare('SELECT COUNT(*) AS count FROM provider_request_cache')
        .first<{ count: number }>();
      expect(rows?.count).toBe(2);
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
