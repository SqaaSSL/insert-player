import {
  ApiSessionChangedError,
  apiFetch,
  captureApiRequestContext,
  type ApiRequestContext,
} from './ApiClient';
import {
  CACHE_VERSION,
  getActiveSpriteCacheScope,
  getAllSpriteVersionsForHash,
  getCachedMeta,
  hashPhoto,
  setCachedMeta,
  setCachedSprite,
  type CachedIntro,
  type CachedMeta,
  type CachedSprite,
} from './SpriteCache';
import type { QualityTier as CloudQualityTier } from './QualityTiers';
import { debugWarn } from './DebugLog.ts';
import { imageBlobFile } from './ImageFile.ts';
import { finishGenerationPurchase } from './Billing.ts';
import {
  normalizeSpriteAnimationFormat,
  type SpriteAnimationFormat,
} from '../SpriteAnimationFormat.ts';

export interface CloudSprite {
  id?: string;
  animationName: string;
  qualityTier: CloudQualityTier;
  url: string | null;
  rawUrl: string | null;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  animationFormat?: SpriteAnimationFormat;
  processingVersion: number;
  createdAt?: string;
  contentHash?: string | null;
  rawContentHash?: string | null;
}

export interface CloudFighter {
  id: string;
  owner?: {
    name: string;
  };
  arcade?: {
    slug: string;
    rank: number;
    challengerLine: string;
    defaultPersonality: 'balanced' | 'brawler' | 'counter' | 'zoner' | 'showboat';
    reference: {
      kind: 'generated' | 'licensed';
      sourceUrl: string | null;
      license: string;
      credit: string;
    };
  };
  name: string;
  photoHash?: string;
  qualityTier: CloudQualityTier;
  public: boolean;
  sources: Record<string, string | null>;
  sourceHashes?: Record<string, string | null>;
  sprites: CloudSprite[];
  spriteVersions?: CloudSprite[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CloudSyncResult {
  status: 'synced' | 'signed_out' | 'failed';
  fighterId?: string;
  message?: string;
}

export interface CloudImportResult {
  fighterId: string;
  spritesImported: number;
  optionalAssetsSkipped: number;
  spritesSkipped: number;
}

export interface CloudImportOptions {
  includeArchivedVersions?: boolean;
  includeRawAssets?: boolean;
  allowIncomplete?: boolean;
}

export interface CloudRosterSyncSummary {
  imported: number;
  updated: number;
  skipped: number;
  drafts: number;
  failed: number;
}

export interface PreparedCloudFighter {
  fighter: CloudFighter;
  photoHash: string;
}

export type CommunityReportReason =
  | 'non_consensual_person'
  | 'sexual_content'
  | 'hate_or_harassment'
  | 'graphic_violence'
  | 'copyright_or_trademark'
  | 'personal_information'
  | 'spam'
  | 'other';

export interface CommunityReportResult {
  status: 'reported' | 'signed_out';
  duplicate?: boolean;
}

const TIER_RANK: Record<CloudQualityTier, number> = {
  rookie: 1,
  contender: 2,
  champion: 3,
};

const CLOUD_SPRITE_IMPORT_CONCURRENCY = 4;
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

export interface FingerprintedSprite {
  sprite: CachedSprite;
  contentHash: string;
  rawContentHash: string | null;
}

export type SpriteUploadAction =
  | { kind: 'upload'; candidate: FingerprintedSprite; setCurrent: boolean }
  | { kind: 'promote'; candidate: FingerprintedSprite };

export interface SpriteDownloadAction {
  remote: CloudSprite;
  existing: CachedSprite | null;
  downloadProcessed: boolean;
  downloadRaw: boolean;
}

function spritePairKey(animationName: string, qualityTier: CloudQualityTier): string {
  return `${animationName}:${qualityTier}`;
}

function spriteContentKey(
  animationName: string,
  qualityTier: CloudQualityTier,
  contentHash: string | null | undefined,
  rawContentHash: string | null | undefined,
  animationFormat: SpriteAnimationFormat | null | undefined,
  frameWidth: number,
  frameHeight: number,
  frameCount: number,
  processingVersion: number | null | undefined,
): string | null {
  if (!contentHash) return null;
  return `${spritePairKey(animationName, qualityTier)}:${normalizeSpriteAnimationFormat(animationFormat)}:${frameWidth}x${frameHeight}:${frameCount}:${processingVersion ?? 0}:${contentHash}:${rawContentHash ?? ''}`;
}

export function buildSpriteUploadPlan(
  localVersions: FingerprintedSprite[],
  currentFallback: FingerprintedSprite[],
  remoteVersions: CloudSprite[],
  remoteCurrent: CloudSprite[],
): SpriteUploadAction[] {
  const currentByPair = new Map<string, FingerprintedSprite>();
  for (const candidate of localVersions) {
    const key = spritePairKey(candidate.sprite.animationName, candidate.sprite.qualityTier);
    const existing = currentByPair.get(key);
    if (!existing || candidate.sprite.createdAt > existing.sprite.createdAt) {
      currentByPair.set(key, candidate);
    }
  }
  for (const candidate of currentFallback) {
    const key = spritePairKey(candidate.sprite.animationName, candidate.sprite.qualityTier);
    const existing = currentByPair.get(key);
    if (!existing || candidate.sprite.createdAt >= existing.sprite.createdAt) {
      currentByPair.set(key, candidate);
    }
  }

  const remoteVersionKeys = new Set(
    remoteVersions
      .map((sprite) => spriteContentKey(
        sprite.animationName,
        sprite.qualityTier,
        sprite.contentHash,
        sprite.rawContentHash,
        sprite.animationFormat,
        sprite.frameWidth,
        sprite.frameHeight,
        sprite.frameCount,
        sprite.processingVersion,
      ))
      .filter((key): key is string => Boolean(key)),
  );
  const remoteCurrentByPair = new Map(
    remoteCurrent.map((sprite) => [
      spritePairKey(sprite.animationName, sprite.qualityTier),
      spriteContentKey(
        sprite.animationName,
        sprite.qualityTier,
        sprite.contentHash,
        sprite.rawContentHash,
        sprite.animationFormat,
        sprite.frameWidth,
        sprite.frameHeight,
        sprite.frameCount,
        sprite.processingVersion,
      ),
    ]),
  );
  const currentContentKeys = new Set(
    Array.from(currentByPair.values()).map((candidate) => spriteContentKey(
      candidate.sprite.animationName,
      candidate.sprite.qualityTier,
      candidate.contentHash,
      candidate.rawContentHash,
      candidate.sprite.animationFormat,
      candidate.sprite.frameWidth,
      candidate.sprite.frameHeight,
      candidate.sprite.frameCount,
      candidate.sprite.processingVersion,
    )),
  );
  const localByContent = new Map<string, FingerprintedSprite>();
  for (const candidate of localVersions) {
    const key = spriteContentKey(
      candidate.sprite.animationName,
      candidate.sprite.qualityTier,
      candidate.contentHash,
      candidate.rawContentHash,
      candidate.sprite.animationFormat,
      candidate.sprite.frameWidth,
      candidate.sprite.frameHeight,
      candidate.sprite.frameCount,
      candidate.sprite.processingVersion,
    );
    if (key && !localByContent.has(key)) localByContent.set(key, candidate);
  }

  const actions: SpriteUploadAction[] = [];
  for (const [key, candidate] of localByContent) {
    if (!currentContentKeys.has(key) && !remoteVersionKeys.has(key)) {
      actions.push({ kind: 'upload', candidate, setCurrent: false });
    }
  }
  for (const [pair, candidate] of currentByPair) {
    const key = spriteContentKey(
      candidate.sprite.animationName,
      candidate.sprite.qualityTier,
      candidate.contentHash,
      candidate.rawContentHash,
      candidate.sprite.animationFormat,
      candidate.sprite.frameWidth,
      candidate.sprite.frameHeight,
      candidate.sprite.frameCount,
      candidate.sprite.processingVersion,
    )!;
    if (remoteCurrentByPair.get(pair) === key) continue;
    actions.push(remoteVersionKeys.has(key)
      ? { kind: 'promote', candidate }
      : { kind: 'upload', candidate, setCurrent: true });
  }
  return actions;
}

export function buildSpriteDownloadPlan(
  remoteVersions: CloudSprite[],
  localVersions: FingerprintedSprite[],
  options: Pick<CloudImportOptions, 'includeRawAssets'> = {},
): SpriteDownloadAction[] {
  const localByVersionId = new Map(
    localVersions
      .filter((candidate) => candidate.sprite.versionId)
      .map((candidate) => [candidate.sprite.versionId as string, candidate]),
  );
  const localByContent = new Map<string, FingerprintedSprite>();
  for (const candidate of localVersions) {
    const key = spriteContentKey(
      candidate.sprite.animationName,
      candidate.sprite.qualityTier,
      candidate.contentHash,
      candidate.rawContentHash,
      candidate.sprite.animationFormat,
      candidate.sprite.frameWidth,
      candidate.sprite.frameHeight,
      candidate.sprite.frameCount,
      candidate.sprite.processingVersion,
    );
    if (key && !localByContent.has(key)) localByContent.set(key, candidate);
  }

  const actions: SpriteDownloadAction[] = [];
  for (const remote of remoteVersions) {
    const remoteKey = spriteContentKey(
      remote.animationName,
      remote.qualityTier,
      remote.contentHash,
      remote.rawContentHash,
      remote.animationFormat,
      remote.frameWidth,
      remote.frameHeight,
      remote.frameCount,
      remote.processingVersion,
    );
    const versionCandidate = remote.id ? localByVersionId.get(remote.id) : undefined;
    const versionCandidateKey = versionCandidate
      ? spriteContentKey(
          versionCandidate.sprite.animationName,
          versionCandidate.sprite.qualityTier,
          versionCandidate.contentHash,
          versionCandidate.rawContentHash,
          versionCandidate.sprite.animationFormat,
          versionCandidate.sprite.frameWidth,
          versionCandidate.sprite.frameHeight,
          versionCandidate.sprite.frameCount,
          versionCandidate.sprite.processingVersion,
        )
      : null;
    // Older public Arcade payloads did not expose content hashes. In that
    // shape both keys are null, which is not proof that the locally cached
    // bytes still match a promoted version whose id is intentionally stable.
    // Fail toward one fresh processed download until the hashed payload is
    // observed rather than pinning stale gameplay art indefinitely.
    const matchingVersionCandidate = versionCandidate && remoteKey && versionCandidateKey === remoteKey
      ? versionCandidate
      : undefined;
    const candidate = matchingVersionCandidate
      ?? (remoteKey ? localByContent.get(remoteKey) : undefined)
      ?? null;
    const existing = candidate?.sprite ?? null;
    const downloadProcessed = !existing || Boolean(
      remote.contentHash && candidate?.contentHash && remote.contentHash !== candidate.contentHash,
    );
    const downloadRaw = options.includeRawAssets !== false &&
      Boolean(remote.rawUrl) &&
      (!existing?.rawPngBlob || (
        Boolean(remote.rawContentHash) &&
        Boolean(candidate?.rawContentHash) &&
        remote.rawContentHash !== candidate?.rawContentHash
      ));
    if (downloadProcessed || downloadRaw) {
      actions.push({ remote, existing, downloadProcessed, downloadRaw });
    }
  }
  return actions;
}

export function selectPlayableCloudSprites(sprites: CloudSprite[]): CloudSprite[] {
  const bestByAnimation = new Map<string, CloudSprite>();
  for (const sprite of sprites) {
    const current = bestByAnimation.get(sprite.animationName);
    if (!current) {
      bestByAnimation.set(sprite.animationName, sprite);
      continue;
    }
    const tierDelta = TIER_RANK[sprite.qualityTier] - TIER_RANK[current.qualityTier];
    const spriteCreatedAt = Date.parse(sprite.createdAt ?? '') || 0;
    const currentCreatedAt = Date.parse(current.createdAt ?? '') || 0;
    if (tierDelta > 0 || (tierDelta === 0 && spriteCreatedAt > currentCreatedAt)) {
      bestByAnimation.set(sprite.animationName, sprite);
    }
  }
  return Array.from(bestByAnimation.values());
}

export function isSourceOnlyCloudFighter(fighter: CloudFighter): boolean {
  return fighter.sprites.length === 0 && (fighter.spriteVersions?.length ?? 0) === 0;
}

export function isCompleteCloudFighterRoster(fighter: CloudFighter): boolean {
  const currentAnimations = new Set(fighter.sprites.map((sprite) => sprite.animationName));
  return PLAYABLE_ANIMATION_NAMES.every((animationName) => currentAnimations.has(animationName));
}

export function formatCloudRosterSyncStatus(
  summary: Pick<CloudRosterSyncSummary, 'imported' | 'updated' | 'drafts' | 'failed'>,
): string | null {
  if (summary.failed > 0) {
    return `Cloud sync incomplete: ${summary.failed} fighter${summary.failed === 1 ? '' : 's'} could not be downloaded`;
  }
  if (summary.imported > 0 || summary.updated > 0) {
    return `Cloud synced: ${summary.imported} imported, ${summary.updated} updated`;
  }
  if (summary.drafts > 0) {
    return `${summary.drafts} unfinished fighter${summary.drafts === 1 ? ' is' : 's are'} safely stored for regeneration`;
  }
  return null;
}

export function cloudSpritesForImport(
  fighter: CloudFighter,
  options: CloudImportOptions,
): CloudSprite[] {
  if (options.includeArchivedVersions === true) {
    throw new Error('Archived sprite versions cannot be imported into the playable cache');
  }
  // Archived/private versions are not playable pointers. Falling back to them here can
  // expose an unapproved review candidate or make a partial roster look complete.
  return selectPlayableCloudSprites(fighter.sprites);
}

function isLocalDevWithoutApi(): boolean {
  return !String(import.meta.env.VITE_API_BASE_URL ?? '').trim() && import.meta.env.DEV;
}

function getMetaTier(meta: CachedMeta): CloudQualityTier {
  return (meta as CachedMeta & { qualityTier?: CloudQualityTier }).qualityTier ?? 'contender';
}

function cloudTimestampMs(fighter: CloudFighter): number {
  return Date.parse(fighter.updatedAt ?? fighter.createdAt ?? '') || 0;
}

function formatMissingAnimationName(name: string): string {
  return name.replace(/_/g, ' ');
}

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.text();
  try {
    const json = JSON.parse(body) as {
      error?: string;
      missingAnimations?: string[];
    };
    if (Array.isArray(json.missingAnimations) && json.missingAnimations.length > 0) {
      return `Generate these animations before publishing: ${json.missingAnimations.map(formatMissingAnimationName).join(', ')}`;
    }
    if (typeof json.error === 'string' && json.error.trim()) {
      return json.error.trim();
    }
  } catch {
    // Fall through to the trimmed response body.
  }
  return body.trim().slice(0, 180) || fallback;
}

export function shouldRefreshLocalFighter(fighter: CloudFighter, existing: CachedMeta | null): boolean {
  if (!existing) return true;
  if (existing.cloudFighterId !== fighter.id) return true;
  if (TIER_RANK[fighter.qualityTier] > TIER_RANK[getMetaTier(existing)]) return true;
  const remoteVersionCount = fighter.sprites.length;
  if (remoteVersionCount > (existing.cloudSpriteVersionCount ?? 0)) return true;
  const remoteAnimationCount = new Set(fighter.sprites.map((sprite) => sprite.animationName)).size;
  const localAnimationCount = new Set(existing.animationsReady ?? []).size;
  if (remoteAnimationCount > localAnimationCount) return true;
  const remoteUpdatedAt = cloudTimestampMs(fighter);
  if (remoteUpdatedAt > (existing.updatedAt ?? 0) + 1000) return true;
  return remoteUpdatedAt === 0 && (
    existing.characterName !== fighter.name ||
    existing.cloudPublic !== fighter.public
  );
}

async function uploadSource(
  fighterId: string,
  kind: string,
  blob: Blob | null | undefined,
  remoteContentHash: string | null | undefined,
  context?: ApiRequestContext,
): Promise<string | null> {
  if (!blob) return null;
  const contentHash = await hashPhoto(blob);
  if (contentHash === remoteContentHash) return contentHash;
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', await imageBlobFile(blob, kind));
  const res = await apiFetch(`/api/fighters/${fighterId}/sources`, {
    method: 'POST',
    body: form,
  }, context);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Source ${kind} upload failed (${res.status}): ${body.slice(0, 180)}`);
  }
  return contentHash;
}

async function uploadSprite(
  fighterId: string,
  sprite: CachedSprite,
  tier: CloudQualityTier,
  setCurrent: boolean,
  context?: ApiRequestContext,
): Promise<void> {
  const form = new FormData();
  form.append('animationName', sprite.animationName);
  form.append('qualityTier', (sprite as CachedSprite & { qualityTier?: CloudQualityTier }).qualityTier ?? tier);
  form.append('frameWidth', String(sprite.frameWidth));
  form.append('frameHeight', String(sprite.frameHeight));
  form.append('frameCount', String(sprite.frameCount));
  form.append('animationFormat', normalizeSpriteAnimationFormat(sprite.animationFormat));
  form.append('processingVersion', String(sprite.processingVersion ?? 0));
  form.append('setCurrent', String(setCurrent));
  form.append('file', await imageBlobFile(sprite.pngBlob, sprite.animationName));
  if (sprite.rawPngBlob) {
    form.append('rawFile', await imageBlobFile(sprite.rawPngBlob, `${sprite.animationName}_raw`));
  }

  const res = await apiFetch(`/api/fighters/${fighterId}/sprites`, {
    method: 'POST',
    body: form,
  }, context);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sprite ${sprite.animationName} upload failed (${res.status}): ${body.slice(0, 180)}`);
  }
}

