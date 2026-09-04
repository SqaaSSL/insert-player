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
          async run() { return { success: true }; },
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
    expect(statements.join('\n')).toContain('DELETE FROM provider_meterkey_capacity_windows');
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
    const reconciliationQueryIndex = statements.findIndex((sql) => (
      sql.includes('FROM provider_cost_events cost_event')
    ));
    const jobPurgeIndex = statements.findIndex((sql) => sql.startsWith('DELETE FROM generation_jobs'));
    const jobPurge = statements[jobPurgeIndex];
    expect(reconciliationQueryIndex).toBeGreaterThanOrEqual(0);
    expect(reconciliationQueryIndex).toBeLessThan(jobPurgeIndex);
    expect(jobPurge).toContain('FROM video_sprite_candidates candidate');
    expect(jobPurge).toContain('candidate.job_id = generation_jobs.id');
    expect(combined).not.toContain('fighters');
    expect(combined).not.toContain('sprites');
    expect(combined).not.toContain('credit_ledger');
    expect(combined).not.toContain('clerk_user_tombstones');
    expect(statements.some((sql) => sql.startsWith('DELETE FROM provider_cost_events'))).toBe(false);
    expect(combined).not.toContain('users');
  });
});
