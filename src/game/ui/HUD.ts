import Phaser from 'phaser';
import { GAME_WIDTH, MAX_HEALTH, ROUNDS_TO_WIN } from '../constants.ts';
import { getCachedMeta } from '../../services/SpriteCache.ts';

const PORTRAIT_SIZE = 44;
const EDGE_MARGIN = 8;
const BAR_X = EDGE_MARGIN + PORTRAIT_SIZE + 10;
const BAR_WIDTH = 330;
const BAR_HEIGHT = 28;
const BAR_Y = 30;
const TIMER_Y = 18;

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

export class HUD {
  private scene: Phaser.Scene;
  private p1HealthBar!: Phaser.GameObjects.Graphics;
  private p2HealthBar!: Phaser.GameObjects.Graphics;
  private timerText!: Phaser.GameObjects.Text;
  private p1NameText!: Phaser.GameObjects.Text;
  private p2NameText!: Phaser.GameObjects.Text;
  private p1TagText?: Phaser.GameObjects.Text;
  private p2TagText?: Phaser.GameObjects.Text;
  private matchLabelText?: Phaser.GameObjects.Text;
  private p1PortraitFrame?: Phaser.GameObjects.Graphics;
  private p2PortraitFrame?: Phaser.GameObjects.Graphics;
  private p1PortraitImage?: Phaser.GameObjects.Image;
  private p2PortraitImage?: Phaser.GameObjects.Image;
  private p1RoundIndicators: Phaser.GameObjects.Graphics[] = [];
  private p2RoundIndicators: Phaser.GameObjects.Graphics[] = [];
  private announceText!: Phaser.GameObjects.Text;
  private comboTexts: (Phaser.GameObjects.Text | null)[] = [null, null];

  private p1Health = MAX_HEALTH;
  private p2Health = MAX_HEALTH;
  private displayP1Health = MAX_HEALTH;
  private displayP2Health = MAX_HEALTH;
  // Ghost bars trail behind real damage so the player reads how much the
  // last exchange cost (classic SF/Tekken delayed drain).
  private ghostP1Health = MAX_HEALTH;
  private ghostP2Health = MAX_HEALTH;

  /** Invoked for HUD objects created after scene setup (combo banners) so
   * the scene can route them to the right camera. */
  onRuntimeObject: ((obj: Phaser.GameObjects.GameObject) => void) | null = null;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Every persistent HUD display object, for camera routing. */
  getUiObjects(): Phaser.GameObjects.GameObject[] {
    return [
      this.p1HealthBar,
      this.p2HealthBar,
      this.p1NameText,
      this.p2NameText,
      this.p1TagText,
      this.p2TagText,
      this.timerText,
      this.matchLabelText,
      this.announceText,
      ...this.p1RoundIndicators,
      ...this.p2RoundIndicators,
      ...(this.p1PortraitFrame ? [this.p1PortraitFrame] : []),
      ...(this.p2PortraitFrame ? [this.p2PortraitFrame] : []),
      ...(this.p1PortraitImage ? [this.p1PortraitImage] : []),
      ...(this.p2PortraitImage ? [this.p2PortraitImage] : []),
    ].filter(Boolean) as Phaser.GameObjects.GameObject[];
  }

  create(
    p1Name: string,
    p2Name: string,
    p1Tag?: string,
    p2Tag?: string,
    matchLabel?: string,
    p1PhotoHash?: string | null,
    p2PhotoHash?: string | null,
  ): void {
    this.p1HealthBar = this.scene.add.graphics().setDepth(100).setScrollFactor(0);
    this.p2HealthBar = this.scene.add.graphics().setDepth(100).setScrollFactor(0);
    this.createPortraitFrames();

    const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '14px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
    };

