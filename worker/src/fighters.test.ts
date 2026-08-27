import { describe, expect, it } from 'vitest';
import {
  cloneCommunityFighter,
  copyCommunitySpritesToFighter,
  copyPublicSourceViewsToFighter,
  uploadFighterSource,
  uploadFighterSprite,
} from './fighters';
import type { AuthContext, Env, Fighter, SourceVersion, SpriteAsset, SpriteVersion, User } from './types';

class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  failPutWhen: ((key: string) => boolean) | null = null;

  async get(key: string): Promise<R2ObjectBody | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      httpMetadata: { contentType: 'image/png' },
      arrayBuffer: async () => bytes.slice().buffer,
    } as unknown as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    return this.objects.has(key) ? ({ key } as R2Object) : null;
  }

  async put(key: string, value: ArrayBuffer): Promise<R2Object> {
    if (this.failPutWhen?.(key)) throw new Error('simulated R2 put failure');
    this.objects.set(key, new Uint8Array(value));
    return { key } as R2Object;
  }

  async delete(input: string | string[]): Promise<void> {
    for (const key of Array.isArray(input) ? input : [input]) {
      this.deleted.push(key);
      this.objects.delete(key);
    }
  }
}

class FakeStatement {
  values: unknown[] = [];

  constructor(
    readonly database: FakeD1Database,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.query, this.values) as T | null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: this.database.all(this.query, this.values) as T[], meta: {} } as D1Result<T>;
  }
}

class FakeD1Database {
  readonly batches: FakeStatement[][] = [];
  existingSprites: SpriteAsset[] = [];
  publicFighter: Fighter | null = null;
  existingOwnedFighter: Fighter | null = null;
  duplicateSourceVersion: SourceVersion | null = null;
  duplicateSpriteVersion: SpriteVersion | null = null;
  committedInsertedVersion = true;
  failBatch = false;

  prepare(query: string): FakeStatement {
    return new FakeStatement(this, query);
  }

  async batch(statements: FakeStatement[]): Promise<D1Result[]> {
    this.batches.push(statements);
    if (this.failBatch) throw new Error('simulated D1 batch failure');
    return statements.map((statement) => {
      if (
        statement.query.includes('SELECT id FROM source_versions WHERE id = ?') ||
        statement.query.includes('SELECT id FROM sprite_versions WHERE id = ?')
      ) {
        return {
          success: true,
          results: this.committedInsertedVersion ? [{ id: statement.values[0] }] : [],
          meta: {},
        } as D1Result;
      }
      return { success: true, meta: {} } as D1Result;
    });
  }

  first(query: string, values: unknown[]): unknown {
    if (query.includes('SELECT * FROM fighters f')) return this.publicFighter;
    if (query.includes('owner_user_id = ? AND photo_hash = ?')) return this.existingOwnedFighter;
    if (query.includes('FROM source_versions') && query.includes('content_hash = ?')) {
      return this.duplicateSourceVersion;
    }
    if (query.includes('FROM sprite_versions') && query.includes('content_hash = ?')) {
      return this.duplicateSpriteVersion;
    }
    if (query.includes('WHERE id = ? AND owner_user_id = ?')) {
      return this.existingOwnedFighter?.id === values[0] ? this.existingOwnedFighter : null;
    }
    return null;
  }

  all(query: string, _values: unknown[]): unknown[] {
    if (query.includes('SELECT * FROM sprites WHERE fighter_id IN')) return this.existingSprites;
    return [];
  }
}

function fakeUser(): User {
  return {
    id: 'user-target',
    clerk_user_id: 'user-target',
    display_name: 'Target Player',
    avatar_url: null,
    email: 'target@example.com',
    plan_tier: 'free',
    credits_balance: 0,
    free_rookie_generations_used: 0,
    stripe_customer_id: null,
    elo_rating: 1200,
    wins: 0,
    losses: 0,
    win_streak: 0,
    best_streak: 0,
    total_kos: 0,
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
  };
}

const auth: AuthContext = {
  userId: 'user-target',
  user: fakeUser(),
  claims: {},
};

