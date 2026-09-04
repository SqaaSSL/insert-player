import type {
  ArcadeFighter,
  AuthContext,
  Env,
  Fighter,
  FighterPersonalityId,
  PublicAuthContext,
  QualityTier,
  SourceVersion,
  SpriteAsset,
  SpriteVersion,
  Stage,
} from './types';
import { generateId, hashString } from './auth';
import { inspectArcadeAssetIntegrity } from './arcadeAssets';
import { drainFighterAssetDeletions, listFighterAssetKeys } from './assetDeletion';
import { maxTier, normalizeQualityTier, TIER_DEFINITIONS } from './tiers';
import { publicAppName, publicSocialCardUrl } from './branding';
import { readJsonBody, readMultipartFormData } from './requestBody';
import {
  isSpriteAnimationFormat,
  normalizeSpriteAnimationFormat,
  type SpriteAnimationFormat,
} from './spriteAnimationFormat';

type SourceKind =
  | 'original'
  | 'side'
  | 'side_raw'
  | 'upright'
  | 'upright_raw'
  | 'crouch'
  | 'crouch_raw';

const SOURCE_COLUMNS: Record<SourceKind, keyof Fighter> = {
  original: 'original_blob_key',
  side: 'side_view_blob_key',
  side_raw: 'side_view_raw_blob_key',
  upright: 'upright_view_blob_key',
  upright_raw: 'upright_view_raw_blob_key',
  crouch: 'crouch_view_blob_key',
  crouch_raw: 'crouch_view_raw_blob_key',
};

const PUBLIC_CLONE_SOURCE_KINDS: SourceKind[] = ['side', 'upright', 'crouch'];
const PLAYABLE_ANIMATION_NAMES = [
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
] as const;
const PLAYABLE_ANIMATION_COUNT = PLAYABLE_ANIMATION_NAMES.length;
const PLAYABLE_ANIMATION_SQL_LIST = PLAYABLE_ANIMATION_NAMES.map((name) => `'${name}'`).join(', ');
const MAX_SOURCE_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_SPRITE_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_MULTIPART_BODY_BYTES = MAX_SOURCE_UPLOAD_BYTES + 256 * 1024;
const MAX_SPRITE_MULTIPART_BODY_BYTES = MAX_SPRITE_UPLOAD_BYTES * 2 + 512 * 1024;
const MAX_FIGHTER_JSON_BODY_BYTES = 16 * 1024;
const MAX_COMMUNITY_REPORT_BODY_BYTES = 2 * 1024;
const MAX_COMMUNITY_REPORT_DETAILS_CHARS = 500;
const MAX_SPRITE_FRAME_DIMENSION = 4096;
const MAX_SPRITE_FRAME_COUNT = 64;
const MAX_PROCESSING_VERSION = 100;
const HIGH_DENSITY_SPRITE_FRAME_WIDTH = 768;
const HIGH_DENSITY_SPRITE_FRAME_HEIGHT = 1024;
const VIDEO_DENSE_PING_PONG_ANIMATIONS = new Set([
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
]);
const MAX_FIGHTER_NAME_CHARS = 48;
const MAX_ARCADE_CHALLENGER_LINE_CHARS = 120;
const MAX_ARCADE_REFERENCE_TEXT_CHARS = 240;
const ALLOWED_UPLOAD_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const FIGHTER_PERSONALITY_IDS = new Set<FighterPersonalityId>([
  'balanced',
  'brawler',
  'counter',
  'zoner',
  'showboat',
]);
const PUBLIC_COMMUNITY_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=300',
};
const PUBLIC_SHARE_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=900',
};
const PUBLIC_ASSET_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=60, s-maxage=300, must-revalidate',
};
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
};
const COMMUNITY_REPORT_REASONS = new Set([
  'non_consensual_person',
  'sexual_content',
  'hate_or_harassment',
  'graphic_violence',
  'copyright_or_trademark',
  'personal_information',
  'spam',
  'other',
]);
const HTML_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; img-src https: data:; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

interface UploadImageFormat {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

interface CopiedPublicSourceView {
  versionId: string;
  kind: SourceKind;
  blobKey: string;
}

interface CopiedPublicSourceViews {
  columns: Partial<Record<keyof Fighter, string | null>>;
  versions: CopiedPublicSourceView[];
}

interface ArcadeFighterRow extends Fighter {
  arcade_slug: string;
  arcade_sort_order: number;
  arcade_challenger_line: string;
  arcade_default_personality: FighterPersonalityId;
  arcade_reference_kind: ArcadeFighter['reference_kind'];
  arcade_reference_source_url: string | null;
  arcade_reference_license: string;
  arcade_reference_credit: string;
  arcade_generation_prompt: string | null;
  arcade_status: ArcadeFighter['status'];
  arcade_created_at: string;
  arcade_updated_at: string;
}

const MIN_ARCADE_GENERATION_PROMPT_CHARS = 180;
const MAX_ARCADE_GENERATION_PROMPT_CHARS = 3000;

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: extraHeaders });
}

