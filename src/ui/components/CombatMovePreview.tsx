import { useEffect, useState } from 'react';
import { getActiveSpriteCacheScope, getAllSpritesForHash, type CachedSprite } from '../../services/SpriteCache.ts';
import type { FighterInput } from '../../game/sim/FighterInput.ts';
import { peekVirtualHeldInput } from '../../game/systems/VirtualInput.ts';
import { useFightControlState } from '../shared/useFightControlState.ts';
import { SpritePreviewSurface } from './SpritePreviewSurface.tsx';

export function controlPreviewMove(input: Readonly<FighterInput>, mode: 'fight' | 'rush') {
  const low = mode === 'fight' && input.down;
  // Special moves use these same authored gestures in AiSpriteLoader.
  if (input.super) return { animation: 'high_punch', label: 'Super', note: mode === 'fight' ? 'A stronger fireball. Needs a full meter.' : 'A stronger fireball.' };
  if (input.fireball) return { animation: 'high_punch', label: 'Fireball', note: 'This gesture launches a projectile.' };
  if (input.uppercut) return mode === 'rush'
    ? { animation: 'jump', label: 'Jump', note: '' }
    : { animation: 'high_punch', label: 'Uppercut', note: 'This strike lifts you into the air.' };
  if (input.punch) return { animation: low ? 'low_punch' : 'high_punch', label: low ? 'Low punch' : 'Punch', note: '' };
  if (input.kick) return { animation: low ? 'low_kick' : 'high_kick', label: low ? 'Low kick' : 'Kick', note: '' };
  if (input.guard) return { animation: 'crouch', label: 'Guard', note: 'Keep the button held to block.' };
  if (mode === 'fight' && input.up) return { animation: 'jump', label: 'Jump', note: '' };
  if (low) return { animation: 'crouch', label: 'Crouch', note: '' };
  if (input.left || input.right || (mode === 'rush' && (input.up || input.down))) {
    return { animation: 'walk', label: 'Move', note: '' };
  }
  return null;
}

/** Reuse the gallery's sprite loop to show the selected fighter, without combat. */
export function CombatMovePreview({ photoHash, mode }: { photoHash: string; mode: 'fight' | 'rush' }) {
  const controls = useFightControlState(mode, false);
  const [move, setMove] = useState({ animation: 'idle', label: 'Try a button', note: '' });
  const [loaded, setLoaded] = useState<{ photoHash: string; sprites: CachedSprite[] } | null>(null);

  useEffect(() => {
    const next = controlPreviewMove(controls.players[0].held, mode);
    if (next) setMove(previous => previous.label === next.label ? previous : next);
  }, [controls, mode]);

  useEffect(() => {
    let frame = 0;
    const sampleTouch = () => {
      if (!document.hidden) {
        const next = controlPreviewMove(peekVirtualHeldInput(0), mode);
        if (next) setMove(previous => previous.label === next.label ? previous : next);
      }
      frame = window.requestAnimationFrame(sampleTouch);
    };
    frame = window.requestAnimationFrame(sampleTouch);
    return () => window.cancelAnimationFrame(frame);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    const scope = getActiveSpriteCacheScope();
    void getAllSpritesForHash(photoHash, scope).then(sprites => {
      if (!cancelled && getActiveSpriteCacheScope() === scope) setLoaded({ photoHash, sprites });
    }).catch(() => { /* The cabinet remains usable without an optional preview. */ });
    return () => { cancelled = true; };
  }, [photoHash]);

  const cached = loaded?.photoHash === photoHash
    ? loaded.sprites.find(sprite => sprite.animationName === move.animation)
    : null;
  if (!cached) return null;
  const native = cached.animationFormat === 'video-dense-v1';
  return <figure className="combat-move-preview" aria-label={`${move.label} animation preview`}>
    <SpritePreviewSurface sprite={{
      blob: cached.pngBlob,
      rawBlob: native ? cached.rawPngBlob : undefined,
      animationName: cached.animationName,
      animationFormat: cached.animationFormat,
      frameWidth: cached.frameWidth, frameHeight: cached.frameHeight, frameCount: cached.frameCount,
      rawFrameWidth: cached.rawFrameWidth, rawFrameHeight: cached.rawFrameHeight, rawFrameCount: cached.rawFrameCount,
    }} />
    <figcaption><strong>{move.label}</strong>{move.note && <span>{move.note}</span>}</figcaption>
  </figure>;
}
