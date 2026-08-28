import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';

export class ScreenEffects {
  static flashWhite(scene: Phaser.Scene, duration = 80): Phaser.GameObjects.Graphics {
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
    return overlay;
  }

  static flashRed(scene: Phaser.Scene, duration = 120): Phaser.GameObjects.Graphics {
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
    return overlay;
  }

  static slowMotion(scene: Phaser.Scene, durationMs: number, scale = 0.05): void {
    scene.time.timeScale = scale;
    scene.time.delayedCall(durationMs, () => {
      scene.time.timeScale = 1;
    });
  }

  static createCRTOverlay(scene: Phaser.Scene): Phaser.GameObjects.Graphics {
    const gfx = scene.add.graphics().setDepth(998).setScrollFactor(0);

    gfx.fillStyle(0xffffff, 0.015);
    gfx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    for (let y = 0; y < GAME_HEIGHT; y += 4) {
      gfx.fillStyle(0x000000, 0.015);
      gfx.fillRect(0, y, GAME_WIDTH, 1);
    }

    const borderSteps = 5;
    for (let i = 0; i < borderSteps; i++) {
      const inset = i * 10;
      const thickness = 18 - i * 3;
      const alpha = 0.03 - i * 0.004;
      gfx.lineStyle(Math.max(4, thickness), 0x000000, Math.max(0.006, alpha));
      gfx.strokeRoundedRect(
        inset,
        inset,
        GAME_WIDTH - inset * 2,
        GAME_HEIGHT - inset * 2,
        18,
      );
    }

    return gfx;
  }
}
