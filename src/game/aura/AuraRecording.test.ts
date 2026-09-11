import { describe, expect, it } from 'vitest';
import { buildMatchSeed, type AuraBattleCompleteDetail } from '../match/MatchConfig.ts';
import { AuraBattle, type AuraJudgement, type AuraPlayerScore } from './AuraBattle.ts';
import { createAuraChallenge, createAuraChallengeRoutine } from './AuraChallenge.ts';
import { createAuraChart } from './AuraChart.ts';
import { AURA_DIFFICULTIES } from './AuraConfig.ts';
import { AURA_TRACKS_GENERATED } from './aura-tracks.generated.ts';
import { getAuraTrack } from './AuraTracks.ts';
import {
  AuraRecorder, AURA_RECORDING_MAX_DURATION_MS, AURA_RECORDING_MAX_EVENTS,
  AURA_RECORDING_MAX_JSON_CHARACTERS, isValidAuraRecording, parseAuraRecording,
  type AuraRecording, type AuraRecordingConfig,
} from './AuraRecording.ts';

function config(): AuraRecordingConfig {
  const chart = createAuraChart(67, 'viral');
  return { engineVersion: 'aura-v1+20ca336', matchSeed: chart.seed, trackId: chart.trackId,
    difficulty: chart.difficulty, stageId: 'mars-incorporated', p1Name: 'Francisco', p2Name: 'Donald Trump',
    p1CloudFighterId: 'local-francisco', p2CloudFighterId: null, chart };
}

function passive(grade: 'mash' | 'wrong_turn' = 'mash'): AuraJudgement {
  return { grade, slot: 0, noteId: null, lane: 2, offsetMs: 0, scoreDelta: grade === 'mash' ? -100 : 0,
    score: 0, combo: 0 };
}

function score(value = 0): AuraPlayerScore {
  return { score: value, combo: 0, bestCombo: 0, perfect: 0, great: 0, good: 0, misses: 0, mashes: 0 };
}

function summary(): AuraBattleCompleteDetail {
  return { winnerSlot: 'draw', p1Name: 'Francisco', p2Name: 'Donald Trump', p1Score: score(), p2Score: score(),
    p1Rank: 'NPC', p2Rank: 'NPC', durationSeconds: 80, difficulty: 'viral',
    stageId: 'mars-incorporated', stageLabel: 'MARS INCORPORATED' };
}

function finalized(): AuraRecording {
  const recorder = new AuraRecorder(config());
  recorder.record(0, passive('wrong_turn'));
  recorder.record(100.125, passive());
  recorder.finish(summary());
  return recorder.toRecording();
}

