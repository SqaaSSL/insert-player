import { useState } from 'react';
import type { RushRunCompleteDetail } from '../../game/match/MatchConfig.ts';
import { copyToClipboard } from '../shared/communityShare.ts';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';
import { getRushDifficulty } from '../../game/brawl/RushConfig.ts';

interface RushRunResultsProps {
  summary: RushRunCompleteDetail;
  onRetry: () => void;
  onExit: () => void;
}

export function formatRushDuration(durationSeconds: number): string {
  const total = Math.max(0, Math.round(durationSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function resultShareCopy(summary: RushRunCompleteDetail): string {
  const result = summary.outcome === 'won'
    ? `cleared ${summary.stageLabel}`
    : `reached checkpoint ${summary.checkpointsCleared + 1} on ${summary.stageLabel}`;
  return `My team ${result} in ${formatRushDuration(summary.durationSeconds)} with Rank ${summary.rank} and ${summary.score.toLocaleString('en-US')} points in ${PUBLIC_APP_NAME}: Rush.`;
}

export function RushRunResults({ summary, onRetry, onExit }: RushRunResultsProps) {
  const [shareState, setShareState] = useState<'idle' | 'sharing' | 'shared' | 'error'>('idle');
  const cleared = summary.outcome === 'won';
  const difficulty = getRushDifficulty(summary.difficulty);
  const routeUrl = typeof window === 'undefined'
    ? '/roster/rush'
    : `${window.location.origin}/roster/rush`;

  const shareResult = async () => {
    if (shareState === 'sharing') return;
    setShareState('sharing');
    const text = resultShareCopy(summary);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `${summary.stageLabel} · Rank ${summary.rank}`, text, url: routeUrl });
        setShareState('shared');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setShareState('idle');
          return;
        }
      }
    }
    const copied = await copyToClipboard(`${text}\n${routeUrl}`);
    setShareState(copied ? 'shared' : 'error');
  };

  return (
    <section
      className={`rush-results is-${summary.outcome}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rush-results-title"
    >
      <div className="rush-results__veil" aria-hidden="true" />
      <div className="rush-results__panel">
        <div className="rush-results__rank" aria-label={`Rank ${summary.rank}`}>
          <span>RANK</span>
          <strong>{summary.rank}</strong>
        </div>

        <div className="rush-results__body">
          <div className="rush-results__eyebrow">
            <span className="rush-results__route">{summary.stageLabel}</span>
            <span className="rush-results__difficulty">{difficulty.label} RUN</span>
          </div>
          <h2 id="rush-results-title">{cleared ? 'ROUTE CLEARED' : 'TEAM DOWN'}</h2>
          <p>
            {cleared
              ? 'The route is open. Your team made it through together.'
              : 'The route held this time. Keep the same team and run it back.'}
          </p>

          <dl className="rush-results__scoreboard">
            <div className="rush-results__score">
              <dt>SCORE</dt>
              <dd>{summary.score.toLocaleString('en-US')}</dd>
            </div>
            <div>
              <dt>TIME</dt>
              <dd>{formatRushDuration(summary.durationSeconds)}</dd>
            </div>
            <div>
              <dt>ENEMIES</dt>
              <dd>{summary.enemiesDefeated}</dd>
            </div>
            <div>
              <dt>WAVES</dt>
              <dd>{summary.checkpointsCleared}</dd>
            </div>
            <div>
              <dt>SMASHED</dt>
              <dd>{summary.obstaclesDestroyed}</dd>
            </div>
            <div>
              <dt>REVIVES</dt>
              <dd>{summary.revives}</dd>
            </div>
          </dl>

          <div className="rush-results__actions">
            <button type="button" className="asf-btn asf-btn--primary" autoFocus onClick={onRetry}>
              Run It Back
            </button>
            <button
              type="button"
              className="asf-btn asf-btn--ghost"
              disabled={shareState === 'sharing'}
              onClick={() => void shareResult()}
            >
              {shareState === 'sharing'
                ? 'Sharing...'
                : shareState === 'shared'
                  ? 'Result Shared'
                  : 'Share Result'}
            </button>
            <button type="button" className="asf-btn asf-btn--ghost" onClick={onExit}>
              Back To Arcade
            </button>
          </div>
          {shareState === 'error' ? (
            <p className="rush-results__share-error" role="alert">
              Sharing is unavailable in this browser.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
