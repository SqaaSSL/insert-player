import { describe, expect, it } from 'vitest';
import {
  AURA_CHALLENGE_MAX_TOKEN_LENGTH, auraChallengeUrl, buildAuraChallengeMatch, cleanAuraChallengeName,
  compareAuraChallenge, createAuraChallenge, createAuraChallengeRoutine, decodeAuraChallenge,
  encodeAuraChallenge, isValidAuraChallengeMatch, maxAuraChallengeScore, validateAuraChallenge,
} from './AuraChallenge.ts';
import { createAuraChart } from './AuraChart.ts';
import { AuraBattle } from './AuraBattle.ts';
import { DEFAULT_AURA_TRACK, getAuraTrack } from './AuraTracks.ts';
import { isValidStoredMatchData } from '../../ui/shared/storedMatch.ts';

function routine(seed = 1234) {
  return createAuraChallengeRoutine(seed, 'viral', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!;
}
function tokenForUnknown(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('asynchronous Aura challenge journey', () => {
  it('replays new Aura Plaza challenges and keeps older stages intact', () => {
    for (const stageId of ['aura-plaza-v3', 'aura-plaza-v2', 'aura-plaza', 'insert-player-arena'] as const) {
      const original = createAuraChallengeRoutine(1234, 'viral', DEFAULT_AURA_TRACK.id, stageId)!;
      expect(original).not.toBeNull();
      const challenge = createAuraChallenge(original, 'Player', 500);
      const decoded = decodeAuraChallenge(encodeAuraChallenge(challenge));
      expect(decoded).toEqual({ ok: true, challenge });
      const match = buildAuraChallengeMatch(challenge);
      expect(match.stageId).toBe(stageId);
      expect(isValidStoredMatchData(match)).toBe(true);
      if (stageId === 'aura-plaza') {
        expect(challenge.stageVersion).toBe('ad789a08901cdad0c068f22559acdecf7f9fb31378413761b0090f07f9b8ceda');
      }
      if (stageId === 'aura-plaza-v2') {
        expect(challenge.stageVersion).toBe('365e72a1ea1808a08f06ea5d2de2e2afc8536620356355ee4f2fe08fc98b4fbb');
      }
    }
  });

  it.each([0, 1] as const)('replays human slot %i at the same music times and sends a higher score back', slot => {
    const original = routine();
    const chart = createAuraChart(original.seed, original.difficulty, getAuraTrack(original.trackId)!);
    const sender = new AuraBattle(chart);
    for (const note of chart.notes) if (note.slot === slot) sender.judgeNote(note.id, 'great');
    const challenge = createAuraChallenge(original, 'Rosalía 🎵', sender.scoreFor(slot).score, slot);
    const url = auraChallengeUrl(challenge, 'https://insertplayer.ai/fight?private=secret');
    const token = new URL(url).searchParams.get('challenge');
    const received = decodeAuraChallenge(token);
    expect(received.ok).toBe(true);
    if (!received.ok) throw new Error('Expected playable challenge');
    expect(url.length).toBeLessThan(1_500);
    expect(new URL(url).pathname).toBe('/challenge');
    expect(url).not.toContain('secret');
    const match = buildAuraChallengeMatch(received.challenge);
    expect(isValidStoredMatchData(match)).toBe(true);
    expect(match).toMatchObject({ p1Name: slot === 0 ? 'NOVA' : 'BYTE', p2Name: slot === 1 ? 'NOVA' : 'BYTE', vsAI: true, cpuVsCpu: false });
    expect(match.auraChallenge?.slot).toBe(slot);
    expect(match).not.toHaveProperty('online');
    expect(match).not.toHaveProperty('p1PhotoHash');
    expect(match).not.toHaveProperty('p1CloudFighterId');
    const recipientChart = createAuraChart(match.seed!, match.auraDifficulty!, getAuraTrack(match.auraTrackId)!);
    expect(recipientChart).toEqual(chart);
    const recipient = new AuraBattle(recipientChart);
    for (const note of recipientChart.notes) if (note.slot === slot) recipient.judgeNote(note.id, 'perfect');
    const score = recipient.scoreFor(slot).score;
    expect(compareAuraChallenge(received.challenge, score).outcome).toBe('won');
    const response = createAuraChallenge(original, 'Sam', score, slot);
    const returned = decodeAuraChallenge(encodeAuraChallenge(response));
    expect(returned).toEqual({ ok: true, challenge: response });
    expect(response.chartId).toBe(challenge.chartId);
    expect(response.score).toBeGreaterThan(challenge.score);
  });

  it.each(['rules', 'chartId', 'trackVersion', 'stageVersion'] as const)('rejects an old or different %s instead of silently substituting', field => {
    const challenge = createAuraChallenge(routine(), 'Player', 10_000);
    const result = decodeAuraChallenge(tokenForUnknown({ ...challenge, [field]: 'old-revision' }));
    expect(result).toEqual({ ok: false, error: 'incompatible' });
  });

  it('rejects future schemas, unknown tracks/stages, malformed numbers and impossible scores', () => {
    const challenge = createAuraChallenge(routine(), 'Player', 10_000);
    for (const mutation of [{ version: 2 }, { seed: -1 }, { seed: 1.5 }, { seed: 0x1_0000_0000 },
      { slot: 2 }, { slot: '1' }, { difficulty: 'easy' }, { trackId: 'https://untrusted.invalid/audio.mp3' }, { stageId: 'private-photo' },
      { trackId: { toString: null } }, { score: -1 }, { score: 4.5 }, { score: maxAuraChallengeScore(challenge) + 1 }]) {
      expect(validateAuraChallenge({ ...challenge, ...mutation }).ok).toBe(false);
    }
    expect(decodeAuraChallenge('')).toEqual({ ok: false, error: 'invalid' });
    expect(decodeAuraChallenge('a'.repeat(AURA_CHALLENGE_MAX_TOKEN_LENGTH + 1)).ok).toBe(false);
    expect(decodeAuraChallenge('@@@').ok).toBe(false);
    expect(decodeAuraChallenge(tokenForUnknown({ name: 'Player' })).ok).toBe(false);
  });

  it('refuses private fields and control characters instead of exporting them', () => {
    const challenge = createAuraChallenge(routine(), 'Player', 10_000);
    for (const field of ['photoHash', 'p1CloudFighterId', 'token', 'url', 'online', 'video']) {
      expect(decodeAuraChallenge(tokenForUnknown({ ...challenge, [field]: 'private-value' })).ok).toBe(false);
    }
    expect(validateAuraChallenge({ ...challenge, name: 'Hidden\u202eName' }).ok).toBe(false);
    expect(validateAuraChallenge({ ...challenge, name: '  ' }).ok).toBe(false);
    const unicode = createAuraChallenge(routine(), '🎵'.repeat(40), 0);
    expect(decodeAuraChallenge(encodeAuraChallenge(unicode))).toEqual({ ok: true, challenge: unicode });
    expect(cleanAuraChallengeName('\ud800Player')).toBe('Player');
  });

  it('never converts a social target into a different routine, CPU-only or live online match', () => {
    const match = buildAuraChallengeMatch(createAuraChallenge(routine(), 'Player', 5_000));
    for (const mutation of [{ seed: 555 }, { auraDifficulty: 'lowkey' }, { auraTrackId: 'elsewhere' },
      { stageId: 'side-street' }, { cpuVsCpu: true }, { vsAI: false }, { gameMode: 'fight' },
      { customStageKey: 'private-stage' }, { online: { localSlot: 0 } }]) {
      const changed = { ...match, ...mutation };
      expect(isValidAuraChallengeMatch(changed as typeof match)).toBe(false);
      expect(isValidStoredMatchData(changed)).toBe(false);
    }
    expect(compareAuraChallenge(match.auraChallenge!, 5_000).outcome).toBe('tied');
    expect(compareAuraChallenge(match.auraChallenge!, 4_000)).toEqual({ outcome: 'lost', difference: -1_000 });
  });
});
