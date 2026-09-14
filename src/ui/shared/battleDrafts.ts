import type { BattleCaptureDetail } from '../../game/match/BattleCapture.ts';

export interface BattleDraft { capture: BattleCaptureDetail; scope: string; savedAt: number; battleId?: string }
const active = new Map<string, BattleDraft>();
const requests = new Map<string, string>();
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 3;
const MAX_BYTES = 128 * 1024 * 1024;
const dbName = 'insert-player-battle-drafts';
const draftKey = (scope: string, id: string) => `${scope}:${id}`;
function guestScope(scope: string): string { return ['signed-out', 'loading', 'local'].includes(scope) ? 'guest' : scope; }
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
async function write(key: string, draft: BattleDraft | null): Promise<boolean> {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      if (draft) tx.objectStore('drafts').put(draft, key); else tx.objectStore('drafts').delete(key);
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    }).finally(() => db.close());
    return true;
  } catch { return false; }
}
/** Device-only draft. No credit or network side effect, including after sign-in. */
export async function saveBattleDraft(scope: string, capture: BattleCaptureDetail, battleId?: string): Promise<boolean> {
  const owner = guestScope(scope);
  const key = draftKey(owner, capture.clientBattleId);
  const draft = { capture, scope: owner, savedAt: Date.now(), battleId: battleId ?? active.get(key)?.battleId };
  active.set(key, draft);
  const saved = await write(key, draft);
  await pruneDrafts(await readAllDrafts());
  return saved;
}
async function readAllDrafts(): Promise<BattleDraft[]> {
  let rows = [...active.values()];
  try {
    const db = await database();
    const stored = await new Promise<BattleDraft[]>((resolve, reject) => {
      const req = db.transaction('drafts').objectStore('drafts').getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    }).finally(() => db.close());
    const merged = new Map(stored.map(row => [draftKey(row.scope, row.capture.clientBattleId), row]));
    for (const row of rows) merged.set(draftKey(row.scope, row.capture.clientBattleId), row);
    rows = [...merged.values()];
  } catch { /* In-memory recovery remains available when storage is blocked. */ }
  return rows.sort((a, b) => b.savedAt - a.savedAt);
}
async function pruneDrafts(rows: BattleDraft[]): Promise<BattleDraft[]> {
  const kept: BattleDraft[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = (row.capture?.stillBase64?.length ?? 0) * 0.75 + (row.capture?.recording?.size ?? 0);
    if (!row.capture?.stillBase64 || !row.capture?.summary || row.savedAt > Date.now() + 60_000 || Date.now() - row.savedAt >= MAX_AGE
      || kept.length >= MAX_DRAFTS || bytes + size > MAX_BYTES) {
      if (row.capture?.clientBattleId && row.scope) await removeBattleDraft(row.scope, row.capture.clientBattleId);
      continue;
    }
    kept.push(row); bytes += size;
  }
  return kept;
}
export async function listBattleDrafts(scope: string): Promise<BattleDraft[]> {
  const owner = guestScope(scope);
  return (await pruneDrafts(await readAllDrafts())).filter(row => row.scope === owner || row.scope === 'guest');
}
export async function removeBattleDraft(scope: string, id: string): Promise<void> {
  const key = draftKey(guestScope(scope), id);
  active.delete(key); await write(key, null);
}
/** Keep an uncertain generation request stable across reloads and retries. */
export function battleFinisherRequestId(scope: string, battleId: string, newAttempt = false): string {
  const key = `insert-player:finisher-request:${scope}:${battleId}`;
  if (!newAttempt && requests.has(key)) return requests.get(key)!;
  let id = crypto.randomUUID();
  try {
    const saved = localStorage.getItem(key);
    if (saved && !newAttempt && /^[0-9a-f-]{36}$/i.test(saved)) id = saved as `${string}-${string}-${string}-${string}-${string}`;
    localStorage.setItem(key, id);
  } catch { /* Same-page retries still reuse the in-memory request key. */ }
  requests.set(key, id);
  return id;
}
