import { useEffect, useMemo, useState } from 'react';
import { buildAuraChallengeMatch, decodeAuraChallenge } from '../../game/aura/AuraChallenge.ts';
import type { MatchSceneData } from '../../game/match/MatchConfig.ts';
import { AuraClipError, auraClipOwnerToken, auraClipShareData, deleteAuraClip, getAuraClip, type AuraClip } from '../../services/AuraClips.ts';
import { withPreferredAuraChallengePlayer } from '../shared/auraChallengePlayer.ts';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';
import '../aura-clips.css';

interface AuraWatchPageProps {
  clipId: string;
  onPlay: (data: MatchSceneData) => void | Promise<void>;
  onExplore: () => void;
  onCreatePlayer?: (challengeToken: string) => void;
  preferredPlayerPhotoHash?: string | null;
}

export function AuraWatchPage({ clipId, ...props }: AuraWatchPageProps) {
  const [clip, setClip] = useState<AuraClip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setClip(null); setError(null); setMissing(false);
    void getAuraClip(clipId, controller.signal).then(value => { if (!controller.signal.aborted) setClip(value); }).catch(reason => {
      if (controller.signal.aborted) return;
      const unavailable = reason instanceof AuraClipError && [404, 410].includes(reason.status);
      setMissing(unavailable);
      setError(unavailable ? 'This battle has expired or its creator removed it.' : 'The battle could not load. Check your connection and try again.');
    });
    return () => controller.abort();
  }, [clipId, retry]);
  if (clip) return <AuraWatchContent key={clip.id} clip={clip} {...props} onRemoved={() => { setClip(null); setMissing(true); setError('Your battle link has been removed.'); }} />;
  return <section className="aura-watch" aria-label="Watch Aura battle">
    {error ? <div className="aura-watch__empty">
      <h1>{missing ? 'This battle is no longer here' : 'Let’s try that again'}</h1>
      <p role="status">{error}</p>
      <div className="aura-watch__actions">
        {!missing ? <button className="asf-btn" type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button> : null}
        <button className="asf-btn asf-btn--primary" type="button" onClick={props.onExplore}>Play Aura free</button>
      </div>
    </div> : <div className="aura-watch__loading" aria-busy="true">
      <div className="aura-watch__placeholder" aria-hidden="true" />
      <p role="status">Loading your Aura battle…</p>
    </div>}
  </section>;
}

/** Kept separate so the public, video-first surface can be verified without a network. */
export function AuraWatchContent({ clip, onPlay, onExplore, onCreatePlayer, preferredPlayerPhotoHash, onRemoved }: Omit<AuraWatchPageProps, 'clipId'> & { clip: AuraClip; onRemoved: () => void }) {
  const decoded = useMemo(() => decodeAuraChallenge(clip.challengeToken), [clip.challengeToken]);
  const [starting, setStarting] = useState(false);
  const [playingError, setPlayingError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [manualCopy, setManualCopy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ownerToken = auraClipOwnerToken(clip.id);
  const challenge = decoded.ok ? decoded.challenge : null;
  useEffect(() => {
    trackProductEvent('challenge_opened', { game: 'aura', source: 'challenge' });
  }, [clip.id]);
  const play = async (usePreferred = true) => {
    if (!challenge || starting) return;
    setStarting(true); setPlayingError(null);
    try {
      const match = await withPreferredAuraChallengePlayer(buildAuraChallengeMatch(challenge), usePreferred ? preferredPlayerPhotoHash : null);
      await onPlay(match);
      rememberAuraChallenge(challenge, 'played');
      trackProductEvent('challenge_started', { game: 'aura', source: 'challenge' });
    } catch (reason) { setPlayingError(reason instanceof Error ? reason.message : 'The stage could not open. Try again.'); setStarting(false); }
  };
  const share = async () => {
    const result = await shareAuraChallenge(auraClipShareData(clip, challenge));
    setManualCopy(result === 'manual');
    setShareStatus(result === 'shared' ? 'Battle link handed to your sharing app.' : result === 'copied' ? 'Battle link copied.'
      : result === 'cancelled' ? 'You can share this battle whenever you want.' : 'Select and copy the battle link below.');
  };
  const remove = async () => {
    if (!ownerToken || removing) return;
    setRemoving(true);
    try { await deleteAuraClip(clip.id, ownerToken); onRemoved(); }
    catch { setShareStatus('The link could not be removed. Try again.'); setRemoving(false); }
  };
  return <section className="aura-watch" aria-label="Watch Aura battle">
    <div className="aura-watch__layout">
      <div className="aura-watch__player">
        <video src={clip.videoUrl} poster={clip.posterUrl} controls playsInline preload="metadata" aria-label="Recorded Aura battle on Insert Player" onError={() => setVideoError(true)} />
        {videoError ? <p role="alert">This browser cannot play the recording. Download the video below to watch it.</p> : null}
      </div>
      <div className="aura-watch__content">
        <p className="aura-watch__brand">INSERT PLAYER · AURA</p>
        <h1>{challenge ? `${challenge.name} brought ${challenge.score.toLocaleString()} Aura.` : 'The room has decided.'}</h1>
        {!challenge ? <p>Watch the battle, then make the next one yours.</p> : null}
        <div className="aura-watch__actions">
          {challenge ? <button className="asf-btn asf-btn--primary" type="button" disabled={starting} onClick={() => void play()}>
            {starting ? 'Opening your stage…' : 'Play this challenge'}
          </button> : <button className="asf-btn asf-btn--primary" type="button" onClick={onExplore}>Play Aura free</button>}
          <button className="asf-btn" type="button" onClick={() => void share()}>Share battle link</button>
        </div>
        <p className="aura-watch__note">{challenge ? preferredPlayerPhotoHash ? 'Your Aura character is ready to play.' : 'Free to play. No account or photo needed.'
          : 'This video is still here, but its exact routine is no longer supported.'}</p>
        {playingError ? <div role="alert"><p>{playingError}</p>{preferredPlayerPhotoHash ? <button className="asf-btn" type="button" disabled={starting} onClick={() => void play(false)}>Use a ready performer</button> : null}</div> : null}
        <div className="aura-watch__secondary">
          <a href={clip.downloadUrl} download>Download video</a>
          {onCreatePlayer && challenge && !preferredPlayerPhotoHash ? <button type="button" onClick={() => onCreatePlayer(clip.challengeToken)}>Create my Aura character</button> : null}
        </div>
        {shareStatus ? <p className="aura-watch__note" role="status">{shareStatus}</p> : null}
        {manualCopy ? <label className="aura-watch__copy">Battle link<input readOnly value={clip.shareUrl} onFocus={event => event.currentTarget.select()} /></label> : null}
        <p className="aura-watch__fine">{challenge ? 'Friendly score, not ranked. ' : ''}Video available until {new Date(clip.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}.</p>
        {ownerToken ? <div className="aura-watch__owner">
          {confirmRemove ? <><p>Remove this public link? Your downloaded video will stay on your device.</p>
            <button className="asf-btn" type="button" disabled={removing} onClick={() => void remove()}>{removing ? 'Removing link…' : 'Remove battle link'}</button>
            <button className="asf-btn asf-btn--ghost" type="button" disabled={removing} onClick={() => setConfirmRemove(false)}>Keep link</button>
          </> : <button type="button" onClick={() => setConfirmRemove(true)}>Remove my battle link</button>}
        </div> : null}
      </div>
    </div>
  </section>;
}
