import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { battleFinisherRequestId, listBattleDrafts, removeBattleDraft, saveBattleDraft } from './battleDrafts.ts';
import type { BattleCaptureDetail } from '../../game/match/BattleCapture.ts';
const capture = (): BattleCaptureDetail => ({ clientBattleId: crypto.randomUUID(), stillBase64: '/9j/AA==', summary: { game: 'fight', winner: 'p1', p1Name: 'Winner', p2Name: 'Loser', stageLabel: 'Stage', durationSeconds: 40 } });
beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('battle draft recovery', () => {
  it('keeps guest final frames across authentication, while account drafts remain scoped', async () => {
    const guest = capture(); const own = capture();
    await saveBattleDraft('signed-out', guest); await saveBattleDraft('user-a', own);
    expect((await listBattleDrafts('user-a')).map(row => row.capture.clientBattleId)).toEqual(expect.arrayContaining([guest.clientBattleId, own.clientBattleId]));
    expect((await listBattleDrafts('user-b')).map(row => row.capture.clientBattleId)).not.toContain(own.clientBattleId);
    await removeBattleDraft('signed-out', guest.clientBattleId); await removeBattleDraft('user-a', own.clientBattleId);
  });
  it('preserves the original recording and server battle ID for interrupted uploads/checkout', async () => {
    const value = { ...capture(), recording: new File(['full match'], 'match.mp4', { type: 'video/mp4' }) };
    await saveBattleDraft('user-c', value, 'saved-server-battle');
    const row = (await listBattleDrafts('user-c')).find(item => item.capture.clientBattleId === value.clientBattleId)!;
    expect(row.battleId).toBe('saved-server-battle'); expect(await row.capture.recording!.text()).toBe('full match');
    await removeBattleDraft('user-c', value.clientBattleId);
  });
  it('reuses the exact generation key after an uncertain response and only changes it for a deliberate new attempt', () => {
    const id = crypto.randomUUID(); const first = battleFinisherRequestId('user-c', id);
    expect(battleFinisherRequestId('user-c', id)).toBe(first);
    const next = battleFinisherRequestId('user-c', id, true); expect(next).not.toBe(first);
    expect(battleFinisherRequestId('user-c', id)).toBe(next);
  });
  it('retains same-page idempotency even if browser storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
    const id = crypto.randomUUID(); expect(battleFinisherRequestId('user-d', id)).toBe(battleFinisherRequestId('user-d', id));
  });
  it('removes expired drafts from IndexedDB and evicts the oldest beyond three records', async () => {
    const now = Date.now(); const clock = vi.spyOn(Date, 'now');
    const values = [capture(), capture(), capture(), capture()];
    for (let index = 0; index < values.length; index++) { clock.mockReturnValue(now + index); await saveBattleDraft('bounded-owner', values[index]); }
    expect((await listBattleDrafts('bounded-owner')).map(row => row.capture.clientBattleId)).toEqual(values.slice(1).reverse().map(row => row.clientBattleId));
    clock.mockReturnValue(now + 25 * 60 * 60 * 1000);
    expect(await listBattleDrafts('bounded-owner')).toEqual([]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('insert-player-battle-drafts', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const count = await new Promise<number>(resolve => { const req = db.transaction('drafts').objectStore('drafts').count(); req.onsuccess = () => resolve(req.result); }); db.close();
    expect(count).toBe(0);
  });
  it('evicts older recordings when the 128 MB device budget would be exceeded', async () => {
    const first = capture(); const second = capture();
    for (const item of [first, second]) {
      item.recording = new File(['small test payload'], 'match.mp4', { type: 'video/mp4' });
      Object.defineProperty(item.recording, 'size', { value: 64 * 1024 * 1024 });
    }
    const clock = vi.spyOn(Date, 'now'); const now = Date.now(); clock.mockReturnValue(now);
    await saveBattleDraft('byte-budget', first); clock.mockReturnValue(now + 1); await saveBattleDraft('byte-budget', second);
    expect((await listBattleDrafts('byte-budget')).map(row => row.capture.clientBattleId)).toEqual([second.clientBattleId]);
    await removeBattleDraft('byte-budget', second.clientBattleId);
  });
});