function html(markup: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(markup, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...HTML_SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function normalizeImageContentType(value: string): string {
  const normalized = value.toLowerCase().trim();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function detectUploadImageFormat(bytes: ArrayBuffer): UploadImageFormat | null {
  const view = new Uint8Array(bytes);
  if (
    view.length >= 8 &&
    view[0] === 0x89 &&
    view[1] === 0x50 &&
    view[2] === 0x4e &&
    view[3] === 0x47 &&
    view[4] === 0x0d &&
    view[5] === 0x0a &&
    view[6] === 0x1a &&
    view[7] === 0x0a
  ) {
    return { contentType: 'image/png' };
  }
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
    return { contentType: 'image/jpeg' };
  }
  if (
    view.length >= 12 &&
    view[0] === 0x52 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x46 &&
    view[8] === 0x57 &&
    view[9] === 0x45 &&
    view[10] === 0x42 &&
    view[11] === 0x50
  ) {
    return { contentType: 'image/webp' };
  }
  return null;
}

function rejectOversizedUpload(file: File, label: string, maxBytes: number): Response | null {
  if (file.size > maxBytes) {
    return json({ error: `${label} is too large` }, 413);
  }
  return null;
}

function validateUploadedImageBytes(
  file: File,
  bytes: ArrayBuffer,
  label: string,
  maxBytes: number,
): UploadImageFormat | Response {
  if (bytes.byteLength > maxBytes) {
    return json({ error: `${label} is too large` }, 413);
  }

  const declaredType = normalizeImageContentType(file.type || '');
  if (declaredType && !ALLOWED_UPLOAD_IMAGE_TYPES.has(declaredType)) {
    return json({ error: `${label} must be a PNG, JPEG, or WebP image` }, 415);
  }

  const detected = detectUploadImageFormat(bytes);
  if (!detected) {
    return json({ error: `${label} must be a PNG, JPEG, or WebP image` }, 415);
  }
  if (declaredType && declaredType !== detected.contentType) {
    return json({ error: `${label} content type does not match the uploaded bytes` }, 415);
  }
  return detected;
}

function assetUrl(request: Request, key: string | null): string | null {
  if (!key) return null;
  const url = new URL(request.url);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${url.origin}/assets/${encoded}`;
}

type PublicSourceKind = 'side' | 'upright' | 'crouch';

const PUBLIC_SOURCE_COLUMNS: Record<PublicSourceKind, keyof Fighter> = {
  side: 'side_view_blob_key',
  upright: 'upright_view_blob_key',
  crouch: 'crouch_view_blob_key',
};

function publicAssetRevision(key: string | null): string | null {
  if (!key) return null;
  return key.split('/').at(-1) ?? null;
}

function publicSourceAssetUrl(
  request: Request,
  fighterId: string,
  kind: PublicSourceKind,
  key: string | null,
): string | null {
  const revision = publicAssetRevision(key);
  if (!revision) return null;
  const url = new URL(request.url);
  return `${url.origin}/public-assets/fighters/${encodeURIComponent(fighterId)}/sources/${kind}/${encodeURIComponent(revision)}`;
}

function publicSpriteAssetUrl(
  request: Request,
  fighterId: string,
  sprite: SpriteAsset,
): string | null {
  const revision = publicAssetRevision(sprite.blob_key);
  if (!revision) return null;
  const url = new URL(request.url);
  return `${url.origin}/public-assets/fighters/${encodeURIComponent(fighterId)}/sprites/${encodeURIComponent(sprite.id)}/${encodeURIComponent(revision)}`;
}

function publicArcadeSpriteHighDensityAssetUrl(
  request: Request,
  fighterId: string,
  sprite: SpriteAsset,
): string | null {
  const revision = publicAssetRevision(sprite.raw_blob_key);
  if (!revision) return null;
  const url = new URL(request.url);
  return `${url.origin}/public-assets/arcade/${encodeURIComponent(fighterId)}/sprites/${encodeURIComponent(sprite.id)}/hq/${encodeURIComponent(revision)}`;
}

function decodeAssetKey(key: string): string | Response {
  let decodedKey: string;
  try {
    decodedKey = decodeURIComponent(key);
  } catch {
    return json({ error: 'Invalid asset key' }, 400);
  }

  const segments = decodedKey.split('/');
  if (
    !decodedKey ||
    decodedKey.length > 1024 ||
    decodedKey.startsWith('/') ||
    !decodedKey.startsWith('users/') ||
    segments.length < 3 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    /[\u0000-\u001f\u007f]/.test(decodedKey)
  ) {
    return json({ error: 'Invalid asset key' }, 400);
  }
  return decodedKey;
}

function namespacedAssetOwner(key: string): string | null {
  const segments = key.split('/');
  return segments[0] === 'users' && segments[1] ? segments[1] : null;
}

function playableSpriteSetSql(fighterAlias: string, qualityTier?: QualityTier): string {
  const tierCondition = qualityTier
    ? `AND s.quality_tier = '${qualityTier}'`
    : `AND NOT EXISTS (
        SELECT 1
        FROM sprites higher
        WHERE higher.fighter_id = s.fighter_id
          AND higher.animation_name = s.animation_name
          AND CASE higher.quality_tier
            WHEN 'champion' THEN 3
            WHEN 'contender' THEN 2
            ELSE 1
          END > CASE s.quality_tier
            WHEN 'champion' THEN 3
            WHEN 'contender' THEN 2
            ELSE 1
          END
      )`;
  return `(
    SELECT COUNT(DISTINCT s.animation_name)
    FROM sprites s
    WHERE s.fighter_id = ${fighterAlias}.id
      AND s.animation_name IN (${PLAYABLE_ANIMATION_SQL_LIST})
      AND length(s.content_hash) = 64
      AND s.content_hash NOT GLOB '*[^0-9A-Fa-f]*'
      AND typeof(s.frame_w) = 'integer'
      AND s.frame_w BETWEEN 1 AND ${MAX_SPRITE_FRAME_DIMENSION}
      AND typeof(s.frame_h) = 'integer'
      AND s.frame_h BETWEEN 1 AND ${MAX_SPRITE_FRAME_DIMENSION}
      AND typeof(s.frame_count) = 'integer'
      AND s.frame_count BETWEEN 1 AND ${MAX_SPRITE_FRAME_COUNT}
      ${tierCondition}
  ) = ${PLAYABLE_ANIMATION_COUNT}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char);
}

function cleanFighterNameString(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeFighterName(value: unknown, fallback: string): string {
  const requested = typeof value === 'string' ? cleanFighterNameString(value) : '';
  const normalized = requested || cleanFighterNameString(fallback) || 'Fighter';
  return Array.from(normalized).slice(0, MAX_FIGHTER_NAME_CHARS).join('');
}

function normalizeBoundedText(value: unknown, fallback: string, maxChars: number): string {
  const requested = typeof value === 'string' ? cleanFighterNameString(value) : '';
  return Array.from(requested || fallback).slice(0, maxChars).join('');
}

function normalizeHttpsUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function frontendOrigin(env: Env): string {
  const configured = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .find((origin) => /^https:\/\//i.test(origin));
  return configured ?? 'https://insertplayer.ai';
}

function serializeSprite(
  request: Request,
  sprite: SpriteAsset | SpriteVersion,
  includeContentHashes = false,
) {
  const hasKnownHighDensityRaw = Boolean(sprite.raw_blob_key) &&
    normalizeSpriteAnimationFormat(sprite.animation_format) === 'video-dense-v1';
  const rawFrameCount = hasKnownHighDensityRaw &&
    normalizeSpriteAnimationFormat(sprite.animation_format) === 'video-dense-v1' &&
    VIDEO_DENSE_PING_PONG_ANIMATIONS.has(sprite.animation_name) &&
    sprite.frame_count % 2 === 1
    ? (sprite.frame_count + 1) / 2
    : hasKnownHighDensityRaw ? sprite.frame_count : null;
  const serialized = {
    id: sprite.id,
    animationName: sprite.animation_name,
    qualityTier: sprite.quality_tier,
    url: assetUrl(request, sprite.blob_key),
    rawUrl: assetUrl(request, sprite.raw_blob_key),
    frameWidth: sprite.frame_w,
    frameHeight: sprite.frame_h,
    frameCount: sprite.frame_count,
    rawFrameWidth: hasKnownHighDensityRaw ? HIGH_DENSITY_SPRITE_FRAME_WIDTH : null,
    rawFrameHeight: hasKnownHighDensityRaw ? HIGH_DENSITY_SPRITE_FRAME_HEIGHT : null,
    rawFrameCount,
    animationFormat: normalizeSpriteAnimationFormat(sprite.animation_format),
    processingVersion: sprite.processing_version,
    createdAt: sprite.created_at,
  };
  return includeContentHashes
    ? {
        ...serialized,
        contentHash: sprite.content_hash,
        rawContentHash: sprite.raw_content_hash,
      }
    : serialized;
}

function serializeCurrentSourceHashes(
  fighter: Fighter,
  sourceVersions: SourceVersion[],
): Record<SourceKind, string | null> {
  const hashesByKey = new Map(sourceVersions.map((version) => [version.blob_key, version.content_hash]));
  return Object.fromEntries(
    Object.entries(SOURCE_COLUMNS).map(([kind, column]) => {
      const blobKey = fighter[column];
      return [kind, typeof blobKey === 'string' ? hashesByKey.get(blobKey) ?? null : null];
    }),
  ) as Record<SourceKind, string | null>;
}

function serializeFighter(
  request: Request,
  fighter: Fighter,
  sprites: SpriteAsset[] = [],
  spriteVersions?: SpriteVersion[],
  sourceVersions?: SourceVersion[],
) {
  const includePrivateManifest = Array.isArray(spriteVersions) && Array.isArray(sourceVersions);
  const serialized = {
    id: fighter.id,
    ownerUserId: fighter.owner_user_id,
    name: normalizeFighterName(fighter.name, 'Fighter'),
    photoHash: fighter.photo_hash,
    qualityTier: fighter.quality_tier,
    public: Boolean(fighter.public_flag),
    createdAt: fighter.created_at,
    updatedAt: fighter.updated_at,
    sources: {
      original: assetUrl(request, fighter.original_blob_key),
      side: assetUrl(request, fighter.side_view_blob_key),
      sideRaw: assetUrl(request, fighter.side_view_raw_blob_key),
      upright: assetUrl(request, fighter.upright_view_blob_key),
      uprightRaw: assetUrl(request, fighter.upright_view_raw_blob_key),
      crouch: assetUrl(request, fighter.crouch_view_blob_key),
      crouchRaw: assetUrl(request, fighter.crouch_view_raw_blob_key),
    },
    sprites: sprites.map((sprite) => serializeSprite(request, sprite, includePrivateManifest)),
  };
  if (includePrivateManifest) {
    return {
      ...serialized,
      sourceHashes: serializeCurrentSourceHashes(fighter, sourceVersions),
      spriteVersions: spriteVersions.map((sprite) => serializeSprite(request, sprite, true)),
    };
  }
  return serialized;
}

function serializeCommunityFighter(
  request: Request,
  fighter: Fighter,
  sprites: SpriteAsset[] = [],
) {
  const serialized = serializeFighter(request, fighter, sprites);
  const {
    ownerUserId: _ownerUserId,
    photoHash: _photoHash,
    sources,
    sprites: _serializedSprites,
    ...publicFighter
  } = serialized;

  return {
    ...publicFighter,
    sources: {
      original: null,
      side: publicSourceAssetUrl(request, fighter.id, 'side', fighter.side_view_blob_key),
      sideRaw: null,
      upright: publicSourceAssetUrl(request, fighter.id, 'upright', fighter.upright_view_blob_key),
      uprightRaw: null,
      crouch: publicSourceAssetUrl(request, fighter.id, 'crouch', fighter.crouch_view_blob_key),
      crouchRaw: null,
    },
    sprites: sprites.map((sprite) => ({
      ...serializeSprite(request, sprite),
      // Processed bytes are already public through this URL. Publishing their
      // digest gives clients an immutable cache identity without exposing the
      // private archival/raw asset or its digest.
      contentHash: sprite.content_hash,
      url: publicSpriteAssetUrl(request, fighter.id, sprite),
      rawUrl: null,
      rawFrameWidth: null,
      rawFrameHeight: null,
      rawFrameCount: null,
    })),
    owner: {
      name: 'Player',
    },
  };
}

function serializeArcadeFighter(
  request: Request,
  fighter: ArcadeFighterRow,
  sprites: SpriteAsset[] = [],
) {
  const serialized = serializeCommunityFighter(request, fighter, sprites);
  const spriteById = new Map(sprites.map((sprite) => [sprite.id, sprite]));
  return {
    ...serialized,
    sprites: serialized.sprites.map((sprite) => {
      const source = spriteById.get(sprite.id);
      const highDensity = source
        ? serializeSprite(request, source)
        : null;
      const hasPublicHighDensityAsset = Boolean(
        source && highDensity?.rawFrameWidth && highDensity.rawFrameHeight && highDensity.rawFrameCount,
      );
      return {
        ...sprite,
        // video-dense RAW rows are compiler-normalized, alpha-cleaned and reviewed.
        // Publish them only as an Arcade gameplay derivative; rawUrl and raw
        // metadata remain private on every public fighter payload.
        hqUrl: source && hasPublicHighDensityAsset
          ? publicArcadeSpriteHighDensityAssetUrl(request, fighter.id, source)
          : null,
        hqFrameWidth: highDensity?.rawFrameWidth ?? null,
        hqFrameHeight: highDensity?.rawFrameHeight ?? null,
        hqFrameCount: highDensity?.rawFrameCount ?? null,
      };
    }),
    arcade: {
      slug: fighter.arcade_slug,
      rank: fighter.arcade_sort_order,
      challengerLine: fighter.arcade_challenger_line,
      defaultPersonality: fighter.arcade_default_personality,
      reference: {
        kind: fighter.arcade_reference_kind,
        sourceUrl: fighter.arcade_reference_source_url,
        license: fighter.arcade_reference_license,
        credit: fighter.arcade_reference_credit,
      },
    },
  };
}

function arcadeFighterSelectSql(whereClause: string, orderClause: string): string {
  return `
    SELECT
      f.*,
      af.slug AS arcade_slug,
      af.sort_order AS arcade_sort_order,
      af.challenger_line AS arcade_challenger_line,
      af.default_personality AS arcade_default_personality,
      af.reference_kind AS arcade_reference_kind,
      af.reference_source_url AS arcade_reference_source_url,
      af.reference_license AS arcade_reference_license,
      af.reference_credit AS arcade_reference_credit,
      af.generation_prompt AS arcade_generation_prompt,
      af.status AS arcade_status,
      af.created_at AS arcade_created_at,
      af.updated_at AS arcade_updated_at
    FROM arcade_fighters af
    JOIN fighters f ON f.id = af.fighter_id
    ${whereClause}
    ${orderClause}
  `;
}

function serializeAdminArcadeFighter(fighter: ArcadeFighterRow) {
  return {
    fighterId: fighter.id,
    fighterName: normalizeFighterName(fighter.name, 'Fighter'),
    qualityTier: fighter.quality_tier,
    public: Boolean(fighter.public_flag),
    slug: fighter.arcade_slug,
    rank: fighter.arcade_sort_order,
    challengerLine: fighter.arcade_challenger_line,
    defaultPersonality: fighter.arcade_default_personality,
    reference: {
      kind: fighter.arcade_reference_kind,
      sourceUrl: fighter.arcade_reference_source_url,
      license: fighter.arcade_reference_license,
      credit: fighter.arcade_reference_credit,
    },
    generationPrompt: fighter.arcade_generation_prompt,
    status: fighter.arcade_status,
    createdAt: fighter.arcade_created_at,
    updatedAt: fighter.arcade_updated_at,
  };
}

async function getOwnedFighter(env: Env, fighterId: string, userId: string): Promise<Fighter | null> {
  return env.DB.prepare(
    'SELECT * FROM fighters WHERE id = ? AND owner_user_id = ?'
  ).bind(fighterId, userId).first<Fighter>();
}

async function isActiveArcadeFighter(env: Env, fighterId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(`
    SELECT 1 FROM arcade_fighters WHERE fighter_id = ? AND status = 'active' LIMIT 1
  `).bind(fighterId).first());
}

function activeArcadeMutationFailure(): Response {
  return json({
    error: 'Active Arcade globals can only change through a sealed reviewed transition',
  }, 409, NO_STORE_HEADERS);
}

async function getOwnedFighterByPhotoHash(env: Env, userId: string, photoHash: string): Promise<Fighter | null> {
  return env.DB.prepare(
    'SELECT * FROM fighters WHERE owner_user_id = ? AND photo_hash = ?'
  ).bind(userId, photoHash).first<Fighter>();
}

async function getSpritesForFighters(env: Env, fighterIds: string[]): Promise<SpriteAsset[]> {
  if (fighterIds.length === 0) return [];
  const placeholders = fighterIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT * FROM sprites WHERE fighter_id IN (${placeholders}) ORDER BY animation_name, quality_tier`
  ).bind(...fighterIds).all<SpriteAsset>();
  return results ?? [];
}

async function getSpriteVersionsForFighter(env: Env, fighterId: string): Promise<SpriteVersion[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sprite_versions WHERE fighter_id = ? ORDER BY created_at DESC'
  ).bind(fighterId).all<SpriteVersion>();
  return results ?? [];
}

async function getSourceVersionsForFighter(env: Env, fighterId: string): Promise<SourceVersion[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM source_versions WHERE fighter_id = ? ORDER BY created_at DESC'
  ).bind(fighterId).all<SourceVersion>();
  return results ?? [];
}

async function getMissingPlayableAnimationNames(
  env: Env,
  fighterId: string,
  qualityTier?: QualityTier,
): Promise<string[]> {
  const tierCondition = qualityTier ? ' AND quality_tier = ?' : '';
  const statement = env.DB.prepare(
    `SELECT DISTINCT animation_name FROM sprites WHERE fighter_id = ?${tierCondition}`
  );
  const { results } = qualityTier
    ? await statement.bind(fighterId, qualityTier).all<{ animation_name: string }>()
    : await statement.bind(fighterId).all<{ animation_name: string }>();
  const available = new Set((results ?? []).map((sprite) => sprite.animation_name));
  return PLAYABLE_ANIMATION_NAMES.filter((name) => !available.has(name));
}

async function fighterHasPlayableSprite(
  env: Env,
  fighterId: string,
  qualityTier?: QualityTier,
): Promise<boolean> {
  return (await getMissingPlayableAnimationNames(env, fighterId, qualityTier)).length === 0;
}

async function resolvePublicFlag(
  env: Env,
  fighterId: string,
  requestedPublic: boolean | undefined,
  currentPublicFlag: number,
): Promise<number | Response> {
  if (typeof requestedPublic !== 'boolean') return currentPublicFlag;
  if (!requestedPublic) return 0;
  const missingAnimations = await getMissingPlayableAnimationNames(env, fighterId);
  if (missingAnimations.length > 0) {
    return json({
      error: 'Upload the full playable animation set before publishing',
      missingAnimations,
    }, 409);
  }
  return 1;
}

function readCommunityLimit(value: string | null): number {
  const parsed = Number(value ?? 48);
  if (!Number.isFinite(parsed)) return 48;
  return Math.min(Math.max(Math.round(parsed), 1), 96);
}

export function tiersResponse(): Response {
  return json({
    tiers: Object.values(TIER_DEFINITIONS).map(({ id, label, creditCost, animationRetryCreditCost }) => ({
      id,
      label,
      creditCost,
      animationRetryCreditCost,
    })),
  });
}

export async function listFighters(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT f.*
     FROM fighters f
     WHERE f.owner_user_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = f.id
       )
     ORDER BY f.updated_at DESC`
  ).bind(auth.userId).all<Fighter>();
  const fighters = results ?? [];
  const fighterIds = fighters.map((fighter) => fighter.id);
  const sprites = await getSpritesForFighters(env, fighterIds);
  const spritesByFighter = new Map<string, SpriteAsset[]>();
  for (const sprite of sprites) {
    const existing = spritesByFighter.get(sprite.fighter_id) ?? [];
    existing.push(sprite);
    spritesByFighter.set(sprite.fighter_id, existing);
  }
  return json({
    fighters: fighters.map((fighter) => serializeFighter(request, fighter, spritesByFighter.get(fighter.id) ?? [])),
  });
}

export async function listCommunityFighters(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = readCommunityLimit(url.searchParams.get('limit'));
  const { results } = await env.DB.prepare(`
    SELECT f.*
    FROM fighters f
    WHERE f.public_flag = 1
      AND NOT EXISTS (
        SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = f.id
      )
      AND ${playableSpriteSetSql('f')}
    ORDER BY f.updated_at DESC
    LIMIT ?
  `).bind(limit).all<Fighter>();
  const fighters = results ?? [];
  const sprites = await getSpritesForFighters(env, fighters.map((fighter) => fighter.id));
  const spritesByFighter = new Map<string, SpriteAsset[]>();
  for (const sprite of sprites) {
    const existing = spritesByFighter.get(sprite.fighter_id) ?? [];
    existing.push(sprite);
    spritesByFighter.set(sprite.fighter_id, existing);
  }
  return json({
    fighters: fighters.map((fighter) => serializeCommunityFighter(request, fighter, spritesByFighter.get(fighter.id) ?? [])),
  }, 200, PUBLIC_COMMUNITY_CACHE_HEADERS);
}

export async function listOwnedCommunityFighterIds(
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const { results } = await env.DB.prepare(`
    SELECT DISTINCT source.id
    FROM fighters source
    JOIN fighters owned
      ON owned.photo_hash = source.photo_hash
     AND owned.owner_user_id = ?
    WHERE source.public_flag = 1
      AND NOT EXISTS (
        SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = source.id
      )
      AND ${playableSpriteSetSql('source')}
    ORDER BY source.id ASC
  `).bind(auth.userId).all<{ id: string }>();
  return json({ fighterIds: (results ?? []).map(({ id }) => id) }, 200, NO_STORE_HEADERS);
}

export async function listArcadeFighters(request: Request, env: Env): Promise<Response> {
  // Arcade globals can change through reviewed promote/rollback operations. Keep
  // the roster uncached across colos; each sprite URL remains content-addressed.
  const { results } = await env.DB.prepare(arcadeFighterSelectSql(
    `WHERE af.status = 'active'
      AND f.public_flag = 1
      AND f.quality_tier = 'champion'
      AND ${playableSpriteSetSql('f', 'champion')}`,
    'ORDER BY af.sort_order ASC, af.updated_at DESC',
  )).all<ArcadeFighterRow>();
  const fighters = results ?? [];
  const sprites = (await getSpritesForFighters(env, fighters.map((fighter) => fighter.id)))
    .filter((sprite) => sprite.quality_tier === 'champion');
  const spritesByFighter = new Map<string, SpriteAsset[]>();
  for (const sprite of sprites) {
    const existing = spritesByFighter.get(sprite.fighter_id) ?? [];
    existing.push(sprite);
    spritesByFighter.set(sprite.fighter_id, existing);
  }
  return json({
    fighters: fighters.map((fighter) => serializeArcadeFighter(
      request,
      fighter,
      spritesByFighter.get(fighter.id) ?? [],
    )),
  }, 200, NO_STORE_HEADERS);
}

export async function listAdminArcadeFighters(env: Env, auth: AuthContext): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403, NO_STORE_HEADERS);
  const { results } = await env.DB.prepare(arcadeFighterSelectSql(
    'WHERE f.owner_user_id = ?',
    'ORDER BY af.sort_order ASC, af.updated_at DESC',
  )).bind(auth.userId).all<ArcadeFighterRow>();
  return json({ fighters: (results ?? []).map(serializeAdminArcadeFighter) }, 200, NO_STORE_HEADERS);
}

