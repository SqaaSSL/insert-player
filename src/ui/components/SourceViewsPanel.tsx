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
}

export function SourceViewsPanel({
  meta,
  selectedSource,
  onSelectSource,
  onRetry,
  busy,
  regeneratingSource,
}: SourceViewsPanelProps) {
  return (
    <>
      <h3>Source Views</h3>
      <div className="gallery-source-grid">
        {SOURCE_VIEWS.map(([key, label]) => {
          const blob = getSourceBlob(meta, key);
          const isRegen = regeneratingSource === key;
          return (
            <button
              key={key}
              className={`gallery-chip${selectedSource === key ? ' is-active' : ''}`}
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
            <button disabled={busy} onClick={() => void onRetry.side!()}>
              Retry Side
            </button>
          ) : null}
          {onRetry.upright ? (
            <button disabled={busy} onClick={() => void onRetry.upright!()}>
              Retry Upright
            </button>
          ) : null}
          {onRetry.crouch ? (
            <button disabled={busy} onClick={() => void onRetry.crouch!()}>
              Retry Crouch
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
