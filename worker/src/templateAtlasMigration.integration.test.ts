import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrationName = '0041_template_atlas_animation_format.sql';
const targetTables = ['sprites', 'sprite_versions', 'generation_artifact_checkpoints'];

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

function migration(name: string): string[] {
  return statements(readFileSync(join(migrationsDirectory, name), 'utf8'));
}

async function database(): Promise<{ mf: Miniflare; db: D1Database }> {
  const mf = new Miniflare({ workers: [{ config: {
    type: 'worker', name: 'template-atlas-migration-test', compatibilityDate: '2026-08-22',
    manifest: { mainModule: 'index.js', modules: { 'index.js': {
      type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };',
    } } },
    env: { DB: { type: 'd1', id: 'template-atlas-migration-db' } },
  } }] });
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql') && name < migrationName).sort()) {
    for (const statement of migration(name)) await db.prepare(statement).run();
  }
  return { mf, db };
}

function spriteInsert(db: D1Database, table: 'sprites' | 'sprite_versions', id: string, format: string, action = 'idle') {
  return db.prepare(`INSERT INTO ${table} (
    id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
    frame_w, frame_h, frame_count, processing_version, content_hash,
    raw_content_hash, animation_format, created_at
  ) VALUES (?, 'fighter-atlas', ?, 'rookie', 'clean.png', 'raw.png',
    768, 1024, 8, 6, 'same-clean-hash', 'same-raw-hash', ?, '2026-01-01 00:00:00')`)
    .bind(id, action, format);
}

function checkpointInsert(db: D1Database, name: string, format: string, stage = 14) {
  return db.prepare(`INSERT INTO generation_artifact_checkpoints (
    run_id, artifact_kind, artifact_name, stage_index, tier, status,
    clean_version_id, raw_version_id, clean_blob_key, raw_blob_key,
    clean_content_hash, raw_content_hash, frame_w, frame_h, frame_count,
    processing_version, metadata_json, completed_by_job_id, created_at, verified_at,
    animation_format
  ) VALUES ('run-atlas', 'sprite', ?, ?, 'rookie', 'approved', 'version-legacy',
    'raw-version', 'clean.png', 'raw.png', 'clean-hash', 'raw-hash', 768, 1024, 8, 6,
    '{"kept":true}', 'job-atlas', '2026-01-01 00:00:00', '2026-01-02 00:00:00', ?)`)
    .bind(name, stage, format);
}

async function seed(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO users (id, display_name, oauth_provider, oauth_id)
      VALUES ('user-atlas', 'Atlas Test', 'clerk', 'clerk-atlas')`),
    db.prepare(`INSERT INTO fighters (id, owner_user_id, name, photo_hash)
      VALUES ('fighter-atlas', 'user-atlas', 'Atlas', 'atlas-photo')`),
    db.prepare(`INSERT INTO generation_artifact_runs (
      id, user_id, fighter_id, tier, operation, root_job_id, status
    ) VALUES ('run-atlas', 'user-atlas', 'fighter-atlas', 'rookie', 'fighter_generation', 'job-atlas', 'partial')`),
    spriteInsert(db, 'sprites', 'sprite-legacy', 'legacy'),
    spriteInsert(db, 'sprites', 'sprite-video', 'video-dense-v1', 'walk'),
    spriteInsert(db, 'sprite_versions', 'version-legacy', 'legacy'),
    spriteInsert(db, 'sprite_versions', 'version-video', 'video-dense-v1'),
    checkpointInsert(db, 'legacy-frame', 'legacy', 1),
    checkpointInsert(db, 'video-frame', 'video-dense-v1'),
    // A referencing child makes any accidental version-table rebuild observable.
    db.prepare(`CREATE TABLE atlas_test_version_ref (
      id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES sprite_versions(id) ON DELETE CASCADE
    )`),
    db.prepare(`INSERT INTO atlas_test_version_ref VALUES ('keep-child', 'version-video')`),
  ]);
}

async function rows(db: D1Database, table: string): Promise<Record<string, unknown>[]> {
  const values = (await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()).results;
  return values.map(row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== 'animation_format_before_atlas').sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function indexesAndTriggers(db: D1Database) {
  return (await db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`).all<{ type: string; name: string; sql: string }>()).results
    .map(row => ({ ...row, sql: row.sql.replace(/\s+/g, ' ').trim() }));
}

