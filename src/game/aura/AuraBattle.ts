import { SeededRng } from '../utils/SeededRng.ts';
import { getAuraDifficulty, type AuraDifficultyId } from './AuraConfig.ts';
import { auraTurnAt, type AuraChart, type AuraLane, type AuraNote, type AuraSlot } from './AuraChart.ts';

export type AuraGrade = 'perfect' | 'great' | 'good' | 'miss' | 'mash' | 'wrong_turn';

export interface AuraJudgement {
  grade: AuraGrade;
  slot: AuraSlot;
  noteId: string | null;
  lane: AuraLane;
  offsetMs: number;
  scoreDelta: number;
  score: number;
  combo: number;
}

export interface AuraPlayerScore {
  score: number;
  combo: number;
  bestCombo: number;
  perfect: number;
  great: number;
  good: number;
  misses: number;
  mashes: number;
}

export interface AuraCpuHit {
  noteId: string;
  atMs: number;
  grade: Exclude<AuraGrade, 'mash' | 'wrong_turn'>;
  offsetMs: number;
}

const SCORE_BY_GRADE: Record<Exclude<AuraGrade, 'wrong_turn'>, number> = {
  perfect: 1_000,
  great: 650,
  good: 350,
  miss: -250,
  mash: -100,
};

function blankScore(): AuraPlayerScore {
  return {
    score: 0,
    combo: 0,
    bestCombo: 0,
    perfect: 0,
    great: 0,
    good: 0,
    misses: 0,
    mashes: 0,
  };
}

function copyScore(score: AuraPlayerScore): AuraPlayerScore {
  return { ...score };
}

export class AuraBattle {
  readonly chart: AuraChart;
  readonly difficultyId: AuraDifficultyId;
  private readonly scores: [AuraPlayerScore, AuraPlayerScore] = [blankScore(), blankScore()];
  private readonly judged = new Map<string, AuraGrade>();

  constructor(chart: AuraChart, difficultyId: AuraDifficultyId = chart.difficulty) {
    this.chart = chart;
    this.difficultyId = difficultyId;
  }

  scoreFor(slot: AuraSlot): AuraPlayerScore {
    return copyScore(this.scores[slot]);
  }

  isJudged(noteId: string): boolean {
    return this.judged.has(noteId);
  }

  judgeInput(slot: AuraSlot, lane: AuraLane, nowMs: number): AuraJudgement {
    const difficulty = getAuraDifficulty(this.difficultyId);
    const activeTurn = auraTurnAt(this.chart, nowMs);
    if (!activeTurn || activeTurn.slot !== slot) {
      return this.makePassiveJudgement('wrong_turn', slot, lane);
    }

    const candidates = activeTurn.notes
      .filter((note) => !this.judged.has(note.id) && note.lane === lane)
      .map((note) => ({ note, offset: nowMs - note.atMs }))
      .filter(({ offset }) => Math.abs(offset) <= difficulty.goodWindowMs)
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
    const nearest = candidates[0];
    if (!nearest) return this.applyGrade(slot, lane, 'mash', null, 0);

    const absoluteOffset = Math.abs(nearest.offset);
    const grade: AuraGrade = absoluteOffset <= difficulty.perfectWindowMs
      ? 'perfect'
      : absoluteOffset <= difficulty.greatWindowMs
        ? 'great'
        : 'good';
    return this.applyGrade(slot, lane, grade, nearest.note, nearest.offset);
  }

  /** Apply CPU or network-authoritative note results without judging a clock twice. */
  judgeNote(
    noteId: string,
    grade: Exclude<AuraGrade, 'mash' | 'wrong_turn'>,
    offsetMs = 0,
  ): AuraJudgement | null {
    const note = this.chart.notes.find((entry) => entry.id === noteId);
    if (!note || this.judged.has(note.id)) return null;
    return this.applyGrade(note.slot, note.lane, grade, note, offsetMs);
  }

  collectMisses(nowMs: number, slots: readonly AuraSlot[] = [0, 1]): AuraJudgement[] {
    const difficulty = getAuraDifficulty(this.difficultyId);
    const controlled = new Set<AuraSlot>(slots);
    const missed: AuraJudgement[] = [];
    for (const note of this.chart.notes) {
      if (!controlled.has(note.slot) || this.judged.has(note.id)) continue;
      if (nowMs <= note.atMs + difficulty.goodWindowMs) continue;
      missed.push(this.applyGrade(note.slot, note.lane, 'miss', note, nowMs - note.atMs));
    }
    return missed;
  }

