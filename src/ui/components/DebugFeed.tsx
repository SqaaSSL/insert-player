import { useEffect, useState } from 'react';
import { DEBUG_EVENT_NAME, getDebugLogLines } from '../../services/DebugLog.ts';

interface DebugFeedProps {
  maxLines?: number;
  title?: string;
  defaultOpen?: boolean;
}

export function DebugFeed({
  maxLines = 8,
  title = 'Debug Feed',
  defaultOpen = false,
}: DebugFeedProps) {
  const [lines, setLines] = useState<string[]>([]);
  const enabled = import.meta.env.DEV;

  useEffect(() => {
    if (!enabled) return;
    const onDebug = () => setLines(getDebugLogLines().slice(-maxLines));
    window.addEventListener(DEBUG_EVENT_NAME, onDebug);
    onDebug();
    return () => window.removeEventListener(DEBUG_EVENT_NAME, onDebug);
  }, [maxLines, enabled]);

  if (!enabled) return null;

  return (
    <details className="gallery-debug" open={defaultOpen}>
      <summary>{title}</summary>
      <pre>{lines.join('\n') || 'No debug lines yet.'}</pre>
    </details>
  );
}
