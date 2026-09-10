import type { AuraBattleCompleteDetail } from '../match/MatchConfig.ts';
import type { StageThemeId } from '../match/StageConfig.ts';
import type { AuraJudgement, AuraPlayerScore } from './AuraBattle.ts';
import type { AuraChart, AuraNote } from './AuraChart.ts';
import type { AuraDifficultyId } from './AuraConfig.ts';

export const AURA_RECORDING_VERSION = 1;
export const AURA_RECORDING_MAX_DURATION_MS = 300_000;
export const AURA_RECORDING_MAX_EVENTS = 10_000;
export const AURA_RECORDING_MAX_JSON_CHARACTERS = 8_000_000;
const MAX_NOTES = 2_000;
const MAX_TURNS = 128;
const MAX_SCORE = 2_147_483_647;

/** Only public identifiers, never source-photo hashes, URLs or room credentials.
 * The actual chart is retained: a seed alone does not pin future chart rules.
 * engineVersion must identify the producer's rules/presentation implementation.
 * Asset bytes and a replay player are deliberately outside this core format. */
export interface AuraRecordingConfig {
  engineVersion: string;
  matchSeed: number;
  trackId: string;
  difficulty: AuraDifficultyId;
  stageId: StageThemeId;
  p1Name: string;
  p2Name: string;
  p1CloudFighterId?: string | null;
  p2CloudFighterId?: string | null;
  chart: AuraChart;
}

export interface AuraRecordedEvent {
  /** Exact local presentation music-clock time, not note time or arrival wall time. */
  atMs: number;
  /** Zero-based order, including multiple events at the same clock instant. */
  sequence: number;
  judgement: AuraJudgement;
}

export type AuraRecordingSummary = Omit<AuraBattleCompleteDetail, 'online' | 'challengeRoutine' | 'challengeShareSlots' | 'challenge'>;
export type AuraRecordingFailure = 'invalid-event' | 'event-limit';

/** Complete means this local presentation session was finalized, not that
 * server verification, remote raw-input capture, or visual replay exists. */
export interface AuraRecording {
  version: typeof AURA_RECORDING_VERSION;
  status: 'recording' | 'complete' | 'failed';
  config: AuraRecordingConfig;
  events: AuraRecordedEvent[];
  finalSummary: AuraRecordingSummary | null;
  failure: AuraRecordingFailure | null;
}

