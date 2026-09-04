import {
  normalizeSpriteAnimationFormat,
  type SpriteAnimationFormat,
} from '../SpriteAnimationFormat.ts';

const DB_NAME = 'ai-street-fighter';
const DB_VERSION = 5;
const STORE_SPRITES = 'sprites';
const STORE_INTROS = 'intros';
const STORE_META = 'meta';
const STORE_STAGES = 'stages';
const LOCAL_CACHE_SCOPE = 'local';

let activeCacheScope = LOCAL_CACHE_SCOPE;
let databasePromise: Promise<IDBDatabase> | null = null;
let scopeMutationQueue: Promise<void> = Promise.resolve();

type QualityTier = 'rookie' | 'contender' | 'champion';

interface CachedSprite {
  ownerScope?: string;
  versionId?: string;
  photoHash: string;
  animationName: string;
  qualityTier: QualityTier;
  pngBlob: Blob;
  rawPngBlob?: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  rawFrameWidth?: number;
  rawFrameHeight?: number;
  rawFrameCount?: number;
  animationFormat?: SpriteAnimationFormat;
  processingVersion?: number;
  contentHash?: string | null;
  rawContentHash?: string | null;
  createdAt: number;
}

export interface CachedPlayableSpriteRef {
  versionId: string | null;
  contentHash: string | null;
  animationName: string;
  qualityTier: QualityTier;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  animationFormat: SpriteAnimationFormat;
  processingVersion: number;
}

interface CachedFailedAnimationArtifact {
  pngBlob: Blob;
  rawPngBlob?: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  reason: string;
  mode?: string;
  createdAt: number;
}

type CachedIntroModel =
  | 'kling-v2-1-std'
  | 'veo-3-1'
  | 'runway-gen4-turbo'
  | 'fal-ltx-v2-3-fast'
  | 'fal-kling-v2-6-pro'
  | 'fal-vidu-q3';

type CachedIntroVariantId = 'legacy' | 'single';

interface CachedIntroVariant {
  id: CachedIntroVariantId;
  label: string;
  videoBlob: Blob;
  mimeType: string;
  createdAt: number;
  model?: CachedIntroModel;
  prompt?: string | null;
  referenceCount?: number;
}

interface CachedIntro {
  ownerScope?: string;
  photoHash: string;
  activeVariantId?: CachedIntroVariantId | null;
  variants: CachedIntroVariant[];
}

type CachedStageKind = 'generated' | 'photo' | 'photo-direct';

interface CachedStageSource {
  provider: 'google-street-view';
  panoId: string;
  latitude: number;
  longitude: number;
  heading: number;
  pitch: number;
  fov: number;
  locationLabel?: string;
  imageDate?: string | null;
  copyright?: string | null;
  capturedAt: number;
}

interface CachedStageBackground {
  ownerScope?: string;
  stageKey: string;
  prompt: string;
  pngBlob: Blob;
  createdAt: number;
  kind?: CachedStageKind;
  label?: string;
  source?: CachedStageSource;
}

const CACHE_VERSION = 1;
const DEFAULT_MIGRATED_TIER: QualityTier = 'champion';
const QUALITY_TIER_RANK: Record<QualityTier, number> = {
  rookie: 1,
  contender: 2,
  champion: 3,
};

interface CachedMeta {
  ownerScope?: string;
  photoHash: string;
  version: number;
  originalPhotoBlob: Blob | null;
  sideViewBlob: Blob | null;
  sideViewRawBlob: Blob | null;
  uprightViewBlob: Blob | null;
  uprightViewRawBlob: Blob | null;
  sideViewCleanBlob: Blob | null;
  crouchViewBlob: Blob | null;
  crouchViewRawBlob: Blob | null;
  crouchViewCleanBlob: Blob | null;
  noBgBlob: Blob | null;
  characterName: string;
  qualityTier?: 'rookie' | 'contender' | 'champion';
  cloudFighterId?: string | null;
  cloudPublic?: boolean;
  cloudManagement?: 'arcade';
  cloudSourceHashes?: Record<string, string | null>;
  cloudSpriteVersionCount?: number;
  cloudPlayableSpriteRefs?: Record<string, CachedPlayableSpriteRef>;
  pendingGenerationPurchaseId?: string | null;
  introVideoPrompt?: string | null;
  introVideoModel?: 'freepik-auto' | 'kling-v2-1-std' | 'veo-3-1' | 'runway-gen4-turbo' | 'fal-ltx-v2-3-fast' | 'fal-kling-v2-6-pro' | 'fal-vidu-q3' | null;
  introVideoReferenceBlobs?: Blob[] | null;
  status: 'pending' | 'sprites_generating' | 'ready' | 'error';
  animationsReady: string[];
  failedAnimationArtifacts?: Record<string, CachedFailedAnimationArtifact> | null;
  createdAt: number;
  updatedAt: number;
}

