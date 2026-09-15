import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const targetMigration = '0042_crew_stages.sql';

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

describe('0042 Crew stage migration', () => {
  it('creates one immutable-ready slot per valid Clerk Organization with intact foreign keys', async () => {
    const mf = new Miniflare({ workers: [{ config: {
      type: 'worker',
      name: 'crew-stage-migration-test',
      compatibilityDate: '2026-08-24',
      manifest: { mainModule: 'index.js', modules: { 'index.js': {
        type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };',
      } } },
      env: { DB: { type: 'd1', id: 'crew-stage-migration-test' } },
    } }] });
    const db = await mf.getD1Database('DB');
    try {
      for (const name of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith('.sql') && name <= targetMigration)
        .sort()) await apply(db, name);
      await db.prepare(`
        INSERT INTO users (id, display_name, oauth_provider, oauth_id)
        VALUES ('crew-stage-user', 'Crew Stage User', 'clerk', 'clerk-crew-stage-user')
      `).run();

      await db.prepare(`
        INSERT INTO crew_stages (
          clerk_organization_id, id, created_by_user_id, status, label,
          kind, blob_key, content_hash
        ) VALUES (
          'org_alpha_1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'crew-stage-user',
          'ready', 'THE OLD PARK', 'photo', 'crews/org_alpha_1/stages/a.png', ?
        )
      `).bind('a'.repeat(64)).run();
      await expect(db.prepare(`
        INSERT INTO crew_stages (clerk_organization_id, id, status)
        VALUES ('org_alpha_1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'reserved')
      `).run()).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(db.prepare(`
        INSERT INTO crew_stages (clerk_organization_id, id, status)
        VALUES ('../other-crew', 'cccccccccccccccccccccccccccccccc', 'reserved')
      `).run()).rejects.toThrow(/CHECK constraint failed/);
      await expect(db.prepare(`
        INSERT INTO crew_stages (clerk_organization_id, id, status)
        VALUES ('org_incomplete', 'dddddddddddddddddddddddddddddddd', 'ready')
      `).run()).rejects.toThrow(/CHECK constraint failed/);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
      expect((await db.prepare('PRAGMA quick_check').all()).results).toEqual([{ quick_check: 'ok' }]);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