function fakeFighter(overrides: Partial<Fighter> = {}): Fighter {
  return {
    id: 'fighter-source',
    owner_user_id: 'user-source',
    name: 'Source Fighter',
    photo_hash: 'photo-hash',
    quality_tier: 'contender',
    public_flag: 1,
    original_blob_key: null,
    side_view_blob_key: null,
    side_view_raw_blob_key: null,
    upright_view_blob_key: null,
    upright_view_raw_blob_key: null,
    crouch_view_blob_key: null,
    crouch_view_raw_blob_key: null,
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

function fakeSprite(overrides: Partial<SpriteAsset> = {}): SpriteAsset {
  return {
    id: 'sprite-source',
    fighter_id: 'fighter-source',
    animation_name: 'idle',
    quality_tier: 'contender',
    blob_key: 'users/user-source/fighters/fighter-source/sprites/idle.png',
    raw_blob_key: null,
    content_hash: 'source-content-hash',
    raw_content_hash: null,
    frame_w: 256,
    frame_h: 256,
    frame_count: 8,
    animation_format: 'legacy',
    processing_version: 4,
    created_at: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

function fakeEnv(database: FakeD1Database, bucket: FakeR2Bucket): Env {
  return {
    DB: database as unknown as D1Database,
    SPRITES: bucket as unknown as R2Bucket,
    ENVIRONMENT: 'production',
    CORS_ORIGIN: 'https://insertplayer.ai',
  };
}

function tinyPngFile(name: string): File {
  return new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  ], name, { type: 'image/png' });
}

function sourceUploadRequest(): Request {
  const formData = new FormData();
  formData.set('kind', 'side');
  formData.set('file', tinyPngFile('side.png'));
  return new Request('https://api.insertplayer.ai/api/fighters/fighter-target/sources', {
    method: 'POST',
    body: formData,
  });
}

function spriteUploadRequest(includeRaw = false, animationFormat?: string): Request {
  const formData = new FormData();
  formData.set('animationName', 'idle');
  formData.set('qualityTier', 'contender');
  formData.set('frameWidth', '256');
  formData.set('frameHeight', '256');
  formData.set('frameCount', '8');
  if (animationFormat) formData.set('animationFormat', animationFormat);
  formData.set('processingVersion', '4');
  formData.set('file', tinyPngFile('idle.png'));
  if (includeRaw) formData.set('rawFile', tinyPngFile('idle-raw.png'));
  return new Request('https://api.insertplayer.ai/api/fighters/fighter-target/sprites', {
    method: 'POST',
    body: formData,
  });
}

describe('community fighter asset persistence', () => {
  it('rejects unknown sprite animation formats before writing bytes', async () => {
    const database = new FakeD1Database();
    database.existingOwnedFighter = fakeFighter({
      id: 'fighter-target',
      owner_user_id: auth.userId,
      public_flag: 0,
    });
    const bucket = new FakeR2Bucket();

    const response = await uploadFighterSprite(
      spriteUploadRequest(false, 'future-format'),
      fakeEnv(database, bucket),
      auth,
      'fighter-target',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid animationFormat' });
    expect(bucket.objects.size).toBe(0);
    expect(database.batches).toEqual([]);
  });

  it('removes earlier source copies when a later R2 copy fails', async () => {
    const database = new FakeD1Database();
    const bucket = new FakeR2Bucket();
    bucket.objects.set('source/side.png', new Uint8Array([1, 2, 3]));
    const source = fakeFighter({
      side_view_blob_key: 'source/side.png',
      upright_view_blob_key: 'source/missing-upright.png',
    });

    await expect(copyPublicSourceViewsToFighter(
      fakeEnv(database, bucket),
      auth,
      source,
      { id: 'fighter-target' },
    )).rejects.toThrow('Missing source asset');

    expect(Array.from(bucket.objects.keys())).toEqual(['source/side.png']);
    expect(bucket.deleted).toHaveLength(1);
    expect(bucket.deleted[0]).toMatch(/^users\/user-target\/fighters\/fighter-target\/sources\/side_/);
  });

  it('writes each copied sprite current row and version in one D1 batch', async () => {
    const database = new FakeD1Database();
    const bucket = new FakeR2Bucket();
    const sprite = fakeSprite();
    bucket.objects.set(sprite.blob_key, new Uint8Array([4, 5, 6]));

    await copyCommunitySpritesToFighter(fakeEnv(database, bucket), auth, [sprite], 'fighter-target');

    expect(database.batches).toHaveLength(1);
    expect(database.batches[0]).toHaveLength(2);
    expect(database.batches[0]?.[0]?.query).toContain('INSERT INTO sprite_versions');
    expect(database.batches[0]?.[1]?.query).toContain('INSERT INTO sprites');
    const copiedKey = String(database.batches[0]?.[0]?.values[4]);
    expect(database.batches[0]?.[1]?.values[4]).toBe(copiedKey);
    expect(bucket.objects.has(copiedKey)).toBe(true);
  });

  it('removes an uncommitted sprite copy when its D1 batch fails', async () => {
    const database = new FakeD1Database();
    database.failBatch = true;
    const bucket = new FakeR2Bucket();
    const sprite = fakeSprite();
    bucket.objects.set(sprite.blob_key, new Uint8Array([7, 8, 9]));

    await expect(copyCommunitySpritesToFighter(
      fakeEnv(database, bucket),
      auth,
      [sprite],
      'fighter-target',
    )).rejects.toThrow('simulated D1 batch failure');

    expect(Array.from(bucket.objects.keys())).toEqual([sprite.blob_key]);
    expect(bucket.deleted).toHaveLength(1);
  });

  it('removes every copied source when the new clone transaction fails', async () => {
    const database = new FakeD1Database();
    database.failBatch = true;
    database.publicFighter = fakeFighter({
      side_view_blob_key: 'source/side.png',
      upright_view_blob_key: 'source/upright.png',
      crouch_view_blob_key: 'source/crouch.png',
    });
    const bucket = new FakeR2Bucket();
    bucket.objects.set('source/side.png', new Uint8Array([1]));
    bucket.objects.set('source/upright.png', new Uint8Array([2]));
    bucket.objects.set('source/crouch.png', new Uint8Array([3]));

    await expect(cloneCommunityFighter(
      new Request('https://api.insertplayer.ai/api/community/fighter-source/clone', { method: 'POST' }),
      fakeEnv(database, bucket),
      auth,
      'fighter-source',
    )).rejects.toThrow('simulated D1 batch failure');

    expect(Array.from(bucket.objects.keys()).sort()).toEqual([
      'source/crouch.png',
      'source/side.png',
      'source/upright.png',
    ]);
    expect(bucket.deleted).toHaveLength(3);
  });
});

describe('direct fighter upload persistence', () => {
  it('keeps a committed source version and points current at the archived content', async () => {
    const database = new FakeD1Database();
    database.existingOwnedFighter = fakeFighter({ id: 'fighter-target', owner_user_id: auth.userId, public_flag: 0 });
    const bucket = new FakeR2Bucket();

    const response = await uploadFighterSource(
      sourceUploadRequest(),
      fakeEnv(database, bucket),
      auth,
      'fighter-target',
    );

    expect(response.status).toBe(200);
    expect(bucket.objects.size).toBe(1);
    expect(bucket.deleted).toHaveLength(0);
    expect(database.batches[0]?.[0]?.query).toContain('INSERT OR IGNORE INTO source_versions');
    expect(database.batches[0]?.[1]?.query).toContain('SELECT blob_key FROM source_versions');
  });

  it('deletes the losing R2 source copy after a concurrent content-hash insert', async () => {
    const database = new FakeD1Database();
    database.existingOwnedFighter = fakeFighter({ id: 'fighter-target', owner_user_id: auth.userId, public_flag: 0 });
    database.committedInsertedVersion = false;
    const bucket = new FakeR2Bucket();

    const response = await uploadFighterSource(
      sourceUploadRequest(),
      fakeEnv(database, bucket),
      auth,
      'fighter-target',
    );

    expect(response.status).toBe(200);
    expect(bucket.objects.size).toBe(0);
    expect(bucket.deleted).toHaveLength(1);
  });

  it('deletes processed and raw copies when a concurrent sprite version wins', async () => {
    const database = new FakeD1Database();
    database.existingOwnedFighter = fakeFighter({ id: 'fighter-target', owner_user_id: auth.userId, public_flag: 0 });
    database.committedInsertedVersion = false;
    const bucket = new FakeR2Bucket();

    const response = await uploadFighterSprite(
      spriteUploadRequest(true),
      fakeEnv(database, bucket),
      auth,
      'fighter-target',
    );

    expect(response.status).toBe(200);
    expect(bucket.objects.size).toBe(0);
    expect(bucket.deleted).toHaveLength(2);
    expect(database.batches[0]?.[0]?.query).toContain('INSERT OR IGNORE INTO sprite_versions');
    expect(database.batches[0]?.[1]?.query).toContain('FROM sprite_versions');
  });

  it('removes every staged sprite object when the atomic D1 write fails', async () => {
    const database = new FakeD1Database();
    database.existingOwnedFighter = fakeFighter({ id: 'fighter-target', owner_user_id: auth.userId, public_flag: 0 });
    database.failBatch = true;
    const bucket = new FakeR2Bucket();

    await expect(uploadFighterSprite(
      spriteUploadRequest(true),
      fakeEnv(database, bucket),
      auth,
      'fighter-target',
    )).rejects.toThrow('simulated D1 batch failure');

    expect(bucket.objects.size).toBe(0);
    expect(bucket.deleted).toHaveLength(2);
  });
});
