import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';
import { AURA_PREVIEW_CYCLE_MS, AURA_PREVIEW_MOVES, AURA_PREVIEW_TURN_MS, type AuraPreviewDuelState } from './auraPreviewDuel.ts';

export interface AuraPreviewSound {
  prepareAuraMoveAudio(): void;
  playAuraMove(name: AuraAnimationName): void;
  pauseBattleMusic(): void;
  resumeBattleMusic(): void;
  destroy(): void;
}

/** Track bubble entrances even while muted. Enabling or resuming sound never
 * replays the current bubble; only the next live movement can make a sound. */
export function createAuraPreviewAudio(createSound: () => AuraPreviewSound) {
  let sound: AuraPreviewSound | null = null;
  let enabled = false;
  let running = false;
  let audible = false;
  let destroyed = false;
  let previousCue: string | null = null;

  const syncPlayback = () => {
    const nextAudible = enabled && running && !destroyed;
    if (!sound) return;
    if (nextAudible === audible) return;
    audible = nextAudible;
    if (audible) sound.resumeBattleMusic();
    else sound.pauseBattleMusic();
  };

  return {
    setEnabled(value: boolean): boolean {
      if (destroyed) return false;
      enabled = value;
      if (!value) { syncPlayback(); return false; }
      try {
        sound ??= createSound();
        // The caller preloads the module, so context preparation remains in
        // the button's synchronous user gesture on Safari as well as Chrome.
        sound.prepareAuraMoveAudio();
        if (!running) sound.pauseBattleMusic();
        syncPlayback();
        return true;
      } catch {
        enabled = false;
        syncPlayback();
        return false;
      }
    },
    update(duel: AuraPreviewDuelState, elapsedMs: number, isRunning: boolean) {
      if (destroyed) return;
      running = isRunning;
      syncPlayback();
      const clock = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
      const cue = duel.phase === 'performing'
        ? `${Math.floor(clock / AURA_PREVIEW_CYCLE_MS)}:${Math.floor(clock % AURA_PREVIEW_CYCLE_MS / AURA_PREVIEW_TURN_MS)}:${duel.moveIndex}`
        : null;
      if (cue !== previousCue && cue !== null && audible) {
        sound?.playAuraMove(AURA_PREVIEW_MOVES[duel.moveIndex].animation);
      }
      previousCue = cue;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      enabled = false;
      sound?.pauseBattleMusic();
      sound?.destroy();
      sound = null;
    },
  };
}
