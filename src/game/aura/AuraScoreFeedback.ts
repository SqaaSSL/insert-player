import type Phaser from 'phaser';
import { PIXEL_FONT } from '../ui/CabinetTheme.ts';
import { AURA_SCORE_CUE, formatAuraScoreDelta } from './AuraScoreCue.ts';

type Cue = { text: Phaser.GameObjects.Text; timer: Phaser.Time.TimerEvent };

/** One quiet delta under the active score. New hits replace it, never form
 * a queue across the performer. The main score continues updating immediately. */
export class AuraScoreFeedback {
  private cue: Cue | null = null;

  constructor(
    private scene: Phaser.Scene,
    private layer: Phaser.GameObjects.Container,
    private reducedMotion: boolean,
  ) {}

  show(delta: number, anchor: { x: number; y: number; originX: number }): void {
    const label = formatAuraScoreDelta(delta);
    if (!label) return;
    this.clear();
    const { durationMs, fadeMs, rise, fontSize, alpha } = AURA_SCORE_CUE;
    const text = this.scene.add.text(anchor.x, anchor.y, label, {
      fontFamily: PIXEL_FONT, fontSize: `${fontSize}px`, color: '#fff4d6',
    }).setOrigin(anchor.originX, 0).setDepth(710).setAlpha(alpha);
    this.layer.add(text);
    const cue = { text, timer: this.scene.time.delayedCall(durationMs, () => {
      if (this.cue === cue) this.clear();
    }) };
    this.cue = cue;
    if (this.reducedMotion) return;
    this.scene.tweens.add({ targets: text, y: text.y - rise, duration: durationMs, ease: 'Linear' });
    this.scene.tweens.add({ targets: text, alpha: 0, delay: durationMs - fadeMs, duration: fadeMs, ease: 'Quad.easeIn' });
  }

  clear(): void {
    const cue = this.cue;
    if (!cue) return;
    this.cue = null;
    cue.timer.remove(false);
    this.scene.tweens.killTweensOf(cue.text);
    cue.text.destroy();
  }
}