async function fingerprintSprites(sprites: CachedSprite[]): Promise<FingerprintedSprite[]> {
  const fingerprints: FingerprintedSprite[] = [];
  for (const sprite of sprites) {
    const cachedContentHash = typeof sprite.contentHash === 'string' && /^[a-f0-9]{64}$/i.test(sprite.contentHash)
      ? sprite.contentHash.toLowerCase()
      : null;
    const cachedRawContentHash = typeof sprite.rawContentHash === 'string' && /^[a-f0-9]{64}$/i.test(sprite.rawContentHash)
      ? sprite.rawContentHash.toLowerCase()
      : null;
    const contentHash = cachedContentHash ?? await hashPhoto(sprite.pngBlob);
    const rawContentHash = sprite.rawPngBlob
      ? cachedRawContentHash ?? await hashPhoto(sprite.rawPngBlob)
      : null;
    if (sprite.contentHash !== contentHash || sprite.rawContentHash !== rawContentHash) {
      sprite.contentHash = contentHash;
      sprite.rawContentHash = rawContentHash;
      await setCachedSprite(sprite, { preserveVersionId: true });
    }
    fingerprints.push({ sprite, contentHash, rawContentHash });
  }
  return fingerprints;
}

async function promoteSprite(
  fighterId: string,
  candidate: FingerprintedSprite,
  context: ApiRequestContext,
): Promise<void> {
  const res = await apiFetch(`/api/fighters/${fighterId}/sprites`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      animationName: candidate.sprite.animationName,
      qualityTier: candidate.sprite.qualityTier,
      contentHash: candidate.contentHash,
      rawContentHash: candidate.rawContentHash,
      animationFormat: normalizeSpriteAnimationFormat(candidate.sprite.animationFormat),
      frameWidth: candidate.sprite.frameWidth,
      frameHeight: candidate.sprite.frameHeight,
      frameCount: candidate.sprite.frameCount,
      processingVersion: candidate.sprite.processingVersion ?? 0,
    }),
  }, context);
  if (!res.ok) {
    throw new Error(`Sprite ${candidate.sprite.animationName} promotion failed (${res.status}): ${(
      await res.text()
    ).slice(0, 180)}`);
  }
}

