import { useEffect, useRef, useState } from 'react';
import { bindCombatPreviewPlayback, type CombatPreviewStatus } from '../shared/combatPreviewPlayback.ts';
import { gameplayPreviewMedia, type GameplayPreviewMode } from '../shared/gameplayPreviewMedia.ts';
import './combat-entry-preview.css';

function viewportSize() {
  return typeof window === 'undefined' ? [1024, 576] as const : [window.innerWidth, window.innerHeight] as const;
}

/** The actual game, recorded with its own HUD, controls, actors and scoring. */
export function GameplayEntryPreview({ mode, compact = false }: { mode: GameplayPreviewMode; compact?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<ReturnType<typeof bindCombatPreviewPlayback> | null>(null);
  const [status, setStatus] = useState<CombatPreviewStatus>('offscreen');
  const [viewport, setViewport] = useState(viewportSize);
  const media = gameplayPreviewMedia(mode, ...viewport);
  const portrait = media.height > media.width;

  useEffect(() => {
    const resize = () => setViewport(viewportSize());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    if (!videoRef.current || !containerRef.current) return;
    const initialMedia = gameplayPreviewMedia(mode, ...viewportSize());
    const playback = bindCombatPreviewPlayback(videoRef.current, containerRef.current, initialMedia, setStatus);
    playbackRef.current = playback;
    return () => { playback.destroy(); playbackRef.current = null; };
  }, [mode]);
  useEffect(() => { playbackRef.current?.setMedia(media); }, [media]);

  const playing = status === 'playing' || status === 'loading';
  const action = status === 'error' ? 'Retry' : playing ? 'Pause' : 'Play';
  return (
    <div ref={containerRef} className={`product-entry__preview product-entry__preview--${mode} combat-entry-preview${mode === 'aura' ? ' aura-gameplay-preview' : ''}${compact ? ' is-compact' : ''}${portrait ? ' is-portrait' : ''}`}
      data-preview-status={status} data-preview-shape={portrait ? 'portrait' : 'landscape'}>
      <div className="combat-entry-preview__viewport">
        <video ref={videoRef} muted loop playsInline preload="none"
          width={media.width} height={media.height} disablePictureInPicture aria-label={media.description} />
      </div>
      <div className="combat-entry-preview__controls">
        <span className="combat-entry-preview__caption">{media.name} · real gameplay</span>
        <button className="combat-entry-preview__toggle" type="button" onClick={() => playbackRef.current?.toggle()}
          aria-label={`${action} ${media.name} gameplay preview`} title={`${action} preview`}>
          <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>
          <span className="combat-entry-preview__action">{action}</span>
        </button>
      </div>
    </div>
  );
}
