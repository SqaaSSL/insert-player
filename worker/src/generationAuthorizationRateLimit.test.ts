import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeGenerationPurchase } from './billing';
import { CURRENT_LEGAL_VERSION } from './legal';
import type { Env, PublicAuthContext } from './types';

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind: (...bindings: unknown[]) => FakeStatement;
}

function createDatabase(rateLimitCounts: number[] = [1]) {
  const counts = [...rateLimitCounts];
  const batch = vi.fn(async (statements: FakeStatement[]) => {
    if (statements[0]?.sql.includes('INSERT INTO rate_limits')) {
      return [
        { success: true, results: [{ count: counts.shift() ?? 1 }], meta: {} },
        { success: true, results: [], meta: {} },
      ] as unknown as D1Result[];
    }
    return statements.map(() => ({ success: true, results: [], meta: {} })) as unknown as D1Result[];
  });
  const prepare = (sql: string): FakeStatement => {
    const statement: FakeStatement = {
      sql,
      bindings: [],
      bind(...bindings: unknown[]) {
        statement.bindings = bindings;
        return statement;
      },
    };
    return statement;
  };

  return {
    batch,
    db: { prepare, batch } as unknown as D1Database,
  };
}

const legal = {
  legalVersion: CURRENT_LEGAL_VERSION,
  ageConfirmed: true,
  termsAccepted: true,
  photoRightsConfirmed: true,
  aiProcessingConfirmed: true,
  immediatePerformanceConfirmed: true,
  withdrawalLossAcknowledged: true,
} as const;

const anonymousAuth = {
  userId: null,
  rateLimitKey: 'anon:test-network',
  user: null,
  claims: null,
} satisfies PublicAuthContext;

function request(turnstileToken?: string): Request {
  return new Request('https://api.insertplayer.ai/api/billing/generation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.9',
    },
    body: JSON.stringify({
      tier: 'rookie',
      operation: 'fighter_generation',
      turnstileToken,
      legal,
    }),
  });
}

function productionEnv(db: D1Database): Env {
  return {
    DB: db,
    ENVIRONMENT: 'production',
    TURNSTILE_REQUIRED: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_ACTION: 'anonymous_rookie',
    TURNSTILE_HOSTNAMES: 'insertplayer.ai,www.insertplayer.ai',
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generation authorization rate-limit ordering', () => {
  it('does not consume the daily authorization when Turnstile is missing', async () => {
    const { db, batch } = createDatabase();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await authorizeGenerationPurchase(
      request(),
      productionEnv(db),
      anonymousAuth,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'turnstile_required' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it('consumes one authorization only after Siteverify and rejects replay before the counter', async () => {
    const { db, batch } = createDatabase([1]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        success: true,
        action: 'anonymous_rookie',
        hostname: 'insertplayer.ai',
      }))
      .mockResolvedValueOnce(Response.json({
        success: false,
        'error-codes': ['timeout-or-duplicate'],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const env = productionEnv(db);

    const accepted = await authorizeGenerationPurchase(request('single-use-token'), env, anonymousAuth);
    const replayed = await authorizeGenerationPurchase(request('single-use-token'), env, anonymousAuth);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      authorized: true,
      mode: 'anonymous_rookie',
    });
    expect(replayed.status).toBe(403);
    expect(await replayed.json()).toMatchObject({ code: 'turnstile_failed' });
    expect(batch).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(batch.mock.invocationCallOrder[0]);
  });
});