export async function listCloudFighters(context?: ApiRequestContext): Promise<CloudFighter[]> {
  if (isLocalDevWithoutApi()) return [];
  const res = await apiFetch('/api/fighters', {}, context);
  if (res.status === 401 || res.status === 503) return [];
  if (!res.ok) throw new Error(`Cloud fighters failed (${res.status})`);
  const json = await res.json() as { fighters?: CloudFighter[] };
  return json.fighters ?? [];
}

export async function getCloudFighter(fighterId: string, context?: ApiRequestContext): Promise<CloudFighter | null> {
  if (isLocalDevWithoutApi()) return null;
  const res = await apiFetch(`/api/fighters/${encodeURIComponent(fighterId)}`, {}, context);
  if (res.status === 401 || res.status === 503 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloud fighter failed (${res.status})`);
  const json = await res.json() as { fighter?: CloudFighter };
  return json.fighter ?? null;
}

export async function prepareCloudFighterGeneration(
  params: {
    name: string;
    photoHash: string;
    originalPhoto: Blob;
  },
  context?: ApiRequestContext,
): Promise<PreparedCloudFighter> {
  const requestContext = context ?? captureApiRequestContext();
  const createRes = await apiFetch('/api/fighters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.name,
      photoHash: params.photoHash,
      qualityTier: 'rookie',
    }),
  }, requestContext);
  const createdBody = await createRes.json().catch(() => ({})) as {
    fighter?: CloudFighter;
    error?: string;
  };
  if (!createRes.ok || !createdBody.fighter?.id) {
    throw new Error(createdBody.error ?? `Private fighter setup failed (${createRes.status})`);
  }

  await uploadSource(
    createdBody.fighter.id,
    'original',
    params.originalPhoto,
    createdBody.fighter.sourceHashes?.original,
    requestContext,
  );
  const detailed = await getCloudFighter(createdBody.fighter.id, requestContext);
  if (!detailed) throw new Error('Private fighter could not be reloaded after source upload');
  return { fighter: detailed, photoHash: params.photoHash };
}

export async function listCommunityFighters(): Promise<CloudFighter[]> {
  if (isLocalDevWithoutApi()) return [];
  const res = await apiFetch('/api/community');
  if (!res.ok) throw new Error(`Community fighters failed (${res.status})`);
  const json = await res.json() as { fighters?: CloudFighter[] };
  return json.fighters ?? [];
}

export async function listArcadeFighters(): Promise<CloudFighter[]> {
  if (isLocalDevWithoutApi()) return [];
  const res = await apiFetch('/api/arcade');
  if (!res.ok) throw new Error(`Arcade fighters failed (${res.status})`);
  const json = await res.json() as { fighters?: CloudFighter[] };
  return (json.fighters ?? []).filter((fighter) => Boolean(fighter.arcade));
}

export function arcadeFighterPhotoHash(fighter: CloudFighter): string {
  return `arcade:${fighter.arcade?.slug ?? fighter.id}:${fighter.id}`;
}

export async function getCommunityFighter(fighterId: string): Promise<CloudFighter | null> {
  if (isLocalDevWithoutApi()) return null;
  const res = await apiFetch(`/api/community/${encodeURIComponent(fighterId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Community fighter failed (${res.status})`);
  const json = await res.json() as { fighter?: CloudFighter };
  return json.fighter ?? null;
}

export async function setCloudFighterPublic(
  fighterId: string,
  isPublic: boolean,
  context?: ApiRequestContext,
): Promise<CloudFighter | null> {
  const res = await apiFetch(`/api/fighters/${fighterId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public: isPublic }),
  }, context);
  if (res.status === 401 || res.status === 503) return null;
  if (!res.ok) {
    throw new Error(`Share update failed (${res.status}): ${await apiErrorMessage(res, 'Publish update failed')}`);
  }
  const json = await res.json() as { fighter?: CloudFighter };
  return json.fighter ?? null;
}

