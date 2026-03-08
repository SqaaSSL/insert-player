import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';

const FONT = '"Press Start 2P", monospace';
const ACCENT = '#ff4444';
const ACCENT_HEX = 0xff4444;

interface MenuItem {
  label: string;
  enabled: boolean;
  action: () => void;
}

export class TitleScene extends Phaser.Scene {
  private menuItems: MenuItem[] = [];
  private menuTexts: Phaser.GameObjects.Text[] = [];
  private selector!: Phaser.GameObjects.Text;
  private selectedIndex = 0;
  private pressStartText!: Phaser.GameObjects.Text;
  private titleText!: Phaser.GameObjects.Text;
  private titleGlow!: Phaser.GameObjects.Text;
  private sparkParticles!: Phaser.GameObjects.Particles.ParticleEmitter;
  private floorLine!: Phaser.GameObjects.Graphics;
  private menuActive = false;
  private transitioning = false;
  private elapsedMs = 0;

  constructor() {
    super({ key: 'TitleScene' });
  }

  create(): void {
    this.selectedIndex = 0;
    this.menuActive = false;
    this.transitioning = false;
    this.elapsedMs = 0;

    this.drawBackground();
    this.drawScanlines();
    this.createTitle();
    this.createPressStart();
    this.createMenu();
    this.createSparkParticles();
    this.createVersionText();
    this.setupInput();

    this.cameras.main.fadeIn(500, 0, 0, 0);
  }

  private drawBackground(): void {
    const bg = this.add.graphics().setDepth(0);

    for (let y = 0; y < GAME_HEIGHT; y++) {
      const t = y / GAME_HEIGHT;
      const r = Math.floor(10 + t * 15);
      const g = Math.floor(2 + t * 5);
      const b = Math.floor(5 + t * 20);
      bg.fillStyle(Phaser.Display.Color.GetColor(r, g, b));
      bg.fillRect(0, y, GAME_WIDTH, 1);
    }

    bg.lineStyle(1, 0xffffff, 0.03);
    for (let x = 0; x < GAME_WIDTH; x += 40) {
      bg.lineBetween(x, 0, x, GAME_HEIGHT);
    }
    for (let y = 0; y < GAME_HEIGHT; y += 40) {
      bg.lineBetween(0, y, GAME_WIDTH, y);
    }

    this.floorLine = this.add.graphics().setDepth(1);
  }

  private drawScanlines(): void {
    const scanlines = this.add.graphics().setDepth(90);
    scanlines.fillStyle(0x000000, 0.08);
    for (let y = 0; y < GAME_HEIGHT; y += 4) {
      scanlines.fillRect(0, y, GAME_WIDTH, 2);
    }
  }