export async function upsertAdminArcadeFighter(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  if (auth.user.plan_tier !== 'admin') return json({ error: 'Admin access required' }, 403, NO_STORE_HEADERS);
  if (!/^[a-f0-9]{32}$/.test(fighterId)) return json({ error: 'A valid fighterId is required' }, 400, NO_STORE_HEADERS);

  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Admin fighter not found' }, 404, NO_STORE_HEADERS);
  const existing = await env.DB.prepare(
    'SELECT * FROM arcade_fighters WHERE fighter_id = ?'
  ).bind(fighterId).first<ArcadeFighter>();
  const body = await readJsonBody<{
    slug?: unknown;
    rank?: unknown;
    challengerLine?: unknown;
    defaultPersonality?: unknown;
    reference?: {
      kind?: unknown;
      sourceUrl?: unknown;
      license?: unknown;
      credit?: unknown;
    };
    generationPrompt?: unknown;
    status?: unknown;
  }>(request, MAX_FIGHTER_JSON_BODY_BYTES);

  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : existing?.slug ?? '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    return json({ error: 'Arcade slug must use lowercase letters, numbers, and hyphens' }, 400, NO_STORE_HEADERS);
  }
  const rank = body.rank === undefined ? existing?.sort_order ?? 0 : Number(body.rank);
  if (!Number.isInteger(rank) || rank < 1 || rank > 999) {
    return json({ error: 'Arcade rank must be an integer from 1 to 999' }, 400, NO_STORE_HEADERS);
  }
  const challengerLine = normalizeBoundedText(
    body.challengerLine,
    existing?.challenger_line ?? '',
    MAX_ARCADE_CHALLENGER_LINE_CHARS,
  );
  if (!challengerLine) return json({ error: 'A challenger line is required' }, 400, NO_STORE_HEADERS);
  const defaultPersonality = (
    body.defaultPersonality === undefined ? existing?.default_personality : body.defaultPersonality
  );
  if (typeof defaultPersonality !== 'string' || !FIGHTER_PERSONALITY_IDS.has(defaultPersonality as FighterPersonalityId)) {
    return json({ error: 'A supported default personality is required' }, 400, NO_STORE_HEADERS);
  }

  const referenceKind = body.reference?.kind === undefined
    ? existing?.reference_kind
    : body.reference.kind;
  if (referenceKind !== 'generated' && referenceKind !== 'licensed') {
    return json({ error: 'Reference kind must be generated or licensed' }, 400, NO_STORE_HEADERS);
  }
  const referenceSourceUrl = body.reference?.sourceUrl === undefined
    ? existing?.reference_source_url ?? null
    : normalizeHttpsUrl(body.reference.sourceUrl);
  if (referenceKind === 'licensed' && !referenceSourceUrl) {
    return json({ error: 'Licensed references require an HTTPS source URL' }, 400, NO_STORE_HEADERS);
  }
  const referenceLicense = normalizeBoundedText(
    body.reference?.license,
    existing?.reference_license ?? '',
    MAX_ARCADE_REFERENCE_TEXT_CHARS,
  );
  const referenceCredit = normalizeBoundedText(
    body.reference?.credit,
    existing?.reference_credit ?? '',
    MAX_ARCADE_REFERENCE_TEXT_CHARS,
  );
  if (!referenceLicense || !referenceCredit) {
    return json({ error: 'Reference licence and credit are required' }, 400, NO_STORE_HEADERS);
  }
  const status = body.status === undefined ? existing?.status ?? 'draft' : body.status;
  if (status !== 'draft' && status !== 'active' && status !== 'retired') {
    return json({ error: 'Arcade status must be draft, active, or retired' }, 400, NO_STORE_HEADERS);
  }
  const generationPrompt = normalizeBoundedText(
    body.generationPrompt,
    existing?.generation_prompt ?? '',
    MAX_ARCADE_GENERATION_PROMPT_CHARS,
  );
  if (status !== 'retired' && generationPrompt.length < MIN_ARCADE_GENERATION_PROMPT_CHARS) {
    return json({ error: 'A detailed private Arcade generation prompt is required' }, 400, NO_STORE_HEADERS);
  }
  if (status === 'active' && existing?.status !== 'active') {
    const reviewedVideoRun = await env.DB.prepare(`
      SELECT 1 AS present
      FROM generation_artifact_runs
      WHERE fighter_id = ? AND user_id = ? AND creation_flow = 'video'
        AND CASE
          WHEN json_valid(source_manifest_json)
          THEN json_extract(source_manifest_json, '$.reviewedCanonicalSources.mode')
          ELSE NULL
        END = 'reviewed-current-v1'
      LIMIT 1
    `).bind(fighterId, auth.userId).first<{ present: number }>();
    if (reviewedVideoRun) {
      return json({
        error: 'Reviewed Video fighters must use the dedicated reviewed activation endpoint',
      }, 409, NO_STORE_HEADERS);
    }
  }
  if (status === 'active') {
    const assetIntegrity = fighter.quality_tier === 'champion'
      ? await inspectArcadeAssetIntegrity(env, fighterId)
      : { ready: false, missingAssets: ['tier:champion'] };
    if (!assetIntegrity.ready) {
      return json({
        error: 'Generate the full playable animation set before activating this fighter',
        missingAssets: assetIntegrity.missingAssets,
      }, 409, NO_STORE_HEADERS);
    }
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO arcade_fighters (
          fighter_id, slug, sort_order, challenger_line, default_personality,
          reference_kind, reference_source_url, reference_license, reference_credit,
          generation_prompt, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fighter_id) DO UPDATE SET
          slug = excluded.slug,
          sort_order = excluded.sort_order,
          challenger_line = excluded.challenger_line,
          default_personality = excluded.default_personality,
          reference_kind = excluded.reference_kind,
          reference_source_url = excluded.reference_source_url,
          reference_license = excluded.reference_license,
          reference_credit = excluded.reference_credit,
          generation_prompt = excluded.generation_prompt,
          status = excluded.status,
          updated_at = datetime('now')
      `).bind(
        fighterId,
        slug,
        rank,
        challengerLine,
        defaultPersonality,
        referenceKind,
        referenceKind === 'licensed' ? referenceSourceUrl : null,
        referenceLicense,
        referenceCredit,
        generationPrompt || null,
        status,
      ),
      env.DB.prepare(`
        UPDATE fighters
        SET public_flag = ?, updated_at = datetime('now')
        WHERE id = ? AND owner_user_id = ?
      `).bind(status === 'active' ? 1 : 0, fighterId, auth.userId),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('unique')) {
      return json({ error: 'Arcade slug is already in use' }, 409, NO_STORE_HEADERS);
    }
    throw error;
  }

  const updated = await env.DB.prepare(arcadeFighterSelectSql(
    'WHERE af.fighter_id = ? AND f.owner_user_id = ?',
    'LIMIT 1',
  )).bind(fighterId, auth.userId).first<ArcadeFighterRow>();
  return json({ fighter: updated ? serializeAdminArcadeFighter(updated) : null }, existing ? 200 : 201, NO_STORE_HEADERS);
}

export async function getCommunityFighter(
  request: Request,
  env: Env,
  fighterId: string,
): Promise<Response> {
  const fighter = await env.DB.prepare(`
    SELECT f.*
    FROM fighters f
    WHERE f.id = ?
      AND f.public_flag = 1
      AND NOT EXISTS (
        SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = f.id
      )
      AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId).first<Fighter>();
  if (!fighter) return json({ error: 'Public fighter not found' }, 404, NO_STORE_HEADERS);
  const sprites = await getSpritesForFighters(env, [fighterId]);
  return json({ fighter: serializeCommunityFighter(request, fighter, sprites) }, 200, PUBLIC_COMMUNITY_CACHE_HEADERS);
}

