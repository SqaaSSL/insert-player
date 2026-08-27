import { Button } from './Button.tsx';

export type CacheStatus = 'ready' | 'pending' | 'degraded';

interface CacheStatusBannerProps {
  status: CacheStatus;
  message?: string | null;
  onRetry?: () => void;
}

export function CacheStatusBanner({ status, message, onRetry }: CacheStatusBannerProps) {
  if (status === 'ready') return null;
  const retrying = status === 'pending';
  return (
    <aside
      className={`cache-status-banner${status === 'degraded' ? ' is-degraded' : ''}`}
      role={status === 'degraded' ? 'alert' : 'status'}
      aria-live="polite"
      aria-busy={retrying}
    >
      <div>
        <strong>{retrying ? 'Retrying local roster storage' : 'Local roster storage unavailable'}</strong>
        <p>{message ?? 'Cloud and public pages still work. Retry before editing cached fighters.'}</p>
      </div>
      {onRetry ? (
        <Button disabled={retrying} onClick={onRetry}>
          {retrying ? 'Retrying...' : 'Retry Storage'}
        </Button>
      ) : null}
    </aside>
  );
}