describe('0041 template atlas format migration', () => {
  it('preserves every value, ID, FK, index and trigger while admitting atlas and 64 ordered stages', async () => {
    const { mf, db } = await database();
    try {
      await seed(db);
      const checkedTables = [...targetTables, 'users', 'fighters', 'generation_artifact_runs', 'atlas_test_version_ref'];
      const before = new Map(await Promise.all(checkedTables.map(async table => [table, await rows(db, table)] as const)));
      const beforeSchema = await indexesAndTriggers(db);
      const beforeFks = new Map(await Promise.all(targetTables.map(async table => [table, (await db.prepare(`PRAGMA foreign_key_list(${table})`).all()).results] as const)));
      // A leaf-only replacement is safe only while there are no incoming FKs.
      for (const { name } of (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()).results) {
        // D1 deliberately denies PRAGMA inspection of its own internal tables.
        if (name.startsWith('_cf_') || name.startsWith('sqlite_')) continue;
        const fks = (await db.prepare(`PRAGMA foreign_key_list('${name.replaceAll("'", "''")}')`).all<{ table: string }>()).results;
        expect(fks.some(fk => fk.table === 'generation_artifact_checkpoints')).toBe(false);
      }
      await db.batch(migration(migrationName).map(sql => db.prepare(sql)));
      for (const table of checkedTables) {
        const after = await rows(db, table);
        expect(after, table).toEqual(before.get(table));
        expect(digest(after), `${table} exact row checksum`).toBe(digest(before.get(table)));
      }
      expect(await indexesAndTriggers(db)).toEqual(beforeSchema);
      for (const table of targetTables) {
        expect((await db.prepare(`PRAGMA foreign_key_list(${table})`).all()).results).toEqual(beforeFks.get(table));
      }
      for (const table of ['sprites', 'sprite_versions']) {
        expect((await db.prepare(`SELECT animation_format, animation_format_before_atlas FROM ${table} ORDER BY animation_format`).all()).results)
          .toEqual([{ animation_format: 'legacy', animation_format_before_atlas: 'legacy' },
            { animation_format: 'video-dense-v1', animation_format_before_atlas: 'video-dense-v1' }]);
      }
      // Identical bytes may have all three playback contracts. The UNIQUE index
      // must use the new column, not the historical default ('legacy').
      await spriteInsert(db, 'sprite_versions', 'version-atlas', 'template-atlas-v1').run();
      await expect(spriteInsert(db, 'sprite_versions', 'duplicate-atlas', 'template-atlas-v1').run()).rejects.toThrow(/UNIQUE constraint failed/);
      await spriteInsert(db, 'sprites', 'sprite-atlas', 'template-atlas-v1', 'high_kick').run();
      await checkpointInsert(db, 'atlas-frame', 'template-atlas-v1', 23).run();
      for (const format of ['legacy', 'video-dense-v1']) {
        await spriteInsert(db, 'sprite_versions', `new-${format}`, format, 'victory').run();
        await spriteInsert(db, 'sprites', `current-${format}`, format, `action-${format}`).run();
        await checkpointInsert(db, `checkpoint-${format}`, format).run();
      }
      for (const table of ['sprites', 'sprite_versions'] as const) {
        await expect(spriteInsert(db, table, `${table}-bad`, 'unknown-format', 'bad').run()).rejects.toThrow(/CHECK constraint failed/);
        await expect(db.prepare(`UPDATE ${table} SET animation_format = 'unknown-format' WHERE id = ?`).bind(table === 'sprites' ? 'sprite-legacy' : 'version-legacy').run()).rejects.toThrow(/CHECK constraint failed/);
      }
      await expect(checkpointInsert(db, 'bad-format', 'unknown-format').run()).rejects.toThrow(/CHECK constraint failed/);
      for (const stage of [1, 14, 15, 22, 23, 64]) await checkpointInsert(db, `stage-${stage}`, 'template-atlas-v1', stage).run();
      for (const stage of [0, 65]) await expect(checkpointInsert(db, `stage-${stage}`, 'template-atlas-v1', stage).run()).rejects.toThrow(/CHECK constraint failed/);
      await expect(checkpointInsert(db, 'atlas-frame', 'template-atlas-v1', 23).run()).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(db.prepare(`UPDATE generation_artifact_checkpoints SET run_id = 'missing-parent' WHERE artifact_name = 'atlas-frame'`).run()).rejects.toThrow(/FOREIGN KEY constraint failed/);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
      expect((await db.prepare('PRAGMA quick_check').all()).results).toEqual([{ quick_check: 'ok' }]);
    } finally { await mf.dispose(); }
  }, 30_000);

  it('rolls back the whole migration transaction on failure, including copied checkpoints and triggers', async () => {
    const { mf, db } = await database();
    try {
      await seed(db);
      const before = await rows(db, 'generation_artifact_checkpoints');
      const schema = await indexesAndTriggers(db);
      const batch = migration(migrationName).map(sql => db.prepare(sql));
      batch.push(db.prepare('INSERT INTO definitely_missing_atlas_test_table VALUES (1)'));
      await expect(db.batch(batch)).rejects.toThrow();
      expect(await rows(db, 'generation_artifact_checkpoints')).toEqual(before);
      expect(await indexesAndTriggers(db)).toEqual(schema);
      expect((await db.prepare('PRAGMA table_info(sprites)').all<{ name: string }>()).results.some(column => column.name === 'animation_format_before_atlas')).toBe(false);
      await expect(checkpointInsert(db, 'still-old-format', 'template-atlas-v1').run()).rejects.toThrow(/CHECK constraint failed/);
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
    } finally { await mf.dispose(); }
  }, 30_000);
});