function normalizeCommunityReportDetails(value: unknown): string | null | Response {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return json({ error: 'Report details must be text' }, 400);
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!normalized) return null;
  if (normalized.length > MAX_COMMUNITY_REPORT_DETAILS_CHARS) {
    return json({ error: `Report details must be ${MAX_COMMUNITY_REPORT_DETAILS_CHARS} characters or fewer` }, 400);
  }
  return normalized;
}

export async function reportCommunityFighter(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const body = await readJsonBody<{ reason?: unknown; details?: unknown }>(
    request,
    MAX_COMMUNITY_REPORT_BODY_BYTES,
  );
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!COMMUNITY_REPORT_REASONS.has(reason)) {
    return json({ error: 'Select a valid report reason' }, 400, NO_STORE_HEADERS);
  }
  const details = normalizeCommunityReportDetails(body.details);
  if (details instanceof Response) return details;

  const fighter = await env.DB.prepare(`
    SELECT f.id, f.owner_user_id, f.name
    FROM fighters f
    WHERE f.id = ? AND f.public_flag = 1
      AND NOT EXISTS (
        SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = f.id
      )
    LIMIT 1
  `).bind(fighterId).first<Pick<Fighter, 'id' | 'owner_user_id' | 'name'>>();
  if (!fighter) return json({ error: 'Public fighter not found' }, 404, NO_STORE_HEADERS);
  if (fighter.owner_user_id === auth.userId) {
    return json({ error: 'You cannot report your own fighter; unpublish it from Training Room instead' }, 409, NO_STORE_HEADERS);
  }

  const reportId = generateId();
  const report = await env.DB.prepare(`
    INSERT INTO community_reports (
      id,
      fighter_id,
      fighter_owner_user_id,
      fighter_name,
      reporter_user_id,
      reason,
      details
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fighter_id, reporter_user_id) DO UPDATE SET
      fighter_owner_user_id = excluded.fighter_owner_user_id,
      fighter_name = excluded.fighter_name,
      reason = excluded.reason,
      details = excluded.details,
      status = 'open',
      submission_count = community_reports.submission_count + 1,
      reviewed_by_user_id = NULL,
      moderation_note = NULL,
      updated_at = datetime('now')
    RETURNING id, status, submission_count, created_at, updated_at
  `).bind(
    reportId,
    fighter.id,
    fighter.owner_user_id,
    normalizeFighterName(fighter.name, 'Community Fighter'),
    auth.userId,
    reason,
    details,
  ).first<{
    id: string;
    status: string;
    submission_count: number;
    created_at: string;
    updated_at: string;
  }>();
  if (!report) throw new Error('Community report was not persisted');

  return json({
    report: {
      id: report.id,
      status: report.status,
      duplicate: report.submission_count > 1,
      createdAt: report.created_at,
      updatedAt: report.updated_at,
    },
  }, report.submission_count > 1 ? 200 : 201, NO_STORE_HEADERS);
}

export async function shareCommunityFighterPage(
  request: Request,
  env: Env,
  fighterId: string,
): Promise<Response> {
  const fighter = await env.DB.prepare(`
    SELECT f.*
    FROM fighters f
    WHERE f.id = ? AND f.public_flag = 1
      AND NOT EXISTS (
        SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = f.id
      )
      AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId).first<Fighter>();
  if (!fighter) {
    return html('<!doctype html><title>Fighter not found</title><h1>Fighter not found</h1>', 404, {
      ...NO_STORE_HEADERS,
    });
  }

  const sprite = await env.DB.prepare(`
    SELECT * FROM sprites
    WHERE fighter_id = ?
    ORDER BY
      CASE quality_tier WHEN 'champion' THEN 3 WHEN 'contender' THEN 2 ELSE 1 END DESC,
      animation_name = 'idle' DESC,
      created_at DESC
    LIMIT 1
  `).bind(fighterId).first<SpriteAsset>();

  const imageUrl =
    publicSourceAssetUrl(request, fighter.id, 'side', fighter.side_view_blob_key) ??
    publicSourceAssetUrl(request, fighter.id, 'upright', fighter.upright_view_blob_key) ??
    publicSourceAssetUrl(request, fighter.id, 'crouch', fighter.crouch_view_blob_key) ??
    (sprite ? publicSpriteAssetUrl(request, fighter.id, sprite) : null) ??
    publicSocialCardUrl(env);
  const redirectUrl = `${frontendOrigin(env)}/community?fighter=${encodeURIComponent(fighter.id)}`;
  const fighterName = normalizeFighterName(fighter.name, 'Community Fighter');
  const appName = publicAppName(env);
  const title = `${fighterName} - ${appName}`;
  const description = `Challenge ${fighterName}, an AI-generated playable fighter in ${appName}, then clone them into your roster.`;
  const imageAlt = `${fighterName}, AI-generated playable fighter preview`;
  const redirectScriptNonce = generateId();
  const shareCsp = `default-src 'none'; img-src https: data:; script-src 'nonce-${redirectScriptNonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <link rel="canonical" href="${escapeHtml(redirectUrl)}" />
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:site_name" content="${escapeHtml(appName)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(request.url)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:alt" content="${escapeHtml(imageAlt)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
    <meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(redirectUrl)}" />
  </head>
  <body>
    <p><a href="${escapeHtml(redirectUrl)}">Open ${escapeHtml(fighterName)} in ${escapeHtml(appName)}</a></p>
    <script nonce="${escapeHtml(redirectScriptNonce)}">window.location.replace(${JSON.stringify(redirectUrl)});</script>
  </body>
</html>`, 200, {
    'Content-Security-Policy': shareCsp,
    ...PUBLIC_SHARE_CACHE_HEADERS,
  });
}

export async function createFighter(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJsonBody<{
    name?: string;
    photoHash?: string;
    qualityTier?: QualityTier;
    public?: boolean;
  }>(request, MAX_FIGHTER_JSON_BODY_BYTES);

  const photoHash = body.photoHash?.trim();
  if (!photoHash) return json({ error: 'photoHash is required' }, 400);

  const requestedTier = normalizeQualityTier(body.qualityTier);
  const requestedName = normalizeFighterName(body.name, 'Fighter');
  const existing = await env.DB.prepare(
    'SELECT * FROM fighters WHERE owner_user_id = ? AND photo_hash = ?'
  ).bind(auth.userId, photoHash).first<Fighter>();

  if (existing) {
    const nextTier = maxTier(existing.quality_tier, requestedTier);
    const publicFlag = await resolvePublicFlag(env, existing.id, body.public, existing.public_flag);
    if (publicFlag instanceof Response) return publicFlag;
    const nextName = normalizeFighterName(body.name, existing.name);
    await env.DB.prepare(`
      UPDATE fighters
      SET name = ?, quality_tier = ?, public_flag = ?, updated_at = datetime('now')
      WHERE id = ? AND owner_user_id = ?
        AND (name <> ? OR quality_tier <> ? OR public_flag <> ?)
    `).bind(
      nextName,
      nextTier,
      publicFlag,
      existing.id,
      auth.userId,
      nextName,
      nextTier,
      publicFlag,
    ).run();
    return getFighter(request, env, auth, existing.id);
  }

  if (body.public) {
    return json({ error: 'Upload the full playable animation set before publishing' }, 409);
  }

  const fighterId = generateId();
  await env.DB.prepare(`
    INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier, public_flag)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    fighterId,
    auth.userId,
    requestedName,
    photoHash,
    requestedTier,
    body.public ? 1 : 0,
  ).run();
  return getFighter(request, env, auth, fighterId);
}

