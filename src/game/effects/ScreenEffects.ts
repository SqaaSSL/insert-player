import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';

export class ScreenEffects {
  static flashWhite(scene: Phaser.Scene, duration = 80): void {
    const overlay = scene.add.graphics().setDepth(999).setScrollFactor(0);
    overlay.fillStyle(0xffffff, 0.6);
    overlay.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    scene.tweens.add({
      targets: overlay,
      alpha: 0,
      duration,
      ease: 'Cubic.easeOut',
      onComplete: () => overlay.destroy(),
    });
  }

  static flashRed(scene: Phaser.Scene, duration = 120): void {
    const overlay = scene.add.graphics().setDepth(999).setScrollFactor(0);
    overlay.fillStyle(0xff0000, 0.35);
    overlay.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    scene.tweens.add({
      targets: overlay,
      alpha: 0,
      duration,
      ease: 'Cubic.easeOut',
      onComplete: () => overlay.destroy(),
    });
  }

  static slowMotion(scene: Phaser.Scene, durationMs: number, scale = 0.05): void {
    scene.time.timeScale = scale;
    scene.time.delayedCall(durationMs, () => {
      scene.time.timeScale = 1;
    });
  }

  static createCRTOverlay(scene: Phaser.Scene): Phaser.GameObjects.Graphics {
    const gfx = scene.add.graphics().setDepth(998).setScrollFactor(0);

    for (let y = 0; y < GAME_HEIGHT; y += 3) {
      gfx.fillStyle(0x000000, 0.04);
      gfx.fillRect(0, y, GAME_WIDTH, 1);
    }

    const vignetteRadius = Math.max(GAME_WIDTH, GAME_HEIGHT) * 0.7;
    const steps = 20;
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const alpha = (1 - t) * (1 - t) * 0.12;
      const radius = vignetteRadius * (0.6 + t * 0.4);
      gfx.fillStyle(0x000000, alpha);
      gfx.fillCircle(GAME_WIDTH / 2, GAME_HEIGHT / 2, radius);
    }

    return gfx;
  }
}
