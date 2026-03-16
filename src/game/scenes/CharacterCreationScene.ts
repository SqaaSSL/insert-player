import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';
import { processCharacter, getAnimationList, type PipelineStatus } from '../../services/CharacterPipeline.ts';
import { getCachedSprite, getCachedMeta, getAllSpritesForHash, type CachedSprite } from '../../services/SpriteCache.ts';

const FONT = '"Press Start 2P", monospace';
const W = GAME_WIDTH;
const H = GAME_HEIGHT;

// Layout zones
const HEADER_Y = 22;
const STAGE_Y = 46;

const PHOTO_X = 80;
const PHOTO_Y = 130;
const PHOTO_SIZE = 90;

const GRID_X = 170;
const GRID_TOP = 74;
const GRID_CELL_W = 76;
const GRID_CELL_H = 52;
const GRID_COLS = 5;

const PREVIEW_X = 790;
const PREVIEW_Y = 260;
const PREVIEW_BOX = 300;

const SIDE_Y = 240;
const CROUCH_Y = 350;
const SIDE_SIZE = 70;

const PROGRESS_Y = H - 56;
const BAR_Y = H - 36;
const CONTROLS_Y = H - 18;

interface SceneData {
  file: File;
  characterName: string;
  slotIndex: number;
  returnScene: string;
}

interface AnimSlot {
  name: string;
  label: string;
  status: 'pending' | 'generating' | 'ready' | 'error';
  sprite?: Phaser.GameObjects.Sprite;
  frames?: number;
}

