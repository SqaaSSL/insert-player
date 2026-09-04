import { useState } from 'react';
import type { AuraBattleCompleteDetail, OnlineRematchStateDetail } from '../../game/match/MatchConfig.ts';
import { auraAccuracy } from '../../game/aura/AuraBattle.ts';

interface AuraBattleResultsProps {
  summary: AuraBattleCompleteDetail;
  localSlot?: 0 | 1;
  onlineRematch?: OnlineRematchStateDetail;
  disableRematch?: boolean;
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
  localSlot,
  onlineRematch = { state: 'idle' },
  disableRematch = false,
  onRetry,
  onRemix,
  onExit,
}: AuraBattleResultsProps) {
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const p1Accuracy = Math.round(auraAccuracy(summary.p1Score) * 100);
  const p2Accuracy = Math.round(auraAccuracy(summary.p2Score) * 100);
  const shareText = `${resultHeadline(summary)} — ${summary.p1Name} ${summary.p1Score.score.toLocaleString()} vs ${summary.p2Score.score.toLocaleString()} ${summary.p2Name}. #AuraBattle #InsertPlayer`;
  const localWinner = summary.winnerSlot === 'draw'
    ? null
    : (summary.winnerSlot === 'p1') === (localSlot === 0);

  const share = async () => {
    try {
      const canShare = typeof navigator.share === 'function';
      if (canShare) await navigator.share({ title: 'Insert Player · Aura Battle', text: shareText });
      else await navigator.clipboard.writeText(shareText);
      setShareStatus(canShare ? 'Shared.' : 'Receipt copied.');
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') setShareStatus('Could not copy the receipt.');
    }
  };

  return (
    <section className="aura-results" role="dialog" aria-modal="true" aria-label="Aura Battle result">
      <div className="aura-results__veil" aria-hidden="true" />
      <div className="aura-results__panel">
        <p className="aura-results__eyebrow">
          {localSlot === undefined
            ? 'THE ROOM HAS DECIDED'
            : localWinner === null
              ? 'A PERFECTLY BALANCED FEED'
              : localWinner ? 'MAIN CHARACTER CONFIRMED' : 'NPC ALLEGATIONS PENDING'}
        </p>
        <h2>{resultHeadline(summary)}</h2>
        <p className="aura-results__meta">{summary.stageLabel} · {summary.difficulty.toUpperCase()} · {summary.durationSeconds}s</p>

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

        {onlineRematch.message ? (
          <p className={`aura-results__status${onlineRematch.state === 'error' ? ' is-error' : ''}`} role="status">
            {onlineRematch.message}
          </p>
        ) : null}
        <div className="aura-results__actions">
          <button
            type="button"
            className="asf-btn asf-btn--primary"
            disabled={disableRematch || onlineRematch.state === 'waiting' || onlineRematch.state === 'starting'}
            onClick={onRetry}
          >
            {onlineRematch.state === 'waiting'
              ? 'Waiting For Rival…'
              : onlineRematch.state === 'starting'
                ? 'Starting…'
                : onlineRematch.state === 'rival_ready'
                  ? 'Rival Ready · Run It Back'
                  : 'Run It Back'}
          </button>
          {onRemix ? <button type="button" className="asf-btn" onClick={onRemix}>Remix Routine</button> : null}
          <button type="button" className="asf-btn" onClick={() => void share()}>Share Receipt</button>
          <button type="button" className="asf-btn asf-btn--ghost" onClick={onExit}>{localSlot === undefined ? 'Menu' : 'Back To Lobby'}</button>
        </div>
        {shareStatus ? <p className="aura-results__status" role="status">{shareStatus}</p> : null}
      </div>
    </section>
  );
}
