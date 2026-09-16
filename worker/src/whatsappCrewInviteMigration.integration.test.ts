import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const targetMigration = '0043_whatsapp_crew_invites.sql';

function statements(sql: string): string[] {
  const result: string[] = [];
  let pending = '';
  let trigger = false;
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || (!pending && !line.trim())) continue;
    pending += `${line}\n`;
    if (/^\s*CREATE\s+TRIGGER\b/i.test(line)) trigger = true;
    if (trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      result.push(pending.trim());
      pending = '';
      trigger = false;
    }
  }
  if (pending.trim()) result.push(pending.trim());
  return result;
}

async function apply(db: D1Database, name: string): Promise<void> {
  for (const sql of statements(readFileSync(join(migrationsDirectory, name), 'utf8'))) {
    await db.prepare(sql).run();
  }
}

describe('0043 WhatsApp Crew invite migration', () => {
  it('preserves legacy invitations and supports constrained one-time links', async () => {
    const mf = new Miniflare({ workers: [{ config: {
      type: 'worker',
      name: 'whatsapp-crew-invite-migration-test',
      compatibilityDate: '2026-08-24',
      manifest: { mainModule: 'index.js', modules: { 'index.js': {
        type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };',
      } } },
      env: { DB: { type: 'd1', id: 'whatsapp-crew-invite-migration-test' } },
    } }] });
    const db = await mf.getD1Database('DB');
    try {
      for (const name of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith('.sql') && name <= targetMigration)
        .sort()) await apply(db, name);
      await db.prepare(`
        INSERT INTO users (id, display_name, oauth_provider, oauth_id)
        VALUES ('crew-link-user', 'Crew Link User', 'clerk', 'clerk-crew-link-user')
      `).run();
      await db.prepare(`
        INSERT INTO crew_referrals (
          id, clerk_organization_id, inviter_user_id, invited_email_hmac,
          crew_name, inviter_display_name, expires_at
        ) VALUES (
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'org_alpha', 'crew-link-user',
          'legacy-email-hmac', 'Alpha', 'Link User', datetime('now', '+30 days')
        )
      `).run();
      expect(await db.prepare(`
        SELECT invite_channel, reward_eligible FROM crew_referrals
        WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      `).first()).toEqual({ invite_channel: 'email', reward_eligible: 1 });
      await expect(db.prepare(`
        UPDATE crew_referrals SET invite_channel = 'sms'
        WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      `).run()).rejects.toThrow(/CHECK constraint failed/);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
      expect((await db.prepare('PRAGMA quick_check').all()).results).toEqual([{ quick_check: 'ok' }]);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
