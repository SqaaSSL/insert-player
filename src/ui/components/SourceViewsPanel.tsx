import type { CachedMeta } from '../../services/SpriteCache.ts';
import {
  SOURCE_VIEWS,
  getSourceBlob,
  type SourceKey,
} from '../shared/fighterPreview.ts';

interface SourceRetryActions {
  side?: () => void | Promise<void>;
  upright?: () => void | Promise<void>;
  crouch?: () => void | Promise<void>;
}

interface SourceViewsPanelProps {
  meta: CachedMeta | null;
  selectedSource: SourceKey | null;
  onSelectSource: (source: SourceKey) => void;
  onRetry?: SourceRetryActions;
  busy?: boolean;
  regeneratingSource?: SourceKey | null;
  retryCreditCost?: number;
}

export function SourceViewsPanel({
  meta,
  selectedSource,
  onSelectSource,
  onRetry,
  busy,
  regeneratingSource,
  retryCreditCost = 1,
}: SourceViewsPanelProps) {
  return (
    <>
      <h3>Source Views</h3>
      <div className="gallery-source-grid" role="group" aria-label="Source views">
        {SOURCE_VIEWS.map(([key, label]) => {
          const blob = getSourceBlob(meta, key);
          const isRegen = regeneratingSource === key;
          return (
            <button
              type="button"
              key={key}
              className={`gallery-chip${selectedSource === key ? ' is-active' : ''}`}
              aria-pressed={selectedSource === key}
              onClick={() => onSelectSource(key)}
            >
              <span>{label}</span>
              <small>{isRegen ? 'Regenerating...' : blob ? 'Ready' : 'Missing'}</small>
            </button>
          );
        })}
      </div>
      {onRetry ? (
        <div className="gallery-actions">
          {onRetry.side ? (
            <button type="button" disabled={busy} onClick={() => void onRetry.side!()}>
              Retry Side · {retryCreditCost} credit
            </button>
          ) : null}
          {onRetry.upright ? (
            <button type="button" disabled={busy} onClick={() => void onRetry.upright!()}>
              Retry Upright · {retryCreditCost} credit
            </button>
          ) : null}
          {onRetry.crouch ? (
            <button type="button" disabled={busy} onClick={() => void onRetry.crouch!()}>
              Retry Crouch · {retryCreditCost} credit
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