function normalizeCacheScope(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : LOCAL_CACHE_SCOPE;
}

export function spriteCacheScopeForOwner(clerkUserId: string | null | undefined): string {
  const normalized = typeof clerkUserId === 'string' ? clerkUserId.trim() : '';
  return normalized ? `clerk:${normalized}` : LOCAL_CACHE_SCOPE;
}

export function configureSpriteCacheOwner(clerkUserId: string | null | undefined): string {
  activeCacheScope = spriteCacheScopeForOwner(clerkUserId);
  return activeCacheScope;
}

export function getActiveSpriteCacheScope(): string {
  return activeCacheScope;
}

function requestedCacheScope(value?: string): string {
  return normalizeCacheScope(value ?? activeCacheScope);
}

function assertActiveCacheScope(scope: string): void {
  if (scope !== activeCacheScope) {
    throw new Error('Player changed while local data was being updated. The stale operation was stopped.');
  }
}

function openDB(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  const openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (event.oldVersion < 5 && tx) {
        migrateStoreToScoped(db, tx, STORE_SPRITES, createSpriteStore, normalizeCachedSpriteRecord);
        migrateStoreToScoped(db, tx, STORE_INTROS, createIntroStore);
        migrateStoreToScoped(db, tx, STORE_META, createMetaStore);
        migrateStoreToScoped(db, tx, STORE_STAGES, createStageStore);
      } else {
        if (!db.objectStoreNames.contains(STORE_SPRITES)) createSpriteStore(db);
        if (!db.objectStoreNames.contains(STORE_INTROS)) createIntroStore(db);
        if (!db.objectStoreNames.contains(STORE_META)) createMetaStore(db);
        if (!db.objectStoreNames.contains(STORE_STAGES)) createStageStore(db);
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Sprite cache upgrade is blocked by another tab'));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  databasePromise = openPromise;

  return openPromise;
}

function createSpriteStore(db: IDBDatabase): IDBObjectStore {
  const store = db.createObjectStore(STORE_SPRITES, { keyPath: ['ownerScope', 'versionId'] });
  ensureSpriteIndexes(store);
  return store;
}

function ensureSpriteIndexes(store: IDBObjectStore): void {
  if (!store.indexNames.contains('byScope')) {
    store.createIndex('byScope', 'ownerScope');
  }
  if (!store.indexNames.contains('byScopeAndHash')) {
    store.createIndex('byScopeAndHash', ['ownerScope', 'photoHash']);
  }
  if (!store.indexNames.contains('byScopeHashAndAnim')) {
    store.createIndex('byScopeHashAndAnim', ['ownerScope', 'photoHash', 'animationName']);
  }
  if (!store.indexNames.contains('byScopeHashAnimTier')) {
    store.createIndex('byScopeHashAnimTier', ['ownerScope', 'photoHash', 'animationName', 'qualityTier']);
  }
}

function createScopedStore(db: IDBDatabase, name: string, recordKey: string): IDBObjectStore {
  const store = db.createObjectStore(name, { keyPath: ['ownerScope', recordKey] });
  store.createIndex('byScope', 'ownerScope');
  return store;
}

function createIntroStore(db: IDBDatabase): IDBObjectStore {
  return createScopedStore(db, STORE_INTROS, 'photoHash');
}

function createMetaStore(db: IDBDatabase): IDBObjectStore {
  return createScopedStore(db, STORE_META, 'photoHash');
}

function createStageStore(db: IDBDatabase): IDBObjectStore {
  return createScopedStore(db, STORE_STAGES, 'stageKey');
}

function normalizeQualityTier(value: unknown, fallback: QualityTier = DEFAULT_MIGRATED_TIER): QualityTier {
  return value === 'rookie' || value === 'contender' || value === 'champion' ? value : fallback;
}

function createSpriteVersionId(sprite: Pick<CachedSprite, 'photoHash' | 'animationName' | 'qualityTier'> & { createdAt?: number }): string {
  const createdAt = typeof sprite.createdAt === 'number' ? sprite.createdAt : Date.now();
  const suffix = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${sprite.photoHash}:${sprite.animationName}:${sprite.qualityTier}:${createdAt}:${suffix}`;
}

function normalizeCachedSpriteRecord(raw: any): CachedSprite | null {
  if (!raw || typeof raw.photoHash !== 'string' || typeof raw.animationName !== 'string' || !(raw.pngBlob instanceof Blob)) {
    return null;
  }
  const normalized = {
    ...raw,
    ownerScope: normalizeCacheScope(raw.ownerScope),
    qualityTier: normalizeQualityTier(raw.qualityTier),
    animationFormat: normalizeSpriteAnimationFormat(raw.animationFormat),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  } as CachedSprite;
  normalized.versionId = typeof raw.versionId === 'string' && raw.versionId
    ? raw.versionId
    : createSpriteVersionId(normalized);
  return normalized;
}

function migrateStoreToScoped(
  db: IDBDatabase,
  tx: IDBTransaction,
  storeName: string,
  createStore: (db: IDBDatabase) => IDBObjectStore,
  normalize: (raw: any) => any | null = (raw) => raw,
): void {
  if (!db.objectStoreNames.contains(storeName)) {
    createStore(db);
    return;
  }

  const oldStore = tx.objectStore(storeName);
  const records: any[] = [];
  const cursorReq = oldStore.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      const normalized = normalize(cursor.value);
      if (normalized) {
        records.push({
          ...normalized,
          ownerScope: normalizeCacheScope(normalized.ownerScope),
        });
      }
      cursor.continue();
      return;
    }

    db.deleteObjectStore(storeName);
    const newStore = createStore(db);
    for (const record of records) {
      newStore.put(record);
    }
  };
  cursorReq.onerror = () => {
    throw cursorReq.error ?? new Error(`${storeName} cache migration failed`);
  };
}

function compareSpritesByTierAndTime(a: CachedSprite, b: CachedSprite): number {
  const tierDelta = QUALITY_TIER_RANK[b.qualityTier] - QUALITY_TIER_RANK[a.qualityTier];
  if (tierDelta !== 0) return tierDelta;
  return (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

function bestSpritesByAnimation(sprites: CachedSprite[]): CachedSprite[] {
  const best = new Map<string, CachedSprite>();
  for (const sprite of sprites) {
    const existing = best.get(sprite.animationName);
    if (!existing || compareSpritesByTierAndTime(sprite, existing) < 0) {
      best.set(sprite.animationName, sprite);
    }
  }
  return Array.from(best.values()).sort((a, b) => a.animationName.localeCompare(b.animationName));
}

function normalizedSpriteContentHash(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function playableSpriteRefFor(sprite: CachedSprite): CachedPlayableSpriteRef {
  return {
    versionId: typeof sprite.versionId === 'string' && sprite.versionId ? sprite.versionId : null,
    contentHash: normalizedSpriteContentHash(sprite.contentHash),
    animationName: sprite.animationName,
    qualityTier: normalizeQualityTier(sprite.qualityTier),
    frameWidth: sprite.frameWidth,
    frameHeight: sprite.frameHeight,
    frameCount: sprite.frameCount,
    animationFormat: normalizeSpriteAnimationFormat(sprite.animationFormat),
    processingVersion: sprite.processingVersion ?? 0,
  };
}

function spriteMatchesPlayableRef(sprite: CachedSprite, ref: CachedPlayableSpriteRef): boolean {
  const expectedHash = normalizedSpriteContentHash(ref.contentHash);
  if (!expectedHash || normalizedSpriteContentHash(sprite.contentHash) !== expectedHash) return false;
  if (ref.qualityTier !== 'rookie' && ref.qualityTier !== 'contender' && ref.qualityTier !== 'champion') return false;
  if (ref.animationFormat !== 'legacy' && ref.animationFormat !== 'video-dense-v1') return false;
  return sprite.animationName === ref.animationName &&
    normalizeQualityTier(sprite.qualityTier) === ref.qualityTier &&
    sprite.frameWidth === ref.frameWidth &&
    sprite.frameHeight === ref.frameHeight &&
    sprite.frameCount === ref.frameCount &&
    normalizeSpriteAnimationFormat(sprite.animationFormat) === ref.animationFormat &&
    (sprite.processingVersion ?? 0) === ref.processingVersion;
}

export function selectPlayableCachedSprites(
  versions: CachedSprite[],
  refs?: Record<string, CachedPlayableSpriteRef>,
): CachedSprite[] {
  if (refs === undefined) return bestSpritesByAnimation(versions);

  const selected: CachedSprite[] = [];
  for (const [animationName, ref] of Object.entries(refs)) {
    if (!ref || ref.animationName !== animationName) continue;
    const matches = versions
      .filter((sprite) => spriteMatchesPlayableRef(sprite, ref))
      .sort(compareSpritesByTierAndTime);
    if (matches[0]) selected.push(matches[0]);
  }
  return selected.sort((a, b) => a.animationName.localeCompare(b.animationName));
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Sprite cache transaction aborted'));
  });
}

function recordsForScope<T>(db: IDBDatabase, storeName: string, scope: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index('byScope').getAll(scope);
    req.onsuccess = () => resolve((req.result ?? []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

function maxOptionalTier(a: QualityTier | undefined, b: QualityTier | undefined): QualityTier | undefined {
  if (!a) return b;
  if (!b) return a;
  return QUALITY_TIER_RANK[a] >= QUALITY_TIER_RANK[b] ? a : b;
}

function mergeClaimedMeta(existing: CachedMeta | undefined, local: CachedMeta, ownerScope: string): CachedMeta {
  if (!existing) return { ...local, ownerScope };
  const newer = (existing.updatedAt ?? 0) >= (local.updatedAt ?? 0) ? existing : local;
  const older = newer === existing ? local : existing;
  return {
    ...older,
    ...newer,
    ownerScope,
    originalPhotoBlob: newer.originalPhotoBlob ?? older.originalPhotoBlob,
    sideViewBlob: newer.sideViewBlob ?? older.sideViewBlob,
    sideViewRawBlob: newer.sideViewRawBlob ?? older.sideViewRawBlob,
    uprightViewBlob: newer.uprightViewBlob ?? older.uprightViewBlob,
    uprightViewRawBlob: newer.uprightViewRawBlob ?? older.uprightViewRawBlob,
    sideViewCleanBlob: newer.sideViewCleanBlob ?? older.sideViewCleanBlob,
    crouchViewBlob: newer.crouchViewBlob ?? older.crouchViewBlob,
    crouchViewRawBlob: newer.crouchViewRawBlob ?? older.crouchViewRawBlob,
    crouchViewCleanBlob: newer.crouchViewCleanBlob ?? older.crouchViewCleanBlob,
    noBgBlob: newer.noBgBlob ?? older.noBgBlob,
    qualityTier: maxOptionalTier(existing.qualityTier, local.qualityTier),
    cloudFighterId: existing.cloudFighterId ?? local.cloudFighterId ?? null,
    cloudPublic: existing.cloudPublic ?? local.cloudPublic ?? false,
    cloudPlayableSpriteRefs: existing.cloudPlayableSpriteRefs ?? local.cloudPlayableSpriteRefs,
    animationsReady: Array.from(new Set([
      ...(existing.animationsReady ?? []),
      ...(local.animationsReady ?? []),
    ])),
    failedAnimationArtifacts: {
      ...(older.failedAnimationArtifacts ?? {}),
      ...(newer.failedAnimationArtifacts ?? {}),
    },
    createdAt: Math.min(existing.createdAt ?? Date.now(), local.createdAt ?? Date.now()),
    updatedAt: Math.max(existing.updatedAt ?? 0, local.updatedAt ?? 0),
  };
}

function mergeClaimedIntro(
  existing: CachedIntro | undefined,
  local: CachedIntro,
  ownerScope: string,
): CachedIntro {
  if (!existing) return { ...local, ownerScope };
  const variants = [...(existing.variants ?? []), ...(local.variants ?? [])];
  const unique = new Map<string, CachedIntroVariant>();
  for (const variant of variants) {
    unique.set(`${variant.id}:${variant.createdAt}:${variant.model ?? ''}`, variant);
  }
  const merged = Array.from(unique.values()).sort((a, b) => b.createdAt - a.createdAt);
  return {
    ownerScope,
    photoHash: local.photoHash,
    activeVariantId: existing.activeVariantId ?? local.activeVariantId ?? merged[0]?.id ?? null,
    variants: merged,
  };
}

async function claimLocalCacheForOwner(ownerScope: string): Promise<void> {
  if (ownerScope === LOCAL_CACHE_SCOPE) return;
  const db = await openDB();
  const [
    localSprites,
    ownerSprites,
    localIntros,
    ownerIntros,
    localMetas,
    ownerMetas,
    localStages,
    ownerStages,
  ] = await Promise.all([
    recordsForScope<CachedSprite>(db, STORE_SPRITES, LOCAL_CACHE_SCOPE),
    recordsForScope<CachedSprite>(db, STORE_SPRITES, ownerScope),
    recordsForScope<CachedIntro>(db, STORE_INTROS, LOCAL_CACHE_SCOPE),
    recordsForScope<CachedIntro>(db, STORE_INTROS, ownerScope),
    recordsForScope<CachedMeta>(db, STORE_META, LOCAL_CACHE_SCOPE),
    recordsForScope<CachedMeta>(db, STORE_META, ownerScope),
    recordsForScope<CachedStageBackground>(db, STORE_STAGES, LOCAL_CACHE_SCOPE),
    recordsForScope<CachedStageBackground>(db, STORE_STAGES, ownerScope),
  ]);

  if (localSprites.length + localIntros.length + localMetas.length + localStages.length === 0) return;

  const tx = db.transaction([STORE_SPRITES, STORE_INTROS, STORE_META, STORE_STAGES], 'readwrite');
  const spriteStore = tx.objectStore(STORE_SPRITES);
  const introStore = tx.objectStore(STORE_INTROS);
  const metaStore = tx.objectStore(STORE_META);
  const stageStore = tx.objectStore(STORE_STAGES);
  const ownerSpriteIds = new Set(ownerSprites.map((sprite) => sprite.versionId).filter(Boolean));
  const ownerIntroByHash = new Map(ownerIntros.map((intro) => [intro.photoHash, intro]));
  const ownerMetaByHash = new Map(ownerMetas.map((meta) => [meta.photoHash, meta]));
  const ownerStageByKey = new Map(ownerStages.map((stage) => [stage.stageKey, stage]));

  for (const sprite of localSprites) {
    if (!sprite.versionId) continue;
    const versionId = ownerSpriteIds.has(sprite.versionId)
      ? createSpriteVersionId(sprite)
      : sprite.versionId;
    spriteStore.put({ ...sprite, ownerScope, versionId });
    spriteStore.delete([LOCAL_CACHE_SCOPE, sprite.versionId]);
  }
  for (const intro of localIntros) {
    introStore.put(mergeClaimedIntro(ownerIntroByHash.get(intro.photoHash), intro, ownerScope));
    introStore.delete([LOCAL_CACHE_SCOPE, intro.photoHash]);
  }
  for (const meta of localMetas) {
    metaStore.put(mergeClaimedMeta(ownerMetaByHash.get(meta.photoHash), meta, ownerScope));
    metaStore.delete([LOCAL_CACHE_SCOPE, meta.photoHash]);
  }
  for (const stage of localStages) {
    const existing = ownerStageByKey.get(stage.stageKey);
    const selected = existing && existing.createdAt >= stage.createdAt ? existing : stage;
    stageStore.put({ ...selected, ownerScope });
    stageStore.delete([LOCAL_CACHE_SCOPE, stage.stageKey]);
  }

  await transactionDone(tx);
}

export function claimLocalSpriteCacheForCurrentOwner(): Promise<void> {
  const ownerScope = activeCacheScope;
  const operation = scopeMutationQueue.then(() => claimLocalCacheForOwner(ownerScope));
  scopeMutationQueue = operation.catch(() => undefined);
  return operation;
}

export async function closeSpriteCacheDatabase(): Promise<void> {
  const current = databasePromise;
  databasePromise = null;
  if (!current) return;
  try {
    (await current).close();
  } catch {
    // A failed open has no live connection to close.
  }
}

export async function hashPhoto(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getCachedMeta(
  photoHash: string,
  ownerScope = activeCacheScope,
): Promise<CachedMeta | null> {
  const scope = requestedCacheScope(ownerScope);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get([scope, photoHash]);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedMeta(meta: CachedMeta, ownerScope = meta.ownerScope ?? activeCacheScope): Promise<void> {
  const scope = requestedCacheScope(ownerScope);
  assertActiveCacheScope(scope);
  const db = await openDB();
  assertActiveCacheScope(scope);
  meta.ownerScope = scope;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const existingRequest = store.get([scope, meta.photoHash]);
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as CachedMeta | undefined;
      store.put({
        ...meta,
        ownerScope: scope,
        cloudPlayableSpriteRefs: existing?.cloudPlayableSpriteRefs ?? meta.cloudPlayableSpriteRefs,
      });
    };
    existingRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Sprite metadata update failed'));
  });
}

export async function setCloudPlayableSpriteRefs(
  photoHash: string,
  refs: Record<string, CachedPlayableSpriteRef>,
  ownerScope = activeCacheScope,
): Promise<void> {
  const scope = requestedCacheScope(ownerScope);
  assertActiveCacheScope(scope);
  const db = await openDB();
  assertActiveCacheScope(scope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const request = store.get([scope, photoHash]);
    request.onsuccess = () => {
      const meta = request.result as CachedMeta | undefined;
      if (!meta) {
        tx.abort();
        return;
      }
      store.put({ ...meta, cloudPlayableSpriteRefs: refs });
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Playable sprite refs update failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Playable sprite refs update failed'));
  });
}

export async function renameCharacter(photoHash: string, characterName: string): Promise<CachedMeta | null> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) return null;
  meta.characterName = characterName;
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);
  return meta;
}

export async function updateCharacterIntroConfig(
  photoHash: string,
  patch: Partial<Pick<CachedMeta, 'introVideoPrompt' | 'introVideoModel' | 'introVideoReferenceBlobs'>>,
): Promise<CachedMeta | null> {
  const meta = await getCachedMeta(photoHash);
  if (!meta) return null;
  if (Object.prototype.hasOwnProperty.call(patch, 'introVideoPrompt')) {
    meta.introVideoPrompt = patch.introVideoPrompt ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'introVideoModel')) {
    meta.introVideoModel = patch.introVideoModel ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'introVideoReferenceBlobs')) {
    meta.introVideoReferenceBlobs = patch.introVideoReferenceBlobs ?? null;
  }
  meta.updatedAt = Date.now();
  await setCachedMeta(meta);
  return meta;
}

export async function getCachedSprite(
  photoHash: string,
  animationName: string,
  qualityTier?: QualityTier,
  ownerScope = activeCacheScope,
): Promise<CachedSprite | null> {
  const scope = requestedCacheScope(ownerScope);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, 'readonly');
    if (qualityTier) {
      const idx = tx.objectStore(STORE_SPRITES).index('byScopeHashAnimTier');
      const req = idx.getAll([scope, photoHash, animationName, qualityTier]);
      req.onsuccess = () => {
        const versions = (req.result ?? []) as CachedSprite[];
        versions.sort(compareSpritesByTierAndTime);
        resolve(versions[0] ?? null);
      };
      req.onerror = () => reject(req.error);
      return;
    }
    const idx = tx.objectStore(STORE_SPRITES).index('byScopeHashAndAnim');
    const req = idx.getAll([scope, photoHash, animationName]);
    req.onsuccess = () => {
      const versions = (req.result ?? []) as CachedSprite[];
      versions.sort(compareSpritesByTierAndTime);
      resolve(versions[0] ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSpritesForHash(
  photoHash: string,
  ownerScope = activeCacheScope,
): Promise<CachedSprite[]> {
  const [versions, meta] = await Promise.all([
    getAllSpriteVersionsForHash(photoHash, ownerScope),
    getCachedMeta(photoHash, ownerScope),
  ]);
  const refs = meta?.cloudPlayableSpriteRefs ?? (meta?.cloudFighterId ? {} : undefined);
  return selectPlayableCachedSprites(versions, refs);
}

export async function getAllSpriteVersionsForHash(
  photoHash: string,
  ownerScope = activeCacheScope,
): Promise<CachedSprite[]> {
  const scope = requestedCacheScope(ownerScope);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, 'readonly');
    const idx = tx.objectStore(STORE_SPRITES).index('byScopeAndHash');
    const req = idx.getAll([scope, photoHash]);
    req.onsuccess = () => {
      const versions = (req.result ?? []) as CachedSprite[];
      versions.sort(compareSpritesByTierAndTime);
      resolve(versions);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedSprite(
  sprite: CachedSprite,
  options: { preserveVersionId?: boolean; ownerScope?: string } = {},
): Promise<void> {
  return writeCachedSprite(sprite, options, true);
}

export async function setCachedArchivedSprite(
  sprite: CachedSprite,
  options: { preserveVersionId?: boolean; ownerScope?: string } = {},
): Promise<void> {
  return writeCachedSprite(sprite, options, false);
}

async function writeCachedSprite(
  sprite: CachedSprite,
  options: { preserveVersionId?: boolean; ownerScope?: string },
  makePlayable: boolean,
): Promise<void> {
  const scope = requestedCacheScope(options.ownerScope ?? sprite.ownerScope);
  assertActiveCacheScope(scope);
  const db = await openDB();
  assertActiveCacheScope(scope);
  sprite.ownerScope = scope;
  const contentHash = makePlayable
    ? await hashPhoto(sprite.pngBlob)
    : normalizedSpriteContentHash(sprite.contentHash);
  const normalized = {
    ...sprite,
    ownerScope: scope,
    qualityTier: normalizeQualityTier(sprite.qualityTier, 'contender'),
    animationFormat: normalizeSpriteAnimationFormat(sprite.animationFormat),
    contentHash,
    createdAt: typeof sprite.createdAt === 'number' ? sprite.createdAt : Date.now(),
  };
  normalized.versionId = options.preserveVersionId && sprite.versionId
    ? sprite.versionId
    : createSpriteVersionId(normalized);
  return new Promise((resolve, reject) => {
    const storeNames = makePlayable ? [STORE_SPRITES, STORE_META] : [STORE_SPRITES];
    const tx = db.transaction(storeNames, 'readwrite');
    tx.objectStore(STORE_SPRITES).put(normalized);
    if (makePlayable) {
      const metaStore = tx.objectStore(STORE_META);
      const metaRequest = metaStore.get([scope, sprite.photoHash]);
      metaRequest.onsuccess = () => {
        const meta = metaRequest.result as CachedMeta | undefined;
        if (!meta?.cloudPlayableSpriteRefs) return;
        metaStore.put({
          ...meta,
          cloudPlayableSpriteRefs: {
            ...meta.cloudPlayableSpriteRefs,
            [normalized.animationName]: playableSpriteRefFor(normalized),
          },
        });
      };
      metaRequest.onerror = () => tx.abort();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Cached sprite write failed'));
  });
}

function normalizeCachedIntro(raw: any): CachedIntro | null {
  if (!raw || typeof raw !== 'object' || typeof raw.photoHash !== 'string') return null;

  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    const variants = raw.variants
      .filter((variant: any) => variant && typeof variant.id === 'string' && variant.videoBlob instanceof Blob)
      .map((variant: any): CachedIntroVariant => ({
        id: variant.id === 'legacy' ? 'legacy' : 'single',
        label: variant.id === 'legacy' ? 'LEGACY' : 'VIDEO',
        videoBlob: variant.videoBlob,
        mimeType: typeof variant.mimeType === 'string' ? variant.mimeType : 'video/mp4',
        createdAt: typeof variant.createdAt === 'number' ? variant.createdAt : Date.now(),
        model: variant.model,
        prompt: variant.prompt ?? null,
        referenceCount: typeof variant.referenceCount === 'number' ? variant.referenceCount : 1,
      }));
    if (variants.length === 0) return null;
    let preferredVariant = variants[0];
    for (const current of variants.slice(1)) {
      const best = preferredVariant;
      if (best.id === 'legacy' && current.id !== 'legacy') {
        preferredVariant = current;
        continue;
      }
      if (best.id !== 'legacy' && current.id === 'legacy') continue;
      const bestRefs = best.referenceCount ?? Number.MAX_SAFE_INTEGER;
      const currentRefs = current.referenceCount ?? Number.MAX_SAFE_INTEGER;
      if (currentRefs < bestRefs) {
        preferredVariant = current;
        continue;
      }
      if (currentRefs > bestRefs) continue;
      if (current.createdAt > best.createdAt) preferredVariant = current;
    }
    return {
      ownerScope: normalizeCacheScope(raw.ownerScope),
      photoHash: raw.photoHash,
      activeVariantId: preferredVariant.id,
      variants: [preferredVariant],
    };
  }

  if (raw.videoBlob instanceof Blob) {
    return {
      ownerScope: normalizeCacheScope(raw.ownerScope),
      photoHash: raw.photoHash,
      activeVariantId: 'legacy',
      variants: [{
        id: 'legacy',
        label: 'LEGACY',
        videoBlob: raw.videoBlob,
        mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : 'video/mp4',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        model: raw.model,
        prompt: raw.prompt ?? null,
        referenceCount: typeof raw.referenceCount === 'number' ? raw.referenceCount : 1,
      }],
    };
  }

  return null;
}

export async function getCachedIntro(
  photoHash: string,
  ownerScope = activeCacheScope,
): Promise<CachedIntro | null> {
  const scope = requestedCacheScope(ownerScope);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INTROS, 'readonly');
    const req = tx.objectStore(STORE_INTROS).get([scope, photoHash]);
    req.onsuccess = () => resolve(normalizeCachedIntro(req.result));
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedIntro(
  intro: CachedIntro,
  ownerScope = intro.ownerScope ?? activeCacheScope,
): Promise<void> {
  const scope = requestedCacheScope(ownerScope);
  assertActiveCacheScope(scope);
  const db = await openDB();
  assertActiveCacheScope(scope);
  intro.ownerScope = scope;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INTROS, 'readwrite');
    tx.objectStore(STORE_INTROS).put({ ...intro, ownerScope: scope });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCachedIntro(photoHash: string): Promise<void> {
  const scope = activeCacheScope;
  const db = await openDB();
  assertActiveCacheScope(scope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INTROS, 'readwrite');
    tx.objectStore(STORE_INTROS).delete([scope, photoHash]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllCachedMetas(ownerScope = activeCacheScope): Promise<CachedMeta[]> {
  const scope = requestedCacheScope(ownerScope);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).index('byScope').getAll(scope);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedStageBackground(
  stageKey: string,
  ownerScope = activeCacheScope,
): Promise<CachedStageBackground | null> {
  const scope = requestedCacheScope(ownerScope);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readonly');
    const req = tx.objectStore(STORE_STAGES).get([scope, stageKey]);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllCachedStageBackgrounds(ownerScope = activeCacheScope): Promise<CachedStageBackground[]> {
  const scope = requestedCacheScope(ownerScope);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readonly');
    const req = tx.objectStore(STORE_STAGES).index('byScope').getAll(scope);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedStageBackground(
  stage: CachedStageBackground,
  ownerScope = stage.ownerScope ?? activeCacheScope,
): Promise<void> {
  const scope = requestedCacheScope(ownerScope);
  assertActiveCacheScope(scope);
  const db = await openDB();
  assertActiveCacheScope(scope);
  stage.ownerScope = scope;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readwrite');
    tx.objectStore(STORE_STAGES).put({ ...stage, ownerScope: scope });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameCachedStageBackground(stageKey: string, label: string): Promise<CachedStageBackground | null> {
  const stage = await getCachedStageBackground(stageKey);
  if (!stage) return null;
  stage.label = label;
  await setCachedStageBackground(stage);
  return stage;
}

export async function deleteCachedStageBackground(stageKey: string): Promise<void> {
  const scope = activeCacheScope;
  const db = await openDB();
  assertActiveCacheScope(scope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readwrite');
    tx.objectStore(STORE_STAGES).delete([scope, stageKey]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCharacter(photoHash: string): Promise<void> {
  const scope = activeCacheScope;
  const db = await openDB();
  assertActiveCacheScope(scope);
  const tx = db.transaction([STORE_SPRITES, STORE_INTROS, STORE_META], 'readwrite');
  tx.objectStore(STORE_META).delete([scope, photoHash]);
  tx.objectStore(STORE_INTROS).delete([scope, photoHash]);
  const spriteCursor = tx.objectStore(STORE_SPRITES)
    .index('byScopeAndHash')
    .openCursor(IDBKeyRange.only([scope, photoHash]));
  spriteCursor.onsuccess = () => {
    const cursor = spriteCursor.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearCache(): Promise<void> {
  const scope = activeCacheScope;
  const db = await openDB();
  assertActiveCacheScope(scope);
  const tx = db.transaction([STORE_SPRITES, STORE_INTROS, STORE_META, STORE_STAGES], 'readwrite');
  for (const storeName of [STORE_SPRITES, STORE_INTROS, STORE_META, STORE_STAGES]) {
    const cursorRequest = tx.objectStore(storeName).index('byScope').openCursor(IDBKeyRange.only(scope));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export { CACHE_VERSION };
export type {
  CachedSprite,
  QualityTier,
  CachedIntro,
  CachedIntroModel,
  CachedIntroVariant,
  CachedIntroVariantId,
  CachedMeta,
  CachedStageBackground,
  CachedStageKind,
  CachedStageSource,
  CachedFailedAnimationArtifact,
};
