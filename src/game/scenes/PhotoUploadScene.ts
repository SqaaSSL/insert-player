import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';
import { getAllCachedMetas, CACHE_VERSION, type CachedMeta } from '../../services/SpriteCache.ts';

const FONT = '"Press Start 2P", monospace';
const ACCENT = '#ff4444';

interface UploadSlot {
  label: string;
  file: File | null;
  photoHash: string | null;
  characterName: string;
  spriteKey: string;
  ready: boolean;
  generating: boolean;
}

interface InitData {
  completedSlot?: number;
  photoHash?: string;
  characterName?: string;
  vsAI?: boolean;
  cpuVsCpu?: boolean;
}

export class PhotoUploadScene extends Phaser.Scene {
  private slots: UploadSlot[] = [];
  private selectedSlot = 0;
  private fileInput!: HTMLInputElement;
  private dropZones: Phaser.GameObjects.Graphics[] = [];
  private previewSprites: (Phaser.GameObjects.Image | null)[] = [null, null];
  private statusTexts: Phaser.GameObjects.Text[] = [];
  private progressTexts: Phaser.GameObjects.Text[] = [];
  private progressBars: Phaser.GameObjects.Graphics[] = [];
  private fightButton!: Phaser.GameObjects.Text;
  private cachedMetas: CachedMeta[] = [];
  private rosterContainer: Phaser.GameObjects.Container | null = null;
  private nameInputs: HTMLInputElement[] = [];
  private nameTexts: Phaser.GameObjects.Text[] = [];
  private vsAI = true;
  private cpuVsCpu = false;

  constructor() {
    super({ key: 'PhotoUploadScene' });
  }

  init(data?: InitData): void {
    if (data?.vsAI !== undefined) {
      this.vsAI = data.vsAI;
    }
    if (data?.cpuVsCpu !== undefined) {
      this.cpuVsCpu = data.cpuVsCpu;
    }
    if (data?.completedSlot !== undefined && data.photoHash) {
      const slotIdx = data.completedSlot;
      if (slotIdx >= 0 && slotIdx < 2) {
        this.slots[slotIdx] = this.slots[slotIdx] || {} as UploadSlot;
        this.slots[slotIdx].photoHash = data.photoHash;
        this.slots[slotIdx].characterName = data.characterName || 'Fighter';
        this.slots[slotIdx].ready = true;
        this.slots[slotIdx].generating = false;
      }
    }
  }

  async create(): Promise<void> {
    const prevSlots = this.slots.length === 2
      ? this.slots.map((s) => ({ photoHash: s.photoHash, characterName: s.characterName, ready: s.ready }))
      : null;

    this.slots = [
      { label: this.cpuVsCpu ? 'CPU 1' : 'PLAYER 1', file: null, photoHash: null, characterName: this.cpuVsCpu ? 'CPU 1' : 'Player 1', spriteKey: 'fighter_p1', ready: false, generating: false },
      { label: this.cpuVsCpu ? 'CPU 2' : (this.vsAI ? 'CPU' : 'PLAYER 2'), file: null, photoHash: null, characterName: this.cpuVsCpu ? 'CPU 2' : (this.vsAI ? 'CPU' : 'Player 2'), spriteKey: 'fighter_p2', ready: false, generating: false },
    ];

    if (prevSlots) {
      for (let i = 0; i < 2; i++) {
        if (prevSlots[i]?.ready && prevSlots[i].photoHash) {
          this.slots[i].photoHash = prevSlots[i].photoHash;
          this.slots[i].characterName = prevSlots[i].characterName;
          this.slots[i].ready = true;
        }
      }
    }

    this.selectedSlot = 0;
    this.dropZones = [];
    this.previewSprites = [null, null];
    this.statusTexts = [];
    this.progressTexts = [];
    this.progressBars = [];
    this.nameTexts = [];
    this.rosterContainer = null;
    this.cleanupNameInputs();

    this.drawBackground();
    this.createTitle();
    this.createDropZones();
    this.createButtons();
    this.createFileInput();
    this.setupInput();

    this.cameras.main.fadeIn(400, 0, 0, 0);

    for (let i = 0; i < 2; i++) {
      if (this.slots[i].ready && this.slots[i].photoHash) {
        this.statusTexts[i].setText('AI SPRITES\nREADY!').setColor('#44ff44');
        this.progressTexts[i].setText('');
        this.nameTexts[i].setText(this.slots[i].characterName.toUpperCase());
        if (this.nameInputs[i]) {
          this.nameInputs[i].value = this.slots[i].characterName;
          this.showNameInput(i);
        }
      }
    }

    await this.loadCachedRoster();
  }

