import { generateId, hashString } from './auth';
import type { Env, Fighter, QualityTier, SourceVersion, SpriteVersion } from './types';
import {
  normalizeSpriteAnimationFormat,
  type SpriteAnimationFormat,
} from './spriteAnimationFormat';

export type GeneratedSourceKind =
  | 'side'
  | 'side_raw'
  | 'upright'
  | 'upright_raw'
  | 'crouch'
  | 'crouch_raw';

const SOURCE_COLUMNS: Record<GeneratedSourceKind, keyof Fighter> = {
  side: 'side_view_blob_key',
  side_raw: 'side_view_raw_blob_key',
  upright: 'upright_view_blob_key',
  upright_raw: 'upright_view_raw_blob_key',
  crouch: 'crouch_view_blob_key',
  crouch_raw: 'crouch_view_raw_blob_key',
};

const PLAYABLE_ANIMATIONS = new Set([
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
]);
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_SPRITE_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_DIMENSION = 4096;
const MAX_FRAME_COUNT = 64;

export interface PersistedGeneratedAsset {
  versionId: string;
  blobKey: string;
  contentHash: string;
  reused: boolean;
}

export interface PersistedGeneratedSprite extends PersistedGeneratedAsset {
  rawBlobKey: string | null;
  rawContentHash: string | null;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  animationFormat: SpriteAnimationFormat;
}

function isPng(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  return view.length >= 8 &&
    view[0] === 0x89 &&
    view[1] === 0x50 &&
    view[2] === 0x4e &&
    view[3] === 0x47 &&
    view[4] === 0x0d &&
    view[5] === 0x0a &&
    view[6] === 0x1a &&
    view[7] === 0x0a;
}

function assertGeneratedPng(bytes: ArrayBuffer, maxBytes: number, label: string): void {
  if (bytes.byteLength < 8 || bytes.byteLength > maxBytes || !isPng(bytes)) {
    throw new Error(`${label} is not a valid bounded PNG`);
  }
}

async function requireOwnedFighter(env: Env, userId: string, fighterId: string): Promise<Fighter> {
  const fighter = await env.DB.prepare(
    'SELECT * FROM fighters WHERE id = ? AND owner_user_id = ?'
  ).bind(fighterId, userId).first<Fighter>();
  if (!fighter) throw new Error('Generation fighter is missing or belongs to another user');
  return fighter;
}

async function ensureObject(
  env: Env,
  key: string,
  bytes: ArrayBuffer,
  metadata: Record<string, string>,
): Promise<boolean> {
  const existing = await env.SPRITES.head(key);
  if (existing?.customMetadata?.contentHash === metadata.contentHash) return false;
  await env.SPRITES.put(key, bytes, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: metadata,
  });
  return true;
}

async function deleteKeys(env: Env, keys: Array<string | null>): Promise<void> {
  const present = keys.filter((key): key is string => Boolean(key));
  if (present.length > 0) await env.SPRITES.delete(present);
}