  private createTitle(): void {
    const titleY = 120;

    this.titleGlow = this.add.text(GAME_WIDTH / 2, titleY, 'AI STREET FIGHTER', {
      fontFamily: FONT,
      fontSize: '42px',
      color: ACCENT,
      stroke: '#ff0000',
      strokeThickness: 12,
    }).setOrigin(0.5).setDepth(9).setAlpha(0.3);

    this.titleText = this.add.text(GAME_WIDTH / 2, titleY, 'AI STREET FIGHTER', {
      fontFamily: FONT,
      fontSize: '42px',
      color: '#ffffff',
      stroke: ACCENT,
      strokeThickness: 6,
    }).setOrigin(0.5).setDepth(10);

    const subtitle = this.add.text(GAME_WIDTH / 2, titleY + 50, '~ WORLD WARRIOR ~', {
      fontFamily: FONT,
      fontSize: '12px',
      color: '#ff8844',
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(10);

    this.titleText.setScale(2).setAlpha(0);
    this.titleGlow.setScale(2).setAlpha(0);
    subtitle.setAlpha(0);

    this.tweens.add({
      targets: [this.titleText, this.titleGlow],
      scaleX: 1,
      scaleY: 1,
      alpha: { value: 1, ease: 'Linear' },
      duration: 600,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.titleGlow.setAlpha(0.3);
        this.cameras.main.shake(150, 0.01);
      },
    });

    this.tweens.add({
      targets: subtitle,
      alpha: 1,
      duration: 400,
      delay: 700,
    });

    this.tweens.add({
      targets: this.titleGlow,
      alpha: { from: 0.15, to: 0.45 },
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
      delay: 800,
    });
  }

  private createPressStart(): void {
    this.pressStartText = this.add.text(GAME_WIDTH / 2, 320, 'CLICK OR PRESS ENTER', {
      fontFamily: FONT,
      fontSize: '16px',
      color: '#ffcc00',
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(10).setAlpha(0)
      .setInteractive({ useHandCursor: true });

    this.pressStartText.on('pointerdown', () => {
      if (this.transitioning) return;
      if (!this.menuActive) this.showMenu();
    });

    this.tweens.add({
      targets: this.pressStartText,
      alpha: 1,
      duration: 500,
      delay: 1200,
      onComplete: () => {
        this.tweens.add({
          targets: this.pressStartText,
          alpha: { from: 1, to: 0.15 },
          duration: 600,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      },
    });
  }

  private createMenu(): void {
    this.menuItems = [
      { label: 'VS CPU', enabled: true, action: () => this.goToRoster(true) },
      { label: 'VS PLAYER', enabled: true, action: () => this.goToRoster(false) },
      { label: 'CPU vs CPU', enabled: true, action: () => this.goToRoster(true, true) },
      { label: 'GALLERY', enabled: true, action: () => this.goToScene('GalleryScene') },
      { label: 'ONLINE', enabled: false, action: () => this.showComingSoon() },
    ];

    const startY = 280;
    const spacing = 36;

    this.menuTexts = this.menuItems.map((item, i) => {
      const text = this.add.text(GAME_WIDTH / 2 + 10, startY + i * spacing, item.label, {
        fontFamily: FONT,
        fontSize: '18px',
        color: item.enabled ? '#cccccc' : '#555555',
        stroke: '#000000',
        strokeThickness: 3,
      }).setOrigin(0.5).setDepth(10).setAlpha(0).setVisible(false)
        .setInteractive({ useHandCursor: true });

      text.on('pointerover', () => {
        if (!this.menuActive || this.transitioning) return;
        this.selectedIndex = i;
        this.updateSelector();
      });
      text.on('pointerdown', () => {
        if (!this.menuActive || this.transitioning) return;
        this.selectedIndex = i;
        this.updateSelector();
        this.confirmSelection();
      });

      return text;
    });

    this.selector = this.add.text(0, 0, '\u25B6', {
      fontFamily: FONT,
      fontSize: '16px',
      color: ACCENT,
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(10).setAlpha(0).setVisible(false);
  }

  private showMenu(): void {
    if (this.menuActive) return;
    this.menuActive = true;

    this.tweens.killTweensOf(this.pressStartText);
    this.tweens.add({
      targets: this.pressStartText,
      alpha: 0,
      duration: 200,
    });

    this.menuTexts.forEach((text, i) => {
      text.setVisible(true);
      this.tweens.add({
        targets: text,
        alpha: 1,
        duration: 300,
        delay: i * 100,
      });
    });

    this.selector.setVisible(true);
    this.tweens.add({
      targets: this.selector,
      alpha: 1,
      duration: 300,
    });

    this.updateSelector();
  }

  private updateSelector(): void {
    const target = this.menuTexts[this.selectedIndex];
    if (!target) return;

    const halfWidth = target.displayWidth / 2;
    this.selector.setPosition(target.x - halfWidth - 20, target.y);

    this.tweens.killTweensOf(this.selector);
    this.selector.setAlpha(1);
    this.tweens.add({
      targets: this.selector,
      alpha: { from: 1, to: 0.3 },
      duration: 400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.menuTexts.forEach((text, i) => {
      const item = this.menuItems[i];
      if (i === this.selectedIndex) {
        text.setColor(item.enabled ? '#ffffff' : '#777777');
        text.setScale(1.05);
      } else {
        text.setColor(item.enabled ? '#888888' : '#444444');
        text.setScale(1);
      }
    });
  }

  private createSparkParticles(): void {
    this.sparkParticles = this.add.particles(0, 0, 'spark', {
      x: { min: 100, max: GAME_WIDTH - 100 },
      y: { min: 80, max: 160 },
      speed: { min: 10, max: 40 },
      angle: { min: -180, max: 0 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.8, end: 0 },
      lifespan: { min: 600, max: 1200 },
      frequency: 200,
      tint: [ACCENT_HEX, 0xff8844, 0xffcc44, 0xffffff],
      gravityY: -20,
      emitting: true,
    }).setDepth(8);
  }

  private createVersionText(): void {
    this.add.text(GAME_WIDTH - 12, GAME_HEIGHT - 12, 'v0.1.0 ALPHA', {
      fontFamily: FONT,
      fontSize: '8px',
      color: '#555555',
    }).setOrigin(1, 1).setDepth(10);
  }

  private setupInput(): void {
    const enterKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    const upKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    const downKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);

    enterKey.on('down', () => {
      if (this.transitioning) return;
      if (!this.menuActive) {
        this.showMenu();
        return;
      }
      this.confirmSelection();
    });

    upKey.on('down', () => {
      if (!this.menuActive || this.transitioning) return;
      this.selectedIndex = (this.selectedIndex - 1 + this.menuItems.length) % this.menuItems.length;
      this.updateSelector();
    });

    downKey.on('down', () => {
      if (!this.menuActive || this.transitioning) return;
      this.selectedIndex = (this.selectedIndex + 1) % this.menuItems.length;
      this.updateSelector();
    });
  }

  private confirmSelection(): void {
    const item = this.menuItems[this.selectedIndex];
    if (!item) return;
    item.action();
  }

  private showComingSoon(): void {
    const text = this.menuTexts[this.selectedIndex];
    if (!text) return;

    const popup = this.add.text(text.x + text.displayWidth / 2 + 16, text.y, 'COMING SOON', {
      fontFamily: FONT,
      fontSize: '10px',
      color: ACCENT,
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(0, 0.5).setDepth(20);

    this.tweens.add({
      targets: popup,
      alpha: 0,
      y: text.y - 15,
      duration: 1500,
      ease: 'Power2',
      onComplete: () => popup.destroy(),
    });
  }

  private goToScene(sceneKey: string): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.sparkParticles.stop();
    this.cameras.main.fadeOut(400, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.start(sceneKey);
    });
  }

  private goToRoster(vsAI = true, cpuVsCpu = false): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.sparkParticles.stop();
    this.cameras.main.fadeOut(400, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.start('RosterScene', { vsAI, cpuVsCpu });
    });
  }

  update(_time: number, delta: number): void {
    this.elapsedMs += delta;

    const cycle = Math.sin(this.elapsedMs * 0.002) * 0.5 + 0.5;
    const lineAlpha = 0.2 + cycle * 0.4;
    this.floorLine.clear();
    this.floorLine.lineStyle(2, ACCENT_HEX, lineAlpha);
    this.floorLine.lineBetween(0, GAME_HEIGHT - 60, GAME_WIDTH, GAME_HEIGHT - 60);
  }
}
