import { beforeEach, describe, expect, it } from 'vitest';
import {
  ARCADE_RUN_CONTINUES,
  ARCADE_RUN_STORAGE_KEY,
  advanceArcadeRun,
  buildRungMatchData,
  clearArcadeRun,
  createArcadeRun,
  isFinalRung,
  readArcadeRun,
  rungDifficulty,
  spendArcadeContinue,
  writeArcadeRun,
  type ArcadeRunRung,
} from './arcadeRun.ts';

// Node test environment: provide the minimal window.sessionStorage surface
// the helpers touch.
const storage = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => { storage.clear(); },
  },
};

const PLAYER = {
  key: 'local:hash-p1',
  photoHash: 'hash-p1',
  cloudFighterId: null,
  name: 'Fran',
  personalityId: 'balanced' as const,
};

function rung(index: number): ArcadeRunRung {
  return {
    slug: `challenger-${index}`,
    fighterId: `cloud-${index}`,
    photoHash: `arcade:challenger-${index}:cloud-${index}`,
    name: `Challenger ${index}`,
    personalityId: 'brawler',
    challengerLine: null,
  };
}

const RUNGS = [rung(1), rung(2), rung(3)];

describe('arcadeRun', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('creates a run at rung 0 with the full continue stock', () => {
    const run = createArcadeRun(PLAYER, RUNGS, 'owner:a', 123);
    expect(run.currentRung).toBe(0);
    expect(run.continuesLeft).toBe(ARCADE_RUN_CONTINUES);
    expect(run.continuesUsed).toBe(0);
    expect(() => createArcadeRun(PLAYER, [], 'owner:a', 123)).toThrow();
  });

  it('escalates difficulty from 0.25 to 1.0 across the ladder', () => {
    expect(rungDifficulty(0, 13)).toBe(0.25);
    expect(rungDifficulty(12, 13)).toBe(1);
    expect(rungDifficulty(6, 13)).toBeGreaterThan(0.25);
    expect(rungDifficulty(6, 13)).toBeLessThan(1);
    expect(rungDifficulty(0, 1)).toBe(1);
  });

  it('advances rungs and clamps at the boss', () => {
    let run = createArcadeRun(PLAYER, RUNGS, 'owner:a', 123);
    expect(isFinalRung(run)).toBe(false);
    run = advanceArcadeRun(run);
    run = advanceArcadeRun(run);
    expect(run.currentRung).toBe(2);
    expect(isFinalRung(run)).toBe(true);
    expect(advanceArcadeRun(run).currentRung).toBe(2);
  });

  it('spends continues and refuses when exhausted; retries reseed via remix', () => {
    let run = createArcadeRun(PLAYER, RUNGS, 'owner:a', 123);
    const firstSeedData = buildRungMatchData(run);
    for (let i = 0; i < ARCADE_RUN_CONTINUES; i++) {
      const next = spendArcadeContinue(run);
      expect(next).not.toBeNull();
      run = next!;
    }
    expect(run.continuesLeft).toBe(0);
    expect(spendArcadeContinue(run)).toBeNull();
    const retryData = buildRungMatchData(run);
    expect(retryData.remix).toBe(ARCADE_RUN_CONTINUES);
    expect(retryData.remix).not.toBe(firstSeedData.remix);
  });

  it('builds a vsAI match against the current rung with scaled difficulty', () => {
    const run = advanceArcadeRun(createArcadeRun(PLAYER, RUNGS, 'owner:a', 123));
    const data = buildRungMatchData(run);
    expect(data.vsAI).toBe(true);
    expect(data.cpuVsCpu).toBe(false);
    expect(data.p1Name).toBe('Fran');
    expect(data.p2Name).toBe('Challenger 2');
    expect(data.p2PersonalityId).toBe('brawler');
    expect(data.p2Difficulty).toBe(rungDifficulty(1, 3));
  });

  it('persists per owner scope and rejects other owners or garbage', () => {
    const run = createArcadeRun(PLAYER, RUNGS, 'owner:a', 123);
    writeArcadeRun(run);
    expect(readArcadeRun('owner:a')?.player.name).toBe('Fran');
    expect(readArcadeRun('owner:b')).toBeNull();
    storage.set(ARCADE_RUN_STORAGE_KEY, '{not json');
    expect(readArcadeRun('owner:a')).toBeNull();
    clearArcadeRun();
    expect(readArcadeRun('owner:a')).toBeNull();
  });
});