export async function persistGeneratedSource(
  env: Env,
  params: {
    jobId: string;
    userId: string;
    fighterId: string;
    kind: GeneratedSourceKind;
    bytes: ArrayBuffer;
  },
): Promise<PersistedGeneratedAsset> {
  assertGeneratedPng(params.bytes, MAX_SOURCE_BYTES, `Generated ${params.kind} source`);
  await requireOwnedFighter(env, params.userId, params.fighterId);
  const contentHash = await hashString(params.bytes);
  const duplicate = await env.DB.prepare(`
    SELECT * FROM source_versions
    WHERE fighter_id = ? AND kind = ? AND content_hash = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(params.fighterId, params.kind, contentHash).first<SourceVersion>();
  const column = SOURCE_COLUMNS[params.kind];

  if (duplicate) {
    await ensureObject(env, duplicate.blob_key, params.bytes, {
      contentHash,
      jobId: params.jobId,
      sourceKind: params.kind,
    });
    await env.DB.prepare(
      `UPDATE fighters SET ${column} = ?, updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?`
    ).bind(duplicate.blob_key, params.fighterId, params.userId).run();
    return {
      versionId: duplicate.id,
      blobKey: duplicate.blob_key,
      contentHash,
      reused: true,
    };
  }

  const versionId = (await hashString(
    `${params.jobId}:source:${params.kind}:${contentHash}`
  )).slice(0, 32);
  const key = `users/${params.userId}/fighters/${params.fighterId}/sources/${params.kind}_${versionId}.png`;
  const wroteSource = await ensureObject(env, key, params.bytes, {
    contentHash,
    jobId: params.jobId,
    sourceKind: params.kind,
  });

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
        VALUES (?, ?, ?, ?, ?)
      `).bind(versionId, params.fighterId, params.kind, key, contentHash),
      env.DB.prepare(`
        UPDATE fighters
        SET ${column} = COALESCE((
          SELECT blob_key FROM source_versions
          WHERE fighter_id = ? AND kind = ? AND content_hash = ?
          ORDER BY created_at DESC
          LIMIT 1
        ), ${column}), updated_at = datetime('now')
        WHERE id = ? AND owner_user_id = ?
      `).bind(params.fighterId, params.kind, contentHash, params.fighterId, params.userId),
    ]);
  } catch (error) {
    if (wroteSource) await deleteKeys(env, [key]);
    throw error;
  }

  const persisted = await env.DB.prepare(`
    SELECT * FROM source_versions
    WHERE fighter_id = ? AND kind = ? AND content_hash = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(params.fighterId, params.kind, contentHash).first<SourceVersion>();
  if (!persisted) {
    if (wroteSource) await deleteKeys(env, [key]);
    throw new Error(`Generated ${params.kind} source could not be committed`);
  }
  if (wroteSource && persisted.blob_key !== key) await deleteKeys(env, [key]);
  return {
    versionId: persisted.id,
    blobKey: persisted.blob_key,
    contentHash,
    reused: persisted.id !== versionId,
  };
}

function currentSpriteStatement(
  env: Env,
  params: {
    fighterId: string;
    animationName: string;
    tier: QualityTier;
    contentHash: string;
    rawContentHash: string | null;
    animationFormat: SpriteAnimationFormat;
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    processingVersion: number;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO sprites (
      id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      content_hash, raw_content_hash, frame_w, frame_h, frame_count, processing_version
      , animation_format
    )
    SELECT ?, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      content_hash, raw_content_hash, frame_w, frame_h, frame_count, processing_version,
      animation_format
    FROM sprite_versions
    WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      AND content_hash = ? AND COALESCE(raw_content_hash, '') = COALESCE(?, '')
      AND animation_format = ?
      AND frame_w = ? AND frame_h = ? AND frame_count = ? AND processing_version = ?
    ORDER BY created_at DESC
    LIMIT 1
    ON CONFLICT(fighter_id, animation_name, quality_tier) DO UPDATE SET
      blob_key = excluded.blob_key,
      raw_blob_key = excluded.raw_blob_key,
      content_hash = excluded.content_hash,
      raw_content_hash = excluded.raw_content_hash,
      frame_w = excluded.frame_w,
      frame_h = excluded.frame_h,
      frame_count = excluded.frame_count,
      processing_version = excluded.processing_version,
      animation_format = excluded.animation_format,
      created_at = datetime('now')
  `).bind(
    generateId(),
    params.fighterId,
    params.animationName,
    params.tier,
    params.contentHash,
    params.rawContentHash,
    params.animationFormat,
    params.frameWidth,
    params.frameHeight,
    params.frameCount,
    params.processingVersion,
  );
}