  private drawBackground(): void {
    const bg = this.add.graphics().setDepth(0);
    for (let y = 0; y < GAME_HEIGHT; y++) {
      const t = y / GAME_HEIGHT;
      const r = Math.floor(8 + t * 12);
      const g = Math.floor(2 + t * 6);
      const b = Math.floor(15 + t * 20);
      bg.fillStyle(Phaser.Display.Color.GetColor(r, g, b));
      bg.fillRect(0, y, GAME_WIDTH, 1);
    }

    const scanlines = this.add.graphics().setDepth(90);
    scanlines.fillStyle(0x000000, 0.06);
    for (let y = 0; y < GAME_HEIGHT; y += 4) {
      scanlines.fillRect(0, y, GAME_WIDTH, 2);
    }
  }

  private createTitle(): void {
    this.add.text(GAME_WIDTH / 2, 36, 'CHOOSE YOUR FIGHTERS', {
      fontFamily: FONT,
      fontSize: '22px',
      color: '#ffffff',
      stroke: ACCENT,
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(10);

    this.add.text(GAME_WIDTH / 2, 64, 'Upload photos to generate AI fighters', {
      fontFamily: FONT,
      fontSize: '9px',
      color: '#888888',
    }).setOrigin(0.5).setDepth(10);
  }

  private getZoneX(i: number, zoneW: number, gap: number): number {
    return i === 0
      ? GAME_WIDTH / 2 - gap / 2 - zoneW
      : GAME_WIDTH / 2 + gap / 2;
  }

  private createDropZones(): void {
    const zoneW = 260;
    const zoneH = 310;
    const startY = 90;
    const gap = 60;

    for (let i = 0; i < 2; i++) {
      const x = this.getZoneX(i, zoneW, gap);
      const y = startY;

      this.add.text(x + zoneW / 2, y - 8, this.slots[i].label, {
        fontFamily: FONT,
        fontSize: '13px',
        color: i === 0 ? '#4488dd' : '#dd4444',
        stroke: '#000000',
        strokeThickness: 3,
      }).setOrigin(0.5).setDepth(10);

      const gfx = this.add.graphics().setDepth(5);
      this.drawZone(gfx, x, y, zoneW, zoneH, i === this.selectedSlot);
      this.dropZones.push(gfx);

      const statusText = this.add.text(x + zoneW / 2, y + 120, 'CLICK TO\nUPLOAD\nPHOTO', {
        fontFamily: FONT,
        fontSize: '11px',
        color: '#555555',
        align: 'center',
        lineSpacing: 8,
      }).setOrigin(0.5).setDepth(15);
      this.statusTexts.push(statusText);

      const progressText = this.add.text(x + zoneW / 2, y + zoneH - 60, '', {
        fontFamily: FONT,
        fontSize: '7px',
        color: '#aaaaaa',
        align: 'center',
        wordWrap: { width: zoneW - 20 },
      }).setOrigin(0.5).setDepth(15);
      this.progressTexts.push(progressText);

      const progressBar = this.add.graphics().setDepth(15);
      this.progressBars.push(progressBar);

      const nameText = this.add.text(x + zoneW / 2, y + zoneH - 24, '', {
        fontFamily: FONT,
        fontSize: '9px',
        color: '#ffcc00',
        align: 'center',
      }).setOrigin(0.5).setDepth(15);
      this.nameTexts.push(nameText);

      this.createNameInput(i, x, y + zoneH - 24, zoneW);

      const hitArea = this.add.rectangle(x + zoneW / 2, y + zoneH / 2, zoneW, zoneH)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true })
        .setDepth(20)
        .setAlpha(0.001);

      hitArea.on('pointerdown', () => {
        if (this.slots[i].generating) return;
        this.selectedSlot = i;
        this.updateSelection();
        this.openFileDialog();
      });
    }
  }

