import { describe, expect, it } from 'vitest';
import { enforceRateLimit } from './rateLimit';
import type { Env, PublicAuthContext } from './types';

describe('D1 rate limits', () => {
  it('allows the configured count and rejects the next atomic increment', async () => {
    let count = 0;
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const database = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            const statement = { sql, args };
            statements.push(statement);
            return statement;
          },
        };
      },
      async batch() {
        count += 1;
        return [
          { results: [{ count }] },
          { results: [] },
        ];
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const auth: PublicAuthContext = {
      userId: null,
      user: null,
      claims: null,
      rateLimitKey: 'ip:203.0.113.10',
    };

    expect(await enforceRateLimit(env, 'generation:authorize', auth)).toBeNull();
    const blocked = await enforceRateLimit(env, 'generation:authorize', auth);

    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(blocked?.headers.get('Retry-After'))).toBeLessThanOrEqual(24 * 60 * 60);
    expect(statements.some((statement) => statement.sql.includes('RETURNING count'))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes('DELETE FROM rate_limits'))).toBe(true);
  });

  it('limits signed-in community reports to ten submissions per day', async () => {
    let count = 0;
    const database = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return { sql, args };
          },
        };
      },
      async batch() {
        count += 1;
        return [{ results: [{ count }] }, { results: [] }];
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const auth: PublicAuthContext = {
      userId: 'user-reporter',
      user: { plan_tier: 'free' } as PublicAuthContext['user'],
      claims: {},
      rateLimitKey: 'user:user-reporter',
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await enforceRateLimit(env, 'community:report', auth)).toBeNull();
    }
    const blocked = await enforceRateLimit(env, 'community:report', auth);
    expect(blocked?.status).toBe(429);
  });

  it('limits free signed-in AI stage sessions to five per day', async () => {
    let count = 0;
    const database = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return { sql, args };
          },
        };
      },
      async batch() {
        count += 1;
        return [{ results: [{ count }] }, { results: [] }];
      },
    };
    const env = { DB: database as unknown as D1Database } as Env;
    const auth: PublicAuthContext = {
      userId: 'user-stage',
      user: { plan_tier: 'free' } as PublicAuthContext['user'],
      claims: {},
      rateLimitKey: 'user:user-stage',
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await enforceRateLimit(env, 'provider:session:stage_background', auth)).toBeNull();
    }
    const blocked = await enforceRateLimit(env, 'provider:session:stage_background', auth);
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(blocked?.headers.get('Retry-After'))).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it.each(['proxy:gemini', 'proxy:fal'])(
    'keeps the %s envelope above paid provider-session budgets',
    async (routeKey) => {
      let count = 0;
      const database = {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return { sql, args };
            },
          };
        },
        async batch() {
          count += 1;
          return [{ results: [{ count }] }, { results: [] }];
        },
      };
      const env = { DB: database as unknown as D1Database } as Env;
      const auth: PublicAuthContext = {
        userId: 'user-paid-generation',
        user: { plan_tier: 'free' } as PublicAuthContext['user'],
        claims: {},
        rateLimitKey: 'user:user-paid-generation',
      };

      for (let attempt = 0; attempt < 1200; attempt += 1) {
        expect(await enforceRateLimit(env, routeKey, auth)).toBeNull();
      }
      const blocked = await enforceRateLimit(env, routeKey, auth);
      expect(blocked?.status).toBe(429);
      expect(Number(blocked?.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(Number(blocked?.headers.get('Retry-After'))).toBeLessThanOrEqual(60 * 60);
    },
  );
});
