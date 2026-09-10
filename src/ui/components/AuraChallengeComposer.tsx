import { useState } from 'react';
import {
  AURA_CHALLENGE_MAX_NAME_LENGTH, auraChallengeUrl, cleanAuraChallengeName, createAuraChallenge,
  type AuraChallenge, type AuraChallengeRoutine,
} from '../../game/aura/AuraChallenge.ts';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';
import { copyToClipboard } from '../shared/communityShare.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import '../aura-challenges.css';

interface AuraChallengeComposerProps {
  routine: AuraChallengeRoutine;
  scores: ReadonlyArray<{ slot: 0 | 1; name: string; score: number }>;
  onCreated?: (challenge: AuraChallenge) => void;
}

export function AuraChallengeComposer({ routine, scores, onCreated }: AuraChallengeComposerProps) {
  const [slot, setSlot] = useState(scores[0]?.slot ?? 0);
  const selected = scores.find(score => score.slot === slot) ?? scores[0];
  const [name, setName] = useState(cleanAuraChallengeName(selected?.name ?? 'Player'));
  const [link, setLink] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  if (!selected) return null;
  const share = async () => {
    if (sharing || !cleanAuraChallengeName(name)) return;
    setSharing(true);
    try {
      const challenge = createAuraChallenge(routine, name, selected.score, selected.slot);
      const url = auraChallengeUrl(challenge, window.location.origin);
      setLink(url);
      rememberAuraChallenge(challenge, 'created');
      trackProductEvent('challenge_created', { game: 'aura', source: 'challenge' });
      onCreated?.(challenge);
      const text = `Can you beat ${challenge.name}'s ${challenge.score.toLocaleString()} points? Play the same Aura routine.`;
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: 'Your turn · Insert Player Aura', text, url });
          setStatus('Challenge handed to your sharing app.');
          return;
        } catch (error) {
          if ((error as DOMException)?.name === 'AbortError') { setStatus('Your challenge link is ready below.'); return; }
        }
      }
      const copied = await copyToClipboard(url);
      setManualCopy(!copied);
      setStatus(copied ? 'Challenge link copied. Send it to your friend.' : 'Your link is ready. Select and copy it below.');
    } catch { setStatus('This result cannot create a challenge. Play a new routine and try again.'); }
    finally { setSharing(false); }
  };
  return (
    <section className="aura-challenge-composer" aria-label="Challenge a friend">
      <h3>Challenge a friend</h3>
      <p className="aura-challenge-composer__notice">{selected.score.toLocaleString()} points. Your friend gets this exact song, routine and difficulty.</p>
      <div className="aura-challenge-composer__form">
        {scores.length > 1 ? <label>Whose score?
          <select value={slot} onChange={event => {
            const next = Number(event.target.value) as 0 | 1;
            setSlot(next); setName(cleanAuraChallengeName(scores.find(score => score.slot === next)?.name ?? 'Player'));
            setLink(null); setStatus(null); setManualCopy(false);
          }}>{scores.map(score => <option key={score.slot} value={score.slot}>{score.name} · {score.score.toLocaleString()}</option>)}</select>
        </label> : null}
        <label>Name shown in the link
          <input value={name} maxLength={AURA_CHALLENGE_MAX_NAME_LENGTH} autoComplete="off"
            onChange={event => { setName(event.target.value); setLink(null); setStatus(null); setManualCopy(false); }} />
        </label>
        <button type="button" className="asf-btn asf-btn--primary" disabled={sharing || !cleanAuraChallengeName(name)} onClick={() => void share()}>
          {sharing ? 'Preparing link…' : 'Share this challenge'}
        </button>
      </div>
      <p className="aura-challenge-composer__notice">This shares your chosen name and score. Your character, photos and match video are not attached. Friendly scores are not ranked.</p>
      {status ? <p className="aura-challenge-composer__notice" role="status">{status}</p> : null}
      {link ? <a className="aura-challenge-composer__link" href={link}>Open your challenge</a> : null}
      {link && manualCopy ? <label>Challenge link
        <input readOnly value={link} onFocus={event => event.currentTarget.select()} />
      </label> : null}
    </section>
  );
}