describe('AuraRecorder immutable local event journal', () => {
  it('retains the actual bundled trial cast without inventing cloud identities', () => {
    const setup: AuraRecordingConfig = { ...config(), p1Name: 'DONALD TRUMP', p2Name: 'LAMINE YAMAL',
      p1CloudFighterId: null, p2CloudFighterId: null, auraTrialPreset: 'trump-lamine' };
    const recording = new AuraRecorder(setup).toRecording();
    expect(parseAuraRecording(JSON.stringify(recording))?.config).toEqual(setup);
    expect(() => new AuraRecorder({ ...setup, p1CloudFighterId: 'owned-player' })).toThrow();
    expect(parseAuraRecording(JSON.stringify({ ...recording,
      config: { ...setup, auraTrialPreset: 'unknown-cast' } }))).toBeNull();
  });

  it('retains all six grades with exact music times and same-time ordering, without deduplication', () => {
    const setup = config();
    const recorder = new AuraRecorder(setup);
    const battle = new AuraBattle(setup.chart);
    const events: AuraJudgement[] = [passive('wrong_turn'), passive(), passive()];
    for (const [index, grade] of (['perfect', 'great', 'good', 'miss'] as const).entries()) {
      events.push(battle.judgeNote(setup.chart.notes[index].id, grade, index + 0.125)!);
    }
    events.forEach(event => recorder.record(2_000.125, event));
    const saved = recorder.toRecording();
    expect(saved.events.map(event => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saved.events.map(event => event.atMs)).toEqual(Array(7).fill(2_000.125));
    expect(saved.events.map(event => event.judgement)).toEqual(events);
    expect(saved.events[1].judgement).toEqual(saved.events[2].judgement);
    expect(isValidAuraRecording(saved)).toBe(true);
  });

  it('does not hide duplicate note events: this journal records calls, not gameplay deduplication', () => {
    const setup = config();
    const recorder = new AuraRecorder(setup);
    const note = setup.chart.notes[0];
    const judgement = new AuraBattle(setup.chart).judgeNote(note.id, 'perfect', 2)!;
    recorder.record(note.atMs, judgement);
    recorder.record(note.atMs, judgement);
    expect(recorder.toRecording().events).toHaveLength(2);
    expect(recorder.toRecording().events.map(event => event.sequence)).toEqual([0, 1]);
  });

  it('copies config, chart, inputs, summaries and every exported snapshot defensively', () => {
    const setup = config();
    const untouchedConfig = JSON.parse(JSON.stringify(setup));
    const recorder = new AuraRecorder(setup);
    setup.p1Name = 'Changed';
    setup.chart.turns[0].notes[0].lane = 3;
    setup.chart.notes.length = 0;
    const event = passive();
    recorder.record(100, event);
    event.score = 999;
    const result = summary();
    recorder.finish(result);
    result.p1Score.score = 999;
    const copy = recorder.toRecording();
    expect(copy.config).toEqual(untouchedConfig);
    expect(copy.events[0].judgement.score).toBe(0);
    expect(copy.finalSummary?.p1Score.score).toBe(0);
    copy.config.chart.notes.length = 0;
    copy.events[0].atMs = 999;
    copy.events[0].judgement.score = 999;
    copy.events.push(copy.events[0]);
    copy.finalSummary!.p1Score.score = 999;
    const fresh = recorder.toRecording();
    expect(fresh.config).toEqual(untouchedConfig);
    expect(fresh.events).toHaveLength(1);
    expect(fresh.events[0]).toMatchObject({ atMs: 100, judgement: { score: 0 } });
    expect(fresh.finalSummary?.p1Score.score).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity, -1, 99.999, AURA_RECORDING_MAX_DURATION_MS + 1])(
    'rejects invalid/backwards event time %s without clamping or later claiming completeness', invalidTime => {
      const recorder = new AuraRecorder(config());
      recorder.record(100, passive());
      expect(() => recorder.record(invalidTime, passive())).toThrow('event.atMs');
      const saved = recorder.toRecording();
      expect(saved.events).toHaveLength(1);
      expect(saved.events[0].atMs).toBe(100);
      expect(saved).toMatchObject({ status: 'failed', failure: 'invalid-event', finalSummary: null });
      expect(() => recorder.record(101, passive())).toThrow('closed');
      expect(() => recorder.finish(summary())).toThrow('closed');
      expect(parseAuraRecording(JSON.stringify(saved))).toEqual(saved);
    },
  );

  it.each([
    { grade: 'unknown' }, { slot: 2 }, { lane: 4 }, { lane: 1.5 }, { offsetMs: NaN },
    { score: -1 }, { scoreDelta: Infinity }, { combo: 1.5 }, { noteId: 'not-a-chart-note' },
    { privatePhotoUrl: 'https://example.invalid/private' },
  ])('fails closed on malformed judgement %j', patch => {
    const recorder = new AuraRecorder(config());
    const malformed = { ...passive(), ...patch } as AuraJudgement;
    expect(() => recorder.record(0, malformed)).toThrow('Invalid Aura recording');
    expect(recorder.toRecording()).toMatchObject({ status: 'failed', failure: 'invalid-event', events: [] });
  });

  it('rejects note IDs, slots or lanes inconsistent with the exact chart snapshot', () => {
    for (const patch of [{ noteId: 'missing' }, { slot: 1 }, { lane: 9 }]) {
      const setup = config();
      const recorder = new AuraRecorder(setup);
      const event = new AuraBattle(setup.chart).judgeNote(setup.chart.notes[0].id, 'perfect')!;
      expect(() => recorder.record(0, { ...event, ...patch } as AuraJudgement)).toThrow();
    }
  });

  it('accepts exactly 10,000 events and the five-minute boundary, then fails rather than dropping one', () => {
    const recorder = new AuraRecorder(config());
    for (let index = 0; index < AURA_RECORDING_MAX_EVENTS; index++) {
      recorder.record(AURA_RECORDING_MAX_DURATION_MS, passive('wrong_turn'));
    }
    expect(recorder.toRecording().events.at(-1)?.sequence).toBe(AURA_RECORDING_MAX_EVENTS - 1);
    expect(() => recorder.record(AURA_RECORDING_MAX_DURATION_MS, passive())).toThrow('event limit');
    expect(recorder.toRecording()).toMatchObject({ status: 'failed', failure: 'event-limit' });
    expect(recorder.toRecording().events).toHaveLength(AURA_RECORDING_MAX_EVENTS);
    expect(() => recorder.finish(summary())).toThrow('closed');
  });

  it('excludes online room details and refuses recording or replacing a finalized summary', () => {
    const recorder = new AuraRecorder(config());
    const result = { ...summary(), online: { roomCode: 'ABC234', localSlot: 0 as const, matchSerial: 3, inputDelay: 2 } };
    recorder.finish(result);
    const saved = recorder.toRecording();
    expect(saved.finalSummary).toEqual(summary());
    expect(JSON.stringify(saved)).not.toContain('roomCode');
    expect(JSON.stringify(saved)).not.toContain('ABC234');
    expect(() => recorder.record(0, passive())).toThrow('closed');
    expect(() => recorder.finish(summary())).toThrow('closed');
    expect(recorder.toRecording()).toEqual(saved);
  });

  it('rejects invalid final metadata without mutating the existing journal', () => {
    const recorder = new AuraRecorder(config());
    recorder.record(0, passive());
    const before = recorder.toRecording();
    expect(() => recorder.finish({ ...summary(), p1Name: 'Wrong person' })).toThrow('identity');
    expect(recorder.toRecording()).toEqual(before);
    expect(() => recorder.finish({ ...summary(), durationSeconds: 301 })).toThrow('durationSeconds');
    expect(() => recorder.finish({ ...summary(), p1Score: { ...score(), score: Infinity } })).toThrow('score');
    recorder.finish(summary());
    expect(recorder.toRecording().status).toBe('complete');
  });

  it('keeps result sharing metadata outside the unchanged validated recording format', () => {
    const recorder = new AuraRecorder(config());
    const routine = createAuraChallengeRoutine(67, 'viral', config().trackId, 'mars-incorporated')!;
    recorder.finish({ ...summary(), challengeRoutine: routine, challengeShareSlots: [1],
      challenge: createAuraChallenge(routine, 'Chosen public name', 0, 1) });
    const saved = recorder.toRecording();
    expect(isValidAuraRecording(saved)).toBe(true);
    expect(saved.finalSummary).toEqual(summary());
    expect(JSON.stringify(saved)).not.toContain('Chosen public name');
  });
});

describe('Aura recording durable JSON validation', () => {
  it('accepts the actual Scene seed convention, including an explicit zero request', () => {
    for (const seed of [undefined, 0, 1, 0xffff_ffff]) {
      const matchSeed = buildMatchSeed({ gameMode: 'aura', seed, vsAI: true, cpuVsCpu: false,
        p1Name: 'Francisco', p2Name: 'Donald Trump' });
      const chart = createAuraChart(matchSeed, 'viral');
      expect(matchSeed).not.toBe(0);
      const recorder = new AuraRecorder({ ...config(), matchSeed, chart, trackId: chart.trackId });
      expect(recorder.toRecording().config.matchSeed).toBe(matchSeed);
      expect(recorder.toRecording().config.chart.seed).toBe(matchSeed);
    }
  });

  it('accepts exact real charts for every track/difficulty and boundary seeds without changing floating-point times', () => {
    for (const { id } of AURA_TRACKS_GENERATED) {
      const track = getAuraTrack(id)!;
      for (const { id: difficulty } of AURA_DIFFICULTIES) {
        for (const seed of [0, 1, 67, 0xffff_ffff]) {
          const chart = createAuraChart(seed, difficulty, track);
          const setup = { ...config(), chart, matchSeed: chart.seed, trackId: chart.trackId, difficulty };
          const recorder = new AuraRecorder(setup);
          const saved = recorder.toRecording();
          expect(saved.config.chart).toEqual(chart);
          expect(parseAuraRecording(JSON.stringify(saved))).toEqual(saved);
        }
      }
    }
  });

  it('round-trips active, failed and complete snapshots without storing references to parsed objects', () => {
    for (const recording of [new AuraRecorder(config()).toRecording(), finalized()]) {
      expect(isValidAuraRecording(recording)).toBe(true);
      expect(parseAuraRecording(JSON.stringify(recording))).toEqual(recording);
    }
  });

  it.each([
    (value: AuraRecording) => { value.version = 2 as 1; },
    (value: AuraRecording) => { value.events[0].sequence = 1; },
    (value: AuraRecording) => { value.events[1].sequence = 0; },
    (value: AuraRecording) => { value.events[1].atMs = -1; },
    (value: AuraRecording) => { value.events[0].atMs = 101; },
    (value: AuraRecording) => { value.events[0].judgement.grade = 'made_up' as 'miss'; },
    (value: AuraRecording) => { value.finalSummary = null; },
    (value: AuraRecording) => { value.failure = 'event-limit'; },
    (value: AuraRecording) => { value.status = 'failed'; },
    (value: AuraRecording) => { value.config.chart.seed = 1; },
    (value: AuraRecording) => { value.config.chart.trackId = 'different-track'; },
    (value: AuraRecording) => { value.config.chart.difficulty = 'lowkey'; },
    (value: AuraRecording) => { value.config.chart.notes[0].lane = 9 as 0; },
    (value: AuraRecording) => { value.config.chart.turns[0].notes[0].atMs += 1; },
    (value: AuraRecording) => { value.config.chart.notes.push(value.config.chart.notes[0]); },
    (value: AuraRecording) => { value.config.chart.turns[1].startMs = 0; },
    (value: AuraRecording) => { value.config.chart.durationMs = 300_001; },
    (value: AuraRecording) => { value.config.p1Name = 'x'.repeat(121); },
    (value: AuraRecording) => { value.config.engineVersion = ''; },
    (value: AuraRecording) => { value.config.p1CloudFighterId = 'https://example.invalid/photo'; },
    (value: AuraRecording) => { Object.assign(value.config, { originalPhotoHash: 'private' }); },
    (value: AuraRecording) => { Object.assign(value.finalSummary!, { online: { roomCode: 'ABC234' } }); },
  ])('rejects corrupted or privacy-expanding serialized data %#', corrupt => {
    const recording = finalized();
    corrupt(recording);
    expect(isValidAuraRecording(recording)).toBe(false);
    expect(parseAuraRecording(JSON.stringify(recording))).toBeNull();
  });

  it('rejects oversized JSON, missing fields, prototypes and non-JSON numeric values', () => {
    expect(parseAuraRecording('x'.repeat(AURA_RECORDING_MAX_JSON_CHARACTERS + 1))).toBeNull();
    for (const json of ['{', 'null', '[]', '{}', '{"version":1}', '{"__proto__":{}}']) {
      expect(parseAuraRecording(json)).toBeNull();
    }
    const recording = finalized();
    recording.events[0].atMs = NaN;
    expect(isValidAuraRecording(recording)).toBe(false);
    expect(parseAuraRecording(JSON.stringify(recording))).toBeNull();
    expect(isValidAuraRecording(Object.create(finalized()))).toBe(false);
  });

  it('bounds serialized arrays even when their elements would be valid individually', () => {
    const recording = finalized();
    recording.events = Array.from({ length: AURA_RECORDING_MAX_EVENTS + 1 }, (_, sequence) => ({
      atMs: 0, sequence, judgement: passive(),
    }));
    expect(isValidAuraRecording(recording)).toBe(false);
    const setup = config();
    setup.chart.turns = Array(129).fill(setup.chart.turns[0]);
    expect(() => new AuraRecorder(setup)).toThrow();
  });
});