export async function getFighter(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Fighter not found' }, 404);
  const sprites = await getSpritesForFighters(env, [fighterId]);
  const spriteVersions = await getSpriteVersionsForFighter(env, fighterId);
  const sourceVersions = await getSourceVersionsForFighter(env, fighterId);
  return json({ fighter: serializeFighter(request, fighter, sprites, spriteVersions, sourceVersions) });
}

export async function patchFighter(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Fighter not found' }, 404);

  const body = await readJsonBody<{
    name?: string;
    public?: boolean;
    qualityTier?: QualityTier;
  }>(request, MAX_FIGHTER_JSON_BODY_BYTES);
  const name = normalizeFighterName(body.name, fighter.name);
  const qualityTier = body.qualityTier ? maxTier(fighter.quality_tier, normalizeQualityTier(body.qualityTier)) : fighter.quality_tier;
  const publicFlag = await resolvePublicFlag(env, fighterId, body.public, fighter.public_flag);
  if (publicFlag instanceof Response) return publicFlag;

  await env.DB.prepare(`
    UPDATE fighters
    SET name = ?, quality_tier = ?, public_flag = ?, updated_at = datetime('now')
    WHERE id = ? AND owner_user_id = ?
  `).bind(name, qualityTier, publicFlag, fighterId, auth.userId).run();

  return getFighter(request, env, auth, fighterId);
}

export async function deleteFighter(env: Env, auth: AuthContext, fighterId: string): Promise<Response> {
  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Fighter not found' }, 404);

  const arcade = await env.DB.prepare(`
    SELECT status FROM arcade_fighters WHERE fighter_id = ? LIMIT 1
  `).bind(fighterId).first<{ status: string }>();
  if (arcade) {
    return json({
      error: 'Official Arcade fighters must be retired and reconciled through the admin roster flow',
      code: 'arcade_fighter_requires_reconciliation',
    }, 409);
  }

  const sprites = await getSpritesForFighters(env, [fighterId]);
  const spriteVersions = await getSpriteVersionsForFighter(env, fighterId);
  const sourceVersions = await getSourceVersionsForFighter(env, fighterId);
  const keys = new Set<string>();
  for (const key of Object.values(SOURCE_COLUMNS).map((column) => fighter[column])) {
    if (typeof key === 'string') keys.add(key);
  }
  for (const version of sourceVersions) {
    keys.add(version.blob_key);
  }
  for (const sprite of sprites) {
    keys.add(sprite.blob_key);
    if (sprite.raw_blob_key) keys.add(sprite.raw_blob_key);
  }
  for (const version of spriteVersions) {
    keys.add(version.blob_key);
    if (version.raw_blob_key) keys.add(version.raw_blob_key);
  }
  for (const key of await listFighterAssetKeys(env, auth.userId, fighterId)) keys.add(key);

  const namespace = `users/${auth.userId}/fighters/${fighterId}/`;
  const namespacedKeys = Array.from(keys).filter((key) => key.startsWith(namespace));
  const queueStatement = env.DB.prepare(`
    INSERT INTO fighter_asset_deletions (
      id, owner_user_id, fighter_id, blob_key, reason
    )
    SELECT lower(hex(randomblob(16))), ?, ?, value, 'fighter_deleted'
    FROM json_each(?)
    WHERE true
    ON CONFLICT(fighter_id, blob_key) DO UPDATE SET
      last_error = NULL,
      updated_at = datetime('now')
  `).bind(auth.userId, fighterId, JSON.stringify(namespacedKeys));
  const releaseMatchReferencesStatement = env.DB.prepare(`
    UPDATE matches
    SET
      p1_fighter_id = CASE WHEN p1_fighter_id = ? THEN NULL ELSE p1_fighter_id END,
      p2_fighter_id = CASE WHEN p2_fighter_id = ? THEN NULL ELSE p2_fighter_id END
    WHERE p1_fighter_id = ? OR p2_fighter_id = ?
  `).bind(fighterId, fighterId, fighterId, fighterId);
  const deleteStatement = env.DB.prepare(`
    DELETE FROM fighters
    WHERE id = ? AND owner_user_id = ?
    RETURNING id
  `).bind(fighterId, auth.userId);
  const results = await env.DB.batch([
    queueStatement,
    releaseMatchReferencesStatement,
    deleteStatement,
  ]);
  const deleted = results[2]?.results?.some((row) => (row as { id?: string }).id === fighterId);
  if (!deleted) throw new Error('Fighter deletion was not committed');

  const cleanup = await drainFighterAssetDeletions(env, { fighterId });
  return json({
    success: true,
    assetCleanup: cleanup.pending > 0 ? 'pending' : 'complete',
    deletedAssets: cleanup.deleted,
  });
}

async function copyR2Object(env: Env, fromKey: string | null, toKey: string): Promise<string | null> {
  if (!fromKey) return null;
  const object = await env.SPRITES.get(fromKey);
  if (!object) throw new Error(`Missing source asset: ${fromKey}`);
  await env.SPRITES.put(toKey, await object.arrayBuffer(), {
    httpMetadata: object.httpMetadata,
  });
  return toKey;
}

async function rethrowAfterCopiedAssetCleanup(env: Env, keys: string[], error: unknown): Promise<never> {
  if (keys.length > 0) {
    try {
      await env.SPRITES.delete(keys);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Asset persistence and R2 cleanup both failed');
    }
  }
  throw error;
}

async function deleteUncommittedAssets(env: Env, keys: Array<string | null>): Promise<void> {
  const presentKeys = keys.filter((key): key is string => typeof key === 'string');
  if (presentKeys.length > 0) await env.SPRITES.delete(presentKeys);
}

async function repairCanonicalAssetIfMissing(
  env: Env,
  key: string | null,
  bytes: ArrayBuffer | null,
  contentType: string,
): Promise<void> {
  if (!key || !bytes) return;
  if (await env.SPRITES.head(key)) return;
  await env.SPRITES.put(key, bytes, {
    httpMetadata: { contentType },
  });
}

function batchContainsRow(result: D1Result | undefined): boolean {
  return Array.isArray(result?.results) && result.results.length > 0;
}

export async function copyPublicSourceViewsToFighter(
  env: Env,
  auth: AuthContext,
  source: Fighter,
  target: Partial<Fighter> & { id: string },
): Promise<CopiedPublicSourceViews> {
  const columns: Partial<Record<keyof Fighter, string | null>> = {};
  const versions: CopiedPublicSourceView[] = [];
  try {
    for (const kind of PUBLIC_CLONE_SOURCE_KINDS) {
      const column = SOURCE_COLUMNS[kind];
      if (typeof target[column] === 'string') {
        columns[column] = target[column];
        continue;
      }
      const sourceKey = source[column];
      if (typeof sourceKey !== 'string') {
        columns[column] = null;
        continue;
      }

      const versionId = generateId();
      const blobKey = `users/${auth.userId}/fighters/${target.id}/sources/${kind}_${versionId}.png`;
      await copyR2Object(env, sourceKey, blobKey);
      columns[column] = blobKey;
      versions.push({ versionId, kind, blobKey });
    }
  } catch (error) {
    return rethrowAfterCopiedAssetCleanup(env, versions.map((version) => version.blobKey), error);
  }
  return { columns, versions };
}

function copiedSourceVersionStatements(
  env: Env,
  targetFighterId: string,
  copiedSources: CopiedPublicSourceViews,
): D1PreparedStatement[] {
  return copiedSources.versions.map((version) => env.DB.prepare(`
    INSERT INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
    VALUES (?, ?, ?, ?, NULL)
  `).bind(version.versionId, targetFighterId, version.kind, version.blobKey));
}

function upsertCurrentSpriteFromVersionStatement(
  env: Env,
  fighterId: string,
  animationName: string,
  qualityTier: QualityTier,
  contentHash: string,
  rawContentHash: string | null,
  animationFormat: SpriteAnimationFormat,
  frameWidth: number,
  frameHeight: number,
  frameCount: number,
  processingVersion: number,
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO sprites (
      id,
      fighter_id,
      animation_name,
      quality_tier,
      blob_key,
      raw_blob_key,
      content_hash,
      raw_content_hash,
      frame_w,
      frame_h,
      frame_count,
      animation_format,
      processing_version
    )
    SELECT ?, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      content_hash, raw_content_hash, frame_w, frame_h, frame_count, animation_format,
      processing_version
    FROM sprite_versions
    WHERE fighter_id = ?
      AND animation_name = ?
      AND quality_tier = ?
      AND content_hash = ?
      AND COALESCE(raw_content_hash, '') = COALESCE(?, '')
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
      animation_format = excluded.animation_format,
      processing_version = excluded.processing_version,
      created_at = datetime('now')
  `).bind(
    generateId(),
    fighterId,
    animationName,
    qualityTier,
    contentHash,
    rawContentHash,
    animationFormat,
    frameWidth,
    frameHeight,
    frameCount,
    processingVersion,
  );
}

export async function copyCommunitySpritesToFighter(
  env: Env,
  auth: AuthContext,
  sourceSprites: SpriteAsset[],
  targetFighterId: string,
): Promise<void> {
  const existingSprites = await getSpritesForFighters(env, [targetFighterId]);
  const existingSpriteKeys = new Set(
    existingSprites.map((sprite) => `${sprite.animation_name}:${sprite.quality_tier}`),
  );
  for (const sprite of sourceSprites) {
    const spriteKey = `${sprite.animation_name}:${sprite.quality_tier}`;
    if (existingSpriteKeys.has(spriteKey)) continue;

    const versionId = generateId();
    const safeAnim = sprite.animation_name.replace(/[^a-z0-9_-]/gi, '_');
    const blobKey = `users/${auth.userId}/fighters/${targetFighterId}/sprites/${safeAnim}_${sprite.quality_tier}_${versionId}.png`;
    await copyR2Object(env, sprite.blob_key, blobKey);
    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO sprite_versions (id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key, content_hash, raw_content_hash, frame_w, frame_h, frame_count, animation_format, processing_version)
          VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
        `).bind(
          versionId,
          targetFighterId,
          sprite.animation_name,
          sprite.quality_tier,
          blobKey,
          sprite.frame_w,
          sprite.frame_h,
          sprite.frame_count,
          normalizeSpriteAnimationFormat(sprite.animation_format),
          sprite.processing_version,
        ),
        env.DB.prepare(`
          INSERT INTO sprites (id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key, content_hash, raw_content_hash, frame_w, frame_h, frame_count, animation_format, processing_version)
          VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
          ON CONFLICT(fighter_id, animation_name, quality_tier) DO NOTHING
        `).bind(
          generateId(),
          targetFighterId,
          sprite.animation_name,
          sprite.quality_tier,
          blobKey,
          sprite.frame_w,
          sprite.frame_h,
          sprite.frame_count,
          normalizeSpriteAnimationFormat(sprite.animation_format),
          sprite.processing_version,
        ),
      ]);
    } catch (error) {
      await rethrowAfterCopiedAssetCleanup(env, [blobKey], error);
    }
    existingSpriteKeys.add(spriteKey);
  }
}

