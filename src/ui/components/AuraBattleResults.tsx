import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuraBattleCompleteDetail, OnlineRematchStateDetail } from '../../game/match/MatchConfig.ts';
import { auraAccuracy } from '../../game/aura/AuraBattle.ts';
import type { AuraCaptureDetail } from '../../game/aura/AuraCapture.ts';
import { auraVideoFile, downloadAuraVideo } from './AuraMatchShare.ts';
import { compareAuraChallenge, type AuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { BattleResultShare } from './BattleResultShare.tsx';
import type { SavedBattle } from '../../shared/BattleFinisher.ts';
import { AuraChallengeComposer } from './AuraChallengeComposer.tsx';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';

interface AuraBattleResultsProps {
  summary: AuraBattleCompleteDetail;
  finisher?: ReactNode;
  battle?: SavedBattle | null;
  onBattleChange?: (battle: SavedBattle) => void;
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
  finisher,
  battle,
  onBattleChange,
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

  const challengeComposer = summary.challengeRoutine && summary.challengeShareSlots?.length ? (
    <AuraChallengeComposer compact key={`${summary.challengeRoutine.chartId}:${summary.p1Score.score}:${summary.p2Score.score}`}
      routine={summary.challengeRoutine} replyTo={summary.challenge?.name}
      scores={summary.challengeShareSlots.map(slot => ({ slot,
        name: slot === 0 ? summary.p1Name : summary.p2Name,
        score: slot === 0 ? summary.p1Score.score : summary.p2Score.score }))}
      onCreated={onChallengeCreated} recording={battle ? null : file} />
  ) : null;

  const download = () => {
    if (!file) return;
    setShareError(false);
    try {
      downloadAuraVideo(file);
      trackProductEvent('share_video', { game: 'aura' });
      setShareStatus('Video download started.');
    } catch {
      setShareError(true);
      setShareStatus('Download could not start. Try the video player’s download option.');
    }
  };


  return (
    <section className="aura-results" role="dialog" aria-label="Aura Battle result">
      <div className="aura-results__panel" ref={panelRef} tabIndex={-1} onKeyUp={event => event.stopPropagation()} onKeyDown={event => {
        // The live finale keeps Phaser mounted. Let inputs and buttons use their
        // native keys without the game's global DFJK captures cancelling them.
        event.stopPropagation();
        if (event.key !== 'Tab') return;
        const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, video[controls], [tabindex="0"]') ?? [])
          .filter(control => control.getClientRects().length > 0);
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}>
        <h2 className="sr-only">{resultHeadline(summary)}</h2>
        {finisher}

        {challenge && comparison ? <p className="aura-results__challenge-result" role="status">
          {comparison.outcome === 'won' ? `You beat ${challenge.name}'s score`
            : comparison.outcome === 'tied' ? `You matched ${challenge.name}`
              : `${Math.abs(comparison.difference).toLocaleString()} more Aura to beat ${challenge.name}`}
          {' · '}{challengeScore.toLocaleString()} / {challenge.score.toLocaleString()} target
        </p> : null}

        <details className="aura-results__share-option">
          <summary>Share battle</summary>
          <div className="aura-results__share-content">
            {battle ? <BattleResultShare battle={battle} onBattleChange={onBattleChange} /> : challengeComposer}
            {battle && challengeComposer ? <details className="aura-results__video-option">
              <summary>Challenge a friend with this score</summary>
              {challengeComposer}
            </details> : null}
            <details className="aura-results__video-option">
              <summary>Watch or save your match video</summary>
              <div className="aura-results__share">
                {videoUrl && file ? <>
                  <video className="aura-results__video" src={videoUrl} controls playsInline preload="metadata"
                    aria-label={`${summary.p1Name} versus ${summary.p2Name}, recorded Aura match`} />
                  <button type="button" className="asf-btn" onClick={download}>Download video</button>
                  <p className="aura-results__share-note">Save the video before leaving, or publish a battle link to keep it online.</p>
                </> : capture?.state === 'unavailable' || !capture ? (
                  <p className="aura-results__share-note" role="status">
                    {capture?.state === 'unavailable' && (capture.reason === 'recording-size-limit' || capture.reason === 'recording-duration-limit')
                      ? 'This recording exceeded the browser limit. No partial video was saved.'
                      : 'A match video is not available for this round.'}
                  </p>
                ) : <p className="aura-results__status" role="status">Preparing your match video…</p>}
                {shareStatus ? <p className={`aura-results__share-note${shareError ? ' is-error' : ''}`} role="status">{shareStatus}</p> : null}
              </div>
            </details>
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
          <button type="button" className="asf-btn asf-btn--ghost" onClick={onExit}>{localSlot === undefined ? 'Menu' : 'Back To Lobby'}</button>
        </div>
        <details className="aura-results__details">
          <summary>Match details &amp; more</summary>
          <p className="aura-results__meta">{summary.stageLabel} · {summary.difficulty.toUpperCase()} · {summary.durationSeconds}s</p>
          <div className="aura-results__duel">
            {([0, 1] as const).map(slot => {
              const score = slot === 0 ? summary.p1Score : summary.p2Score;
              const winner = summary.winnerSlot === (slot === 0 ? 'p1' : 'p2');
              return <article key={slot} className={winner ? 'is-winner' : ''}>
                <span>{summary.winnerSlot === 'draw' ? 'DRAW' : winner ? 'VICTORY' : 'DEFEAT'} · {slot === 0 ? summary.p1Rank : summary.p2Rank} RANK</span>
                <strong>{slot === 0 ? summary.p1Name : summary.p2Name}</strong>
                <b>{score.score.toLocaleString()} AURA</b>
                <small>{slot === 0 ? p1Accuracy : p2Accuracy}% accurate · {score.bestCombo} best combo · {score.misses} misses</small>
              </article>;
            })}
          </div>
          <div className="aura-results__actions">
            {onRemix ? <button type="button" className="asf-btn" onClick={onRemix}>Remix Routine</button> : null}
            {onCreatePlayer ? <button type="button" className="asf-btn" onClick={onCreatePlayer}>
              {trial ? 'Create my Rookie Aura' : 'Create my Aura character'}
            </button> : null}
          </div>
        </details>
      </div>
    </section>
  );
}
