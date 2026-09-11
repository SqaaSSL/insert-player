import { useEffect, useRef, useState } from 'react';
import { auraAtlasContentHash } from '../../game/aura/AuraPoseCalibration.ts';
import { AURA_PLAZA_ASSET_PATH } from '../../game/match/StageConfig.ts';
import { AURA_PREVIEW_MOVES, AURA_PREVIEW_PERFORMERS, AURA_PREVIEW_STILL_MS, auraPreviewDuelAt } from '../shared/auraPreviewDuel.ts';
import { drawAuraPreview, AURA_PREVIEW_FRAME, type AuraPreviewAtlas, type AuraPreviewAtlases } from '../shared/auraPreviewCanvas.ts';
import { auraPreviewFrameGeometry } from '../shared/auraPreviewGeometry.ts';
import { createAuraPreviewAudio } from '../shared/auraPreviewAudio.ts';
import type { SoundManager } from '../../game/systems/SoundManager.ts';

const PERFORMERS = AURA_PREVIEW_PERFORMERS;
const ANIMATIONS = ['aura_unbothered', 'aura_shrug', ...AURA_PREVIEW_MOVES.map((move) => move.animation)] as const;
const atlasLoads = new Map<string, Promise<AuraPreviewAtlas>>();

function loadAtlas(subject: string, animation: string): Promise<AuraPreviewAtlas> {
  const key = `${subject}/${animation}`;
  const cached = atlasLoads.get(key);
  if (cached) return cached;
  const request = (async () => {
    const response = await fetch(`/assets/aura/${key}.png`);
    if (!response.ok) throw new Error('Aura preview could not load.');
    const blob = await response.blob();
    const contentHash = await auraAtlasContentHash(blob);
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Aura preview image could not load.'));
        image.src = url;
      });
      return { image, contentHash };
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  atlasLoads.set(key, request);
  void request.catch(() => atlasLoads.delete(key));
  return request;
}

function loadStage(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Aura stage could not load.'));
    image.src = AURA_PLAZA_ASSET_PATH;
  });
}

/** Short excerpts of the real chart and score rules in the game's cabinet layout. */
export function AuraEntryPreview({ compact = false }: { compact?: boolean }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<ReturnType<typeof createAuraPreviewAudio> | null>(null);
  const soundConstructorRef = useRef<typeof SoundManager | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundReady, setSoundReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [visible, setVisible] = useState(false);
  const [atlases, setAtlases] = useState<AuraPreviewAtlases | null>(null);
  const [stage, setStage] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const audio = createAuraPreviewAudio(() => {
      const Sound = soundConstructorRef.current;
      if (!Sound) throw new Error('Preview sound is still loading.');
      return new Sound();
    });
    audioRef.current = audio;
    return () => { audio.destroy(); audioRef.current = null; };
  }, []);

  useEffect(() => {
    if (!visible || soundReady) return;
    let current = true;
    void import('../../game/systems/SoundManager.ts').then(({ SoundManager }) => {
      if (!current) return;
      soundConstructorRef.current = SoundManager;
      setSoundReady(true);
    }).catch(() => { /* A later visibility change can retry the module. */ });
    return () => { current = false; };
  }, [visible, soundReady]);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let inView = false;
    const updateMotion = () => setReducedMotion(motion.matches);
    const updateVisibility = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      updateVisibility();
    });
    updateMotion();
    if (previewRef.current) observer.observe(previewRef.current);
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (!visible || atlases || loadError) return;
    let current = true;
    const sprites = Promise.all(PERFORMERS.flatMap(({ subject }) => ANIMATIONS.map(async (animation) => {
      const atlas = await loadAtlas(subject, animation);
      if (!auraPreviewFrameGeometry({ subject, animation, frameIndex: 0, contentHash: atlas.contentHash, ...AURA_PREVIEW_FRAME })) {
        throw new Error('Aura preview art has changed.');
      }
      return [`${subject}/${animation}`, atlas] as const;
    })));
    void Promise.all([sprites, loadStage(), document.fonts.load('14px "Press Start 2P"').catch(() => [])])
      .then(([entries, image]) => { if (current) { setAtlases(new Map(entries)); setStage(image); } })
      .catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [visible, atlases, loadError]);

  const running = visible && !!atlases && !paused && !reducedMotion;
  useEffect(() => {
    if (!running) return;
    let previous = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      if (now - previous >= 1000 / 30) {
        const delta = Math.min(100, now - previous);
        previous = now;
        setElapsedMs((elapsed) => elapsed + delta);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  const displayMs = reducedMotion ? AURA_PREVIEW_STILL_MS : elapsedMs;
  const duel = auraPreviewDuelAt(displayMs);
  useEffect(() => {
    audioRef.current?.update(auraPreviewDuelAt(displayMs), displayMs, running);
  }, [displayMs, running]);

  const toggleSound = () => {
    setSoundEnabled(audioRef.current?.setEnabled(!soundEnabled) ?? false);
  };
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (context) drawAuraPreview(context, stage, atlases, auraPreviewDuelAt(displayMs), displayMs);
  }, [stage, atlases, displayMs]);

  return (
    <div ref={previewRef} className={`product-entry__preview product-entry__preview--aura aura-entry-preview${compact ? ' is-compact' : ''}`} data-running={running}>
      <div className="aura-entry-preview__screen">
        <canvas ref={canvasRef} width="1024" height="576" className="aura-entry-preview__canvas" role="img" aria-label="Aura gameplay demo: the active performer dances beside four falling-note lanes. Notes reach D, F, J and K to earn Aura, then the rival takes a turn." />
        {(!atlases || loadError) && <p className="aura-entry-preview__status" role="status">{loadError ? 'Preview unavailable. You can still play Aura.' : 'Loading the duel…'}</p>}
      </div>
      <div className="aura-entry-preview__header">
        <span className="aura-entry-preview__eyebrow">Duel preview</span>
        {!reducedMotion && <div className="aura-entry-preview__controls">
          <button type="button" className="aura-entry-preview__pause" onClick={toggleSound} disabled={!soundReady} aria-pressed={soundEnabled} aria-label={soundEnabled ? 'Mute duel preview' : 'Enable duel preview sound'}>Moves {soundEnabled ? 'on' : 'off'}</button>
          <button type="button" className="aura-entry-preview__pause" onClick={() => setPaused((value) => !value)} aria-label={paused ? 'Play duel preview' : 'Pause duel preview'}><span aria-hidden="true">{paused ? '▶' : 'Ⅱ'}</span> {paused ? 'Play' : 'Pause'}</button>
        </div>}
      </div>
      <dl className="sr-only" aria-label="Demo Aura scores">
        {PERFORMERS.map((performer, index) => <div key={performer.subject}><dt>{performer.name}</dt><dd>{duel.scores[index].toLocaleString('en-US')} Aura</dd></div>)}
      </dl>
      <p className="aura-entry-preview__explanation">Hit the beat. The higher Aura wins.</p>
    </div>
  );
}
