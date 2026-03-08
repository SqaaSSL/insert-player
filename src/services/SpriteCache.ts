const DB_NAME = 'ai-street-fighter';
const DB_VERSION = 1;
const STORE_SPRITES = 'sprites';
const STORE_INTROS = 'intros';
const STORE_META = 'meta';

interface CachedSprite {
  photoHash: string;
  animationName: string;
  pngBlob: Blob;
  rawPngBlob?: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  createdAt: number;
}

interface CachedIntro {
  photoHash: string;
  videoBlob: Blob;
  mimeType: string;
  createdAt: number;
}

const CACHE_VERSION = 1;

interface CachedMeta {
  photoHash: string;
  version: number;
  originalPhotoBlob: Blob | null;
  sideViewBlob: Blob | null;
  sideViewCleanBlob: Blob | null;
  crouchViewBlob: Blob | null;
  crouchViewCleanBlob: Blob | null;
  noBgBlob: Blob | null;
  characterName: string;
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

export async function getCachedIntro(photoHash: string): Promise<CachedIntro | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INTROS, 'readonly');
    const req = tx.objectStore(STORE_INTROS).get(photoHash);
    req.onsuccess = () => resolve(req.result ?? null);
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

export async function getAllCachedMetas(): Promise<CachedMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
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
  const tx = db.transaction([STORE_SPRITES, STORE_INTROS, STORE_META], 'readwrite');
  tx.objectStore(STORE_SPRITES).clear();
  tx.objectStore(STORE_INTROS).clear();
  tx.objectStore(STORE_META).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export { CACHE_VERSION };
export type { CachedSprite, CachedIntro, CachedMeta };
