import type { Env } from './types';

export async function cleanupOperationalData(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM rate_limits
      WHERE datetime(expires_at) <= datetime('now')
    `),
    env.DB.prepare(`
      DELETE FROM provider_sessions
      WHERE datetime(expires_at) <= datetime('now', '-7 days')
    `),
    env.DB.prepare(`
      DELETE FROM provider_spend_reservations
      WHERE created_at_epoch <= unixepoch('now', '-1 day')
    `),
    env.DB.prepare(`
      DELETE FROM stripe_events
      WHERE datetime(created_at) <= datetime('now', '-180 days')
    `),
    env.DB.prepare(`
      DELETE FROM clerk_webhook_events
      WHERE datetime(processed_at) <= datetime('now', '-180 days')
    `),
    env.DB.prepare(`
      DELETE FROM checkout_sessions
      WHERE status IN ('open', 'failed')
        AND datetime(updated_at) <= datetime('now', '-30 days')
    `),
    env.DB.prepare(`
      DELETE FROM legal_acceptances
      WHERE datetime(created_at) <= datetime('now', '-6 years')
    `),
    env.DB.prepare(`
      DELETE FROM community_reports
      WHERE status IN ('dismissed', 'actioned')
        AND datetime(updated_at) <= datetime('now', '-1 year')
    `),
  ]);
}