function requireValue(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid Aura recording: ${field}`);
}

function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null, field);
  const result = value as Record<string, unknown>;
  requireValue(Object.keys(result).every(key => keys.includes(key)), `${field}.fields`);
  return result;
}

function number(value: unknown, min: number, max: number, field: string, integer = false): asserts value is number {
  requireValue(typeof value === 'number' && Number.isFinite(value)
    && value >= min && value <= max && (!integer || Number.isSafeInteger(value)), field);
}

function text(value: unknown, max: number, field: string): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value), field);
}

function identifier(value: unknown, field: string): asserts value is string {
  text(value, 160, field);
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_.:+-]*$/.test(value), field);
}

function difficulty(value: unknown, field: string): void {
  requireValue(value === 'lowkey' || value === 'viral' || value === 'untouchable', field);
}

function array(value: unknown, max: number, field: string): asserts value is unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, field);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateNote(value: unknown, field: string, durationMs: number): asserts value is AuraNote {
  const note = object(value, ['id', 'turnIndex', 'slot', 'lane', 'beat', 'atMs'], field);
  identifier(note.id, `${field}.id`);
  number(note.turnIndex, 0, MAX_TURNS - 1, `${field}.turnIndex`, true);
  number(note.slot, 0, 1, `${field}.slot`, true);
  number(note.lane, 0, 3, `${field}.lane`, true);
  number(note.beat, 0, 100_000, `${field}.beat`);
  number(note.atMs, 0, durationMs, `${field}.atMs`);
}

function sameNote(left: AuraNote, right: AuraNote): boolean {
  return left.id === right.id && left.turnIndex === right.turnIndex && left.slot === right.slot
    && left.lane === right.lane && left.beat === right.beat && left.atMs === right.atMs;
}

function validateConfig(value: unknown): asserts value is AuraRecordingConfig {
  const config = object(value, ['engineVersion', 'matchSeed', 'trackId', 'difficulty', 'stageId',
    'p1Name', 'p2Name', 'p1CloudFighterId', 'p2CloudFighterId', 'chart'], 'config');
  identifier(config.engineVersion, 'config.engineVersion');
  number(config.matchSeed, 0, 0xffff_ffff, 'config.matchSeed', true);
  identifier(config.trackId, 'config.trackId');
  identifier(config.stageId, 'config.stageId');
  difficulty(config.difficulty, 'config.difficulty');
  text(config.p1Name, 120, 'config.p1Name');
  text(config.p2Name, 120, 'config.p2Name');
  for (const key of ['p1CloudFighterId', 'p2CloudFighterId']) {
    if (config[key] !== undefined && config[key] !== null) identifier(config[key], `config.${key}`);
  }
  const chart = object(config.chart, ['seed', 'difficulty', 'trackId', 'bpm', 'beatMs', 'beatOffsetMs',
    'noteTravelMs', 'firstTurnMs', 'durationMs', 'turns', 'notes'], 'config.chart');
  requireValue(chart.seed === config.matchSeed && chart.trackId === config.trackId
    && chart.difficulty === config.difficulty, 'config.chart.identity');
  number(chart.bpm, 1, 1_000, 'config.chart.bpm');
  number(chart.beatMs, 1, AURA_RECORDING_MAX_DURATION_MS, 'config.chart.beatMs');
  number(chart.durationMs, 1, AURA_RECORDING_MAX_DURATION_MS, 'config.chart.durationMs');
  number(chart.beatOffsetMs, 0, chart.durationMs, 'config.chart.beatOffsetMs');
  number(chart.noteTravelMs, 1, chart.durationMs, 'config.chart.noteTravelMs');
  number(chart.firstTurnMs, 0, chart.durationMs, 'config.chart.firstTurnMs');
  array(chart.notes, MAX_NOTES, 'config.chart.notes');
  array(chart.turns, MAX_TURNS, 'config.chart.turns');
  requireValue(chart.turns.length > 0, 'config.chart.turns.empty');
  const notes = chart.notes;
  const noteIds = new Set<string>();
  let previousNoteAt = -1;
  for (const note of notes) {
    validateNote(note, 'config.chart.note', chart.durationMs);
    requireValue(!noteIds.has(note.id) && note.atMs >= previousNoteAt, 'config.chart.notes.order');
    noteIds.add(note.id);
    previousNoteAt = note.atMs;
  }
  let noteIndex = 0;
  let previousEnd = -1;
  for (const [index, value] of chart.turns.entries()) {
    const turn = object(value, ['index', 'round', 'slot', 'startMs', 'firstNoteMs', 'endMs', 'notes'], 'config.chart.turn');
    requireValue(turn.index === index, 'config.chart.turn.index');
    number(turn.round, 0, MAX_TURNS - 1, 'config.chart.turn.round', true);
    number(turn.slot, 0, 1, 'config.chart.turn.slot', true);
    // Adjacent times use different floating-point arithmetic in createAuraChart
    // (index * duration versus previousStart + duration). Preserve both exact
    // values; tolerate sub-microsecond roundoff only when validating adjacency.
    number(turn.startMs, Math.max(0, previousEnd - 0.000_001), chart.durationMs, 'config.chart.turn.startMs');
    number(turn.endMs, turn.startMs, chart.durationMs, 'config.chart.turn.endMs');
    number(turn.firstNoteMs, turn.startMs, turn.endMs, 'config.chart.turn.firstNoteMs');
    array(turn.notes, MAX_NOTES, 'config.chart.turn.notes');
    for (const note of turn.notes) {
      validateNote(note, 'config.chart.turn.note', chart.durationMs);
      requireValue(note.turnIndex === index && note.slot === turn.slot
        && note.atMs >= turn.firstNoteMs && note.atMs <= turn.endMs, 'config.chart.turn.note.bounds');
      const flat = notes[noteIndex++];
      requireValue(flat !== undefined && sameNote(note, flat as AuraNote), 'config.chart.notes.snapshot');
    }
    previousEnd = turn.endMs;
  }
  requireValue(noteIndex === notes.length, 'config.chart.notes.snapshot');
}

function validateJudgement(value: unknown, notes: Map<string, AuraNote>): asserts value is AuraJudgement {
  const judgement = object(value, ['grade', 'slot', 'noteId', 'lane', 'offsetMs', 'scoreDelta', 'score', 'combo'], 'judgement');
  requireValue(['perfect', 'great', 'good', 'miss', 'mash', 'wrong_turn'].includes(judgement.grade as string), 'judgement.grade');
  number(judgement.slot, 0, 1, 'judgement.slot', true);
  number(judgement.lane, 0, 3, 'judgement.lane', true);
  number(judgement.offsetMs, -AURA_RECORDING_MAX_DURATION_MS, AURA_RECORDING_MAX_DURATION_MS, 'judgement.offsetMs');
  number(judgement.scoreDelta, -MAX_SCORE, MAX_SCORE, 'judgement.scoreDelta', true);
  number(judgement.score, 0, MAX_SCORE, 'judgement.score', true);
  number(judgement.combo, 0, AURA_RECORDING_MAX_EVENTS, 'judgement.combo', true);
  if (judgement.grade === 'mash' || judgement.grade === 'wrong_turn') {
    requireValue(judgement.noteId === null, 'judgement.noteId');
  } else {
    identifier(judgement.noteId, 'judgement.noteId');
    const note = notes.get(judgement.noteId);
    requireValue(note && note.slot === judgement.slot && note.lane === judgement.lane, 'judgement.note');
  }
}

function validateScore(value: unknown, field: string): asserts value is AuraPlayerScore {
  const score = object(value, ['score', 'combo', 'bestCombo', 'perfect', 'great', 'good', 'misses', 'mashes'], field);
  number(score.score, 0, MAX_SCORE, `${field}.score`, true);
  for (const key of ['combo', 'bestCombo', 'perfect', 'great', 'good', 'misses', 'mashes']) {
    number(score[key], 0, AURA_RECORDING_MAX_EVENTS, `${field}.${key}`, true);
  }
  requireValue((score.bestCombo as number) >= (score.combo as number), `${field}.bestCombo`);
}

function validateSummary(value: unknown, config: AuraRecordingConfig): asserts value is AuraRecordingSummary {
  const summary = object(value, ['winnerSlot', 'p1Name', 'p2Name', 'p1Score', 'p2Score', 'p1Rank', 'p2Rank',
    'durationSeconds', 'difficulty', 'stageId', 'stageLabel'], 'finalSummary');
  requireValue(['p1', 'p2', 'draw'].includes(summary.winnerSlot as string), 'finalSummary.winnerSlot');
  requireValue(summary.p1Name === config.p1Name && summary.p2Name === config.p2Name
    && summary.difficulty === config.difficulty && summary.stageId === config.stageId, 'finalSummary.identity');
  validateScore(summary.p1Score, 'finalSummary.p1Score');
  validateScore(summary.p2Score, 'finalSummary.p2Score');
  for (const key of ['p1Rank', 'p2Rank']) {
    requireValue(['S', 'A', 'B', 'C', 'NPC'].includes(summary[key] as string), `finalSummary.${key}`);
  }
  number(summary.durationSeconds, 0, AURA_RECORDING_MAX_DURATION_MS / 1_000, 'finalSummary.durationSeconds');
  text(summary.stageLabel, 120, 'finalSummary.stageLabel');
}

function validateRecording(value: unknown): asserts value is AuraRecording {
  const recording = object(value, ['version', 'status', 'config', 'events', 'finalSummary', 'failure'], 'recording');
  requireValue(recording.version === AURA_RECORDING_VERSION, 'version');
  requireValue(['recording', 'complete', 'failed'].includes(recording.status as string), 'status');
  validateConfig(recording.config);
  array(recording.events, AURA_RECORDING_MAX_EVENTS, 'events');
  const notes = new Map(recording.config.chart.notes.map(note => [note.id, note]));
  let previousAt = 0;
  for (const [sequence, value] of recording.events.entries()) {
    const event = object(value, ['atMs', 'sequence', 'judgement'], 'event');
    requireValue(event.sequence === sequence, 'event.sequence');
    number(event.atMs, previousAt, AURA_RECORDING_MAX_DURATION_MS, 'event.atMs');
    validateJudgement(event.judgement, notes);
    previousAt = event.atMs;
  }
  if (recording.status === 'complete') validateSummary(recording.finalSummary, recording.config);
  else requireValue(recording.finalSummary === null, 'finalSummary');
  if (recording.status === 'failed') {
    requireValue(recording.failure === 'invalid-event' || recording.failure === 'event-limit', 'failure');
  } else requireValue(recording.failure === null, 'failure');
}

export function isValidAuraRecording(value: unknown): value is AuraRecording {
  try { validateRecording(value); return true; } catch { return false; }
}

/** Invalid, oversized, future-version or corrupted durable JSON is refused. */
export function parseAuraRecording(json: string): AuraRecording | null {
  if (typeof json !== 'string' || json.length > AURA_RECORDING_MAX_JSON_CHARACTERS) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isValidAuraRecording(value) ? clone(value) : null;
  } catch { return null; }
}

/** Pure local event journal. It has no clocks, browser storage or network.
 * Every invocation is retained, even identical same-time judgements: input
 * deduplication belongs upstream, never in an evidentiary event recording. */
export class AuraRecorder {
  private readonly recording: AuraRecording;
  private readonly notes: Map<string, AuraNote>;

  constructor(config: AuraRecordingConfig) {
    validateConfig(config);
    this.recording = { version: AURA_RECORDING_VERSION, status: 'recording', config: clone(config),
      events: [], finalSummary: null, failure: null };
    this.notes = new Map(this.recording.config.chart.notes.map(note => [note.id, note]));
  }

  record(atMs: number, judgement: AuraJudgement): void {
    requireValue(this.recording.status === 'recording', 'recorder.closed');
    if (this.recording.events.length >= AURA_RECORDING_MAX_EVENTS) {
      this.recording.status = 'failed';
      this.recording.failure = 'event-limit';
      throw new Error('Invalid Aura recording: event limit');
    }
    try {
      number(atMs, this.recording.events.at(-1)?.atMs ?? 0, AURA_RECORDING_MAX_DURATION_MS, 'event.atMs');
      validateJudgement(judgement, this.notes);
      this.recording.events.push({ atMs, sequence: this.recording.events.length, judgement: clone(judgement) });
    } catch (error) {
      // A caller catching this cannot later label the truncated journal complete.
      this.recording.status = 'failed';
      this.recording.failure = 'invalid-event';
      throw error;
    }
  }

  finish(summary: AuraBattleCompleteDetail): void {
    requireValue(this.recording.status === 'recording', 'recorder.closed');
    // Live summary includes optional room/seat metadata. It is never exported.
    const { online: _online, challengeRoutine: _routine, challengeShareSlots: _slots,
      challenge: _challenge, ...publicSummary } = summary;
    validateSummary(publicSummary, this.recording.config);
    this.recording.finalSummary = clone(publicSummary);
    this.recording.status = 'complete';
  }

  toRecording(): AuraRecording { return clone(this.recording); }
}
