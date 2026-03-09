import Phaser from 'phaser';
import { GAME_WIDTH, MAX_HEALTH, ROUNDS_TO_WIN } from '../constants.ts';

const BAR_WIDTH = 380;
const BAR_HEIGHT = 28;
const BAR_Y = 30;
const BAR_PADDING = 4;
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
  private p1RoundIndicators: Phaser.GameObjects.Graphics[] = [];
  private p2RoundIndicators: Phaser.GameObjects.Graphics[] = [];
  private announceText!: Phaser.GameObjects.Text;
  private comboTexts: (Phaser.GameObjects.Text | null)[] = [null, null];

  private p1Health = MAX_HEALTH;
  private p2Health = MAX_HEALTH;
  private displayP1Health = MAX_HEALTH;
  private displayP2Health = MAX_HEALTH;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  create(p1Name: string, p2Name: string, p1Tag?: string, p2Tag?: string, matchLabel?: string): void {
    this.p1HealthBar = this.scene.add.graphics().setDepth(100).setScrollFactor(0);
    this.p2HealthBar = this.scene.add.graphics().setDepth(100).setScrollFactor(0);

    const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '14px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
    };

    this.p1NameText = this.scene.add.text(20, 8, p1Name.toUpperCase(), textStyle).setDepth(100).setScrollFactor(0);
    this.p2NameText = this.scene.add.text(GAME_WIDTH - 20, 8, p2Name.toUpperCase(), { ...textStyle, align: 'right' }).setOrigin(1, 0).setDepth(100).setScrollFactor(0);
    this.p1TagText = this.scene.add.text(20, 24, p1Tag ?? '', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '8px',
      color: '#ffcc66',
      stroke: '#000000',
      strokeThickness: 2,
    }).setDepth(100).setScrollFactor(0);
    this.p2TagText = this.scene.add.text(GAME_WIDTH - 20, 24, p2Tag ?? '', {
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
      p1Dot.strokeCircle(BAR_PADDING + 20 + i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
      this.p1RoundIndicators.push(p1Dot);

      const p2Dot = this.scene.add.graphics().setDepth(100).setScrollFactor(0);
      p2Dot.lineStyle(2, 0xffffff);
      p2Dot.strokeCircle(GAME_WIDTH - BAR_PADDING - 20 - i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
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
  }

  update(p1Health: number, p2Health: number, timer: number): void {
    this.p1Health = p1Health;
    this.p2Health = p2Health;

    // Smooth health bar animation
    this.displayP1Health += (this.p1Health - this.displayP1Health) * 0.15;
    this.displayP2Health += (this.p2Health - this.displayP2Health) * 0.15;

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
        this.p1RoundIndicators[i].fillCircle(BAR_PADDING + 20 + i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
      }
      this.p1RoundIndicators[i].lineStyle(2, 0xffffff);
      this.p1RoundIndicators[i].strokeCircle(BAR_PADDING + 20 + i * 24, BAR_Y + BAR_HEIGHT + 16, 6);

      this.p2RoundIndicators[i].clear();
      if (i < p2Wins) {
        this.p2RoundIndicators[i].fillStyle(0xffdd00);
        this.p2RoundIndicators[i].fillCircle(GAME_WIDTH - BAR_PADDING - 20 - i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
      }
      this.p2RoundIndicators[i].lineStyle(2, 0xffffff);
      this.p2RoundIndicators[i].strokeCircle(GAME_WIDTH - BAR_PADDING - 20 - i * 24, BAR_Y + BAR_HEIGHT + 16, 6);
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

  private drawHealthBars(): void {
    const cx = GAME_WIDTH / 2;

    // Player 1 (right-aligned, fills from right to left)
    this.p1HealthBar.clear();
    this.p1HealthBar.fillStyle(0x222222);
    this.p1HealthBar.fillRoundedRect(BAR_PADDING, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);
    const p1Ratio = Math.max(0, this.displayP1Health / MAX_HEALTH);
    const p1Color = p1Ratio > 0.3 ? 0x44cc44 : p1Ratio > 0.15 ? 0xcccc44 : 0xcc4444;
    this.p1HealthBar.fillStyle(p1Color);
    this.p1HealthBar.fillRoundedRect(
      BAR_PADDING + BAR_WIDTH * (1 - p1Ratio),
      BAR_Y,
      BAR_WIDTH * p1Ratio,
      BAR_HEIGHT,
      4,
    );
    this.p1HealthBar.lineStyle(2, 0xffffff, 0.6);
    this.p1HealthBar.strokeRoundedRect(BAR_PADDING, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);

    // Player 2 (anchored right, drains toward center)
    const p2BarX = GAME_WIDTH - BAR_PADDING - BAR_WIDTH;
    this.p2HealthBar.clear();
    this.p2HealthBar.fillStyle(0x222222);
    this.p2HealthBar.fillRoundedRect(p2BarX, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);
    const p2Ratio = Math.max(0, this.displayP2Health / MAX_HEALTH);
    const p2Color = p2Ratio > 0.3 ? 0x44cc44 : p2Ratio > 0.15 ? 0xcccc44 : 0xcc4444;
    this.p2HealthBar.fillStyle(p2Color);
    this.p2HealthBar.fillRoundedRect(p2BarX, BAR_Y, BAR_WIDTH * p2Ratio, BAR_HEIGHT, 4);
    this.p2HealthBar.lineStyle(2, 0xffffff, 0.6);
    this.p2HealthBar.strokeRoundedRect(p2BarX, BAR_Y, BAR_WIDTH, BAR_HEIGHT, 4);
  }
}
