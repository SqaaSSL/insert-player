import { useEffect, useRef, useState } from 'react';
import {
  AURA_CHALLENGE_MAX_NAME_LENGTH, cleanAuraChallengeName, createAuraChallenge,
  type AuraChallenge, type AuraChallengeRoutine,
} from '../../game/aura/AuraChallenge.ts';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';
import { copyToClipboard } from '../shared/communityShare.ts';
import { auraChallengeShareData, shareAuraChallenge } from '../shared/auraChallengeShare.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import '../aura-challenges.css';

interface AuraChallengeComposerProps {
  routine: AuraChallengeRoutine;
  scores: ReadonlyArray<{ slot: 0 | 1; name: string; score: number }>;
  replyTo?: string;
  onCreated?: (challenge: AuraChallenge) => void;
  onDraftChange?: (challenge: AuraChallenge | null) => void;
}

export function AuraChallengeComposer({ routine, scores, replyTo, onCreated, onDraftChange }: AuraChallengeComposerProps) {
  const [slot, setSlot] = useState(scores[0]?.slot ?? 0);
  const selected = scores.find(score => score.slot === slot) ?? scores[0];
  const [name, setName] = useState(cleanAuraChallengeName(selected?.name ?? 'Player'));
  const [link, setLink] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'share' | 'copy' | null>(null);
  const busyRef = useRef(false);
  const [manualCopy, setManualCopy] = useState(false);
  useEffect(() => {
    if (!onDraftChange) return;
    try { onDraftChange(selected ? createAuraChallenge(routine, name, selected.score, selected.slot) : null); }
    catch { onDraftChange(null); }
  }, [routine, name, selected?.score, selected?.slot, onDraftChange]);
  if (!selected) return null;
  const handoff = async (action: 'share' | 'copy') => {
    if (busyRef.current || !cleanAuraChallengeName(name)) return;
    busyRef.current = true;
    setBusy(action);
    setStatus(null);
    setManualCopy(false);
    try {
      const challenge = createAuraChallenge(routine, name, selected.score, selected.slot);
      const data = auraChallengeShareData(challenge, window.location.origin);
      const { url } = data;
      setLink(url);
      if (link !== url) {
        rememberAuraChallenge(challenge, 'created');
        trackProductEvent('challenge_created', { game: 'aura', source: 'challenge' });
        onCreated?.(challenge);
      }
      const outcome = action === 'copy'
        ? await copyToClipboard(url) ? 'copied' : 'manual'
        : await shareAuraChallenge(data);
      setManualCopy(outcome === 'manual');
      setStatus(outcome === 'shared' ? 'Challenge handed to your sharing app.'
        : outcome === 'cancelled' ? 'Your challenge is ready. Copy its link whenever you want.'
          : outcome === 'copied' ? 'Challenge link copied. Send it to your friend.'
            : 'Your link is ready. Select and copy it below.');
    } catch { setStatus('This result cannot create a challenge. Play a new routine and try again.'); }
    finally { busyRef.current = false; setBusy(null); }
  };
  return (
    <section className="aura-challenge-composer" aria-label={replyTo ? 'Send your score back' : 'Challenge a friend'}>
      <p className="aura-challenge-composer__brand">INSERT PLAYER · AURA CHALLENGE</p>
      <h3>{replyTo ? 'Send your score back' : 'Challenge a friend'}</h3>
      <p className="aura-challenge-composer__notice">{selected.score.toLocaleString()} AURA. {replyTo || 'Your friend'} gets this exact song, routine and difficulty.</p>
      <div className="aura-challenge-composer__form">
        {scores.length > 1 ? <label>Whose score?
          <select value={slot} disabled={busy !== null} onChange={event => {
            const next = Number(event.target.value) as 0 | 1;
            setSlot(next); setName(cleanAuraChallengeName(scores.find(score => score.slot === next)?.name ?? 'Player'));
            setLink(null); setStatus(null); setManualCopy(false);
          }}>{scores.map(score => <option key={score.slot} value={score.slot}>{score.name} · {score.score.toLocaleString()}</option>)}</select>
        </label> : null}
        <label>Name shown in the link
          <input value={name} disabled={busy !== null} maxLength={AURA_CHALLENGE_MAX_NAME_LENGTH} autoComplete="off"
            onChange={event => { setName(event.target.value); setLink(null); setStatus(null); setManualCopy(false); }} />
        </label>
        <button type="button" className="asf-btn asf-btn--primary" disabled={busy !== null || !cleanAuraChallengeName(name)} onClick={() => void handoff('share')}>
          {busy === 'share' ? 'Preparing link…' : replyTo ? 'Share score back' : 'Share this challenge'}
        </button>
        <button type="button" className="asf-btn" disabled={busy !== null || !cleanAuraChallengeName(name)} onClick={() => void handoff('copy')}>
          {busy === 'copy' ? 'Copying link…' : 'Copy challenge link'}
        </button>
      </div>
      <p className="aura-challenge-composer__notice">Send a playable link with your name and score. Your character, photos and match video are not attached. Friendly scores are not ranked.</p>
      {status ? <p className="aura-challenge-composer__notice" role="status">{status}</p> : null}
      {link ? <a className="aura-challenge-composer__link" href={link}>Open your challenge</a> : null}
      {link && manualCopy ? <label>Challenge link
        <input readOnly value={link} onFocus={event => event.currentTarget.select()} />
      </label> : null}
    </section>
  );
}
