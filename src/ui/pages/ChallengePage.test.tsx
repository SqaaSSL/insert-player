import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChallengePage } from './ChallengePage.tsx';
import { ChallengesPage } from './ChallengesPage.tsx';
import { AuraBattleResults } from '../components/AuraBattleResults.tsx';
import { createAuraChallenge, createAuraChallengeRoutine, encodeAuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';
import { AuraBattle } from '../../game/aura/AuraBattle.ts';
import { createAuraChart } from '../../game/aura/AuraChart.ts';
import type { AuraBattleCompleteDetail } from '../../game/match/MatchConfig.ts';

const routine = createAuraChallengeRoutine(34, 'lowkey', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!;
const challenge = createAuraChallenge(routine, 'Alex', 1_000);
const score = new AuraBattle(createAuraChart(34, 'lowkey', DEFAULT_AURA_TRACK)).scoreFor(0);
const summary: AuraBattleCompleteDetail = {
  winnerSlot: 'p2', p1Name: 'NOVA', p2Name: 'BYTE', p1Score: { ...score, score: 1_200 },
  p2Score: { ...score, score: 2_000 }, p1Rank: 'C', p2Rank: 'A', durationSeconds: 52,
  difficulty: 'lowkey', stageId: 'insert-player-arena', stageLabel: 'INSERT PLAYER ARENA',
  challengeRoutine: routine, challengeShareSlots: [0], challenge,
};

describe('Aura challenge entry and result surfaces', () => {
  it('shows the actual target, exact level, short format and a playable guest action', () => {
    const markup = renderToStaticMarkup(<ChallengePage token={encodeAuraChallenge(challenge)} onPlay={vi.fn()} onBack={vi.fn()} />);
    expect(markup).toContain('Can you beat Alex?');
    expect(markup).toContain('1,000');
    expect(markup).toContain('LOWKEY');
    expect(markup).toContain('3 rounds');
    expect(markup).toContain('Play this challenge');
    expect(markup).toContain('No account or photo needed');
    expect(markup).toContain('does not count toward ranked results');
    expect(markup).not.toContain('<main');
  });

  it('does not offer a play action for malformed or incompatible links', () => {
    const markup = renderToStaticMarkup(<ChallengePage token="broken" onPlay={vi.fn()} onBack={vi.fn()} />);
    expect(markup).toContain('link is incomplete');
    expect(markup).not.toContain('Play this challenge');
  });

  it('celebrates beating the friend target even when the CPU won and offers retry, reply and character creation', () => {
    const markup = renderToStaticMarkup(<AuraBattleResults summary={summary} onRetry={vi.fn()} onExit={vi.fn()} onCreatePlayer={vi.fn()} />);
    expect(markup).toContain('You beat Alex');
    expect(markup).toContain('200 points ahead');
    expect(markup).toContain('CPU result below is separate');
    expect(markup).toContain('Retry this challenge');
    expect(markup).toContain('Share this challenge');
    expect(markup).toContain('Name shown in the link');
    expect(markup).toContain('Create my Aura character');
    expect(markup).toContain('A match video is not available');
  });

  it('never offers a CPU/watch score as a personal challenge', () => {
    const markup = renderToStaticMarkup(<AuraBattleResults summary={{ ...summary, challenge: undefined, challengeShareSlots: [] }} onRetry={vi.fn()} onExit={vi.fn()} />);
    expect(markup).not.toContain('Share this challenge');
    expect(markup).toContain('Run It Back');
  });
  it('compares the recipient score from P2 when the shared phrase belongs to that side', () => {
    const markup = renderToStaticMarkup(<AuraBattleResults summary={{ ...summary, p1Score: { ...score, score: 900 },
      p2Score: { ...score, score: 1_300 }, challenge: { ...challenge, slot: 1 }, challengeShareSlots: [1] }} onRetry={vi.fn()} onExit={vi.fn()} />);
    expect(markup).toContain('You beat Alex');
    expect(markup).toContain('300 points ahead');
    expect(markup).toContain('1,300 / 1,000 target');
  });

  it('explains how to start a challenge when local history is empty', () => {
    const markup = renderToStaticMarkup(<ChallengesPage onPlay={vi.fn()} onOpenChallenge={vi.fn()} onBack={vi.fn()} />);
    expect(markup).toContain('Set a new score');
    expect(markup).toContain('Finish a round');
    expect(markup).toContain('on this device');
  });
});