export async function renameCloudFighter(
  fighterId: string,
  name: string,
  context?: ApiRequestContext,
): Promise<CloudFighter | null> {
  const res = await apiFetch(`/api/fighters/${fighterId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }, context);
  if (res.status === 401 || res.status === 503) return null;
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloud rename failed (${res.status}): ${body.slice(0, 180)}`);
  }
  const json = await res.json() as { fighter?: CloudFighter };
  return json.fighter ?? null;
}

export async function deleteCloudFighter(
  fighterId: string,
  context?: ApiRequestContext,
): Promise<CloudSyncResult> {
  const res = await apiFetch(`/api/fighters/${fighterId}`, { method: 'DELETE' }, context);
  if (res.status === 401 || res.status === 503) {
    return { status: 'signed_out', message: 'Sign in to delete this fighter from cloud sync.' };
  }
  if (res.status === 404) {
    return { status: 'synced', fighterId, message: 'Cloud fighter was already deleted.' };
  }
  if (!res.ok) {
    const body = await res.text();
    return { status: 'failed', message: body.slice(0, 180) };
  }
  return { status: 'synced', fighterId };
}

export async function cloneCommunityFighter(
  sourceFighterId: string,
  context?: ApiRequestContext,
): Promise<CloudFighter | null> {
  const res = await apiFetch(`/api/community/${sourceFighterId}/clone`, { method: 'POST' }, context);
  if (res.status === 401 || res.status === 503) return null;
  if (!res.ok) throw new Error(`Clone failed (${res.status})`);
  const json = await res.json() as { fighter?: CloudFighter };
  return json.fighter ?? null;
}

