import { describe, expect, it } from 'vitest';
import { cleanupOperationalData } from './maintenance';
import type { Env } from './types';

describe('operational data retention', () => {
  it('deletes only expired operational records', async () => {
    const statements: string[] = [];
    const database = {
      prepare(sql: string) {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
      async batch() {
        return [];
      },
    };
    const bucket = { async delete() {} };

    await cleanupOperationalData({
      DB: database as unknown as D1Database,
      SPRITES: bucket as unknown as R2Bucket,
    } as Env);

    expect(statements.length).toBeGreaterThanOrEqual(12);
    expect(statements.join('\n')).toContain('DELETE FROM provider_spend_reservations');
    expect(statements.join('\n')).toContain('DELETE FROM provider_capacity_windows');
    expect(statements.some((sql) => sql.startsWith('DELETE FROM rate_limits'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM provider_request_cache'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM generation_jobs'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM provider_sessions'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM stripe_events'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM clerk_webhook_events'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM checkout_sessions'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM legal_acceptances'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM community_reports'))).toBe(true);

    const combined = statements.join('\n');
    expect(combined).not.toContain('fighters');
    expect(combined).not.toContain('sprites');
    expect(combined).not.toContain('credit_ledger');
    expect(combined).not.toContain('clerk_user_tombstones');
    expect(combined).not.toContain('provider_cost_events');
    expect(combined).not.toContain('users');
  });
});
