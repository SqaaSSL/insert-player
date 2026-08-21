import { apiFetch } from './ApiClient';
import type { MatchCompletionDetail } from '../game/match/MatchConfig';

function isLocalDevWithoutApi(): boolean {
  return !String(import.meta.env.VITE_API_BASE_URL ?? '').trim() && import.meta.env.DEV;
}

export async function reportMatchCompletion(detail: MatchCompletionDetail): Promise<void> {
  if (isLocalDevWithoutApi()) return;

  const opponentKind = detail.cpuVsCpu || detail.vsAI ? 'cpu' : 'local';
  const res = await apiFetch('/api/matches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      winnerSlot: detail.winnerSlot,
      roundsP1: detail.roundsP1,
      roundsP2: detail.roundsP2,
      duration: detail.durationSeconds,
      p1FighterId: detail.p1FighterId ?? null,
      p2FighterId: detail.p2FighterId ?? null,
      opponentKind,
      isRanked: false,
    }),
  });

  if (res.status === 401 || res.status === 503) return;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Match report failed (${res.status}): ${body.slice(0, 180)}`);
  }
}
