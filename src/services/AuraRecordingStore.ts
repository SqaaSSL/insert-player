import { isValidAuraRecording, type AuraRecording } from '../game/aura/AuraRecording.ts';

const DATABASE = 'insert-player-aura-recordings';
const STORE = 'matches';
export const AURA_HISTORY_LIMIT = 5;
export interface SavedAuraRecording { id: string; savedAt: number; recording: AuraRecording }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Local history unavailable')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Local history blocked'));
  });
}

/** Bounded local action history, not a public replay or an asset upload.
 * Videos are deliberately not auto-persisted: players explicitly download them.
 */
export async function saveAuraRecording(id: string, recording: AuraRecording): Promise<boolean> {
  if (!id || id.length > 160 || recording.status !== 'complete' || !isValidAuraRecording(recording)) return false;
  let db: IDBDatabase | undefined;
  try {
    db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.put({ id, savedAt: Date.now(), recording } satisfies SavedAuraRecording);
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = (request.result as SavedAuraRecording[]).sort((a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id));
        for (const entry of entries.slice(AURA_HISTORY_LIMIT)) store.delete(entry.id);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    return true;
  } catch { return false; }
  finally { db?.close(); }
}

export async function listAuraRecordings(): Promise<SavedAuraRecording[]> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db!.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as SavedAuraRecording[])
        .filter(entry => entry.recording?.status === 'complete' && isValidAuraRecording(entry.recording))
        .sort((a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id)));
      request.onerror = () => reject(request.error);
    });
  } catch { return []; }
  finally { db?.close(); }
}
