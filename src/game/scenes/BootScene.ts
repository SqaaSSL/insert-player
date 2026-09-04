import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';
import {
  generateFighterSpriteSheet,
  generateTemplateZeroFighterSpriteSheet,
} from '../sprites/SpriteGenerator.ts';
import { getPendingLaunchTarget } from '../launchState.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';

const RUSH_ENEMY_TEMPLATE_ZERO_SOURCES = [
  ['rush_enemy_grunt', 'rush_enemy_grunt_template_zero', '/assets/rush/enemies/rivet-template-zero.png'],
  ['rush_enemy_bruiser', 'rush_enemy_bruiser_template_zero', '/assets/rush/enemies/boiler-template-zero.png'],
  ['rush_enemy_shooter', 'rush_enemy_shooter_template_zero', '/assets/rush/enemies/arc-template-zero.png'],
  ['rush_enemy_captain', 'rush_enemy_captain_template_zero', '/assets/rush/enemies/vanta-template-zero.png'],
] as const;

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    const pendingTarget = getPendingLaunchTarget();
    const barW = 400;
    const barH = 20;
    const barX = (GAME_WIDTH - barW) / 2;
    const barY = GAME_HEIGHT / 2;

    const bg = this.add.graphics();
    bg.fillStyle(0x222222);
    bg.fillRect(barX, barY, barW, barH);

    const bar = this.add.graphics();
    this.load.on('progress', (value: number) => {
      bar.clear();
      bar.fillStyle(0xcc4444);
      bar.fillRect(barX, barY, barW * value, barH);
    });

    const loadingTitle = pendingTarget?.sceneKey === 'RushScene'
      ? 'INSERT PLAYER: CO-OP RUSH'
      : pendingTarget?.sceneKey === 'AuraScene'
        ? 'INSERT PLAYER: AURA BATTLE'
        : 'INSERT PLAYER: FIGHT';

    this.add.text(
      GAME_WIDTH / 2,
      barY - 60,
      loadingTitle,
      {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '28px',
      color: '#ff4444',
      stroke: '#000000',
      strokeThickness: 4,
      },
    ).setOrigin(0.5);

    this.add.text(GAME_WIDTH / 2, barY + 40, 'LOADING...', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '12px',
      color: '#888888',
    }).setOrigin(0.5);

    for (const [, sourceKey, assetPath] of RUSH_ENEMY_TEMPLATE_ZERO_SOURCES) {
      if (!this.textures.exists(sourceKey)) this.load.image(sourceKey, assetPath);
    }

    this.generatePlaceholderAssets();
  }

  create(): void {
    for (const [spriteKey, sourceKey] of RUSH_ENEMY_TEMPLATE_ZERO_SOURCES) {
      if (!generateTemplateZeroFighterSpriteSheet(this, spriteKey, sourceKey)) {
        debugWarn(`[BootScene] Template Zero enemy source missing: ${sourceKey}`);
      }
    }
    const pendingTarget = getPendingLaunchTarget();
    debugInfo('[BootScene] create', {
      pendingSceneKey: pendingTarget?.sceneKey ?? null,
      hasPendingData: Boolean(pendingTarget?.data),
    });
    if (pendingTarget) {
      this.scene.start(pendingTarget.sceneKey, pendingTarget.data);
      return;
    }
    // No scene to launch into — the React shell owns menu/gallery/roster flows now.
    // If Phaser was mounted without a target, bounce back to the React menu.
    debugWarn('[BootScene] No pending launch target. Bouncing back to React menu.');
    const exitToMenu = (window as Window & { __ASF_EXIT_TO_MENU__?: () => void }).__ASF_EXIT_TO_MENU__;
    if (exitToMenu) {
      exitToMenu();
    } else {
      window.location.href = '/menu';
    }
  }

  private generatePlaceholderAssets(): void {
    generateFighterSpriteSheet(this, 'fighter_p1', '#3388cc', '#ffcc88');
    generateFighterSpriteSheet(this, 'fighter_p2', '#cc3838', '#ffcc88');
    generateFighterSpriteSheet(this, 'rush_enemy_grunt', '#3b365f', '#9ba3b8', {
      accentColor: '#7b6cff',
      armor: 'light',
      headgear: 'mask',
    });
    generateFighterSpriteSheet(this, 'rush_enemy_bruiser', '#662b31', '#b8a28f', {
      accentColor: '#ff6b3d',
      armor: 'heavy',
      headgear: 'mask',
    });
    generateFighterSpriteSheet(this, 'rush_enemy_shooter', '#173d54', '#a7b7c5', {
      accentColor: '#4fdcff',
      armor: 'light',
      headgear: 'visor',
    });
    generateFighterSpriteSheet(this, 'rush_enemy_captain', '#3b2d18', '#c7bba4', {
      accentColor: '#ffce3a',
      armor: 'heavy',
      headgear: 'commander',
    });

    const sparkGfx = this.add.graphics();
    sparkGfx.fillStyle(0xffffff);
    sparkGfx.fillCircle(4, 4, 4);
    sparkGfx.generateTexture('spark', 8, 8);
    sparkGfx.destroy();

    this.generateFireballTexture();
  }

  private generateFireballTexture(): void {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    const cx = size / 2;
    const cy = size / 2;

    // Outer glow
    const outerGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 16);
    outerGrad.addColorStop(0, 'rgba(255, 200, 50, 0.9)');
    outerGrad.addColorStop(0.4, 'rgba(255, 140, 20, 0.7)');
    outerGrad.addColorStop(0.7, 'rgba(255, 80, 10, 0.3)');
    outerGrad.addColorStop(1, 'rgba(255, 40, 0, 0)');
    ctx.fillStyle = outerGrad;
    ctx.fillRect(0, 0, size, size);

    // Hot center
    const innerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 6);
    innerGrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    innerGrad.addColorStop(0.5, 'rgba(255, 240, 180, 0.8)');
    innerGrad.addColorStop(1, 'rgba(255, 200, 50, 0)');
    ctx.fillStyle = innerGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();

    if (this.textures.exists('fireball_projectile')) {
      this.textures.remove('fireball_projectile');
    }
    const tex = this.textures.addCanvas('fireball_projectile_canvas', canvas);
    const src = tex!.getSourceImage() as HTMLCanvasElement;
    this.textures.addSpriteSheet('fireball_projectile', src as unknown as HTMLImageElement, {
      frameWidth: size,
      frameHeight: size,
    });
    this.textures.remove('fireball_projectile_canvas');
  }
}
