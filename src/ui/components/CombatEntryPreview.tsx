import { useEffect, useRef, useState } from 'react';
import {
  bindCombatPreviewPlayback,
  COMBAT_PREVIEW_MEDIA,
  type CombatPreviewStatus,
} from '../shared/combatPreviewPlayback.ts';
import './combat-entry-preview.css';

/** Complete real gameplay captures, including the game's own HUD and actions. */
export function CombatEntryPreview({ mode, compact = false }: { mode: 'fight' | 'rush'; compact?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<ReturnType<typeof bindCombatPreviewPlayback> | null>(null);
  const [status, setStatus] = useState<CombatPreviewStatus>('offscreen');
  const media = COMBAT_PREVIEW_MEDIA[mode];
  const name = mode === 'fight' ? 'Fight' : 'Rush';

  useEffect(() => {
    if (!videoRef.current || !containerRef.current) return;
    const playback = bindCombatPreviewPlayback(videoRef.current, containerRef.current, media, setStatus);
    playbackRef.current = playback;
    return () => { playback.destroy(); playbackRef.current = null; };
  }, [media]);

  const playing = status === 'playing' || status === 'loading';
  const action = status === 'error' ? 'Retry' : playing ? 'Pause' : 'Play';
  return (
    <div ref={containerRef} className={`product-entry__preview product-entry__preview--${mode} combat-entry-preview${compact ? ' is-compact' : ''}`} data-preview-status={status}>
      <div className="combat-entry-preview__viewport">
        <video ref={videoRef} muted loop playsInline preload="none"
          width="960" height="540" disablePictureInPicture
          aria-label={mode === 'fight'
            ? 'Real Fight gameplay: two fighters exchange attacks, with health bars and round timer.'
            : 'Real Rush gameplay: a player and CPU ally clear Side Street together.'} />
      </div>
      <div className="combat-entry-preview__controls">
        <span className="combat-entry-preview__caption">{name} · real gameplay</span>
        <button className="combat-entry-preview__toggle" type="button" onClick={() => playbackRef.current?.toggle()}
          aria-label={`${action} ${name} gameplay preview`} title={`${action} preview`}>
          <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>
          <span className="combat-entry-preview__action">{action}</span>
        </button>
      </div>
    </div>
  );
}
