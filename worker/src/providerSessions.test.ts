import { describe, expect, it } from 'vitest';
import {
  createProviderRequestState,
  createFeatureProviderSession,
  finalizeProviderRequest,
  PROVIDER_SESSION_HEADER,
  requireProviderSession,
} from './providerSessions';
import type { Env, PublicAuthContext } from './types';

describe('provider session usage', () => {
  it('rejects a feature session without current generation consent', async () => {
    const env = { DB: {} as D1Database } as Env;
    const auth: PublicAuthContext = {
      userId: 'user-1',
      user: { id: 'user-1' } as PublicAuthContext['user'],
      claims: {},
      rateLimitKey: 'user:user-1',
    };
    const request = new Request('https://api.insertplayer.ai/api/provider-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'stage_background' }),
    });

    const response = await createFeatureProviderSession(request, env, auth);

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({ error: 'Current generation consent is required' });
  });

  it('requires a scoped session for polling without consuming the paid call budget', async () => {
    const database = {
      prepare(sql: string) {
        if (sql.includes('UPDATE provider_sessions')) {
          throw new Error('Polling must not consume the provider call budget');
        }
        return {
          bind() {
            return {
              async first() {
                return {
                  id: 'session-poll',
                  tier: 'contender',
                  purpose: 'fighter_generation',
                  provider_calls_used: 4,
                  provider_call_limit: 4,
                  expires_at: new Date(Date.now() + 30_000).toISOString(),
                };
              },
            };
          },
        };
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const auth: PublicAuthContext = {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    };
    const request = new Request('https://api.insertplayer.ai/proxy/fal/fal-ai/birefnet/requests/job-1/status', {
      headers: { [PROVIDER_SESSION_HEADER]: 'session-poll' },
    });

    await expect(requireProviderSession(request, env, auth, {
      provider: 'fal',
      path: '/proxy/fal/fal-ai/birefnet/requests/job-1/status',
    })).resolves.toBeNull();
  });

  it('reports an atomic last-call race as an exhausted session', async () => {
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    let readCount = 0;
    const database = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('UPDATE provider_sessions')) return null;
                readCount += 1;
                return readCount === 1
                  ? {
                      id: 'session-1',
                      tier: 'contender',
                      purpose: 'fighter_generation',
                      provider_calls_used: 0,
                      provider_call_limit: 1,
                      provider_cost_used_cents: 0,
                      provider_cost_limit_cents: 100,
                      expires_at: expiresAt,
                    }
                  : {
                      id: 'session-1',
                      tier: 'contender',
                      purpose: 'fighter_generation',
                      provider_calls_used: 1,
                      provider_call_limit: 1,
                      provider_cost_used_cents: 0,
                      provider_cost_limit_cents: 100,
                      expires_at: expiresAt,
                    };
              },
            };
          },
        };
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const auth: PublicAuthContext = {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    };
    const request = new Request('https://api.insertplayer.ai/proxy/gemini', {
      method: 'POST',
      headers: { [PROVIDER_SESSION_HEADER]: 'session-1' },
    });

    const response = await requireProviderSession(request, env, auth, {
      provider: 'gemini',
      path: '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
    });

    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(response?.headers.get('Retry-After'))).toBeLessThanOrEqual(30);
  });

  it('rejects Gemini models outside the tier allowlist before spending a call', async () => {
    const database = {
      prepare(sql: string) {
        if (sql.includes('UPDATE provider_sessions')) {
          throw new Error('A rejected model must not consume the provider call budget');
        }
        return {
          bind() {
            return {
              async first() {
                return {
                  id: 'session-model',
                  tier: 'rookie',
                  purpose: 'fighter_generation',
                  provider_calls_used: 0,
                  provider_call_limit: 48,
                  expires_at: new Date(Date.now() + 30_000).toISOString(),
                };
              },
            };
          },
        };
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const request = new Request('https://api.insertplayer.ai/proxy/gemini', {
      method: 'POST',
      headers: { [PROVIDER_SESSION_HEADER]: 'session-model' },
    });

    const response = await requireProviderSession(request, env, {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    }, {
      provider: 'gemini',
      path: '/proxy/gemini/v1beta/models/gemini-3.5-pro-preview:generateContent',
    });

    expect(response?.status).toBe(403);
  });

  it('keeps source retries on Pro and tier animation retries on their paid model', async () => {
    let session = {
      id: 'session-source-retry',
      tier: 'rookie',
      purpose: 'fighter_retry',
      charge_reason: 'fighter_retry_source',
      provider_calls_used: 0,
      provider_call_limit: 8,
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    };
    const database = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return session;
              },
            };
          },
        };
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const auth: PublicAuthContext = {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    };
    const checkModel = (model: string) => requireProviderSession(
      new Request('https://api.insertplayer.ai/proxy/gemini', {
        headers: { [PROVIDER_SESSION_HEADER]: session.id },
      }),
      env,
      auth,
      {
        provider: 'gemini',
        path: `/proxy/gemini/v1beta/models/${model}:generateContent`,
      },
    );

    await expect(checkModel('gemini-3-pro-image')).resolves.toBeNull();
    await expect(checkModel('gemini-3.1-flash-image')).resolves.toMatchObject({ status: 403 });

    session = {
      ...session,
      id: 'session-animation-retry',
      tier: 'contender',
      charge_reason: 'fighter_retry_animation',
      provider_call_limit: 72,
    };
    await expect(checkModel('gemini-3.1-flash-image')).resolves.toBeNull();
    await expect(checkModel('gemini-3-pro-image')).resolves.toMatchObject({ status: 403 });
  });

  it('allows the approved Flash scaffold and Pro renderer in Champion sessions', async () => {
    const database = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  id: 'session-champion',
                  tier: 'champion',
                  purpose: 'fighter_generation',
                  provider_calls_used: 0,
                  provider_call_limit: 320,
                  expires_at: new Date(Date.now() + 30_000).toISOString(),
                };
              },
            };
          },
        };
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const auth = {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    };
    const checkModel = (model: string) => requireProviderSession(
      new Request('https://api.insertplayer.ai/proxy/gemini', {
        headers: { [PROVIDER_SESSION_HEADER]: 'session-champion' },
      }),
      env,
      auth,
      {
        provider: 'gemini',
        path: `/proxy/gemini/v1beta/models/${model}:generateContent`,
      },
    );

    await expect(checkModel('gemini-3.1-flash-image')).resolves.toBeNull();
    await expect(checkModel('gemini-3-pro-image')).resolves.toBeNull();
    await expect(checkModel('gemini-3.5-pro-preview')).resolves.toMatchObject({ status: 403 });

    await expect(requireProviderSession(
      new Request('https://api.insertplayer.ai/proxy/freepik', {
        headers: { [PROVIDER_SESSION_HEADER]: 'session-champion' },
      }),
      env,
      auth,
      {
        provider: 'freepik',
        path: '/proxy/freepik/v1/ai/beta/remove-background',
      },
    )).resolves.toBeNull();
  });

  it('stops a session before a paid call exceeds its cost allowance', async () => {
    const database = {
      prepare(sql: string) {
        if (sql.includes('UPDATE provider_sessions')) {
          throw new Error('An over-budget session must not reserve another call');
        }
        return {
          bind() {
            return {
              async first() {
                return {
                  id: 'session-cost',
                  tier: 'rookie',
                  purpose: 'fighter_generation',
                  provider_calls_used: 10,
                  provider_call_limit: 48,
                  provider_cost_used_cents: 295,
                  provider_cost_limit_cents: 300,
                  expires_at: new Date(Date.now() + 30_000).toISOString(),
                };
              },
            };
          },
        };
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const request = new Request('https://api.insertplayer.ai/proxy/gemini', {
      method: 'POST',
      headers: { [PROVIDER_SESSION_HEADER]: 'session-cost' },
    });

    const response = await requireProviderSession(request, env, {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    }, {
      provider: 'gemini',
      path: '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
    });

    expect(response?.status).toBe(429);
    expect(await response?.json()).toMatchObject({ code: 'provider_session_spend_limit' });
  });

  it('fails closed when the global monthly provider ceiling is exhausted', async () => {
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const database = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('UPDATE provider_sessions')) {
                  return {
                    id: 'session-global',
                    provider_calls_used: 1,
                    provider_call_limit: 48,
                    provider_cost_used_cents: 8,
                    provider_cost_limit_cents: 300,
                  };
                }
                if (sql.includes('UPDATE provider_spend_months')) return null;
                return {
                  id: 'session-global',
                  tier: 'rookie',
                  purpose: 'fighter_generation',
                  provider_calls_used: 0,
                  provider_call_limit: 48,
                  provider_cost_used_cents: 0,
                  provider_cost_limit_cents: 300,
                  expires_at: expiresAt,
                };
              },
              async run() {
                return {};
              },
            };
          },
        };
      },
      async batch() {
        return [];
      },
    };
    const env = {
      DB: database as unknown as D1Database,
      PROVIDER_MONTHLY_BUDGET_USD_CENTS: '100',
    } as Env;
    const request = new Request('https://api.insertplayer.ai/proxy/gemini', {
      method: 'POST',
      headers: { [PROVIDER_SESSION_HEADER]: 'session-global' },
    });

    const response = await requireProviderSession(request, env, {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    }, {
      provider: 'gemini',
      path: '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
    });

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ code: 'provider_monthly_budget_exhausted' });
  });

  it('defers Gemini globally before consuming a session call', async () => {
    const nowEpoch = Math.floor(Date.now() / 1_000);
    let sessionUpdateAttempted = false;
    const database = {
      prepare(sql: string) {
        if (sql.includes('UPDATE provider_sessions')) sessionUpdateAttempted = true;
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM provider_sessions')) {
                  return {
                    id: 'session-rate',
                    tier: 'champion',
                    purpose: 'fighter_upgrade',
                    provider_calls_used: 0,
                    provider_call_limit: 320,
                    provider_cost_used_cents: 0,
                    provider_cost_limit_cents: 1_800,
                    expires_at: new Date(Date.now() + 30_000).toISOString(),
                  };
                }
                if (sql.includes('INSERT INTO provider_spend_reservations')) return null;
                if (sql.includes('MIN(created_at_epoch)')) {
                  return { created_at_epoch: nowEpoch - 120 };
                }
                return null;
              },
            };
          },
        };
      },
    };
    const env = {
      DB: database as unknown as D1Database,
      GEMINI_SPEND_RATE_LIMIT_USD_CENTS: '900',
    } as Env;
    const request = new Request('https://api.insertplayer.ai/proxy/gemini', {
      method: 'POST',
      headers: { [PROVIDER_SESSION_HEADER]: 'session-rate' },
    });

    const response = await requireProviderSession(request, env, {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    }, {
      provider: 'gemini',
      path: '/proxy/gemini/v1beta/models/gemini-3-pro-image:generateContent',
    });

    expect(response?.status).toBe(429);
    expect(await response?.json()).toMatchObject({ code: 'provider_global_spend_rate' });
    expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(sessionUpdateAttempted).toBe(false);
  });

  it('releases session and monthly reservations after an upstream failure', async () => {
    let releasedStatements = 0;
    let providerCostEventReserved = false;
    let providerCostEventFailed = false;
    const database = {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO provider_cost_events')) providerCostEventReserved = true;
        if (sql.includes('UPDATE provider_cost_events')) providerCostEventFailed = true;
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('UPDATE provider_sessions')) {
                  return {
                    id: 'session-release',
                    provider_calls_used: 1,
                    provider_call_limit: 48,
                    provider_cost_used_cents: 8,
                    provider_cost_limit_cents: 300,
                  };
                }
                if (sql.includes('UPDATE provider_spend_months')) return { period: '2026-08' };
                return {
                  id: 'session-release',
                  tier: 'rookie',
                  purpose: 'fighter_generation',
                  provider_calls_used: 0,
                  provider_call_limit: 48,
                  provider_cost_used_cents: 0,
                  provider_cost_limit_cents: 300,
                  expires_at: new Date(Date.now() + 30_000).toISOString(),
                };
              },
              async run() {
                return {};
              },
            };
          },
        };
      },
      async batch(statements: unknown[]) {
        releasedStatements = statements.length;
        return [];
      },
    };
    const env = {
      DB: database as unknown as D1Database,
      PROVIDER_MONTHLY_BUDGET_USD_CENTS: '1000',
    } as Env;
    const request = new Request('https://api.insertplayer.ai/proxy/gemini', {
      method: 'POST',
      headers: { [PROVIDER_SESSION_HEADER]: 'session-release' },
    });
    const auth: PublicAuthContext = {
      userId: 'user-1',
      user: null,
      claims: null,
      rateLimitKey: 'user:user-1',
    };
    const providerState = createProviderRequestState();

    await expect(requireProviderSession(request, env, auth, {
      provider: 'gemini',
      path: '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
    }, providerState)).resolves.toBeNull();
    await finalizeProviderRequest(env, Response.json({ error: 'busy' }, { status: 429 }), providerState);

    expect(releasedStatements).toBe(3);
    expect(providerCostEventReserved).toBe(true);
    expect(providerCostEventFailed).toBe(true);
  });
});
