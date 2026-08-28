import Phaser from 'phaser';

const COMBO_COLORS: Record<string, string> = {
  low: '#ffffff',
  mid: '#ffdd00',
  high: '#ff8800',
  max: '#ff2200',
};

function getComboColor(count: number): string {
  if (count >= 8) return COMBO_COLORS.max;
  if (count >= 6) return COMBO_COLORS.high;
  if (count >= 4) return COMBO_COLORS.mid;
  return COMBO_COLORS.low;
}

/** In-canvas fight feedback that stays world-adjacent (combo banners).
 * Health bars, timer, round pips, portraits, and announcements are DOM
 * overlays rendered by React from FightScene's HUD/announce events. */
export class HUD {
  private scene: Phaser.Scene;
  private comboTexts: (Phaser.GameObjects.Text | null)[] = [null, null];

  /** Invoked for HUD objects created after scene setup (combo banners) so
   * the scene can route them to the right camera. */
  onRuntimeObject: ((obj: Phaser.GameObjects.GameObject) => void) | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  showCombo(x: number, y: number, comboCount: number, playerIndex: number): void {
    if (comboCount < 2) return;

    const existing = this.comboTexts[playerIndex];
    if (existing) {
      this.scene.tweens.killTweensOf(existing);
      existing.destroy();
    }

    const color = getComboColor(comboCount);
    const text = this.scene.add.text(x, y - 140, `${comboCount} HIT COMBO!`, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '16px',
      color,
      stroke: '#000000',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(110).setScale(0.3).setAlpha(1);

    this.onRuntimeObject?.(text);
    this.comboTexts[playerIndex] = text;

    this.scene.tweens.add({
      targets: text,
      scaleX: 1,
      scaleY: 1,
      duration: 150,
      ease: 'Back.easeOut',
    });

    this.scene.time.delayedCall(1500, () => {
      if (this.comboTexts[playerIndex] === text) {
        this.scene.tweens.add({
          targets: text,
          alpha: 0,
          y: text.y - 30,
          duration: 300,
          onComplete: () => {
            text.destroy();
            if (this.comboTexts[playerIndex] === text) {
              this.comboTexts[playerIndex] = null;
            }
          },
        });
      }
    });
  }
}
