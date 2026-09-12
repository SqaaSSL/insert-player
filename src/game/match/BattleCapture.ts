import type Phaser from 'phaser';
import type { BattleSummary } from '../../shared/BattleFinisher.ts';

/** A local result draft, never a provider request or a charge. */
export interface BattleCaptureDetail {
  clientBattleId: string;
  summary: BattleSummary;
  stillBase64: string;
  recording?: File;
}
export const BATTLE_CAPTURE_EVENT = 'insert-player-battle-capture';
/** Describe physical image placement only when the groups are unambiguous. */
export function battleWinnerSide(winners: readonly number[], losers: readonly number[]): 'left' | 'right' | undefined {
  if (!winners.length || !losers.length || ![...winners, ...losers].every(Number.isFinite)) return undefined;
  if (Math.max(...winners) < Math.min(...losers)) return 'left';
  if (Math.min(...winners) > Math.max(...losers)) return 'right';
  return undefined;
}
export type BattleCaptureEventDetail =
  | { state: 'started' | 'unavailable'; clientBattleId: string }
  | { state: 'ready'; clientBattleId: string; capture: BattleCaptureDetail };
export type BattleCaptureOutcome = 'ready' | 'unavailable' | 'cancelled';

/** One session per scene init. Cancel on shutdown/restart so an old renderer
 * callback can never attach its final frame to a new battle. */
export class BattleCaptureSession {
  readonly clientBattleId = crypto.randomUUID();
  private cancelled = false;
  private requested = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private resolveCompletion: ((outcome: BattleCaptureOutcome) => void) | null = null;
  private readonly completion = new Promise<BattleCaptureOutcome>(resolve => { this.resolveCompletion = resolve; });

  constructor() { this.emit({ state: 'started', clientBattleId: this.clientBattleId }); }

  capture(scene: Phaser.Scene, summary: BattleSummary, frame?: { heightRatio: number }): Promise<BattleCaptureOutcome> {
    if (this.cancelled || this.requested) return this.completion;
    this.requested = true;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(this.timeout);
      this.emit({ state: 'unavailable', clientBattleId: this.clientBattleId });
      this.settle('unavailable');
    };
    this.timeout = setTimeout(fail, 8_000);
    try {
      // Phaser takes this on the next render, before WebGL clears its buffer.
      scene.game.renderer.snapshot((image) => {
        if (settled || this.cancelled) return;
        if (!('src' in image) || !image.width || !image.height) { fail(); return; }
        try {
          const canvas = document.createElement('canvas');
          // Portrait Aura retires its instrument at the finale. Keep the HUD
          // and complete stage, without sending a large empty lower panel.
          const ratio = frame && Number.isFinite(frame.heightRatio) ? Math.max(0.1, Math.min(1, frame.heightRatio)) : 1;
          const sourceHeight = Math.max(1, Math.round(image.height * ratio));
          const scale = Math.min(1, 1280 / Math.max(image.width, sourceHeight));
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(sourceHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) { fail(); return; }
          context.drawImage(image, 0, 0, image.width, sourceHeight, 0, 0, canvas.width, canvas.height);
          const stillBase64 = canvas.toDataURL('image/jpeg', 0.88);
          if (!stillBase64.startsWith('data:image/jpeg;base64,')) { fail(); return; }
          settled = true;
          clearTimeout(this.timeout);
          this.emit({ state: 'ready', clientBattleId: this.clientBattleId,
            capture: { clientBattleId: this.clientBattleId, summary, stillBase64 } });
          this.settle('ready');
        } catch { fail(); }
      }, 'image/jpeg', 0.92);
    } catch { fail(); }
    return this.completion;
  }

  cancel(): void { this.cancelled = true; clearTimeout(this.timeout); this.settle('cancelled'); }
  private settle(outcome: BattleCaptureOutcome): void {
    const resolve = this.resolveCompletion;
    this.resolveCompletion = null;
    resolve?.(outcome);
  }
  private emit(detail: BattleCaptureEventDetail): void {
    if (!this.cancelled && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(BATTLE_CAPTURE_EVENT, { detail }));
    }
  }
}

declare global {
  interface WindowEventMap { [BATTLE_CAPTURE_EVENT]: CustomEvent<BattleCaptureEventDetail>; }
}
