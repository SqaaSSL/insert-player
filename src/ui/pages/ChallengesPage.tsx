import { useState } from 'react';
import { decodeAuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { getAuraTrack } from '../../game/aura/AuraTracks.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import { DEFAULT_AURA_STAGE_ID } from '../../game/match/StageConfig.ts';
import { readAuraChallenges } from '../shared/auraChallenges.ts';
import '../aura-challenges.css';

interface ChallengesPageProps {
  onPlay: (data: MatchSceneData) => void | Promise<void>;
  onOpenChallenge: (token: string) => void;
  onBack: () => void;
}

export function ChallengesPage({ onPlay, onOpenChallenge, onBack }: ChallengesPageProps) {
  const [history] = useState(readAuraChallenges);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      await onPlay({ gameMode: 'aura', vsAI: true, cpuVsCpu: false,
        p1Name: 'NOVA', p2Name: 'BYTE', auraDifficulty: 'lowkey', stageId: DEFAULT_AURA_STAGE_ID });
    } catch { setError('The stage could not open. Try again.'); setStarting(false); }
  };
  return (
    <section className="aura-challenge-page" aria-label="Your Aura challenges">
      <div className="aura-challenge-page__content">
        <h1>Your Aura challenges</h1>
        <p>Set a score. Send the routine. Give someone a reason to play you back.</p>
        <p className="aura-challenge-page__note">Start free with Nova and Byte, our generic demo performers.</p>
        <div className="aura-challenge-page__actions">
          <button className="asf-btn asf-btn--primary" type="button" disabled={starting} onClick={() => void start()}>{starting ? 'Opening your stage…' : 'Set a new score'}</button>
          <button className="asf-btn asf-btn--ghost" type="button" onClick={onBack}>Back to games</button>
        </div>
        {history.length ? (
          <ul className="aura-challenge-history">
            {history.map(entry => {
              const decoded = decodeAuraChallenge(entry.token);
              if (!decoded.ok) return null;
              const { challenge } = decoded;
              return <li key={entry.token}>
                <div><strong>{challenge.name} · {challenge.score.toLocaleString()} points</strong>
                  <p>{getAuraTrack(challenge.trackId)?.title} · {challenge.difficulty.toUpperCase()}</p>
                  <small>{entry.kind === 'created' ? 'You shared this routine' : 'You played this challenge'}
                    {entry.bestScore === undefined ? '' : ` · Your best: ${entry.bestScore.toLocaleString()}`}</small></div>
                <button className="asf-btn" type="button" onClick={() => onOpenChallenge(entry.token)}>Open challenge</button>
              </li>;
            })}
          </ul>
        ) : <p className="aura-challenge-page__empty">Finish a round and choose “Challenge a friend”. Your recent links and attempts will appear here.</p>}
        <p className="aura-challenge-page__note">Recent compatible challenges on this device. Friendly scores are not ranked records.</p>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
