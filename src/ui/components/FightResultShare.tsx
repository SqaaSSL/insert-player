import { useState } from 'react';
import type { MatchCompletionDetail } from '../../game/match/MatchConfig.ts';
import { copyToClipboard } from '../shared/communityShare.ts';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';

interface FightResultShareProps {
  summary: MatchCompletionDetail;
  p1Name: string;
  p2Name: string;
}

export function fightResultShareCopy(
  summary: MatchCompletionDetail,
  p1Name: string,
  p2Name: string,
): string {
  const p1Won = summary.winnerSlot === 'p1';
  if (summary.online) {
    const localIsP1 = summary.online.localSlot === 0;
    const localName = localIsP1 ? p1Name : p2Name;
    const rivalName = localIsP1 ? p2Name : p1Name;
    const localWon = p1Won === localIsP1;
    const score = localIsP1
      ? `${summary.roundsP1}-${summary.roundsP2}`
      : `${summary.roundsP2}-${summary.roundsP1}`;
    return `I ${localWon ? 'won' : 'lost'} ${score} as ${localName} against ${rivalName} in ${PUBLIC_APP_NAME}: Fight.`;
  }
  const score = `${summary.roundsP1}-${summary.roundsP2}`;
  const winner = p1Won ? p1Name : p2Name;
  const loser = p1Won ? p2Name : p1Name;
  return `${winner} beat ${loser} ${score} in ${PUBLIC_APP_NAME}: Fight.`;
}

export function FightResultShare({ summary, p1Name, p2Name }: FightResultShareProps) {
  const [state, setState] = useState<'idle' | 'sharing' | 'shared' | 'error'>('idle');

  const share = async () => {
    if (state === 'sharing') return;
    setState('sharing');
    const text = fightResultShareCopy(summary, p1Name, p2Name);
    const url = typeof window === 'undefined' ? '/menu' : `${window.location.origin}/menu`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `${PUBLIC_APP_NAME}: Fight`, text, url });
        setState('shared');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setState('idle');
          return;
        }
      }
    }
    const copied = await copyToClipboard(`${text} ${url}`);
    setState(copied ? 'shared' : 'error');
  };

  return (
    <button
      type="button"
      className="match-actions__button"
      disabled={state === 'sharing'}
      onClick={() => void share()}
    >
      {state === 'sharing'
        ? 'Sharing…'
        : state === 'shared'
          ? 'Result Copied'
          : state === 'error'
            ? 'Copy Failed'
            : 'Share Result'}
    </button>
  );
}
