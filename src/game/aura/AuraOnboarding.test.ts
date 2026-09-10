import { describe, expect, it } from 'vitest';
import { AuraOnboarding, AURA_PRACTICE_TRAVEL_MS, canGuideAuraFirstBattle, isAuraOnboardingDetail } from './AuraOnboarding.ts';
import type { AuraLane } from './AuraChart.ts';
import type { MatchSceneData } from '../match/MatchConfig.ts';

function finishPractice(guide = new AuraOnboarding()): AuraOnboarding {
  for (const lane of [0, 1, 2, 3] as const) {
    guide.advance(AURA_PRACTICE_TRAVEL_MS);
    guide.practiceInput(lane);
  }
  return guide;
}

describe('Aura first battle guide', () => {
  it.each([
    { gameMode: 'aura', vsAI: true },
    { gameMode: 'aura', experience: 'trial' },
  ] as MatchSceneData[])('allows explicit opt-in for a solo battle: %o', data => {
    expect(canGuideAuraFirstBattle(data)).toBe(true);
  });

  it.each([
    {}, { gameMode: 'fight' }, { gameMode: 'rush' }, { gameMode: 'aura', vsAI: false },
    { gameMode: 'aura', cpuVsCpu: true }, { gameMode: 'aura', online: {} },
    { gameMode: 'aura', auraChallenge: {} },
  ] as MatchSceneData[])('never guides other modes, spectators, local versus, online or challenge: %o', data => {
    expect(canGuideAuraFirstBattle(data)).toBe(false);
  });

  it('waits for a deliberate correct press on each lane and never advances on early/wrong input', () => {
    const guide = new AuraOnboarding();
    for (const lane of [0, 1, 2, 3] as const) {
      expect(guide.practiceInput(lane)).toBe('wait');
      expect(guide.snapshot.completedLanes).toBe(lane);
      guide.advance(AURA_PRACTICE_TRAVEL_MS - 1);
      expect(guide.practiceInput(lane)).toBe('wait');
      guide.advance(1);
      expect(guide.snapshot.cue).toBe('hit');
      expect(guide.practiceInput(((lane + 1) % 4) as AuraLane)).toBe('ignored');
      expect(guide.snapshot.practiceLane).toBe(lane);
      guide.advance(60_000); // A novice can take their time at the receptor.
      expect(guide.practiceProgress).toBe(1);
      expect(guide.practiceInput(lane)).toBe(lane === 3 ? 'start-battle' : 'hit');
    }
    expect(guide.snapshot).toEqual({ phase: 'battle', cue: 'timing', practiceLane: null, completedLanes: 4 });
    expect(guide.practiceInput(3)).toBe('ignored');
    guide.advance(60_000);
    expect(guide.snapshot.cue).toBe('timing'); // The true song count-in never hides the timing lesson.
  });

  it('ignores invalid clock deltas instead of skipping the guided interaction', () => {
    const guide = new AuraOnboarding();
    for (const delta of [NaN, Infinity, -1, 0]) guide.advance(delta);
    expect(guide.practiceProgress).toBe(0);
    expect(guide.snapshot.completedLanes).toBe(0);
  });

  it('explains an actual positive human score once, then the rival handoff and return', () => {
    const guide = finishPractice();
    guide.judgement({ slot: 1, grade: 'perfect', scoreDelta: 1_000 }, 1);
    guide.judgement({ slot: 0, grade: 'miss', scoreDelta: 0 }, 0);
    guide.judgement({ slot: 0, grade: 'perfect', scoreDelta: 1_000 }, 1); // A stale human result.
    expect(guide.snapshot.cue).toBe('timing');
    guide.judgement({ slot: 0, grade: 'good', scoreDelta: 475 }, 0);
    expect(guide.snapshot).toMatchObject({ cue: 'score', scoreDelta: 475 });
    guide.advance(3_000);
    expect(guide.snapshot.cue).toBeNull();
    guide.judgement({ slot: 0, grade: 'perfect', scoreDelta: 1_250 }, 0);
    expect(guide.snapshot.cue).toBeNull();
    guide.turn(1);
    expect(guide.snapshot.cue).toBe('rival');
    guide.advance(4_000);
    expect(guide.snapshot.cue).toBeNull();
    guide.turn(0);
    expect(guide.snapshot.cue).toBe('your-turn');
    guide.advance(2_999);
    expect(guide.snapshot.phase).toBe('battle');
    guide.advance(1);
    expect(guide.snapshot.phase).toBe('complete');
    guide.turn(1);
    expect(guide.snapshot.cue).toBeNull();
  });

  it('still completes when the first successful note happens after the rival has already played', () => {
    const guide = finishPractice();
    guide.turn(1);
    guide.turn(0);
    guide.judgement({ slot: 0, grade: 'great', scoreDelta: 750 }, 0);
    expect(guide.snapshot).toMatchObject({ cue: 'score', scoreDelta: 750 });
    guide.advance(3_000);
    expect(guide.snapshot.phase).toBe('complete');
  });

  it.each([false, true])('allows skipping with no further tips, already playing=%s', playing => {
    const guide = playing ? finishPractice() : new AuraOnboarding();
    guide.skip();
    guide.advance(60_000);
    guide.turn(1);
    guide.judgement({ slot: 0, grade: 'perfect', scoreDelta: 1_000 }, 0);
    expect(guide.practiceInput(0)).toBe('ignored');
    expect(guide.snapshot).toMatchObject({ phase: 'skipped', cue: null, practiceLane: null });
    guide.complete();
    expect(guide.snapshot.phase).toBe('skipped');
  });

  it('completes remaining battle guidance at the finale without declaring abandoned practice complete', () => {
    const guide = new AuraOnboarding();
    guide.complete();
    expect(guide.snapshot.phase).toBe('practice');
    finishPractice(guide).complete();
    expect(guide.snapshot).toMatchObject({ phase: 'complete', cue: null });
  });

  it('accepts only usable lifecycle-scoped UI event data', () => {
    const detail = { ...new AuraOnboarding().snapshot, token: 1, seed: 67, laneKeys: ['D', 'F', 'J', 'K'] };
    expect(isAuraOnboardingDetail(detail)).toBe(true);
    for (const change of [{ token: 0 }, { seed: -1 }, { phase: 'playing' }, { practiceLane: 4 },
      { completedLanes: 7 }, { laneKeys: ['D'] }, { scoreDelta: NaN }, { cue: 'injected' }]) {
      expect(isAuraOnboardingDetail({ ...detail, ...change })).toBe(false);
    }
  });
});
