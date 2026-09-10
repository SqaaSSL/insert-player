import { useEffect, useMemo, useState } from 'react';
import { buildAuraChallengeMatch, decodeAuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { getAuraDifficulty } from '../../game/aura/AuraConfig.ts';
import { getAuraTrack } from '../../game/aura/AuraTracks.ts';
import { createAuraChart } from '../../game/aura/AuraChart.ts';
import { getStageTheme } from '../../game/match/StageConfig.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';
import { withPreferredAuraChallengePlayer } from '../shared/auraChallengePlayer.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import '../aura-challenges.css';

interface ChallengePageProps {
  token: string | null;
  onPlay: (data: MatchSceneData) => void | Promise<void>;
  onBack: () => void;
  onCreatePlayer?: () => void;
  preferredPlayerPhotoHash?: string | null;
}

export function ChallengePage({ token, onPlay, onBack, onCreatePlayer, preferredPlayerPhotoHash }: ChallengePageProps) {
  const decoded = useMemo(() => decodeAuraChallenge(token), [token]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (decoded.ok) trackProductEvent('challenge_opened', { game: 'aura', source: 'challenge' });
    setStarting(false);
    setError(null);
  }, [token]);
  if (!decoded.ok) return (
    <section className="aura-challenge-page" aria-label="Aura challenge">
      <div className="aura-challenge-page__content">
        <h1>{decoded.error === 'incompatible' ? 'This routine has changed' : 'This challenge link is incomplete'}</h1>
        <p>{decoded.error === 'incompatible'
          ? 'Ask your friend for a new challenge. This version cannot play the exact routine they shared.'
          : 'Open the complete link from your friend, or set a new score in Aura.'}</p>
        <button className="asf-btn asf-btn--primary" type="button" onClick={onBack}>All challenges</button>
      </div>
    </section>
  );
  const { challenge } = decoded;
  const track = getAuraTrack(challenge.trackId)!;
  const stage = getStageTheme(challenge.stageId);
  const duration = Math.round(createAuraChart(challenge.seed, challenge.difficulty, track).durationMs / 1_000);
  const play = async (usePreferred = true) => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const data = await withPreferredAuraChallengePlayer(buildAuraChallengeMatch(challenge),
        usePreferred ? preferredPlayerPhotoHash : null);
      await onPlay(data);
      rememberAuraChallenge(challenge, 'played');
      trackProductEvent('challenge_started', { game: 'aura', source: 'challenge' });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The stage could not open. Try again.'); setStarting(false); }
  };
  return (
    <section className="aura-challenge-page" aria-label="Aura challenge">
      <img className="aura-challenge-page__art" src={stage.assetPath} alt="" />
      <div className="aura-challenge-page__content">
        <span className="aura-challenge-page__label">AURA CHALLENGE</span>
        <h1>Can you beat {challenge.name}?</h1>
        <p className="aura-challenge-page__target"><strong>{challenge.score.toLocaleString()}</strong><span>AURA to beat</span></p>
        <p>Same song. Same routine. Your turn to own the room.</p>
        <dl className="aura-challenge-page__facts">
          <div><dt>Song</dt><dd>{track.title}</dd></div>
          <div><dt>Level</dt><dd>{getAuraDifficulty(challenge.difficulty).label}</dd></div>
          <div><dt>Match</dt><dd>3 rounds · about {duration}s</dd></div>
        </dl>
        <div className="aura-challenge-page__actions">
          <button className="asf-btn asf-btn--primary" type="button" disabled={starting} onClick={() => void play()}>
            {starting ? 'Opening your stage…' : preferredPlayerPhotoHash ? 'Play with my character' : 'Play this challenge'}
          </button>
          {onCreatePlayer && !preferredPlayerPhotoHash ? <button className="asf-btn" type="button" disabled={starting} onClick={onCreatePlayer}>Create my Aura character</button> : null}
          <button className="asf-btn asf-btn--ghost" type="button" onClick={onBack}>All challenges</button>
        </div>
        <p className="aura-challenge-page__note">{preferredPlayerPhotoHash
          ? 'Your character is selected. The song, notes and difficulty stay exactly the same.'
          : 'Play free with Nova, a generic demo performer. No account or photo needed.'} Four lanes, tap when each note reaches its mark.</p>
        <p className="aura-challenge-page__note">Beat the target, then send your score back. The CPU is your stage rival; your friend’s score is the challenge.</p>
        <p className="aura-challenge-page__note">A friendly score shared by a player. It does not count toward ranked results.</p>
        {error ? <div role="alert"><p>{error}</p>{preferredPlayerPhotoHash ? (
          <button className="asf-btn" type="button" disabled={starting} onClick={() => void play(false)}>Use a ready performer</button>
        ) : null}</div> : null}
      </div>
    </section>
  );
}