  private drawZone(gfx: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, selected: boolean): void {
    gfx.clear();
    gfx.fillStyle(0x111122, 0.8);
    gfx.fillRoundedRect(x, y, w, h, 8);
    gfx.lineStyle(2, selected ? 0xff4444 : 0x333355);
    gfx.strokeRoundedRect(x, y, w, h, 8);

    if (selected) {
      gfx.lineStyle(1, 0xff4444, 0.3);
      gfx.strokeRoundedRect(x - 2, y - 2, w + 4, h + 4, 10);
    }
  }

  private createButtons(): void {
    const btnY = GAME_HEIGHT - 40;

    const backButton = this.add.text(80, btnY, '< BACK', {
      fontFamily: FONT,
      fontSize: '13px',
      color: '#888888',
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });
    backButton.on('pointerover', () => backButton.setColor('#ffffff'));
    backButton.on('pointerout', () => backButton.setColor('#888888'));
    backButton.on('pointerdown', () => this.goBack());

    const createBtn = this.add.text(GAME_WIDTH / 2, btnY, '+ CREATE NEW FIGHTER', {
      fontFamily: FONT,
      fontSize: '12px',
      color: '#44ff44',
      stroke: '#000000',
      strokeThickness: 4,
      backgroundColor: '#0a2a0a',
      padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });
    createBtn.on('pointerover', () => createBtn.setColor('#88ff88'));
    createBtn.on('pointerout', () => createBtn.setColor('#44ff44'));
    createBtn.on('pointerdown', () => this.openFileDialog());

    this.fightButton = this.add.text(GAME_WIDTH - 100, btnY, 'FIGHT! >', {
      fontFamily: FONT,
      fontSize: '16px',
      color: ACCENT,
      stroke: '#000000',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });

    this.tweens.add({
      targets: this.fightButton,
      alpha: { from: 1, to: 0.4 },
      duration: 600,
      yoyo: true,
      repeat: -1,
    });

    this.fightButton.on('pointerover', () => this.fightButton.setScale(1.1));
    this.fightButton.on('pointerout', () => this.fightButton.setScale(1));
    this.fightButton.on('pointerdown', () => this.startFight());
  }

  private createNameInput(slotIndex: number, x: number, y: number, zoneW: number): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Name your fighter...';
    input.maxLength = 16;
    input.style.cssText = `
      position: absolute;
      display: none;
      width: ${zoneW - 40}px;
      left: ${x + 20}px;
      top: ${y - 10}px;
      background: rgba(0,0,0,0.85);
      border: 1px solid #ffcc00;
      border-radius: 4px;
      color: #ffcc00;
      font-family: 'Press Start 2P', monospace;
      font-size: 8px;
      padding: 4px 8px;
      text-align: center;
      outline: none;
      z-index: 100;
      pointer-events: auto;
    `;

    input.addEventListener('input', () => {
      this.slots[slotIndex].characterName = input.value || (slotIndex === 0 ? 'Player 1' : 'CPU');
      this.nameTexts[slotIndex].setText(input.value.toUpperCase());
    });

    for (const evt of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'] as const) {
      input.addEventListener(evt, (e) => e.stopPropagation());
    }

    const wrapper = document.getElementById('game-wrapper');
    if (wrapper) wrapper.appendChild(input);
    else document.body.appendChild(input);