export async function reportCommunityFighter(
  fighterId: string,
  reason: CommunityReportReason,
  details: string,
  context?: ApiRequestContext,
): Promise<CommunityReportResult> {
  const res = await apiFetch(`/api/community/${encodeURIComponent(fighterId)}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, details: details.trim() || null }),
  }, context);
  if (res.status === 401 || res.status === 503) return { status: 'signed_out' };
  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Report failed (${res.status})`));
  }
  const json = await res.json() as { report?: { duplicate?: boolean } };
  return { status: 'reported', duplicate: json.report?.duplicate === true };
}

export async function syncFighterToCloud(
  meta: CachedMeta,
  sprites: CachedSprite[],
  _intro?: CachedIntro | null,
  context?: ApiRequestContext,
): Promise<CloudSyncResult> {
  if (isLocalDevWithoutApi()) {
    return { status: 'signed_out', message: 'Cloud sync is disabled in local mode.' };
  }
  const requestContext = context ?? captureApiRequestContext();
  const tier = getMetaTier(meta);
  const targetPublic = meta.cloudPublic === true;
  const createBody: {
    name: string;
    photoHash: string;
    qualityTier: CloudQualityTier;
  } = {
    name: meta.characterName,
    photoHash: meta.photoHash,
    qualityTier: tier,
  };
  const createRes = await apiFetch('/api/fighters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createBody),
  }, requestContext);

  if (createRes.status === 401 || createRes.status === 503) {
    return { status: 'signed_out', message: 'Sign in to sync this fighter across devices.' };
  }
  if (!createRes.ok) {
    const body = await createRes.text();
    return { status: 'failed', message: body.slice(0, 180) };
  }

  const created = await createRes.json() as { fighter?: CloudFighter };
  const fighterId = created.fighter?.id;
  if (!fighterId) return { status: 'failed', message: 'Cloud API returned no fighter id.' };
  meta.cloudFighterId = fighterId;
  meta.cloudPublic = created.fighter?.public ?? meta.cloudPublic ?? false;
  await setCachedMeta(meta);

  const remoteSourceHashes = { ...(created.fighter?.sourceHashes ?? {}) };
  const sourceUploads: Array<[string, Blob | null | undefined]> = [
    ['original', meta.originalPhotoBlob],
    ['side', meta.sideViewBlob],
    ['side_raw', meta.sideViewRawBlob],
    ['upright', meta.uprightViewBlob],
    ['upright_raw', meta.uprightViewRawBlob],
    ['crouch', meta.crouchViewBlob],
    ['crouch_raw', meta.crouchViewRawBlob],
  ];
  for (const [kind, blob] of sourceUploads) {
    remoteSourceHashes[kind] = await uploadSource(
      fighterId,
      kind,
      blob,
      remoteSourceHashes[kind],
      requestContext,
    );
  }
  meta.cloudSourceHashes = remoteSourceHashes;

  const allLocalSpriteVersions = await getAllSpriteVersionsForHash(meta.photoHash, meta.ownerScope);
  const versionFingerprints = await fingerprintSprites(allLocalSpriteVersions);
  const fingerprintsByVersionId = new Map(
    versionFingerprints
      .filter((candidate) => candidate.sprite.versionId)
      .map((candidate) => [candidate.sprite.versionId as string, candidate]),
  );
  const currentFingerprints: FingerprintedSprite[] = [];
  for (const sprite of sprites) {
    const existing = sprite.versionId ? fingerprintsByVersionId.get(sprite.versionId) : undefined;
    currentFingerprints.push(existing ?? (await fingerprintSprites([sprite]))[0]);
  }
  const spritePlan = buildSpriteUploadPlan(
    versionFingerprints,
    currentFingerprints,
    created.fighter?.spriteVersions ?? [],
    created.fighter?.sprites ?? [],
  );

  for (const action of spritePlan) {
    if (action.kind === 'promote') {
      await promoteSprite(fighterId, action.candidate, requestContext);
    } else {
      await uploadSprite(
        fighterId,
        action.candidate.sprite,
        tier,
        action.setCurrent,
        requestContext,
      );
    }
  }

  if (targetPublic && !meta.cloudPublic) {
    const published = await setCloudFighterPublic(fighterId, true, requestContext);
    if (!published) {
      return { status: 'signed_out', message: 'Sign in to publish fighters.' };
    }
    meta.cloudPublic = published.public;
    await setCachedMeta(meta);
  }

  meta.updatedAt = Date.now();
  await setCachedMeta(meta);

  if (meta.pendingGenerationPurchaseId) {
    try {
      await finishGenerationPurchase(
        meta.pendingGenerationPurchaseId,
        true,
        fighterId,
        requestContext,
      );
      meta.pendingGenerationPurchaseId = null;
      meta.updatedAt = Date.now();
      await setCachedMeta(meta);
    } catch (error) {
      debugWarn(
        '[CloudSync] Fighter synced, but its generation purchase link will retry on the next sync:',
        error instanceof Error ? error.message : error,
      );
      return {
        status: 'synced',
        fighterId,
        message: 'Fighter synced. Billing history will finish linking on the next cloud sync.',
      };
    }
  }

  return { status: 'synced', fighterId };
}