  winner(): AuraSlot | null {
    if (this.scores[0].score === this.scores[1].score) return null;
    return this.scores[0].score > this.scores[1].score ? 0 : 1;
  }

  private makePassiveJudgement(
    grade: 'wrong_turn',
    slot: AuraSlot,
    lane: AuraLane,
  ): AuraJudgement {
    const score = this.scores[slot];
    return {
      grade,
      slot,
      noteId: null,
      lane,
      offsetMs: 0,
      scoreDelta: 0,
      score: score.score,
      combo: score.combo,
    };
  }

  private applyGrade(
    slot: AuraSlot,
    lane: AuraLane,
    grade: Exclude<AuraGrade, 'wrong_turn'>,
    note: AuraNote | null,
    offsetMs: number,
  ): AuraJudgement {
    if (note) this.judged.set(note.id, grade);
    const score = this.scores[slot];
    const hit = grade === 'perfect' || grade === 'great' || grade === 'good';
    if (hit) {
      score.combo += 1;
      score.bestCombo = Math.max(score.bestCombo, score.combo);
      score[grade] += 1;
    } else {
      score.combo = 0;
      if (grade === 'miss') score.misses += 1;
      if (grade === 'mash') score.mashes += 1;
    }
    const comboBonus = hit ? Math.min(20, Math.max(0, score.combo - 1)) * 25 : 0;
    const scoreDelta = SCORE_BY_GRADE[grade] + comboBonus;
    score.score = Math.max(0, score.score + scoreDelta);
    return {
      grade,
      slot,
      noteId: note?.id ?? null,
      lane,
      offsetMs,
      scoreDelta,
      score: score.score,
      combo: score.combo,
    };
  }
}

export function createAuraCpuPlan(
  chart: AuraChart,
  slot: AuraSlot,
  difficultyId: AuraDifficultyId = chart.difficulty,
  seed = chart.seed,
): AuraCpuHit[] {
  const difficulty = getAuraDifficulty(difficultyId);
  const rng = new SeededRng((seed ^ (slot ? 0x43505532 : 0x43505531)) >>> 0);
  return chart.notes.filter((note) => note.slot === slot).map((note) => {
    const roll = rng.next();
    let grade: AuraCpuHit['grade'];
    if (roll < difficulty.cpuPerfectChance) grade = 'perfect';
    else if (roll < difficulty.cpuPerfectChance + difficulty.cpuGreatChance) grade = 'great';
    else if (roll < difficulty.cpuPerfectChance + difficulty.cpuGreatChance + difficulty.cpuGoodChance) grade = 'good';
    else grade = 'miss';

    const sign = rng.next() < 0.5 ? -1 : 1;
    const magnitude = grade === 'perfect'
      ? rng.next() * difficulty.perfectWindowMs * 0.82
      : grade === 'great'
        ? difficulty.perfectWindowMs + rng.next() * (difficulty.greatWindowMs - difficulty.perfectWindowMs)
        : grade === 'good'
          ? difficulty.greatWindowMs + rng.next() * (difficulty.goodWindowMs - difficulty.greatWindowMs)
          : difficulty.goodWindowMs + 1;
    const offsetMs = grade === 'miss' ? difficulty.goodWindowMs + 1 : Math.round(sign * magnitude);
    return {
      noteId: note.id,
      atMs: note.atMs + Math.max(-difficulty.goodWindowMs, offsetMs),
      grade,
      offsetMs,
    };
  });
}

export function auraAccuracy(score: AuraPlayerScore): number {
  const total = score.perfect + score.great + score.good + score.misses;
  if (total === 0) return 0;
  const weighted = score.perfect + score.great * 0.72 + score.good * 0.42;
  return weighted / total;
}

export function auraRank(score: AuraPlayerScore): 'S' | 'A' | 'B' | 'C' | 'NPC' {
  const accuracy = auraAccuracy(score);
  if (accuracy >= 0.9 && score.mashes <= 1) return 'S';
  if (accuracy >= 0.78) return 'A';
  if (accuracy >= 0.62) return 'B';
  if (accuracy >= 0.44) return 'C';
  return 'NPC';
}
