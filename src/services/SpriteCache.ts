const DB_NAME = 'ai-street-fighter';
const DB_VERSION = 2;
const STORE_SPRITES = 'sprites';
const STORE_INTROS = 'intros';
const STORE_META = 'meta';
const STORE_STAGES = 'stages';

interface CachedSprite {
  photoHash: string;
  animationName: string;
  pngBlob: Blob;
  rawPngBlob?: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  processingVersion?: number;
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
  photoHash: string;
  activeVariantId?: CachedIntroVariantId | null;
  variants: CachedIntroVariant[];
}

type CachedStageKind = 'generated' | 'photo' | 'photo-direct';

interface CachedStageBackground {
  stageKey: string;
  prompt: string;
  pngBlob: Blob;
  createdAt: number;
  kind?: CachedStageKind;
  label?: string;
}

const CACHE_VERSION = 1;

interface CachedMeta {
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
  introVideoPrompt?: string | null;
  introVideoModel?: 'freepik-auto' | 'kling-v2-1-std' | 'veo-3-1' | 'runway-gen4-turbo' | 'fal-ltx-v2-3-fast' | 'fal-kling-v2-6-pro' | 'fal-vidu-q3' | null;
  introVideoReferenceBlobs?: Blob[] | null;
  status: 'pending' | 'sprites_generating' | 'ready' | 'error';
  animationsReady: string[];
  createdAt: number;
  updatedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SPRITES)) {
        const store = db.createObjectStore(STORE_SPRITES, { keyPath: ['photoHash', 'animationName'] });
        store.createIndex('byHash', 'photoHash');
      }
      if (!db.objectStoreNames.contains(STORE_INTROS)) {
        db.createObjectStore(STORE_INTROS, { keyPath: 'photoHash' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'photoHash' });
      }
      if (!db.objectStoreNames.contains(STORE_STAGES)) {
        db.createObjectStore(STORE_STAGES, { keyPath: 'stageKey' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function hashPhoto(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getCachedMeta(photoHash: string): Promise<CachedMeta | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get(photoHash);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedMeta(meta: CachedMeta): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

export async function getCachedSprite(photoHash: string, animationName: string): Promise<CachedSprite | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, 'readonly');
    const req = tx.objectStore(STORE_SPRITES).get([photoHash, animationName]);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSpritesForHash(photoHash: string): Promise<CachedSprite[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, 'readonly');
    const idx = tx.objectStore(STORE_SPRITES).index('byHash');
    const req = idx.getAll(photoHash);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedSprite(sprite: CachedSprite): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SPRITES, 'readwrite');
    tx.objectStore(STORE_SPRITES).put(sprite);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
      photoHash: raw.photoHash,
      activeVariantId: preferredVariant.id,
      variants: [preferredVariant],
    };
  }

  if (raw.videoBlob instanceof Blob) {
    return {
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

export async function getCachedIntro(photoHash: string): Promise<CachedIntro | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INTROS, 'readonly');
    const req = tx.objectStore(STORE_INTROS).get(photoHash);
    req.onsuccess = () => resolve(normalizeCachedIntro(req.result));
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedIntro(intro: CachedIntro): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INTROS, 'readwrite');
    tx.objectStore(STORE_INTROS).put(intro);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCachedIntro(photoHash: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INTROS, 'readwrite');
    tx.objectStore(STORE_INTROS).delete(photoHash);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllCachedMetas(): Promise<CachedMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedStageBackground(stageKey: string): Promise<CachedStageBackground | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readonly');
    const req = tx.objectStore(STORE_STAGES).get(stageKey);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllCachedStageBackgrounds(): Promise<CachedStageBackground[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readonly');
    const req = tx.objectStore(STORE_STAGES).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedStageBackground(stage: CachedStageBackground): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readwrite');
    tx.objectStore(STORE_STAGES).put(stage);
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
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STAGES, 'readwrite');
    tx.objectStore(STORE_STAGES).delete(stageKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCharacter(photoHash: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([STORE_SPRITES, STORE_INTROS, STORE_META], 'readwrite');
  tx.objectStore(STORE_META).delete(photoHash);
  tx.objectStore(STORE_INTROS).delete(photoHash);

  const sprites = await new Promise<CachedSprite[]>((resolve, reject) => {
    const idx = tx.objectStore(STORE_SPRITES).index('byHash');
    const req = idx.getAll(photoHash);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
  for (const s of sprites) {
    tx.objectStore(STORE_SPRITES).delete([s.photoHash, s.animationName]);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearCache(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([STORE_SPRITES, STORE_INTROS, STORE_META, STORE_STAGES], 'readwrite');
  tx.objectStore(STORE_SPRITES).clear();
  tx.objectStore(STORE_INTROS).clear();
  tx.objectStore(STORE_META).clear();
  tx.objectStore(STORE_STAGES).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export { CACHE_VERSION };
export type {
  CachedSprite,
  CachedIntro,
  CachedIntroModel,
  CachedIntroVariant,
  CachedIntroVariantId,
  CachedMeta,
  CachedStageBackground,
  CachedStageKind,
};
