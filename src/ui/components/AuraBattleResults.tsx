import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuraBattleCompleteDetail, OnlineRematchStateDetail } from '../../game/match/MatchConfig.ts';
import { auraAccuracy } from '../../game/aura/AuraBattle.ts';
import type { AuraCaptureDetail } from '../../game/aura/AuraCapture.ts';
import { auraVideoFile, downloadAuraVideo } from './AuraMatchShare.ts';
import { compareAuraChallenge, type AuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { AuraChallengeComposer } from './AuraChallengeComposer.tsx';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';

interface AuraBattleResultsProps {
  summary: AuraBattleCompleteDetail;
  trial?: boolean;
  capture?: AuraCaptureDetail | null;
  localSlot?: 0 | 1;
  onlineRematch?: OnlineRematchStateDetail;
  disableRematch?: boolean;
  onChallengeCreated?: (challenge: AuraChallenge) => void;
  onCreatePlayer?: () => void;
  onRetry: () => void;
  onRemix?: () => void;
  onExit: () => void;
}

function resultHeadline(summary: AuraBattleCompleteDetail): string {
  if (summary.winnerSlot === 'draw') return 'AURA EQUILIBRIUM';
  return `${summary.winnerSlot === 'p1' ? summary.p1Name : summary.p2Name} OWNS THE ROOM`;
}

export function AuraBattleResults({
  summary,
  capture = null,
  trial = false,
  localSlot,
  onlineRematch = { state: 'idle' },
  disableRematch = false,
  onChallengeCreated,
  onCreatePlayer,
  onRetry,
  onRemix,
  onExit,
}: AuraBattleResultsProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { panelRef.current?.focus(); }, [summary]);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [shareError, setShareError] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const completedChallenge = useRef<AuraBattleCompleteDetail | null>(null);
  const challenge = summary.challenge;
  const challengeScore = challenge?.slot === 1 ? summary.p2Score.score : summary.p1Score.score;
  const comparison = challenge ? compareAuraChallenge(challenge, challengeScore) : null;
  useEffect(() => {
    if (!challenge || completedChallenge.current === summary) return;
    completedChallenge.current = summary;
    rememberAuraChallenge(challenge, 'played', challengeScore);
    trackProductEvent('challenge_completed', { game: 'aura', source: 'challenge' });
  }, [summary, challenge, challengeScore]);
  const video = capture?.state === 'ready' ? capture.video : null;
  const file = useMemo(() => video ? auraVideoFile(video, summary.p1Name, summary.p2Name) : null,
    [video, summary.p1Name, summary.p2Name]);
  useEffect(() => {
    if (!file) { setVideoUrl(null); return; }
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const p1Accuracy = Math.round(auraAccuracy(summary.p1Score) * 100);
  const p2Accuracy = Math.round(auraAccuracy(summary.p2Score) * 100);
  const localWinner = summary.winnerSlot === 'draw'
    ? null
    : (summary.winnerSlot === 'p1') === (localSlot === 0);

  const download = () => {
    if (!file) return;
    setShareError(false);
    try {
      downloadAuraVideo(file);
      trackProductEvent('share_video', { game: 'aura' });
      setShareStatus('Video download started. Attach the file in your chat or social app.');
    } catch {
      setShareError(true);
      setShareStatus('Download could not start. Try the video player’s download option.');
    }
  };


  return (
    <section className="aura-results" role="dialog" aria-modal="true" aria-label="Aura Battle result">
      <div className="aura-results__veil" aria-hidden="true" />
      <div className="aura-results__panel" ref={panelRef} tabIndex={-1} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, video[controls], [tabindex="0"]') ?? [])
          .filter(control => !control.closest('details:not([open])') || control.tagName === 'SUMMARY');
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}>
        <p className="aura-results__eyebrow">
          INSERT PLAYER · {' '}
          {localSlot === undefined
            ? 'THE ROOM HAS DECIDED'
            : localWinner === null
              ? 'A PERFECTLY BALANCED FEED'
              : localWinner ? 'MAIN CHARACTER CONFIRMED' : 'NPC ALLEGATIONS PENDING'}
        </p>
        <h2>{challenge && comparison
          ? comparison.outcome === 'won' ? `You beat ${challenge.name}'s score`
            : comparison.outcome === 'tied' ? `You matched ${challenge.name}` : 'One more run?'
          : resultHeadline(summary)}</h2>
        <p className="aura-results__meta">{summary.stageLabel} · {summary.difficulty.toUpperCase()} · {summary.durationSeconds}s</p>

        {challenge && comparison ? <div className="aura-challenge-comparison">
          <h3>{challengeScore.toLocaleString()} / {challenge.score.toLocaleString()} target</h3>
          <p>{comparison.outcome === 'won' ? `${comparison.difference.toLocaleString()} points ahead. Send your score back.`
            : comparison.outcome === 'tied' ? 'Exactly level. Play the same routine again to take the lead.'
              : `${Math.abs(comparison.difference).toLocaleString()} more points to match the target. Try the same routine again.`}</p>
          <p>Friendly challenge from {challenge.name}. The CPU result below is separate.</p>
        </div> : null}

        <div className="aura-results__duel">
          <article className={summary.winnerSlot === 'p1' ? 'is-winner' : ''}>
            <span>P1 · {summary.p1Rank} RANK</span>
            <strong>{summary.p1Name}</strong>
            <b>{summary.p1Score.score.toLocaleString()} AURA</b>
            <small>{p1Accuracy}% accurate · {summary.p1Score.bestCombo} best combo · {summary.p1Score.misses} aura leaks</small>
          </article>
          <em>VS</em>
          <article className={summary.winnerSlot === 'p2' ? 'is-winner' : ''}>
            <span>P2 · {summary.p2Rank} RANK</span>
            <strong>{summary.p2Name}</strong>
            <b>{summary.p2Score.score.toLocaleString()} AURA</b>
            <small>{p2Accuracy}% accurate · {summary.p2Score.bestCombo} best combo · {summary.p2Score.misses} aura leaks</small>
          </article>
        </div>

        {summary.challengeRoutine && summary.challengeShareSlots?.length ? (
          <AuraChallengeComposer key={`${summary.challengeRoutine.chartId}:${summary.p1Score.score}:${summary.p2Score.score}`}
            routine={summary.challengeRoutine}
            replyTo={summary.challenge?.name}
            scores={summary.challengeShareSlots.map(slot => ({ slot,
              name: slot === 0 ? summary.p1Name : summary.p2Name,
              score: slot === 0 ? summary.p1Score.score : summary.p2Score.score }))}
            onCreated={onChallengeCreated} recording={file} />
        ) : null}

        {trial && onCreatePlayer ? <div className="aura-results__rookie">
          <div><h3>Your moves. Your face. Your next battle.</h3>
            <p>Turn one photo into your Rookie Aura with six moves. Your first Rookie is included with your account.</p></div>
          <button type="button" className="asf-btn" onClick={onCreatePlayer}>Create my Rookie Aura</button>
        </div> : null}

        <details className="aura-results__video-option">
          <summary>Watch or save your match video</summary>
          <div className="aura-results__share">
          {videoUrl && file ? (
            <>
              <video className="aura-results__video" src={videoUrl} controls playsInline preload="metadata"
                aria-label={`${summary.p1Name} versus ${summary.p2Name}, recorded Aura match`} />
              <div className="aura-results__actions">
                <button type="button" className="asf-btn" onClick={download}>Download video</button>
              </div>
              <p className="aura-results__share-note">
                {file.type === 'video/mp4' ? 'MP4' : 'WebM'} · {(file.size / 1024 / 1024).toFixed(1)} MB
                {video?.hasAudio ? ' · Game audio included.' : ' · No audio in this recording.'}
                {' '}Your original video stays on this device. Create a battle link above to publish a copy, or download it before leaving.
              </p>
            </>
          ) : capture?.state === 'unavailable' || !capture ? (
            <p className="aura-results__share-note" role="status">
              {capture?.state === 'unavailable' && (capture.reason === 'recording-size-limit' || capture.reason === 'recording-duration-limit')
                ? 'This recording exceeded the browser limit. No partial video was saved.'
                : 'A match video is not available. Try a new round in a browser that supports game recording.'}
            </p>
          ) : <p className="aura-results__status" role="status">Preparing your match video…</p>}
          {shareStatus ? <p className={`aura-results__share-note${shareError ? ' is-error' : ''}`} role="status">{shareStatus}</p> : null}
          </div>
        </details>

        {onlineRematch.message ? (
          <p className={`aura-results__status${onlineRematch.state === 'error' ? ' is-error' : ''}`} role="status">
            {onlineRematch.message}
          </p>
        ) : null}
        <div className="aura-results__actions">
          <button
            type="button"
            className="asf-btn"
            disabled={disableRematch || onlineRematch.state === 'waiting' || onlineRematch.state === 'starting'}
            onClick={onRetry}
          >
            {onlineRematch.state === 'waiting'
              ? 'Waiting For Rival…'
              : onlineRematch.state === 'starting'
                ? 'Starting…'
                : onlineRematch.state === 'rival_ready'
                  ? 'Rival Ready · Run It Back'
                  : challenge ? 'Retry this challenge' : 'Run It Back'}
          </button>
          {onRemix ? <button type="button" className="asf-btn" onClick={onRemix}>Remix Routine</button> : null}
          {onCreatePlayer && !trial ? <button type="button" className="asf-btn" onClick={onCreatePlayer}>Create my Aura character</button> : null}
          <button type="button" className="asf-btn asf-btn--ghost" onClick={onExit}>{localSlot === undefined ? 'Menu' : 'Back To Lobby'}</button>
        </div>
      </div>
    </section>
  );
}