async function fetchRequiredBlob(
  url: string | null | undefined,
  label: string,
  context: ApiRequestContext,
): Promise<Blob | null> {
  if (!url) return null;
  const res = await apiFetch(url, {}, context);
  if (!res.ok) throw new Error(`${label} fetch failed (${res.status})`);
  return res.blob();
}

async function fetchOptionalBlob(
  url: string | null | undefined,
  label: string,
  context: ApiRequestContext,
): Promise<Blob | null> {
  try {
    return await fetchRequiredBlob(url, label, context);
  } catch (err: any) {
    if (err instanceof ApiSessionChangedError) throw err;
    debugWarn(`[Cloud] Optional asset skipped for ${label}:`, err?.message ?? err);
    return null;
  }
}

export async function downloadCloudFighterToLocal(
  fighter: CloudFighter,
  context?: ApiRequestContext,
  options: CloudImportOptions = {},
): Promise<CloudImportResult> {
  const requestContext = context ?? captureApiRequestContext();
  const ownerScope = getActiveSpriteCacheScope();
  const includeRawAssets = options.includeRawAssets !== false;
  if (!fighter.photoHash) {
    throw new Error(`Cloud fighter ${fighter.name} is missing a private sync hash.`);
  }
  const photoHash = fighter.photoHash;
  const [existingMeta, localSpriteVersions] = await Promise.all([
    getCachedMeta(photoHash, ownerScope),
    getAllSpriteVersionsForHash(photoHash, ownerScope),
  ]);
  const staleSourceKinds = new Set<string>();
  const loadSource = async (
    kind: string,
    url: string | null | undefined,
    existingBlob: Blob | null | undefined,
    label: string,
  ): Promise<Blob | null> => {
    const remoteHash = fighter.sourceHashes?.[kind] ?? null;
    const localHash = existingMeta?.cloudSourceHashes?.[kind] ?? null;
    if (existingBlob && remoteHash && localHash === remoteHash) return existingBlob;
    if (!url) return existingBlob ?? null;
    const fetched = await fetchOptionalBlob(url, label, requestContext);
    if (fetched) return fetched;
    if (existingBlob) {
      staleSourceKinds.add(kind);
      return existingBlob;
    }
    return null;
  };
  const [
    originalPhotoBlob,
    sideViewBlob,
    sideViewRawBlob,
    uprightViewBlob,
    uprightViewRawBlob,
    crouchViewBlob,
    crouchViewRawBlob,
  ] = await Promise.all([
    loadSource('original', fighter.sources.original, existingMeta?.originalPhotoBlob, `${fighter.name} original source`),
    loadSource('side', fighter.sources.side, existingMeta?.sideViewBlob, `${fighter.name} side source`),
    loadSource(
      'side_raw',
      includeRawAssets ? fighter.sources.sideRaw : null,
      existingMeta?.sideViewRawBlob,
      `${fighter.name} raw side source`,
    ),
    loadSource('upright', fighter.sources.upright, existingMeta?.uprightViewBlob, `${fighter.name} upright source`),
    loadSource(
      'upright_raw',
      includeRawAssets ? fighter.sources.uprightRaw : null,
      existingMeta?.uprightViewRawBlob,
      `${fighter.name} raw upright source`,
    ),
    loadSource('crouch', fighter.sources.crouch, existingMeta?.crouchViewBlob, `${fighter.name} crouch source`),
    loadSource(
      'crouch_raw',
      includeRawAssets ? fighter.sources.crouchRaw : null,
      existingMeta?.crouchViewRawBlob,
      `${fighter.name} raw crouch source`,
    ),
  ]);

  const now = Date.now();
  const remoteUpdatedAt = cloudTimestampMs(fighter);
  const remoteSpriteVersionCount = fighter.sprites.length;
  const createdAt = Date.parse(
    String((fighter as CloudFighter & { createdAt?: string }).createdAt ?? ''),
  ) || remoteUpdatedAt || now;
  const availableAnimations = new Set(localSpriteVersions.map((sprite) => sprite.animationName));
  let spritesImported = 0;
  let optionalAssetsSkipped = [
    fighter.sources.original && !originalPhotoBlob,
    fighter.sources.side && !sideViewBlob,
    includeRawAssets && fighter.sources.sideRaw && !sideViewRawBlob,
    fighter.sources.upright && !uprightViewBlob,
    includeRawAssets && fighter.sources.uprightRaw && !uprightViewRawBlob,
    fighter.sources.crouch && !crouchViewBlob,
    includeRawAssets && fighter.sources.crouchRaw && !crouchViewRawBlob,
  ].filter(Boolean).length + staleSourceKinds.size;
  let spritesSkipped = 0;
  let spriteRawAssetsSkipped = 0;

  const spriteVersions = cloudSpritesForImport(fighter, options);
  const localFingerprints = await fingerprintSprites(localSpriteVersions);
  const spritePlan = buildSpriteDownloadPlan(spriteVersions, localFingerprints, options);

  for (let index = 0; index < spritePlan.length; index += CLOUD_SPRITE_IMPORT_CONCURRENCY) {
    const batch = spritePlan.slice(index, index + CLOUD_SPRITE_IMPORT_CONCURRENCY);
    await Promise.all(batch.map(async (action) => {
      const sprite = action.remote;
      try {
        const pngBlob = action.downloadProcessed
          ? await fetchRequiredBlob(sprite.url, `${fighter.name} ${sprite.animationName} sprite`, requestContext)
          : action.existing?.pngBlob ?? null;
        if (!pngBlob) {
          spritesSkipped += 1;
          return;
        }
        const downloadedRawBlob = action.downloadRaw
          ? await fetchOptionalBlob(sprite.rawUrl, `${fighter.name} ${sprite.animationName} raw sprite`, requestContext)
          : null;
        const rawPngBlob = downloadedRawBlob ?? action.existing?.rawPngBlob ?? null;
        if (action.downloadRaw && sprite.rawUrl && !downloadedRawBlob) {
          optionalAssetsSkipped += 1;
          spriteRawAssetsSkipped += 1;
        }
        if (!action.downloadProcessed && action.downloadRaw && !downloadedRawBlob) return;
        await setCachedSprite({
          ownerScope,
          versionId: action.existing?.versionId ?? sprite.id,
          photoHash,
          animationName: sprite.animationName,
          pngBlob,
          rawPngBlob: rawPngBlob ?? undefined,
          frameWidth: sprite.frameWidth,
          frameHeight: sprite.frameHeight,
          frameCount: sprite.frameCount,
          animationFormat: normalizeSpriteAnimationFormat(sprite.animationFormat),
          processingVersion: sprite.processingVersion,
          contentHash: sprite.contentHash ?? action.existing?.contentHash ?? null,
          rawContentHash: sprite.rawContentHash ?? action.existing?.rawContentHash ?? null,
          createdAt: Date.parse(String(sprite.createdAt ?? '')) || now,
          qualityTier: sprite.qualityTier,
        } as CachedSprite & { qualityTier: CloudQualityTier }, { preserveVersionId: Boolean(sprite.id) });
        availableAnimations.add(sprite.animationName);
        spritesImported += 1;
      } catch (err: any) {
        if (err instanceof ApiSessionChangedError) throw err;
        spritesSkipped += 1;
        debugWarn(`[Cloud] Sprite skipped for ${fighter.name}:`, err?.message ?? err);
      }
    }));
  }

  const remoteRosterComplete = isCompleteCloudFighterRoster(fighter);
  const currentAnimationNames = new Set(fighter.sprites.map((sprite) => sprite.animationName));
  const availableCurrentAnimations = new Set(
    Array.from(availableAnimations).filter((animationName) => currentAnimationNames.has(animationName)),
  );
  if (!remoteRosterComplete && !options.allowIncomplete) {
    const missing = PLAYABLE_ANIMATION_NAMES.filter((animationName) => !currentAnimationNames.has(animationName));
    throw new Error(
      `Cloud fighter ${fighter.name} is incomplete; missing current animations: ${missing.join(', ')}.`,
    );
  }

  const meta = {
    ...(existingMeta ?? {}),
    ownerScope,
    photoHash,
    version: CACHE_VERSION,
    originalPhotoBlob,
    sideViewBlob,
    sideViewRawBlob,
    uprightViewBlob,
    uprightViewRawBlob,
    sideViewCleanBlob: existingMeta?.sideViewCleanBlob ?? sideViewBlob,
    crouchViewBlob,
    crouchViewRawBlob,
    crouchViewCleanBlob: existingMeta?.crouchViewCleanBlob ?? crouchViewBlob,
    noBgBlob: existingMeta?.noBgBlob ?? null,
    characterName: fighter.name,
    status: remoteRosterComplete ? 'ready' : 'sprites_generating',
    animationsReady: Array.from(availableCurrentAnimations),
    createdAt,
    updatedAt: staleSourceKinds.size > 0 || spritesSkipped > 0
      ? existingMeta?.updatedAt ?? remoteUpdatedAt ?? now
      : remoteUpdatedAt || now,
    qualityTier: fighter.qualityTier,
    cloudFighterId: fighter.id,
    cloudPublic: fighter.public,
    cloudSourceHashes: {
      ...(existingMeta?.cloudSourceHashes ?? {}),
      ...(fighter.sourceHashes ?? {}),
      ...Object.fromEntries(Array.from(staleSourceKinds).map((kind) => [
        kind,
        existingMeta?.cloudSourceHashes?.[kind] ?? null,
      ])),
    },
    cloudSpriteVersionCount: spritesSkipped === 0 && spriteRawAssetsSkipped === 0
      ? remoteSpriteVersionCount
      : existingMeta?.cloudSpriteVersionCount ?? 0,
  } satisfies CachedMeta & { qualityTier: CloudQualityTier };

  await setCachedMeta(meta);

  return {
    fighterId: fighter.id,
    spritesImported,
    optionalAssetsSkipped,
    spritesSkipped,
  };
}