    this.p1NameText = this.scene.add.text(BAR_X, 8, p1Name.toUpperCase(), textStyle).setDepth(100).setScrollFactor(0);
    this.p2NameText = this.scene.add.text(GAME_WIDTH - BAR_X, 8, p2Name.toUpperCase(), { ...textStyle, align: 'right' }).setOrigin(1, 0).setDepth(100).setScrollFactor(0);
    this.p1TagText = this.scene.add.text(BAR_X, 24, p1Tag ?? '', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '8px',
      color: '#ffcc66',
      stroke: '#000000',
      strokeThickness: 2,
    }).setDepth(100).setScrollFactor(0);
    this.p2TagText = this.scene.add.text(GAME_WIDTH - BAR_X, 24, p2Tag ?? '', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '8px',
      color: '#66ccff',
      stroke: '#000000',
      strokeThickness: 2,
      align: 'right',
    }).setOrigin(1, 0).setDepth(100).setScrollFactor(0);

    this.timerText = this.scene.add.text(GAME_WIDTH / 2, TIMER_Y, '99', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '36px',
      color: '#ffff00',
      stroke: '#000000',
      strokeThickness: 4,
    }).setOrigin(0.5, 0).setDepth(100).setScrollFactor(0);
    this.matchLabelText = this.scene.add.text(GAME_WIDTH / 2, 58, matchLabel ?? '', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '8px',
      color: '#bbbbbb',
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(0.5, 0).setDepth(100).setScrollFactor(0);

    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
      const p1Dot = this.scene.add.graphics().setDepth(100).setScrollFactor(0);
      p1Dot.lineStyle(2, 0xffffff);
      p1Dot.strokeCircle(BAR_X + 20 + i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
      this.p1RoundIndicators.push(p1Dot);

      const p2Dot = this.scene.add.graphics().setDepth(100).setScrollFactor(0);
      p2Dot.lineStyle(2, 0xffffff);
      p2Dot.strokeCircle(GAME_WIDTH - BAR_X - 20 - i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
      this.p2RoundIndicators.push(p2Dot);
    }

    this.announceText = this.scene.add.text(GAME_WIDTH / 2, 200, '', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '48px',
      color: '#ff4444',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5).setDepth(200).setAlpha(0).setScrollFactor(0);

    this.drawHealthBars();
    void this.loadPortraits(p1PhotoHash, p2PhotoHash);
  }

  update(p1Health: number, p2Health: number, timer: number): void {
    this.p1Health = p1Health;
    this.p2Health = p2Health;

    this.displayP1Health += (this.p1Health - this.displayP1Health) * 0.15;
    this.displayP2Health += (this.p2Health - this.displayP2Health) * 0.15;
    this.ghostP1Health = this.p1Health > this.ghostP1Health
      ? this.p1Health
      : this.ghostP1Health + (this.p1Health - this.ghostP1Health) * 0.03;
    this.ghostP2Health = this.p2Health > this.ghostP2Health
      ? this.p2Health
      : this.ghostP2Health + (this.p2Health - this.ghostP2Health) * 0.03;

    this.timerText.setText(Math.ceil(timer).toString().padStart(2, '0'));
    this.drawHealthBars();
  }

  showAnnouncement(text: string, duration = 2000): void {
    this.announceText.setText(text).setAlpha(1).setScale(0.5);
    this.scene.tweens.add({
      targets: this.announceText,
      scaleX: 1,
      scaleY: 1,
      duration: 200,
      ease: 'Back.easeOut',
    });

    if (duration > 0) {
      this.scene.time.delayedCall(duration, () => {
        this.scene.tweens.add({
          targets: this.announceText,
          alpha: 0,
          duration: 300,
        });
      });
    }
  }

  updateRoundWins(p1Wins: number, p2Wins: number): void {
    for (let i = 0; i < ROUNDS_TO_WIN; i++) {
      this.p1RoundIndicators[i].clear();
      if (i < p1Wins) {
        this.p1RoundIndicators[i].fillStyle(0xffdd00);
        this.p1RoundIndicators[i].fillCircle(BAR_X + 20 + i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
      }
      this.p1RoundIndicators[i].lineStyle(2, 0xffffff);
      this.p1RoundIndicators[i].strokeCircle(BAR_X + 20 + i * 24, BAR_Y + BAR_HEIGHT + 16, 6);

      this.p2RoundIndicators[i].clear();
      if (i < p2Wins) {
        this.p2RoundIndicators[i].fillStyle(0xffdd00);
        this.p2RoundIndicators[i].fillCircle(GAME_WIDTH - BAR_X - 20 - i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
      }
      this.p2RoundIndicators[i].lineStyle(2, 0xffffff);
      this.p2RoundIndicators[i].strokeCircle(GAME_WIDTH - BAR_X - 20 - i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
    }
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

  private createPortraitFrames(): void {
    const portraitY = BAR_Y + BAR_HEIGHT / 2;
    this.p1PortraitFrame = this.createPortraitFrame(EDGE_MARGIN + PORTRAIT_SIZE / 2, portraitY);
    this.p2PortraitFrame = this.createPortraitFrame(GAME_WIDTH - EDGE_MARGIN - PORTRAIT_SIZE / 2, portraitY);
  }

  private createPortraitFrame(x: number, y: number): Phaser.GameObjects.Graphics {
    const gfx = this.scene.add.graphics().setDepth(100).setScrollFactor(0);
    const half = PORTRAIT_SIZE / 2;
    gfx.fillStyle(0x081018, 0.96);
    gfx.fillRoundedRect(x - half, y - half, PORTRAIT_SIZE, PORTRAIT_SIZE, 6);
    gfx.lineStyle(2, 0xffffff, 0.5);
    gfx.strokeRoundedRect(x - half, y - half, PORTRAIT_SIZE, PORTRAIT_SIZE, 6);
    return gfx;
  }

  private async loadPortraits(p1PhotoHash?: string | null, p2PhotoHash?: string | null): Promise<void> {
    await Promise.all([
      this.loadPortrait(p1PhotoHash, 'p1'),
      this.loadPortrait(p2PhotoHash, 'p2'),
    ]);
  }

  private async loadPortrait(photoHash: string | null | undefined, side: 'p1' | 'p2'): Promise<void> {
    if (!photoHash) return;

    const meta = await getCachedMeta(photoHash);
    if (!meta?.originalPhotoBlob) return;

    const canvas = await this.renderPortrait(meta.originalPhotoBlob);
    const texKey = `hud_portrait_${side}_${photoHash.slice(0, 12)}`;
    if (this.scene.textures.exists(texKey)) this.scene.textures.remove(texKey);
    this.scene.textures.addCanvas(texKey, canvas);

    const x = side === 'p1'
      ? EDGE_MARGIN + PORTRAIT_SIZE / 2
      : GAME_WIDTH - EDGE_MARGIN - PORTRAIT_SIZE / 2;
    const y = BAR_Y + BAR_HEIGHT / 2;

    const image = this.scene.add.image(x, y, texKey).setDepth(101).setScrollFactor(0);
    if (side === 'p1') {
      this.p1PortraitImage?.destroy();
      this.p1PortraitImage = image;
    } else {
      this.p2PortraitImage?.destroy();
      this.p2PortraitImage = image;
    }
  }

  private renderPortrait(blob: Blob): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);

        const inset = 4;
        const size = PORTRAIT_SIZE - inset * 2;
        const canvas = document.createElement('canvas');
        canvas.width = PORTRAIT_SIZE;
        canvas.height = PORTRAIT_SIZE;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#081018';
        ctx.fillRect(0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);

        const scale = Math.max(size / img.width, size / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const dx = Math.round((PORTRAIT_SIZE - drawW) / 2);
        const dy = Math.round((PORTRAIT_SIZE - drawH) / 2);
        ctx.drawImage(img, dx, dy, drawW, drawH);

        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to render portrait'));
      };
      img.src = url;
    });
  }

  private drawHealthBars(): void {
    this.p1HealthBar.clear();
    this.p1HealthBar.fillStyle(0x222222);
    this.p1HealthBar.fillRoundedRect(BAR_X, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);
    const p1Ratio = Math.max(0, this.displayP1Health / MAX_HEALTH);
    const p1Ghost = Math.max(p1Ratio, this.ghostP1Health / MAX_HEALTH);
    this.p1HealthBar.fillStyle(0xdd5533, 0.85);
    this.p1HealthBar.fillRoundedRect(
      BAR_X + BAR_WIDTH * (1 - p1Ghost),
      BAR_Y,
      BAR_WIDTH * p1Ghost,
      BAR_HEIGHT,
      4,
    );
    const p1Color = p1Ratio > 0.3 ? 0x44cc44 : p1Ratio > 0.15 ? 0xcccc44 : 0xcc4444;
    this.p1HealthBar.fillStyle(p1Color);
    this.p1HealthBar.fillRoundedRect(
      BAR_X + BAR_WIDTH * (1 - p1Ratio),
      BAR_Y,
      BAR_WIDTH * p1Ratio,
      BAR_HEIGHT,
      4,
    );
    this.p1HealthBar.lineStyle(2, 0xffffff, 0.6);
    this.p1HealthBar.strokeRoundedRect(BAR_X, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);

    const p2BarX = GAME_WIDTH - BAR_X - BAR_WIDTH;
    this.p2HealthBar.clear();
    this.p2HealthBar.fillStyle(0x222222);
    this.p2HealthBar.fillRoundedRect(p2BarX, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);
    const p2Ratio = Math.max(0, this.displayP2Health / MAX_HEALTH);
    const p2Ghost = Math.max(p2Ratio, this.ghostP2Health / MAX_HEALTH);
    this.p2HealthBar.fillStyle(0xdd5533, 0.85);
    this.p2HealthBar.fillRoundedRect(p2BarX, BAR_Y, BAR_WIDTH * p2Ghost, BAR_HEIGHT, 4);
    const p2Color = p2Ratio > 0.3 ? 0x44cc44 : p2Ratio > 0.15 ? 0xcccc44 : 0xcc4444;
    this.p2HealthBar.fillStyle(p2Color);
    this.p2HealthBar.fillRoundedRect(p2BarX, BAR_Y, BAR_WIDTH * p2Ratio, BAR_HEIGHT, 4);
    this.p2HealthBar.lineStyle(2, 0xffffff, 0.6);
    this.p2HealthBar.strokeRoundedRect(p2BarX, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);
  }
}
