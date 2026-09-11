import type Phaser from 'phaser';
import type { AuraLayout } from './AuraLayout.ts';
import type { AuraStartupDetail } from './AuraStartup.ts';
import { CREAM, HEAT, INK, PIXEL_FONT, fillChamfered } from '../ui/CabinetGraphics.ts';

/** Authored on the game canvas so the visible versus intro is also the video intro. */
export class AuraStartupView {
  private readonly plate: Phaser.GameObjects.Graphics;
  private readonly brand: Phaser.GameObjects.Text;
  private readonly match: Phaser.GameObjects.Text;
  private readonly cue: Phaser.GameObjects.Text;
  private readonly watermark: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Container, private readonly names: [string, string]) {
    this.plate = scene.add.graphics();
    const text = (size: number, color: string) => scene.add.text(0, 0, '', {
      fontFamily: PIXEL_FONT, fontSize: `${size}px`, color,
      align: 'center', stroke: '#050507', strokeThickness: 4,
    }).setOrigin(0.5);
    this.brand = text(18, '#fff4d6').setText('INSERT PLAYER');
    this.match = text(12, '#fff4d6').setText(`${names[0]}  VS  ${names[1]}`);
    this.cue = text(18, '#ffce3a');
    this.watermark = text(7, '#fff4d6').setText('INSERTPLAYER.AI · AURA').setOrigin(0, 1).setAlpha(0.8);
    layer.add([this.plate, this.brand, this.match, this.cue, this.watermark]);
  }

  render(layout: AuraLayout, state: Pick<AuraStartupDetail, 'phase' | 'count'> | null, waitingForRival = false): void {
    this.plate.clear();
    this.watermark.setPosition(12, layout.height - 8);
    const visible = state !== null && state.phase !== 'playing';
    const versus = visible && state.phase !== 'countdown';
    this.brand.setVisible(versus);
    this.match.setVisible(versus);
    this.cue.setVisible(visible);
    if (!visible) return;
    if (versus) {
      fillChamfered(this.plate, 16, 12, layout.width - 32, layout.hudHeight - 22, 10, INK, 0.97);
      this.plate.lineStyle(2, HEAT, 0.9).lineBetween(40, layout.hudHeight - 10, layout.width - 40, layout.hudHeight - 10);
      this.brand.setPosition(layout.width / 2, 40).setScale(layout.portrait ? 0.86 : 1);
      this.match.setPosition(layout.width / 2, layout.portrait ? 90 : 78).setScale(1);
      this.match.setScale(Math.min(1, (layout.width - 72) / Math.max(1, this.match.width)));
      this.cue.setPosition(layout.width / 2, layout.portrait ? 554 : 176)
        .setFontSize(layout.portrait ? 15 : 18)
        .setText(state.phase === 'versus' ? 'AURA DUEL · GET READY' : waitingForRival ? 'WAITING FOR YOUR RIVAL' : 'READY TO FARM');
    } else {
      const x = layout.highwayX;
      // The first note is already travelling during this musical count-in.
      // Keep its entire approach visible instead of placing a card on the lanes.
      const y = layout.laneStartY - 55;
      fillChamfered(this.plate, x - 38, y - 25, 76, 50, 8, INK, 0.94);
      this.plate.lineStyle(1, CREAM, 0.8).strokeRect(x - 32, y - 20, 64, 40);
      this.cue.setPosition(x, y).setFontSize(28).setText(String(state.count ?? 3));
    }
  }

  destroy(): void {
    this.plate.destroy(); this.brand.destroy(); this.match.destroy(); this.cue.destroy(); this.watermark.destroy();
  }
}