export async function downloadArcadeFighterToLocal(
  fighter: CloudFighter,
  context?: ApiRequestContext,
): Promise<CloudImportResult> {
  if (!fighter.arcade || !fighter.public) {
    throw new Error(`${fighter.name} is not an active Arcade fighter.`);
  }
  return downloadCloudFighterToLocal({
    ...fighter,
    photoHash: arcadeFighterPhotoHash(fighter),
  }, context, {
    includeArchivedVersions: false,
    includeRawAssets: false,
  });
}

export async function importMissingCloudFighters(
  localPhotoHashes: Set<string>,
  context?: ApiRequestContext,
): Promise<number> {
  const requestContext = context ?? captureApiRequestContext();
  const fighters = await listCloudFighters(requestContext);
  const missing = fighters.filter((fighter) => !fighter.photoHash || !localPhotoHashes.has(fighter.photoHash));
  let imported = 0;
  for (const fighter of missing) {
    try {
      const detailed = await getCloudFighter(fighter.id, requestContext);
      await downloadCloudFighterToLocal(detailed ?? fighter, requestContext);
      imported += 1;
    } catch (err: any) {
      if (err instanceof ApiSessionChangedError) throw err;
      debugWarn(`[Cloud] Fighter import skipped for ${fighter.name}:`, err?.message ?? err);
    }
  }
  return imported;
}

