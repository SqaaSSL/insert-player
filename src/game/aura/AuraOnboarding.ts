import type { MatchSceneData } from '../match/MatchConfig.ts';
import type { AuraJudgement } from './AuraBattle.ts';
import type { AuraLane, AuraSlot } from './AuraChart.ts';
import type { AuraLaneKeys } from './AuraConfig.ts';

/** Local presentation only: never serialized in a match, replay or challenge. */
export const AURA_ONBOARDING_EVENT = 'asf:aura-onboarding';
export const AURA_ONBOARDING_SKIP_EVENT = 'asf:aura-onboarding-skip';
export const AURA_PRACTICE_TRAVEL_MS = 1_200;

export type AuraOnboardingPhase = 'practice' | 'battle' | 'complete' | 'skipped';
export type AuraOnboardingCue = 'controls' | 'wait' | 'hit' | 'timing' | 'score' | 'rival' | 'your-turn';
export interface AuraOnboardingSnapshot {
  phase: AuraOnboardingPhase;
  /** Null hides the contextual tip between teaching moments. */
  cue: AuraOnboardingCue | null;
  practiceLane: AuraLane | null;
  completedLanes: number;
  /** Actual scored gain, only supplied with the first successful real note. */
  scoreDelta?: number;
}
export interface AuraOnboardingDetail extends AuraOnboardingSnapshot {
  token: number;
  seed: number;
  laneKeys: AuraLaneKeys;
}
export interface AuraOnboardingSkipDetail { token: number; seed: number }

export function canGuideAuraFirstBattle(data: MatchSceneData): boolean {
  return data.gameMode === 'aura' && data.vsAI !== false && data.cpuVsCpu !== true
    && !data.online && !data.auraChallenge;
}

export function isAuraOnboardingDetail(value: unknown): value is AuraOnboardingDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<AuraOnboardingDetail>;
  return Number.isSafeInteger(detail.token) && detail.token! > 0
    && Number.isInteger(detail.seed) && detail.seed! >= 0 && detail.seed! <= 0xffff_ffff
    && ['practice', 'battle', 'complete', 'skipped'].includes(String(detail.phase))
    && (detail.cue === null || ['controls', 'wait', 'hit', 'timing', 'score', 'rival', 'your-turn'].includes(String(detail.cue)))
    && (detail.practiceLane === null || Number.isInteger(detail.practiceLane) && detail.practiceLane! >= 0 && detail.practiceLane! < 4)
    && Number.isInteger(detail.completedLanes) && detail.completedLanes! >= 0 && detail.completedLanes! <= 4
    && Array.isArray(detail.laneKeys) && detail.laneKeys.length === 4 && detail.laneKeys.every(key => typeof key === 'string')
    && (detail.scoreDelta === undefined || Number.isFinite(detail.scoreDelta) && detail.scoreDelta > 0);
}

/** Four unscored notes wait at the real receptors. The real clock starts only
 * after the fourth deliberate hit, or an explicit skip. No timing/score rules
 * are relaxed once the actual match begins. */
export class AuraOnboarding {
  private state: AuraOnboardingSnapshot = { phase: 'practice', cue: 'controls', practiceLane: 0, completedLanes: 0 };
  private practiceElapsedMs = 0;
  private cueRemainingMs = 0;
  private explainedScore = false;
  private sawRivalTurn = false;
  private explainedReturn = false;

  get snapshot(): AuraOnboardingSnapshot { return { ...this.state }; }
  get practiceProgress(): number { return Math.min(1, this.practiceElapsedMs / AURA_PRACTICE_TRAVEL_MS); }

  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    if (this.state.phase === 'practice') {
      this.practiceElapsedMs = Math.min(AURA_PRACTICE_TRAVEL_MS, this.practiceElapsedMs + deltaMs);
      if (this.practiceProgress === 1) this.state.cue = 'hit';
    } else if (this.state.phase === 'battle' && this.cueRemainingMs > 0) {
      this.cueRemainingMs = Math.max(0, this.cueRemainingMs - deltaMs);
      if (this.cueRemainingMs === 0) {
        if (this.explainedReturn) this.complete();
        else this.state = { ...this.state, cue: null, scoreDelta: undefined };
      }
    }
  }

  practiceInput(lane: AuraLane): 'ignored' | 'wait' | 'hit' | 'start-battle' {
    if (this.state.phase !== 'practice' || lane !== this.state.practiceLane) return 'ignored';
    if (this.practiceProgress < 1) { this.state.cue = 'wait'; return 'wait'; }
    this.state.completedLanes += 1;
    if (this.state.completedLanes === 4) {
      this.state = { phase: 'battle', cue: 'timing', practiceLane: null, completedLanes: 4 };
      this.cueRemainingMs = 0; // Keep the timing hint through the real count-in.

      return 'start-battle';
    }
    this.practiceElapsedMs = 0;
    this.state = { ...this.state, practiceLane: this.state.completedLanes as AuraLane, cue: 'controls' };
    return 'hit';
  }

  judgement(judgement: Pick<AuraJudgement, 'slot' | 'grade' | 'scoreDelta'>, activeSlot: AuraSlot | null): void {
    if (this.state.phase !== 'battle' || this.explainedScore || judgement.slot !== 0 || activeSlot !== 0
      || !['perfect', 'great', 'good'].includes(judgement.grade) || !(judgement.scoreDelta > 0)) return;
    this.explainedScore = true;
    this.state = { ...this.state, cue: 'score', scoreDelta: judgement.scoreDelta };
    this.cueRemainingMs = 3_000;
  }

  turn(slot: AuraSlot): void {
    if (this.state.phase !== 'battle') return;
    if (slot === 1 && !this.sawRivalTurn) {
      this.sawRivalTurn = true;
      this.state = { ...this.state, cue: 'rival', scoreDelta: undefined };
      this.cueRemainingMs = 4_000;
    } else if (slot === 0 && this.sawRivalTurn && !this.explainedReturn) {
      this.explainedReturn = true;
      this.state = { ...this.state, cue: 'your-turn', scoreDelta: undefined };
      this.cueRemainingMs = 3_000;
    }
  }

  skip(): void {
    if (this.state.phase === 'complete' || this.state.phase === 'skipped') return;
    this.state = { ...this.state, phase: 'skipped', cue: null, practiceLane: null, scoreDelta: undefined };
  }

  complete(): void {
    if (this.state.phase !== 'battle') return;
    this.state = { ...this.state, phase: 'complete', cue: null, practiceLane: null, scoreDelta: undefined };
  }
}

declare global {
  interface WindowEventMap {
    [AURA_ONBOARDING_EVENT]: CustomEvent<AuraOnboardingDetail>;
    [AURA_ONBOARDING_SKIP_EVENT]: CustomEvent<AuraOnboardingSkipDetail>;
  }
}