export async function persistGeneratedSprite(
  env: Env,
  params: {
    jobId: string;
    userId: string;
    fighterId: string;
    tier: QualityTier;
    animationName: string;
    bytes: ArrayBuffer;
    rawBytes: ArrayBuffer | null;
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    processingVersion: number;
    animationFormat?: SpriteAnimationFormat;
    /** Keep false for private review candidates. Existing callers promote immediately. */
    setCurrent?: boolean;
  },
): Promise<PersistedGeneratedSprite> {
  if (!PLAYABLE_ANIMATIONS.has(params.animationName)) {
    throw new Error(`Unsupported generated animation: ${params.animationName}`);
  }
  const numericMetadata = [
    params.frameWidth,
    params.frameHeight,
    params.frameCount,
    params.processingVersion,
  ];
  if (
    numericMetadata.some((value) => !Number.isInteger(value)) ||
    params.frameWidth < 1 || params.frameWidth > MAX_FRAME_DIMENSION ||
    params.frameHeight < 1 || params.frameHeight > MAX_FRAME_DIMENSION ||
    params.frameCount < 1 || params.frameCount > MAX_FRAME_COUNT ||
    params.processingVersion < 0 || params.processingVersion > 100
  ) {
    throw new Error('Generated sprite metadata is invalid');
  }
  assertGeneratedPng(params.bytes, MAX_SPRITE_BYTES, 'Generated sprite sheet');
  if (params.rawBytes) assertGeneratedPng(params.rawBytes, MAX_SPRITE_BYTES, 'Generated raw sprite sheet');
  await requireOwnedFighter(env, params.userId, params.fighterId);
  const contentHash = await hashString(params.bytes);
  const rawContentHash = params.rawBytes ? await hashString(params.rawBytes) : null;
  const animationFormat = normalizeSpriteAnimationFormat(params.animationFormat);
  const duplicate = await env.DB.prepare(`
    SELECT * FROM sprite_versions
    WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      AND content_hash = ? AND COALESCE(raw_content_hash, '') = COALESCE(?, '')
      AND animation_format = ?
      AND frame_w = ? AND frame_h = ? AND frame_count = ? AND processing_version = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(
    params.fighterId,
    params.animationName,
    params.tier,
    contentHash,
    rawContentHash,
    animationFormat,
    params.frameWidth,
    params.frameHeight,
    params.frameCount,
    params.processingVersion,
  ).first<SpriteVersion>();

  if (duplicate) {
    await ensureObject(env, duplicate.blob_key, params.bytes, {
      contentHash,
      jobId: params.jobId,
      animationName: params.animationName,
      animationFormat,
      qualityTier: params.tier,
    });
    if (duplicate.raw_blob_key && params.rawBytes && rawContentHash) {
      await ensureObject(env, duplicate.raw_blob_key, params.rawBytes, {
        contentHash: rawContentHash,
        jobId: params.jobId,
        animationName: params.animationName,
        animationFormat,
        qualityTier: params.tier,
        raw: 'true',
      });
    }
    if (params.setCurrent !== false) {
      await currentSpriteStatement(env, {
        fighterId: params.fighterId,
        animationName: params.animationName,
        tier: params.tier,
        contentHash,
        rawContentHash,
        animationFormat,
        frameWidth: params.frameWidth,
        frameHeight: params.frameHeight,
        frameCount: params.frameCount,
        processingVersion: params.processingVersion,
      }).run();
    }
    return {
      versionId: duplicate.id,
      blobKey: duplicate.blob_key,
      contentHash,
      rawBlobKey: duplicate.raw_blob_key,
      rawContentHash,
      frameWidth: duplicate.frame_w,
      frameHeight: duplicate.frame_h,
      frameCount: duplicate.frame_count,
      animationFormat: normalizeSpriteAnimationFormat(duplicate.animation_format),
      reused: true,
    };
  }

  const versionId = (await hashString(
    `${params.jobId}:sprite:${params.animationName}:${params.tier}:${animationFormat}:${params.frameWidth}x${params.frameHeight}:${params.frameCount}:${params.processingVersion}:${contentHash}:${rawContentHash ?? ''}`
  )).slice(0, 32);
  const safeAnimation = params.animationName.replace(/[^a-z0-9_-]/gi, '_');
  const key = `users/${params.userId}/fighters/${params.fighterId}/sprites/${safeAnimation}_${params.tier}_${versionId}.png`;
  const rawKey = params.rawBytes
    ? `users/${params.userId}/fighters/${params.fighterId}/sprites/raw/${safeAnimation}_${params.tier}_${versionId}.png`
    : null;
  const stagedKeys: string[] = [];
  try {
    const wroteSprite = await ensureObject(env, key, params.bytes, {
      contentHash,
      jobId: params.jobId,
      animationName: params.animationName,
      animationFormat,
      qualityTier: params.tier,
    });
    if (wroteSprite) stagedKeys.push(key);
    if (rawKey && params.rawBytes && rawContentHash) {
      const wroteRaw = await ensureObject(env, rawKey, params.rawBytes, {
        contentHash: rawContentHash,
        jobId: params.jobId,
        animationName: params.animationName,
        animationFormat,
        qualityTier: params.tier,
        raw: 'true',
      });
      if (wroteRaw) stagedKeys.push(rawKey);
    }
    const statements = [
      env.DB.prepare(`
        INSERT OR IGNORE INTO sprite_versions (
          id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
          content_hash, raw_content_hash, frame_w, frame_h, frame_count, processing_version
          , animation_format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        versionId,
        params.fighterId,
        params.animationName,
        params.tier,
        key,
        rawKey,
        contentHash,
        rawContentHash,
        params.frameWidth,
        params.frameHeight,
        params.frameCount,
        params.processingVersion,
        animationFormat,
      ),
    ];
    if (params.setCurrent !== false) {
      statements.push(currentSpriteStatement(env, {
        fighterId: params.fighterId,
        animationName: params.animationName,
        tier: params.tier,
        contentHash,
        rawContentHash,
        animationFormat,
        frameWidth: params.frameWidth,
        frameHeight: params.frameHeight,
        frameCount: params.frameCount,
        processingVersion: params.processingVersion,
      }));
    }
    await env.DB.batch(statements);
  } catch (error) {
    await deleteKeys(env, stagedKeys);
    throw error;
  }

  const persisted = await env.DB.prepare(`
    SELECT * FROM sprite_versions
    WHERE fighter_id = ? AND animation_name = ? AND quality_tier = ?
      AND content_hash = ? AND COALESCE(raw_content_hash, '') = COALESCE(?, '')
      AND animation_format = ?
      AND frame_w = ? AND frame_h = ? AND frame_count = ? AND processing_version = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(
    params.fighterId,
    params.animationName,
    params.tier,
    contentHash,
    rawContentHash,
    animationFormat,
    params.frameWidth,
    params.frameHeight,
    params.frameCount,
    params.processingVersion,
  ).first<SpriteVersion>();
  if (!persisted) {
    await deleteKeys(env, stagedKeys);
    throw new Error(`Generated ${params.animationName} sprite could not be committed`);
  }
  if (persisted.blob_key !== key && stagedKeys.includes(key)) await deleteKeys(env, [key]);
  if (rawKey && persisted.raw_blob_key !== rawKey && stagedKeys.includes(rawKey)) {
    await deleteKeys(env, [rawKey]);
  }
  return {
    versionId: persisted.id,
    blobKey: persisted.blob_key,
    contentHash,
    rawBlobKey: persisted.raw_blob_key,
    rawContentHash,
    frameWidth: persisted.frame_w,
    frameHeight: persisted.frame_h,
    frameCount: persisted.frame_count,
    animationFormat: normalizeSpriteAnimationFormat(persisted.animation_format),
    reused: persisted.id !== versionId,
  };
}

export async function promoteGeneratedSourceVersion(
  env: Env,
  params: {
    userId: string;
    fighterId: string;
    kind: GeneratedSourceKind;
    versionId: string;
  },
): Promise<SourceVersion> {
  await requireOwnedFighter(env, params.userId, params.fighterId);
  const version = await env.DB.prepare(`
    SELECT *
    FROM source_versions
    WHERE id = ? AND fighter_id = ? AND kind = ?
    LIMIT 1
  `).bind(params.versionId, params.fighterId, params.kind).first<SourceVersion>();
  if (!version) throw new Error(`Checkpointed ${params.kind} source version is unavailable`);

  const column = SOURCE_COLUMNS[params.kind];
  await env.DB.prepare(`
    UPDATE fighters
    SET ${column} = ?, updated_at = datetime('now')
    WHERE id = ? AND owner_user_id = ?
  `).bind(version.blob_key, params.fighterId, params.userId).run();
  return version;
}

export async function promoteGeneratedSpriteVersion(
  env: Env,
  params: {
    userId: string;
    fighterId: string;
    tier: QualityTier;
    animationName: string;
    versionId: string;
  },
): Promise<SpriteVersion> {
  await requireOwnedFighter(env, params.userId, params.fighterId);
  const version = await env.DB.prepare(`
    SELECT *
    FROM sprite_versions
    WHERE id = ? AND fighter_id = ? AND animation_name = ? AND quality_tier = ?
    LIMIT 1
  `).bind(
    params.versionId,
    params.fighterId,
    params.animationName,
    params.tier,
  ).first<SpriteVersion>();
  if (!version) throw new Error(`Checkpointed ${params.animationName} sprite version is unavailable`);

  await env.DB.prepare(`
    INSERT INTO sprites (
      id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      content_hash, raw_content_hash, frame_w, frame_h, frame_count, processing_version
      , animation_format
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fighter_id, animation_name, quality_tier) DO UPDATE SET
      blob_key = excluded.blob_key,
      raw_blob_key = excluded.raw_blob_key,
      content_hash = excluded.content_hash,
      raw_content_hash = excluded.raw_content_hash,
      frame_w = excluded.frame_w,
      frame_h = excluded.frame_h,
      frame_count = excluded.frame_count,
      processing_version = excluded.processing_version,
      animation_format = excluded.animation_format,
      created_at = datetime('now')
  `).bind(
    generateId(),
    version.fighter_id,
    version.animation_name,
    version.quality_tier,
    version.blob_key,
    version.raw_blob_key,
    version.content_hash,
    version.raw_content_hash,
    version.frame_w,
    version.frame_h,
    version.frame_count,
    version.processing_version,
    normalizeSpriteAnimationFormat(version.animation_format),
  ).run();
  return version;
}