export async function syncCloudFightersToLocal(
  localMetas: CachedMeta[],
  context?: ApiRequestContext,
): Promise<CloudRosterSyncSummary> {
  const requestContext = context ?? captureApiRequestContext();
  const fighters = await listCloudFighters(requestContext);
  const localByCloudId = new Map(
    localMetas
      .filter((meta) => meta.cloudFighterId)
      .map((meta) => [meta.cloudFighterId as string, meta]),
  );
  const localByPhotoHash = new Map(localMetas.map((meta) => [meta.photoHash, meta]));
  const summary: CloudRosterSyncSummary = {
    imported: 0,
    updated: 0,
    skipped: 0,
    drafts: 0,
    failed: 0,
  };
  for (const fighter of fighters) {
    const existing = localByCloudId.get(fighter.id) ?? (fighter.photoHash ? localByPhotoHash.get(fighter.photoHash) : undefined) ?? null;
    if (!shouldRefreshLocalFighter(fighter, existing)) {
      summary.skipped += 1;
      continue;
    }

    try {
      const detailed = await getCloudFighter(fighter.id, requestContext);
      const manifest = detailed ?? fighter;
      if (!isCompleteCloudFighterRoster(manifest)) {
        summary.drafts += 1;
        continue;
      }
      await downloadCloudFighterToLocal(manifest, requestContext, {
        includeArchivedVersions: false,
        includeRawAssets: false,
      });
      if (existing) {
        summary.updated += 1;
      } else {
        summary.imported += 1;
      }
    } catch (err: any) {
      if (err instanceof ApiSessionChangedError) throw err;
      summary.failed += 1;
      debugWarn(`[Cloud] Fighter sync skipped for ${fighter.name}:`, err?.message ?? err);
    }
  }

  return summary;
}
