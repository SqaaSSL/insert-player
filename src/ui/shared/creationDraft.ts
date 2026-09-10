import type { GenerationPackage } from '../../services/GenerationPackages.ts';
import { isQualityTier, type QualityTier } from '../../services/QualityTiers.ts';
import type { CreationFlow } from './creationFlow.ts';
import type { CreationNavigationContext } from './onboardingFlow.ts';

export interface CreationDraft {
  file: Blob;
  fileName: string;
  name: string;
  tier: QualityTier;
  creationPackage: GenerationPackage;
  creationFlow?: CreationFlow;
  savedAt: number;
}

/** Explicit game-entry or checkout choices take precedence over an older draft. */
export function restoreCreationChoices(draft: CreationDraft, context: CreationNavigationContext) {
  const creationPackage = context.creationPackage ?? draft.creationPackage;
  return {
    tier: context.tier ?? draft.tier,
    creationPackage,
    creationFlow: creationPackage === 'aura' ? 'original' as const : draft.creationFlow ?? 'original',
  };
}
const MAX_AGE = 24 * 60 * 60 * 1000;
const active = new Map<string, CreationDraft>();

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ip-creation-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/** Preserve unfinished creation on this device, scoped to the current account. */
export async function saveCreationDraft(scope: string, draft: CreationDraft): Promise<boolean> {
  active.set(scope, draft);
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put(draft, scope);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch { return false; }
}

export async function readCreationDraft(scope: string): Promise<CreationDraft | null> {
  let draft = active.get(scope);
  if (!draft) try {
    const db = await database();
    draft = await new Promise<CreationDraft | undefined>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get(scope);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch { return null; }
  if (!draft) return null;
  if (!(draft.file instanceof Blob)
    || typeof draft.fileName !== 'string' || typeof draft.name !== 'string'
    || !isQualityTier(draft.tier)
    || (draft.creationPackage !== 'aura' && draft.creationPackage !== 'complete')
    || (draft.creationFlow !== undefined && draft.creationFlow !== 'original' && draft.creationFlow !== 'video')
    || !Number.isFinite(draft.savedAt)
    || Date.now() - draft.savedAt > MAX_AGE || draft.savedAt > Date.now() + 60_000) {
    await clearCreationDraft(scope);
    return null;
  }
  return draft;
}

export async function clearCreationDraft(scope: string): Promise<void> {
  active.delete(scope);
  try {
    const db = await database();
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').delete(scope);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch { /* Local storage may be disabled. */ }
}
