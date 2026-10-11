import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const targetMigration = '0048_fighter_source_videos.sql';

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

describe('0048 fighter source video registry', () => {
  it('records one immutable live source per action plus alternate takes', async () => {
    const mf = new Miniflare({ workers: [{ config: {
      type: 'worker',
      name: 'fighter-source-videos-migration-test',
      compatibilityDate: '2026-08-24',
      manifest: { mainModule: 'index.js', modules: { 'index.js': {
        type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };',
      } } },
      env: { DB: { type: 'd1', id: 'fighter-source-videos-migration-test' } },
    } }] });
    const db = await mf.getD1Database('DB');
    const sha = (c: string) => c.repeat(64);
    const insert = (id: string, take: string, role: string, sprite: string | null, key: string) => db.prepare(`
      INSERT INTO fighter_source_videos (
        id, fighter_id, action, take_label, role, sprite_version_id, provider_model,
        video_blob_key, video_sha256, video_size_bytes, video_width, video_height,
        video_frame_count, video_fps, source_note
      ) VALUES (?, 'f', 'ko', ?, ?, ?, 'xai/grok-imagine-video/v1.5/image-to-video',
        ?, ?, 667357, 816, 1104, 49, 24, 'sealed bundle source')
    `).bind(id, take, role, sprite, key, sha('a')).run();
    try {
      for (const name of readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith('.sql') && name <= targetMigration)
        .sort()) await apply(db, name);
      await db.prepare(`
        INSERT INTO users (id, display_name, oauth_provider, oauth_id)
        VALUES ('u', 'Owner', 'clerk', 'clerk-u')
      `).run();
      await db.prepare(`
        INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
        VALUES ('f', 'u', 'Champion', 'hash', 'champion')
      `).run();
      await db.prepare(`
        INSERT INTO sprite_versions (id, fighter_id, animation_name, quality_tier, blob_key, frame_w, frame_h, frame_count)
        VALUES ('sv', 'f', 'ko', 'champion', 'k', 192, 256, 12)
      `).run();
      await insert('1'.repeat(32), '1', 'alternate_take', null, 'archive/ko-1.mp4');
      await insert('2'.repeat(32), '2', 'live_source', 'sv', 'archive/ko-2.mp4');
      await expect(insert('3'.repeat(32), '3', 'live_source', 'sv', 'archive/ko-3.mp4'))
        .rejects.toThrow(/UNIQUE constraint failed/);
      await expect(insert('4'.repeat(32), '4', 'live_source', null, 'archive/ko-4.mp4'))
        .rejects.toThrow(/CHECK constraint failed/);
      await expect(db.prepare(`
        UPDATE fighter_source_videos SET role = 'alternate_take' WHERE id = ?
      `).bind('2'.repeat(32)).run()).rejects.toThrow(/immutable/);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
      expect((await db.prepare('PRAGMA quick_check').all()).results).toEqual([{ quick_check: 'ok' }]);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