export async function cloneCommunityFighter(
  request: Request,
  env: Env,
  auth: AuthContext,
  sourceFighterId: string,
): Promise<Response> {
  const source = await env.DB.prepare(`
    SELECT * FROM fighters f
    WHERE f.id = ?
      AND f.public_flag = 1
      AND NOT EXISTS (
        SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = f.id
      )
      AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `
  ).bind(sourceFighterId).first<Fighter>();
  if (!source) return json({ error: 'Public fighter not found' }, 404);
  const sourceSprites = await getSpritesForFighters(env, [source.id]);

  const existing = await getOwnedFighterByPhotoHash(env, auth.userId, source.photo_hash);
  if (existing) {
    const copiedSources = await copyPublicSourceViewsToFighter(env, auth, source, existing);
    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE fighters
          SET
            quality_tier = ?,
            side_view_blob_key = COALESCE(side_view_blob_key, ?),
            upright_view_blob_key = COALESCE(upright_view_blob_key, ?),
            crouch_view_blob_key = COALESCE(crouch_view_blob_key, ?),
            updated_at = datetime('now')
          WHERE id = ? AND owner_user_id = ?
        `).bind(
          maxTier(existing.quality_tier, source.quality_tier),
          copiedSources.columns.side_view_blob_key ?? null,
          copiedSources.columns.upright_view_blob_key ?? null,
          copiedSources.columns.crouch_view_blob_key ?? null,
          existing.id,
          auth.userId,
        ),
        ...copiedSourceVersionStatements(env, existing.id, copiedSources),
      ]);
    } catch (error) {
      await rethrowAfterCopiedAssetCleanup(
        env,
        copiedSources.versions.map((version) => version.blobKey),
        error,
      );
    }
    await copyCommunitySpritesToFighter(env, auth, sourceSprites, existing.id);

    const merged = await getOwnedFighter(env, existing.id, auth.userId);
    const sprites = await getSpritesForFighters(env, [existing.id]);
    return json({ fighter: serializeFighter(request, merged ?? existing, sprites), cloned: false });
  }

  const cloneId = generateId();
  const copiedSources = await copyPublicSourceViewsToFighter(env, auth, source, { id: cloneId });

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO fighters (
          id,
          owner_user_id,
          name,
          photo_hash,
          quality_tier,
          public_flag,
          original_blob_key,
          side_view_blob_key,
          side_view_raw_blob_key,
          upright_view_blob_key,
          upright_view_raw_blob_key,
          crouch_view_blob_key,
          crouch_view_raw_blob_key
        )
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        cloneId,
        auth.userId,
        source.name,
        source.photo_hash,
        source.quality_tier,
        copiedSources.columns.original_blob_key ?? null,
        copiedSources.columns.side_view_blob_key ?? null,
        copiedSources.columns.side_view_raw_blob_key ?? null,
        copiedSources.columns.upright_view_blob_key ?? null,
        copiedSources.columns.upright_view_raw_blob_key ?? null,
        copiedSources.columns.crouch_view_blob_key ?? null,
        copiedSources.columns.crouch_view_raw_blob_key ?? null,
      ),
      ...copiedSourceVersionStatements(env, cloneId, copiedSources),
    ]);
  } catch (error) {
    await rethrowAfterCopiedAssetCleanup(
      env,
      copiedSources.versions.map((version) => version.blobKey),
      error,
    );
  }

  await copyCommunitySpritesToFighter(env, auth, sourceSprites, cloneId);

  const clone = await getOwnedFighter(env, cloneId, auth.userId);
  if (!clone) return json({ error: 'Clone failed' }, 500);
  const sprites = await getSpritesForFighters(env, [cloneId]);
  return json({ fighter: serializeFighter(request, clone, sprites), cloned: true }, 201);
}

export async function uploadFighterSource(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Fighter not found' }, 404);
  if (await isActiveArcadeFighter(env, fighterId)) return activeArcadeMutationFailure();

  const formData = await readMultipartFormData(request, MAX_SOURCE_MULTIPART_BODY_BYTES);
  const kind = formData.get('kind');
  const file = formData.get('file');
  if (typeof kind !== 'string' || !(kind in SOURCE_COLUMNS)) {
    return json({ error: 'Invalid source kind' }, 400);
  }
  if (!file || typeof file === 'string') {
    return json({ error: 'file is required' }, 400);
  }

  const sourceKind = kind as SourceKind;
  const column = SOURCE_COLUMNS[sourceKind];
  const sourceFile = file as File;
  const sourceSizeError = rejectOversizedUpload(sourceFile, 'Source image', MAX_SOURCE_UPLOAD_BYTES);
  if (sourceSizeError) return sourceSizeError;
  const sourceBytes = await sourceFile.arrayBuffer();
  const sourceFormat = validateUploadedImageBytes(sourceFile, sourceBytes, 'Source image', MAX_SOURCE_UPLOAD_BYTES);
  if (sourceFormat instanceof Response) return sourceFormat;
  const contentHash = await hashString(sourceBytes);

  const duplicateVersion = await env.DB.prepare(`
    SELECT * FROM source_versions
    WHERE fighter_id = ? AND kind = ? AND content_hash = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(fighterId, sourceKind, contentHash).first<SourceVersion>();

  if (duplicateVersion) {
    await repairCanonicalAssetIfMissing(
      env,
      duplicateVersion.blob_key,
      sourceBytes,
      sourceFormat.contentType,
    );
    await env.DB.prepare(
      `UPDATE fighters SET ${column} = ?, updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?`
    ).bind(duplicateVersion.blob_key, fighterId, auth.userId).run();
    return getFighter(request, env, auth, fighterId);
  }

  const versionId = generateId();
  const key = `users/${auth.userId}/fighters/${fighterId}/sources/${sourceKind}_${versionId}.png`;
  await env.SPRITES.put(key, sourceBytes, {
    httpMetadata: { contentType: sourceFormat.contentType },
  });

  let sourceResults: D1Result[];
  try {
    sourceResults = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
        VALUES (?, ?, ?, ?, ?)
      `).bind(versionId, fighterId, sourceKind, key, contentHash),
      env.DB.prepare(`
        UPDATE fighters
        SET ${column} = COALESCE((
          SELECT blob_key FROM source_versions
          WHERE fighter_id = ? AND kind = ? AND content_hash = ?
          ORDER BY created_at DESC
          LIMIT 1
        ), ${column}), updated_at = datetime('now')
        WHERE id = ? AND owner_user_id = ?
      `).bind(fighterId, sourceKind, contentHash, fighterId, auth.userId),
      env.DB.prepare('SELECT id FROM source_versions WHERE id = ?').bind(versionId),
    ]);
  } catch (error) {
    return rethrowAfterCopiedAssetCleanup(env, [key], error);
  }

  if (!batchContainsRow(sourceResults[2])) {
    await deleteUncommittedAssets(env, [key]);
  }

  return getFighter(request, env, auth, fighterId);
}

export async function uploadFighterSprite(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Fighter not found' }, 404);

  const formData = await readMultipartFormData(request, MAX_SPRITE_MULTIPART_BODY_BYTES);
  const animationName = String(formData.get('animationName') ?? '').trim();
  const qualityTier = normalizeQualityTier(String(formData.get('qualityTier') ?? fighter.quality_tier));
  const file = formData.get('file');
  const rawFile = formData.get('rawFile');
  if (!animationName) return json({ error: 'animationName is required' }, 400);
  if (!file || typeof file === 'string') return json({ error: 'file is required' }, 400);

  const frameWidth = Number(formData.get('frameWidth') ?? 0);
  const frameHeight = Number(formData.get('frameHeight') ?? 0);
  const frameCount = Number(formData.get('frameCount') ?? 0);
  const animationFormatValue = formData.get('animationFormat');
  const processingVersion = Number(formData.get('processingVersion') ?? 0);
  const setCurrentValue = formData.get('setCurrent');
  if (
    setCurrentValue !== null &&
    (typeof setCurrentValue !== 'string' || !['true', 'false'].includes(setCurrentValue))
  ) {
    return json({ error: 'setCurrent must be true or false' }, 400);
  }
  const setCurrent = setCurrentValue !== 'false';
  if (setCurrent && await isActiveArcadeFighter(env, fighterId)) {
    return activeArcadeMutationFailure();
  }
  const animationFormat = animationFormatValue === null || animationFormatValue === ''
    ? normalizeSpriteAnimationFormat(undefined)
    : typeof animationFormatValue === 'string' && isSpriteAnimationFormat(animationFormatValue)
      ? animationFormatValue
      : null;
  if (!animationFormat) {
    return json({ error: 'Invalid animationFormat' }, 400);
  }
  if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) || !Number.isFinite(frameCount)) {
    return json({ error: 'Invalid frame metadata' }, 400);
  }

  const spriteFile = file as File;
  const rawSpriteFile = rawFile && typeof rawFile !== 'string' ? rawFile as File : null;
  const spriteSizeError = rejectOversizedUpload(spriteFile, 'Sprite sheet', MAX_SPRITE_UPLOAD_BYTES);
  if (spriteSizeError) return spriteSizeError;
  if (rawSpriteFile) {
    const rawSizeError = rejectOversizedUpload(rawSpriteFile, 'Raw sprite sheet', MAX_SPRITE_UPLOAD_BYTES);
    if (rawSizeError) return rawSizeError;
  }

  const roundedFrameWidth = Math.round(frameWidth);
  const roundedFrameHeight = Math.round(frameHeight);
  const roundedFrameCount = Math.round(frameCount);
  const roundedProcessingVersion = Math.round(processingVersion);
  if (
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    !Number.isFinite(frameCount) ||
    !Number.isFinite(processingVersion) ||
    roundedFrameWidth < 1 ||
    roundedFrameHeight < 1 ||
    roundedFrameCount < 1 ||
    roundedFrameWidth > MAX_SPRITE_FRAME_DIMENSION ||
    roundedFrameHeight > MAX_SPRITE_FRAME_DIMENSION ||
    roundedFrameCount > MAX_SPRITE_FRAME_COUNT ||
    roundedProcessingVersion < 0 ||
    roundedProcessingVersion > MAX_PROCESSING_VERSION
  ) {
    return json({ error: 'Invalid frame metadata' }, 400);
  }

  const spriteBytes = await spriteFile.arrayBuffer();
  const rawSpriteBytes = rawSpriteFile ? await rawSpriteFile.arrayBuffer() : null;
  const spriteFormat = validateUploadedImageBytes(spriteFile, spriteBytes, 'Sprite sheet', MAX_SPRITE_UPLOAD_BYTES);
  if (spriteFormat instanceof Response) return spriteFormat;
  const rawSpriteFormat = rawSpriteFile && rawSpriteBytes
    ? validateUploadedImageBytes(rawSpriteFile, rawSpriteBytes, 'Raw sprite sheet', MAX_SPRITE_UPLOAD_BYTES)
    : null;
  if (rawSpriteFormat instanceof Response) return rawSpriteFormat;
  const contentHash = await hashString(spriteBytes);
  const rawContentHash = rawSpriteBytes ? await hashString(rawSpriteBytes) : null;

  const duplicateVersion = await env.DB.prepare(`
    SELECT * FROM sprite_versions
    WHERE fighter_id = ?
      AND animation_name = ?
      AND quality_tier = ?
      AND content_hash = ?
      AND COALESCE(raw_content_hash, '') = COALESCE(?, '')
      AND animation_format = ?
      AND frame_w = ? AND frame_h = ? AND frame_count = ? AND processing_version = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(
    fighterId,
    animationName,
    qualityTier,
    contentHash,
    rawContentHash,
    animationFormat,
    roundedFrameWidth,
    roundedFrameHeight,
    roundedFrameCount,
    roundedProcessingVersion,
  ).first<SpriteVersion>();

  if (duplicateVersion) {
    await repairCanonicalAssetIfMissing(
      env,
      duplicateVersion.blob_key,
      spriteBytes,
      spriteFormat.contentType,
    );
    await repairCanonicalAssetIfMissing(
      env,
      duplicateVersion.raw_blob_key,
      rawSpriteBytes,
      rawSpriteFormat?.contentType ?? 'image/png',
    );
    if (setCurrent) {
      await env.DB.batch([
        upsertCurrentSpriteFromVersionStatement(
          env,
          fighterId,
          animationName,
          qualityTier,
          contentHash,
          rawContentHash,
          animationFormat,
          roundedFrameWidth,
          roundedFrameHeight,
          roundedFrameCount,
          roundedProcessingVersion,
        ),
        env.DB.prepare(
          'UPDATE fighters SET quality_tier = ?, updated_at = datetime(\'now\') WHERE id = ? AND owner_user_id = ?'
        ).bind(maxTier(fighter.quality_tier, qualityTier), fighterId, auth.userId),
      ]);
    }

    return getFighter(request, env, auth, fighterId);
  }

  const versionId = generateId();
  const safeAnim = animationName.replace(/[^a-z0-9_-]/gi, '_');
  const key = `users/${auth.userId}/fighters/${fighterId}/sprites/${safeAnim}_${qualityTier}_${versionId}.png`;
  const rawKey = rawSpriteFile
    ? `users/${auth.userId}/fighters/${fighterId}/sprites/raw/${safeAnim}_${qualityTier}_${versionId}.png`
    : null;

  const stagedKeys: string[] = [];
  try {
    await env.SPRITES.put(key, spriteBytes, {
      httpMetadata: { contentType: spriteFormat.contentType },
    });
    stagedKeys.push(key);
    if (rawSpriteFile && rawKey && rawSpriteBytes) {
      await env.SPRITES.put(rawKey, rawSpriteBytes, {
        httpMetadata: { contentType: rawSpriteFormat?.contentType ?? 'image/png' },
      });
      stagedKeys.push(rawKey);
    }
  } catch (error) {
    return rethrowAfterCopiedAssetCleanup(env, stagedKeys, error);
  }

  let spriteResults: D1Result[];
  try {
    const statements = [
      env.DB.prepare(`
        INSERT OR IGNORE INTO sprite_versions (id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key, content_hash, raw_content_hash, frame_w, frame_h, frame_count, animation_format, processing_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        versionId,
        fighterId,
        animationName,
        qualityTier,
        key,
        rawKey,
        contentHash,
        rawContentHash,
        roundedFrameWidth,
        roundedFrameHeight,
        roundedFrameCount,
        animationFormat,
        roundedProcessingVersion,
      ),
    ];
    if (setCurrent) {
      statements.push(upsertCurrentSpriteFromVersionStatement(
        env,
        fighterId,
        animationName,
        qualityTier,
        contentHash,
        rawContentHash,
        animationFormat,
        roundedFrameWidth,
        roundedFrameHeight,
        roundedFrameCount,
        roundedProcessingVersion,
      ));
      statements.push(env.DB.prepare(
        'UPDATE fighters SET quality_tier = ?, updated_at = datetime(\'now\') WHERE id = ? AND owner_user_id = ?'
      ).bind(maxTier(fighter.quality_tier, qualityTier), fighterId, auth.userId));
    } else {
      statements.push(env.DB.prepare(
        'UPDATE fighters SET updated_at = datetime(\'now\') WHERE id = ? AND owner_user_id = ?'
      ).bind(fighterId, auth.userId));
    }
    statements.push(env.DB.prepare('SELECT id FROM sprite_versions WHERE id = ?').bind(versionId));
    spriteResults = await env.DB.batch(statements);
  } catch (error) {
    return rethrowAfterCopiedAssetCleanup(env, stagedKeys, error);
  }

  if (!batchContainsRow(spriteResults[spriteResults.length - 1])) {
    await deleteUncommittedAssets(env, stagedKeys);
  }

  return getFighter(request, env, auth, fighterId);
}

export async function promoteFighterSpriteVersion(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Fighter not found' }, 404);
  if (await isActiveArcadeFighter(env, fighterId)) return activeArcadeMutationFailure();

  const body = await readJsonBody<{
    animationName?: string;
    qualityTier?: QualityTier;
    contentHash?: string;
    rawContentHash?: string | null;
    animationFormat?: SpriteAnimationFormat;
    frameWidth?: number;
    frameHeight?: number;
    frameCount?: number;
    processingVersion?: number;
  }>(request, MAX_FIGHTER_JSON_BODY_BYTES);
  const animationName = body.animationName?.trim() ?? '';
  if (!/^[a-z0-9_-]{1,64}$/i.test(animationName)) {
    return json({ error: 'Invalid animationName' }, 400);
  }
  if (!body.qualityTier || !['rookie', 'contender', 'champion'].includes(body.qualityTier)) {
    return json({ error: 'Invalid qualityTier' }, 400);
  }
  const contentHash = body.contentHash?.trim().toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    return json({ error: 'Invalid contentHash' }, 400);
  }
  const rawContentHash = body.rawContentHash == null
    ? null
    : body.rawContentHash.trim().toLowerCase();
  if (rawContentHash !== null && !/^[a-f0-9]{64}$/.test(rawContentHash)) {
    return json({ error: 'Invalid rawContentHash' }, 400);
  }
  const hasExplicitAnimationFormat = body.animationFormat !== undefined;
  const animationFormat = hasExplicitAnimationFormat && isSpriteAnimationFormat(body.animationFormat)
    ? body.animationFormat
    : null;
  if (hasExplicitAnimationFormat && !animationFormat) {
    return json({ error: 'Invalid animationFormat' }, 400);
  }

  const metadataValues = [body.frameWidth, body.frameHeight, body.frameCount, body.processingVersion];
  const hasInterpretationMetadata = metadataValues.every((value) => value !== undefined);
  if (
    metadataValues.some((value) => value !== undefined) && !hasInterpretationMetadata ||
    hasInterpretationMetadata && (
      metadataValues.some((value) => !Number.isInteger(value)) ||
      body.frameWidth! < 1 || body.frameWidth! > MAX_SPRITE_FRAME_DIMENSION ||
      body.frameHeight! < 1 || body.frameHeight! > MAX_SPRITE_FRAME_DIMENSION ||
      body.frameCount! < 1 || body.frameCount! > MAX_SPRITE_FRAME_COUNT ||
      body.processingVersion! < 0 || body.processingVersion! > MAX_PROCESSING_VERSION
    )
  ) {
    return json({ error: 'Invalid frame metadata' }, 400);
  }

  const { results: matchingVersions } = await env.DB.prepare(`
    SELECT * FROM sprite_versions
    WHERE fighter_id = ?
      AND animation_name = ?
      AND quality_tier = ?
      AND content_hash = ?
      AND COALESCE(raw_content_hash, '') = COALESCE(?, '')
      ${hasExplicitAnimationFormat ? 'AND animation_format = ?' : ''}
      ${hasInterpretationMetadata
        ? 'AND frame_w = ? AND frame_h = ? AND frame_count = ? AND processing_version = ?'
        : ''}
    ORDER BY created_at DESC
    LIMIT 2
  `).bind(
    fighterId,
    animationName,
    body.qualityTier,
    contentHash,
    rawContentHash,
    ...(hasExplicitAnimationFormat ? [animationFormat] : []),
    ...(hasInterpretationMetadata ? metadataValues : []),
  ).all<SpriteVersion>();
  if (matchingVersions.length > 1) {
    return json({
      error: 'Sprite version selection is ambiguous; include animationFormat and frame metadata',
    }, 409);
  }
  const version = matchingVersions[0];
  if (!version) return json({ error: 'Sprite version not found' }, 404);
  const selectedAnimationFormat = normalizeSpriteAnimationFormat(version.animation_format);

  const [processedObject, rawObject] = await Promise.all([
    env.SPRITES.head(version.blob_key),
    version.raw_blob_key ? env.SPRITES.head(version.raw_blob_key) : Promise.resolve(null),
  ]);
  if (!processedObject || (version.raw_blob_key && !rawObject)) {
    return json({ error: 'Sprite version asset is missing; upload it again before promotion' }, 409);
  }

  await env.DB.batch([
    upsertCurrentSpriteFromVersionStatement(
      env,
      fighterId,
      animationName,
      body.qualityTier,
      contentHash,
      rawContentHash,
      selectedAnimationFormat,
      version.frame_w,
      version.frame_h,
      version.frame_count,
      version.processing_version,
    ),
    env.DB.prepare(
      'UPDATE fighters SET quality_tier = ?, updated_at = datetime(\'now\') WHERE id = ? AND owner_user_id = ?'
    ).bind(maxTier(fighter.quality_tier, body.qualityTier), fighterId, auth.userId),
  ]);

  return getFighter(request, env, auth, fighterId);
}

export async function requestFighterUpgrade(
  request: Request,
  env: Env,
  auth: AuthContext,
  fighterId: string,
): Promise<Response> {
  const fighter = await getOwnedFighter(env, fighterId, auth.userId);
  if (!fighter) return json({ error: 'Fighter not found' }, 404);
  const body = await readJsonBody<{ toTier?: QualityTier }>(request, MAX_FIGHTER_JSON_BODY_BYTES);
  const toTier = normalizeQualityTier(body.toTier, 'champion');
  return json({
    fighter: serializeFighter(request, fighter),
    upgrade: {
      toTier,
      cost: TIER_DEFINITIONS[toTier].creditCost,
      mode: 'client-orchestrated',
      message: 'Regenerate animations on the client, then upload each new tier sprite to this fighter.',
    },
  });
}

export async function listStages(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM stages WHERE owner_user_id = ? ORDER BY updated_at DESC'
  ).bind(auth.userId).all<Stage>();
  return json({
    stages: (results ?? []).map((stage) => ({
      id: stage.id,
      label: stage.label,
      kind: stage.kind,
      public: Boolean(stage.public_flag),
      url: assetUrl(request, stage.blob_key),
      createdAt: stage.created_at,
      updatedAt: stage.updated_at,
    })),
  });
}

export async function getAsset(request: Request, env: Env, auth: PublicAuthContext, key: string): Promise<Response> {
  const decodedKey = decodeAssetKey(key);
  if (decodedKey instanceof Response) return decodedKey;
  const namespaceOwner = namespacedAssetOwner(decodedKey);
  if (!auth.userId || namespaceOwner !== auth.userId) return json({ error: 'Asset not found' }, 404);

  const object = await env.SPRITES.get(decodedKey);
  if (!object) return json({ error: 'Asset missing' }, 404);
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

async function publicAssetResponse(env: Env, blobKey: string): Promise<Response> {
  const object = await env.SPRITES.get(blobKey);
  if (!object) return json({ error: 'Asset missing' }, 404, NO_STORE_HEADERS);
  const headers = new Headers(PUBLIC_ASSET_CACHE_HEADERS);
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
}

export async function getPublicFighterSourceAsset(
  env: Env,
  fighterId: string,
  kind: PublicSourceKind,
  revision: string,
): Promise<Response> {
  const column = PUBLIC_SOURCE_COLUMNS[kind];
  const fighter = await env.DB.prepare(`
    SELECT f.${column} AS blob_key
    FROM fighters f
    WHERE f.id = ? AND f.public_flag = 1
      AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId).first<{ blob_key: string | null }>();
  if (!fighter?.blob_key || publicAssetRevision(fighter.blob_key) !== revision) {
    return json({ error: 'Public asset not found' }, 404, NO_STORE_HEADERS);
  }
  return publicAssetResponse(env, fighter.blob_key);
}

/**
 * Online versus: the opponent's fighter for one room. Same privacy shape as
 * the community manifest (clean sources + playable sprites only, neutral
 * owner label, no photo hash, RAW, or ids) but the asset URLs are room
 * routes that require an authenticated seat — a private fighter is shared
 * with exactly the person you chose to fight, for as long as the room lives.
 */
export async function loadVersusRoomFighterManifest(
  request: Request,
  env: Env,
  roomCode: string,
  fighterId: string,
): Promise<Record<string, unknown> | null> {
  const fighter = await env.DB.prepare(`
    SELECT f.*
    FROM fighters f
    WHERE f.id = ? AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId).first<Fighter>();
  if (!fighter) return null;
  const sprites = await getSpritesForFighters(env, [fighterId]);
  const origin = new URL(request.url).origin;
  const roomBase = `${origin}/api/versus/rooms/${encodeURIComponent(roomCode)}/fighters/${encodeURIComponent(fighter.id)}`;
  const sourceUrl = (kind: PublicSourceKind, key: string | null): string | null => {
    const revision = publicAssetRevision(key);
    return revision ? `${roomBase}/sources/${kind}/${encodeURIComponent(revision)}` : null;
  };
  const community = serializeCommunityFighter(request, fighter, sprites);
  return {
    ...community,
    sources: {
      original: null,
      side: sourceUrl('side', fighter.side_view_blob_key),
      sideRaw: null,
      upright: sourceUrl('upright', fighter.upright_view_blob_key),
      uprightRaw: null,
      crouch: sourceUrl('crouch', fighter.crouch_view_blob_key),
      crouchRaw: null,
    },
    sprites: sprites.map((sprite) => {
      const revision = publicAssetRevision(sprite.blob_key);
      return {
        ...serializeSprite(request, sprite),
        contentHash: sprite.content_hash,
        url: revision ? `${roomBase}/sprites/${encodeURIComponent(sprite.id)}/${encodeURIComponent(revision)}` : null,
        rawUrl: null,
        rawFrameWidth: null,
        rawFrameHeight: null,
        rawFrameCount: null,
      };
    }),
  };
}

export interface VersusInviteFighterSnapshot {
  fighterId: string;
  fighterName: string;
  qualityTier: QualityTier;
  sourceKind: 'side' | 'upright' | 'crouch' | 'idle';
  sourceBlobKey: string;
}

/**
 * Freeze the clean visual used by a versus invitation. The caller performs
 * authorization first; this helper only guarantees that the fighter remains
 * playable and selects a stable R2 object for the public composite image.
 */
export async function loadVersusInviteFighterSnapshot(
  env: Env,
  fighterId: string,
): Promise<VersusInviteFighterSnapshot | null> {
  const fighter = await env.DB.prepare(`
    SELECT f.*
    FROM fighters f
    WHERE f.id = ? AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId).first<Fighter>();
  if (!fighter) return null;

  const source = (
    [
      ['side', fighter.side_view_blob_key],
      ['upright', fighter.upright_view_blob_key],
      ['crouch', fighter.crouch_view_blob_key],
    ] as const
  ).find((entry): entry is readonly ['side' | 'upright' | 'crouch', string] => Boolean(entry[1]));

  if (source) {
    return {
      fighterId: fighter.id,
      fighterName: normalizeFighterName(fighter.name, 'Fighter'),
      qualityTier: fighter.quality_tier,
      sourceKind: source[0],
      sourceBlobKey: source[1],
    };
  }

  const idle = await env.DB.prepare(`
    SELECT s.blob_key
    FROM sprites s
    WHERE s.fighter_id = ? AND s.animation_name = 'idle'
    ORDER BY CASE s.quality_tier
      WHEN 'champion' THEN 3 WHEN 'contender' THEN 2 ELSE 1 END DESC,
      s.created_at DESC
    LIMIT 1
  `).bind(fighter.id).first<{ blob_key: string }>();
  if (!idle?.blob_key) return null;
  return {
    fighterId: fighter.id,
    fighterName: normalizeFighterName(fighter.name, 'Fighter'),
    qualityTier: fighter.quality_tier,
    sourceKind: 'idle',
    sourceBlobKey: idle.blob_key,
  };
}

/** Clean playable sprite bytes for a fighter declared in a room (seat already verified). */
export async function getVersusRoomFighterSpriteAsset(
  env: Env,
  fighterId: string,
  spriteId: string,
  revision: string,
): Promise<Response> {
  const sprite = await env.DB.prepare(`
    SELECT s.blob_key
    FROM sprites s
    JOIN fighters f ON f.id = s.fighter_id
    WHERE f.id = ? AND s.id = ?
      AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId, spriteId).first<{ blob_key: string }>();
  if (!sprite?.blob_key || publicAssetRevision(sprite.blob_key) !== revision) {
    return json({ error: 'Asset not found' }, 404, NO_STORE_HEADERS);
  }
  return privateAssetResponse(env, sprite.blob_key);
}

/** Clean (non-RAW) source view for a fighter declared in a room (seat already verified). */
export async function getVersusRoomFighterSourceAsset(
  env: Env,
  fighterId: string,
  kind: PublicSourceKind,
  revision: string,
): Promise<Response> {
  const column = PUBLIC_SOURCE_COLUMNS[kind];
  if (!column) return json({ error: 'Asset not found' }, 404, NO_STORE_HEADERS);
  const fighter = await env.DB.prepare(`
    SELECT f.${column} AS blob_key
    FROM fighters f
    WHERE f.id = ? AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId).first<{ blob_key: string | null }>();
  if (!fighter?.blob_key || publicAssetRevision(fighter.blob_key) !== revision) {
    return json({ error: 'Asset not found' }, 404, NO_STORE_HEADERS);
  }
  return privateAssetResponse(env, fighter.blob_key);
}

async function privateAssetResponse(env: Env, blobKey: string): Promise<Response> {
  const object = await env.SPRITES.get(blobKey);
  if (!object) return json({ error: 'Asset missing' }, 404, NO_STORE_HEADERS);
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

export async function getPublicFighterSpriteAsset(
  env: Env,
  fighterId: string,
  spriteId: string,
  revision: string,
): Promise<Response> {
  const sprite = await env.DB.prepare(`
    SELECT s.blob_key
    FROM sprites s
    JOIN fighters f ON f.id = s.fighter_id
    WHERE f.id = ? AND f.public_flag = 1 AND s.id = ?
      AND ${playableSpriteSetSql('f')}
    LIMIT 1
  `).bind(fighterId, spriteId).first<{ blob_key: string }>();
  if (!sprite?.blob_key || publicAssetRevision(sprite.blob_key) !== revision) {
    return json({ error: 'Public asset not found' }, 404, NO_STORE_HEADERS);
  }
  return publicAssetResponse(env, sprite.blob_key);
}

export async function getPublicArcadeSpriteHighDensityAsset(
  env: Env,
  fighterId: string,
  spriteId: string,
  revision: string,
): Promise<Response> {
  const sprite = await env.DB.prepare(`
    SELECT s.raw_blob_key
    FROM sprites s
    JOIN fighters f ON f.id = s.fighter_id
    JOIN arcade_fighters af ON af.fighter_id = f.id
    WHERE f.id = ? AND f.public_flag = 1 AND f.quality_tier = 'champion'
      AND af.status = 'active' AND s.id = ? AND s.quality_tier = 'champion'
      AND s.animation_format = 'video-dense-v1'
      AND ${playableSpriteSetSql('f', 'champion')}
    LIMIT 1
  `).bind(fighterId, spriteId).first<{ raw_blob_key: string | null }>();
  if (!sprite?.raw_blob_key || publicAssetRevision(sprite.raw_blob_key) !== revision) {
    return json({ error: 'Public asset not found' }, 404, NO_STORE_HEADERS);
  }
  return publicAssetResponse(env, sprite.raw_blob_key);
}
