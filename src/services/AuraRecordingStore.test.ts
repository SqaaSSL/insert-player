import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuraRecorder } from '../game/aura/AuraRecording.ts';
import { AuraBattle, auraRank } from '../game/aura/AuraBattle.ts';
import { createAuraChart } from '../game/aura/AuraChart.ts';
import { AURA_HISTORY_LIMIT, listAuraRecordings, saveAuraRecording } from './AuraRecordingStore.ts';

function recording(complete = true) {
  const chart = createAuraChart(67, 'viral');
  const recorder = new AuraRecorder({ engineVersion: 'aura-presentation-v1', matchSeed: chart.seed,
    trackId: chart.trackId, difficulty: 'viral', stageId: 'mars-incorporated',
    p1Name: 'Francisco', p2Name: 'Donald Trump', chart });
  const battle = new AuraBattle(chart);
  for (const note of chart.notes) recorder.record(note.atMs, battle.judgeNote(note.id, 'perfect')!);
  const p1Score = battle.scoreFor(0), p2Score = battle.scoreFor(1);
  if (complete) recorder.finish({ winnerSlot: p1Score.score === p2Score.score ? 'draw' : p1Score.score > p2Score.score ? 'p1' : 'p2',
    p1Name: 'Francisco', p2Name: 'Donald Trump', p1Score, p2Score, p1Rank: auraRank(p1Score), p2Rank: auraRank(p2Score),
    difficulty: 'viral', stageId: 'mars-incorporated', stageLabel: 'MARS INCORPORATED', durationSeconds: chart.durationMs / 1000 });
  return recorder.toRecording();
}

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('insert-player-aura-recordings');
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
});

describe('bounded local Aura action history', () => {
  it('saves and reloads the full finalized event sequence, without a video or original photo', async () => {
    const original = recording();
    expect(await saveAuraRecording('match-one', original)).toBe(true);
    original.config.p1Name = 'changed';
    const saved = await listAuraRecordings();
    expect(saved).toHaveLength(1);
    expect(saved[0].recording.config.p1Name).toBe('Francisco');
    expect(saved[0].recording.events).toHaveLength(original.events.length);
    expect(saved[0].recording.status).toBe('complete');
    expect(JSON.stringify(saved)).not.toMatch(/blob:|photoHash|roomCode|originalPhoto/);
  });

  it('retains only the five most recent completed matches', async () => {
    const data = recording();
    for (let index = 0; index < 8; index++) {
      vi.spyOn(Date, 'now').mockReturnValue(1000 + index);
      expect(await saveAuraRecording(`match-${index}`, data)).toBe(true);
    }
    const saved = await listAuraRecordings();
    expect(saved).toHaveLength(AURA_HISTORY_LIMIT);
    expect(saved.map(entry => entry.id)).toEqual(['match-7', 'match-6', 'match-5', 'match-4', 'match-3']);
  });

  it('never saves incomplete, failed or malformed sessions', async () => {
    expect(await saveAuraRecording('partial', recording(false))).toBe(false);
    expect(await saveAuraRecording('', recording())).toBe(false);
    expect(await saveAuraRecording('invalid', { ...recording(), version: 99 } as never)).toBe(false);
    expect(await listAuraRecordings()).toEqual([]);
  });

  it('degrades gracefully if private mode or storage quota blocks IndexedDB', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('Unavailable', 'QuotaExceededError'); });
    expect(await saveAuraRecording('blocked', recording())).toBe(false);
    expect(await listAuraRecordings()).toEqual([]);
  });
});