export class CharacterCreationScene extends Phaser.Scene {
  private sceneData!: SceneData;
  private animSlots: AnimSlot[] = [];
  private statusText!: Phaser.GameObjects.Text;
  private stageText!: Phaser.GameObjects.Text;
  private photoPreview: Phaser.GameObjects.Image | null = null;
  private resultHash: string | null = null;
  private pipelineError: string | null = null;
  private previewContainer!: Phaser.GameObjects.Container;
  private selectedAnimIndex = 0;
  private bigPreviewSprite: Phaser.GameObjects.Sprite | null = null;
  private bigPreviewBg!: Phaser.GameObjects.Graphics;
  private animNameText!: Phaser.GameObjects.Text;
  private progressBar!: Phaser.GameObjects.Graphics;
  private totalAnims = 0;
  private completedAnims = 0;
  private downloadBtn!: Phaser.GameObjects.Text;
  private downloadAllBtn!: Phaser.GameObjects.Text;
  private currentPreviewBlob: Blob | null = null;
  private currentPreviewAnimName = '';
  private sideViewImage: Phaser.GameObjects.Image | null = null;
  private crouchViewImage: Phaser.GameObjects.Image | null = null;
  private dynamicObjects: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super({ key: 'CharacterCreationScene' });
  }

  init(data: SceneData): void {
    this.sceneData = data;
    this.animSlots = [];
    this.resultHash = null;
    this.pipelineError = null;
    this.selectedAnimIndex = 0;
    this.bigPreviewSprite = null;
    this.completedAnims = 0;
    this.currentPreviewBlob = null;
    this.currentPreviewAnimName = '';
    this.sideViewImage = null;
    this.crouchViewImage = null;
    this.dynamicObjects = [];
  }

  async create(): Promise<void> {
    this.drawBackground();
    this.createHeader();
    this.createPhotoPreview();
    this.createSideViewPanels();
    this.createAnimGrid();
    this.createBigPreview();
    this.createProgressSection();
    this.createControls();

    this.cameras.main.fadeIn(300, 0, 0, 0);
    this.runPipeline();
  }

  private drawBackground(): void {
    const bg = this.add.graphics().setDepth(0);
    for (let y = 0; y < H; y++) {
      const t = y / H;
      const r = Math.floor(5 + t * 8);
      const g = Math.floor(2 + t * 8);
      const b = Math.floor(12 + t * 22);
      bg.fillStyle(Phaser.Display.Color.GetColor(r, g, b));
      bg.fillRect(0, y, W, 1);
    }
    const scanlines = this.add.graphics().setDepth(1);
    scanlines.fillStyle(0x000000, 0.04);
    for (let y = 0; y < H; y += 4) scanlines.fillRect(0, y, W, 2);
  }

  private createHeader(): void {
    this.add.text(W / 2, HEADER_Y, 'FORGING YOUR FIGHTER', {
      fontFamily: FONT, fontSize: '16px', color: '#ff4444',
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(10);

    this.stageText = this.add.text(W / 2, STAGE_Y, '', {
      fontFamily: FONT, fontSize: '8px', color: '#aaaaaa',
    }).setOrigin(0.5).setDepth(10);
  }

  private createPhotoPreview(): void {
    const file = this.sceneData.file;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = PHOTO_SIZE;
        canvas.height = PHOTO_SIZE;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.min(PHOTO_SIZE / img.width, PHOTO_SIZE / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (PHOTO_SIZE - dw) / 2, (PHOTO_SIZE - dh) / 2, dw, dh);

        const texKey = 'creation_preview_photo';
        if (this.textures.exists(texKey)) this.textures.remove(texKey);
        this.textures.addCanvas(texKey, canvas);

        this.photoPreview = this.add.image(PHOTO_X, PHOTO_Y, texKey).setDepth(10);

        this.add.text(PHOTO_X, PHOTO_Y + PHOTO_SIZE / 2 + 12, this.sceneData.characterName.toUpperCase(), {
          fontFamily: FONT, fontSize: '7px', color: '#ffcc00',
        }).setOrigin(0.5).setDepth(10);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);

    this.add.text(PHOTO_X, PHOTO_Y - PHOTO_SIZE / 2 - 10, 'ORIGINAL', {
      fontFamily: FONT, fontSize: '6px', color: '#666666',
    }).setOrigin(0.5).setDepth(10);
  }

  private createSideViewPanels(): void {
    const panels = [
      { label: 'SIDE VIEW', y: SIDE_Y },
      { label: 'CROUCH', y: CROUCH_Y },
    ];
    for (const p of panels) {
      this.add.text(PHOTO_X, p.y - SIDE_SIZE / 2 - 10, p.label, {
        fontFamily: FONT, fontSize: '6px', color: '#666666',
      }).setOrigin(0.5).setDepth(10);

      const box = this.add.graphics().setDepth(8);
      const half = SIDE_SIZE / 2;
      box.fillStyle(0x0a0a1e, 0.9);
      box.fillRoundedRect(PHOTO_X - half, p.y - half, SIDE_SIZE, SIDE_SIZE, 5);
      box.lineStyle(1, 0x333366, 0.6);
      box.strokeRoundedRect(PHOTO_X - half, p.y - half, SIDE_SIZE, SIDE_SIZE, 5);
    }
  }

  private loadSideViewBlob(blob: Blob, cy: number, keyHint: string): Phaser.GameObjects.Image | null {
    const url = URL.createObjectURL(blob);
    const htmlImg = new Image();
    const isCrouch = keyHint === 'crouchview';
    htmlImg.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = SIDE_SIZE;
      canvas.height = SIDE_SIZE;
      const ctx = canvas.getContext('2d')!;
      const scale = Math.min(SIDE_SIZE / htmlImg.width, SIDE_SIZE / htmlImg.height);
      const dw = htmlImg.width * scale;
      const dh = htmlImg.height * scale;
      ctx.drawImage(htmlImg, (SIDE_SIZE - dw) / 2, (SIDE_SIZE - dh) / 2, dw, dh);

      const texKey = `creation_${keyHint}_${Date.now()}`;
      if (this.textures.exists(texKey)) this.textures.remove(texKey);
      this.textures.addCanvas(texKey, canvas);
      const img = this.add.image(PHOTO_X, cy, texKey).setDepth(11);
      this.dynamicObjects.push(img);
      if (isCrouch) this.crouchViewImage = img;
      else this.sideViewImage = img;
    };
    htmlImg.src = url;
    return null;
  }

  private createAnimGrid(): void {
    const anims = getAnimationList();
    this.totalAnims = anims.length;

    const LABELS: Record<string, string> = {
      idle: 'IDLE', walk: 'WALK',
      high_punch: 'PUNCH', low_punch: 'C.PUNCH',
      high_kick: 'KICK', low_kick: 'C.KICK',
      jump: 'JUMP', crouch: 'CROUCH',
      hit: 'HIT', ko: 'K.O.',
    };

    this.previewContainer = this.add.container(0, 0).setDepth(10);

    for (let i = 0; i < anims.length; i++) {
      const anim = anims[i];
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const cx = GRID_X + col * GRID_CELL_W + GRID_CELL_W / 2;
      const cy = GRID_TOP + row * GRID_CELL_H + GRID_CELL_H / 2;

      const slot: AnimSlot = {
        name: anim.name,
        label: LABELS[anim.name] || anim.name.toUpperCase(),
        status: 'pending',
      };
      this.animSlots.push(slot);

      const bg = this.add.graphics().setDepth(8);
      bg.fillStyle(0x111122, 0.7);
      bg.fillRoundedRect(cx - GRID_CELL_W / 2 + 2, cy - GRID_CELL_H / 2 + 2, GRID_CELL_W - 4, GRID_CELL_H - 4, 4);
      bg.lineStyle(1, 0x333355);
      bg.strokeRoundedRect(cx - GRID_CELL_W / 2 + 2, cy - GRID_CELL_H / 2 + 2, GRID_CELL_W - 4, GRID_CELL_H - 4, 4);
      this.previewContainer.add(bg);

      const label = this.add.text(cx, cy + GRID_CELL_H / 2 - 8, slot.label, {
        fontFamily: FONT, fontSize: '5px', color: '#555555',
      }).setOrigin(0.5).setDepth(12);
      this.previewContainer.add(label);

      const statusIcon = this.add.text(cx, cy - 4, '\u23f3', {
        fontSize: '14px',
      }).setOrigin(0.5).setDepth(12).setName(`status_${i}`);
      this.previewContainer.add(statusIcon);

      const hitArea = this.add.rectangle(cx, cy, GRID_CELL_W - 4, GRID_CELL_H - 4)
        .setInteractive({ useHandCursor: true })
        .setAlpha(0.001)
        .setDepth(15);
      hitArea.on('pointerdown', () => this.selectAnim(i));
      this.previewContainer.add(hitArea);
    }
  }

  private createBigPreview(): void {
    const half = PREVIEW_BOX / 2;

    this.bigPreviewBg = this.add.graphics().setDepth(8);
    this.bigPreviewBg.fillStyle(0x0a0a1a, 0.9);
    this.bigPreviewBg.fillRoundedRect(PREVIEW_X - half, PREVIEW_Y - half, PREVIEW_BOX, PREVIEW_BOX, 8);
    this.bigPreviewBg.lineStyle(2, 0x333366);
    this.bigPreviewBg.strokeRoundedRect(PREVIEW_X - half, PREVIEW_Y - half, PREVIEW_BOX, PREVIEW_BOX, 8);

    this.animNameText = this.add.text(PREVIEW_X, PREVIEW_Y - half - 12, 'SELECT AN ANIMATION', {
      fontFamily: FONT, fontSize: '7px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);

    this.add.text(PREVIEW_X, PREVIEW_Y + half + 10, 'CLICK GRID TO PREVIEW', {
      fontFamily: FONT, fontSize: '5px', color: '#444444',
    }).setOrigin(0.5).setDepth(10);

    this.downloadBtn = this.add.text(PREVIEW_X - 50, PREVIEW_Y + half + 24, 'SAVE PNG', {
      fontFamily: FONT, fontSize: '6px', color: '#44aaff',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadBtn.on('pointerover', () => this.downloadBtn.setColor('#88ccff'));
    this.downloadBtn.on('pointerout', () => this.downloadBtn.setColor('#44aaff'));
    this.downloadBtn.on('pointerdown', () => this.downloadCurrentSprite());

    this.downloadAllBtn = this.add.text(PREVIEW_X + 50, PREVIEW_Y + half + 24, 'SAVE ALL', {
      fontFamily: FONT, fontSize: '6px', color: '#aaaa44',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadAllBtn.on('pointerover', () => this.downloadAllBtn.setColor('#dddd88'));
    this.downloadAllBtn.on('pointerout', () => this.downloadAllBtn.setColor('#aaaa44'));
    this.downloadAllBtn.on('pointerdown', () => this.downloadAllSprites());
  }

  private createProgressSection(): void {
    const barBg = this.add.graphics().setDepth(17);
    barBg.fillStyle(0x000000, 0.7);
    barBg.fillRect(0, H - 70, W, 70);

    this.progressBar = this.add.graphics().setDepth(18);

    this.statusText = this.add.text(W / 2, PROGRESS_Y, 'Starting pipeline...', {
      fontFamily: FONT, fontSize: '7px', color: '#aaaaaa', align: 'center',
    }).setOrigin(0.5).setDepth(18);

    this.drawProgressBar(0);
  }

  private drawProgressBar(pct: number): void {
    const barX = W / 2 - 200;
    const barW = 400;
    const barH = 8;

    this.progressBar.clear();
    this.progressBar.fillStyle(0x111133);
    this.progressBar.fillRoundedRect(barX, BAR_Y, barW, barH, 3);
    if (pct > 0) {
      this.progressBar.fillStyle(0xff4444);
      this.progressBar.fillRoundedRect(barX, BAR_Y, barW * Math.min(pct, 1), barH, 3);
    }
  }

  private createControls(): void {
    const cancelBtn = this.add.text(80, CONTROLS_Y, '< CANCEL', {
      fontFamily: FONT, fontSize: '9px', color: '#666666',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    cancelBtn.on('pointerover', () => cancelBtn.setColor('#ffffff'));
    cancelBtn.on('pointerout', () => cancelBtn.setColor('#666666'));
    cancelBtn.on('pointerdown', () => this.goBack());
  }

  private selectAnim(index: number): void {
    if (index < 0 || index >= this.animSlots.length) return;
    this.selectedAnimIndex = index;
    const slot = this.animSlots[index];

    this.animNameText.setText(slot.label);

    if (this.bigPreviewSprite) {
      this.bigPreviewSprite.destroy();
      this.bigPreviewSprite = null;
    }

    if (slot.status === 'ready' && this.resultHash) {
      this.showBigPreview(slot.name);
    } else {
      this.animNameText.setColor(slot.status === 'generating' ? '#ffaa00' : '#555555');
      this.downloadBtn.setVisible(false);
      this.currentPreviewBlob = null;
    }
  }

  private async buildAnimSpriteSheet(
    cached: CachedSprite,
    texKey: string,
    animKey: string,
    frameRate: number,
  ): Promise<{ frameW: number; frameH: number; frameCount: number }> {
    if (this.textures.exists(texKey)) this.textures.remove(texKey);

    const img = await blobToImage(cached.pngBlob);
    const frameW = cached.frameWidth;
    const frameH = cached.frameHeight;
    const gridCols = Math.round(img.width / frameW);
    const gridRows = Math.round(img.height / frameH);
    const frameCount = Math.min(cached.frameCount, gridCols * gridRows);

    const canvas = document.createElement('canvas');
    canvas.width = frameCount * frameW;
    canvas.height = frameH;
    const ctx = canvas.getContext('2d')!;

    for (let f = 0; f < frameCount; f++) {
      const sc = f % gridCols;
      const sr = Math.floor(f / gridCols);
      ctx.drawImage(img, sc * frameW, sr * frameH, frameW, frameH, f * frameW, 0, frameW, frameH);
    }

    this.textures.addSpriteSheet(texKey, canvas as unknown as HTMLImageElement, {
      frameWidth: frameW, frameHeight: frameH,
    });

    if (this.anims.exists(animKey)) this.anims.remove(animKey);
    this.anims.create({
      key: animKey,
      frames: this.anims.generateFrameNumbers(texKey, { start: 0, end: frameCount - 1 }),
      frameRate, repeat: -1,
    });

    return { frameW, frameH, frameCount };
  }

  private async showBigPreview(animName: string): Promise<void> {
    if (!this.resultHash) return;

    const cached = await getCachedSprite(this.resultHash, animName);
    if (!cached) return;

    this.currentPreviewBlob = cached.pngBlob;
    this.currentPreviewAnimName = animName;

    const texKey = `big_preview_${animName}`;
    const animKey = `big_anim_${animName}`;
    const { frameW, frameH } = await this.buildAnimSpriteSheet(cached, texKey, animKey, 12);

    if (this.bigPreviewSprite) this.bigPreviewSprite.destroy();

    const maxDim = PREVIEW_BOX - 40;
    this.bigPreviewSprite = this.add.sprite(PREVIEW_X, PREVIEW_Y, texKey)
      .setDepth(12)
      .setScale(Math.min(maxDim / frameW, maxDim / frameH));
    this.bigPreviewSprite.play(animKey);

    this.animNameText.setColor('#44ff44');
    this.downloadBtn.setVisible(true);
  }

  private async showSmallPreview(animName: string, slotIndex: number): Promise<void> {
    if (!this.resultHash) return;

    const cached = await getCachedSprite(this.resultHash, animName);
    if (!cached) return;

    const col = slotIndex % GRID_COLS;
    const row = Math.floor(slotIndex / GRID_COLS);
    const cx = GRID_X + col * GRID_CELL_W + GRID_CELL_W / 2;
    const cy = GRID_TOP + row * GRID_CELL_H + GRID_CELL_H / 2 - 4;

    const texKey = `small_preview_${animName}`;
    const animKey = `small_anim_${animName}`;
    const { frameW, frameH } = await this.buildAnimSpriteSheet(cached, texKey, animKey, 8);

    const scale = Math.min(30 / frameW, 30 / frameH);
    const sprite = this.add.sprite(cx, cy, texKey).setDepth(14).setScale(scale);
    sprite.play(animKey);
    this.previewContainer.add(sprite);

    const statusIcon = this.previewContainer.getByName(`status_${slotIndex}`) as Phaser.GameObjects.Text;
    if (statusIcon) statusIcon.setVisible(false);
  }

  private updateGridStatus(slotIndex: number, status: 'pending' | 'generating' | 'ready' | 'error'): void {
    const iconMap = { pending: '\u23f3', generating: '\u26a1', ready: '\u2705', error: '\u274c' };
    const statusIcon = this.previewContainer.getByName(`status_${slotIndex}`) as Phaser.GameObjects.Text;
    if (statusIcon) {
      statusIcon.setText(iconMap[status]);
      statusIcon.setVisible(status !== 'ready');
    }
  }

  private async runPipeline(): Promise<void> {
    try {
      const photoHash = await processCharacter(
        this.sceneData.file,
        (status: PipelineStatus) => this.handleStatus(status),
        this.sceneData.characterName,
      );

      this.resultHash = photoHash;
      this.statusText.setText('ALL SPRITES GENERATED!').setColor('#44ff44');
      this.stageText.setText('Character ready \u2014 select animations to preview');
      this.drawProgressBar(1);

      this.time.delayedCall(1500, () => {
        this.goBackWithResult(photoHash);
      });

    } catch (err: any) {
      console.error('Pipeline error in creation scene:', err);
      this.pipelineError = err.message;
      this.statusText.setText(`ERROR: ${err.message.slice(0, 80)}`).setColor('#ff4444');
      this.stageText.setText('Pipeline failed');
      this.createRetryButton();
    }
  }

  private handleStatus(status: PipelineStatus): void {
    switch (status.stage) {
      case 'hashing':
        this.stageText.setText('Calculating image hash...');
        break;

      case 'cached':
        this.resultHash = status.photoHash;
        this.loadSideViewsFromCache(status.photoHash);
        this.downloadAllBtn.setVisible(true);
        this.stageText.setText('Found in cache! Loading...');
        this.statusText.setText('CACHED!').setColor('#44ff44');
        this.drawProgressBar(1);
        for (let i = 0; i < this.animSlots.length; i++) {
          this.animSlots[i].status = 'ready';
          this.updateGridStatus(i, 'ready');
          this.showSmallPreview(this.animSlots[i].name, i);
        }
        break;

      case 'converting_side_view':
        this.stageText.setText('Converting to fighting stance...');
        this.statusText.setText('AI is preserving your face & reposing...');
        this.drawProgressBar(0.05);
        break;

      case 'converting_upright_view':
        this.stageText.setText('Straightening reference stance...');
        this.statusText.setText('Preparing an upright base for crouch generation...');
        this.drawProgressBar(0.09);
        break;

      case 'converting_crouch_view':
        this.stageText.setText('Generating crouched stance...');
        this.statusText.setText('Creating low-stance base for crouch attacks...');
        this.drawProgressBar(0.12);
        break;

      case 'converting_side_view_polling':
        this.stageText.setText(`Waiting for result (task: ${status.taskId.slice(0, 8)}...)...`);
        break;

      case 'falling_back':
        this.stageText.setText('Switching to backup pipeline...');
        this.statusText.setText(status.reason.slice(0, 60)).setColor('#ffaa00');
        break;

      case 'preparing_base':
        this.stageText.setText('Removing background, cropping & standardizing...');
        this.statusText.setText('Preparing base image...');
        this.drawProgressBar(0.08);
        break;

      case 'generating_sprites': {
        const idx = this.animSlots.findIndex((s) => s.name === status.animation);
        if (idx >= 0) {
          this.animSlots[idx].status = 'generating';
          this.updateGridStatus(idx, 'generating');
        }
        const basePct = 0.1;
        const spritePct = 0.9 * (status.current / status.total);
        this.drawProgressBar(basePct + spritePct);
        this.statusText.setText(`${status.animation} (${status.current}/${status.total})`).setColor('#ffaa00');
        this.stageText.setText(`Animating ${status.animation}...`);
        break;
      }

      case 'sprite_ready': {
        const wasNull = !this.resultHash;
        this.resultHash = status.photoHash;
        if (wasNull) this.loadSideViewsFromCache(status.photoHash);
        const idx = this.animSlots.findIndex((s) => s.name === status.animation);
        if (idx >= 0) {
          this.animSlots[idx].status = 'ready';
          this.updateGridStatus(idx, 'ready');
          this.showSmallPreview(status.animation, idx);

          if (this.selectedAnimIndex === idx) {
            this.showBigPreview(status.animation);
          }
        }
        this.completedAnims++;
        const pct = 0.1 + 0.9 * (this.completedAnims / this.totalAnims);
        this.drawProgressBar(pct);
        break;
      }

      case 'done':
        this.resultHash = status.photoHash;
        this.downloadAllBtn.setVisible(true);
        this.loadSideViewsFromCache(status.photoHash);
        break;

      case 'error':
        this.statusText.setText(status.message.slice(0, 80)).setColor('#ff4444');
        break;
    }
  }

  private createRetryButton(): void {
    const retryBtn = this.add.text(W / 2, CONTROLS_Y, '\u21bb RETRY', {
      fontFamily: FONT, fontSize: '10px', color: '#ffcc00',
      stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#332200',
      padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });

    retryBtn.on('pointerover', () => retryBtn.setColor('#ffffff'));
    retryBtn.on('pointerout', () => retryBtn.setColor('#ffcc00'));
    retryBtn.on('pointerdown', () => {
      retryBtn.destroy();
      this.pipelineError = null;
      this.completedAnims = 0;
      this.statusText.setText('Retrying...').setColor('#ffaa00');
      this.drawProgressBar(0);
      this.runPipeline();
    });
  }

  private async loadSideViewsFromCache(photoHash: string): Promise<void> {
    try {
      const meta = await getCachedMeta(photoHash);
      if (!meta) return;
      if (meta.sideViewBlob && !this.sideViewImage) {
        this.sideViewImage = this.loadSideViewBlob(meta.sideViewBlob, SIDE_Y, 'sideview');
      }
      if (meta.crouchViewBlob && !this.crouchViewImage) {
        this.crouchViewImage = this.loadSideViewBlob(meta.crouchViewBlob, CROUCH_Y, 'crouchview');
      }
    } catch { /* ignore */ }
  }

  private downloadCurrentSprite(): void {
    if (!this.currentPreviewBlob) return;
    const safeName = (this.sceneData.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
    downloadBlob(this.currentPreviewBlob, `${safeName}_${this.currentPreviewAnimName}.png`);
  }

  private async downloadAllSprites(): Promise<void> {
    if (!this.resultHash) return;
    const safeName = (this.sceneData.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
    try {
      const sprites = await getAllSpritesForHash(this.resultHash);
      for (const sp of sprites) {
        downloadBlob(sp.pngBlob, `${safeName}_${sp.animationName}.png`);
      }
    } catch { /* ignore */ }
  }

  private goBack(): void {
    this.cameras.main.fadeOut(300, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.start(this.sceneData.returnScene);
    });
  }

  private goBackWithResult(photoHash: string): void {
    this.cameras.main.fadeOut(300, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.start(this.sceneData.returnScene, {
        completedSlot: this.sceneData.slotIndex,
        photoHash,
        characterName: this.sceneData.characterName,
      });
    });
  }
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