    this.nameInputs.push(input);
  }

  private showNameInput(slotIndex: number): void {
    const input = this.nameInputs[slotIndex];
    if (input) {
      input.style.display = 'block';
    }
  }

  private cleanupNameInputs(): void {
    for (const input of this.nameInputs) {
      input.parentNode?.removeChild(input);
    }
    this.nameInputs = [];
  }

  private createFileInput(): void {
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/png,image/jpeg,image/webp';
    this.fileInput.style.display = 'none';
    document.body.appendChild(this.fileInput);

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) {
        this.handleFile(file, this.selectedSlot);
      }
      this.fileInput.value = '';
    });
  }

  private setupInput(): void {
    const escKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    const enterKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    const leftKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    const rightKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);

    escKey.on('down', () => this.goBack());
    enterKey.on('down', () => this.startFight());
    leftKey.on('down', () => {
      if (!this.slots[0].generating) { this.selectedSlot = 0; this.updateSelection(); }
    });
    rightKey.on('down', () => {
      if (!this.slots[1].generating) { this.selectedSlot = 1; this.updateSelection(); }
    });
  }

  private updateSelection(): void {
    const zoneW = 260;
    const zoneH = 310;
    const gap = 60;
    const startY = 90;

    for (let i = 0; i < 2; i++) {
      const x = this.getZoneX(i, zoneW, gap);
      this.drawZone(this.dropZones[i], x, startY, zoneW, zoneH, i === this.selectedSlot);
    }
  }

  private openFileDialog(): void {
    this.fileInput.click();
  }

  private async handleFile(file: File, slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    if (slot.generating) return;

    slot.file = file;

    const img = await this.loadImage(file);
    this.showPreview(img, slotIndex);
    this.showNameInput(slotIndex);

    const nameFromFile = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    if (nameFromFile && nameFromFile.length <= 16) {
      slot.characterName = nameFromFile;
      this.nameTexts[slotIndex].setText(nameFromFile.toUpperCase());
      if (this.nameInputs[slotIndex]) {
        this.nameInputs[slotIndex].value = nameFromFile;
      }
    }

    this.cleanup();
    this.scene.start('CharacterCreationScene', {
      file,
      characterName: slot.characterName,
      slotIndex,
      returnScene: 'PhotoUploadScene',
    } as any);
  }

  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private showPreview(img: HTMLImageElement, slotIndex: number): void {
    const zoneW = 260;
    const gap = 60;
    const startY = 90;
    const x = this.getZoneX(slotIndex, zoneW, gap);

    const canvas = document.createElement('canvas');
    const previewSize = 180;
    canvas.width = previewSize;
    canvas.height = previewSize;
    const ctx = canvas.getContext('2d')!;

    const scale = Math.min(previewSize / img.width, previewSize / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, (previewSize - dw) / 2, (previewSize - dh) / 2, dw, dh);

    const texKey = `preview_${slotIndex}`;
    if (this.textures.exists(texKey)) this.textures.remove(texKey);
    this.textures.addCanvas(texKey, canvas);

    if (this.previewSprites[slotIndex]) {
      this.previewSprites[slotIndex]!.destroy();
    }

    this.previewSprites[slotIndex] = this.add.image(
      x + zoneW / 2, startY + 130, texKey
    ).setDepth(12).setScale(0.85);

    this.tweens.add({
      targets: this.previewSprites[slotIndex],
      scaleX: { from: 0, to: 0.85 },
      scaleY: { from: 0, to: 0.85 },
      duration: 300,
      ease: 'Back.easeOut',
    });
  }

  private async loadCachedRoster(): Promise<void> {
    try {
      const metas = await getAllCachedMetas();
      this.cachedMetas = metas.filter((m) => m.status === 'ready' && m.version === CACHE_VERSION);
    } catch {
      this.cachedMetas = [];
    }

    if (this.cachedMetas.length === 0) return;

    const container = this.add.container(0, 0).setDepth(15);
    this.rosterContainer = container;

    const rosterY = 460;
    const label = this.add.text(GAME_WIDTH / 2, rosterY - 10, 'SAVED FIGHTERS (click to select)', {
      fontFamily: FONT,
      fontSize: '7px',
      color: '#666666',
    }).setOrigin(0.5);
    container.add(label);

    const thumbSize = 40;
    const thumbGap = 8;
    const totalW = this.cachedMetas.length * (thumbSize + thumbGap) - thumbGap;
    const startX = GAME_WIDTH / 2 - totalW / 2;

    for (let i = 0; i < this.cachedMetas.length; i++) {
      const meta = this.cachedMetas[i];
      const tx = startX + i * (thumbSize + thumbGap) + thumbSize / 2;
      const ty = rosterY + thumbSize / 2 + 4;

      const border = this.add.graphics().setDepth(15);
      border.lineStyle(2, 0x444466);
      border.strokeRoundedRect(tx - thumbSize / 2 - 2, ty - thumbSize / 2 - 2, thumbSize + 4, thumbSize + 4, 4);
      container.add(border);

      const hitArea = this.add.rectangle(tx, ty, thumbSize + 4, thumbSize + 4)
        .setInteractive({ useHandCursor: true })
        .setAlpha(0.001)
        .setDepth(20);
      container.add(hitArea);

      hitArea.on('pointerover', () => {
        border.clear();
        border.lineStyle(2, 0xff4444);
        border.strokeRoundedRect(tx - thumbSize / 2 - 2, ty - thumbSize / 2 - 2, thumbSize + 4, thumbSize + 4, 4);
      });
      hitArea.on('pointerout', () => {
        border.clear();
        border.lineStyle(2, 0x444466);
        border.strokeRoundedRect(tx - thumbSize / 2 - 2, ty - thumbSize / 2 - 2, thumbSize + 4, thumbSize + 4, 4);
      });
      hitArea.on('pointerdown', () => {
        this.selectCachedCharacter(meta.photoHash);
      });

      this.loadRosterThumbnail(meta, tx, ty, thumbSize, container);
    }
  }

  private async loadRosterThumbnail(
    meta: CachedMeta,
    x: number,
    y: number,
    size: number,
    container: Phaser.GameObjects.Container,
  ): Promise<void> {
    const blob = meta.originalPhotoBlob ?? meta.sideViewBlob;
    if (!blob) return;

    try {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.min(size / img.width, size / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);

        const texKey = `roster_${meta.photoHash.slice(0, 8)}`;
        if (this.textures.exists(texKey)) this.textures.remove(texKey);
        this.textures.addCanvas(texKey, canvas);

        const sprite = this.add.image(x, y, texKey).setDepth(16);
        container.add(sprite);
      };
      img.src = url;

      if (meta.characterName) {
        const nameLabel = this.add.text(x, y + size / 2 + 8, meta.characterName.toUpperCase(), {
          fontFamily: FONT,
          fontSize: '5px',
          color: '#aaaaaa',
        }).setOrigin(0.5).setDepth(16);
        container.add(nameLabel);
      }
    } catch {
      // Thumbnail load failed
    }
  }

  private selectCachedCharacter(photoHash: string): void {
    const slot = this.slots[this.selectedSlot];
    if (slot.generating) return;

    const meta = this.cachedMetas.find((m) => m.photoHash === photoHash);
    const name = meta?.characterName || `Fighter #${photoHash.slice(0, 6)}`;

    slot.photoHash = photoHash;
    slot.characterName = name;
    slot.ready = true;
    slot.generating = false;
    this.statusTexts[this.selectedSlot].setText('SAVED\nFIGHTER').setColor('#44ff44');
    this.progressTexts[this.selectedSlot].setText('');
    this.nameTexts[this.selectedSlot].setText(name.toUpperCase());

    if (this.nameInputs[this.selectedSlot]) {
      this.nameInputs[this.selectedSlot].value = name;
      this.showNameInput(this.selectedSlot);
    }

    const blob = meta?.originalPhotoBlob ?? meta?.sideViewBlob;
    if (blob) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        this.showPreview(img, this.selectedSlot);
      };
      img.src = url;
    }
  }

  private goBack(): void {
    if (this.slots.some(s => s.generating)) return;
    this.cameras.main.fadeOut(300, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.cleanup();
      this.scene.start('TitleScene');
    });
  }

  private startFight(): void {
    if (this.slots.some(s => s.generating)) return;

    this.cameras.main.flash(300, 255, 68, 68);
    this.time.delayedCall(300, () => {
      this.cameras.main.fadeOut(400, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this.cleanup();
        this.scene.start('FightScene', {
          vsAI: this.vsAI,
          cpuVsCpu: this.cpuVsCpu,
          p1PhotoHash: this.slots[0].photoHash,
          p2PhotoHash: this.slots[1].photoHash,
          p1Name: this.slots[0].characterName,
          p2Name: this.slots[1].characterName,
        });
      });
    });
  }

  private cleanup(): void {
    if (this.fileInput?.parentNode) {
      this.fileInput.parentNode.removeChild(this.fileInput);
    }
    this.cleanupNameInputs();
  }

  shutdown(): void {
    this.cleanup();
  }
}
