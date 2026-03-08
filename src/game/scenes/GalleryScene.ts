import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';
import {
  getAllCachedMetas,
  getAllSpritesForHash,
  deleteCharacter,
  CACHE_VERSION,
  type CachedMeta,
  type CachedSprite,
} from '../../services/SpriteCache.ts';
import { getAnimationList, rebuildCharacter, retryAnimation, retrySideView, retryCrouchView, type StatusCallback } from '../../services/CharacterPipeline.ts';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

const FONT = '"Press Start 2P", monospace';
const ACCENT = '#ff4444';
const W = GAME_WIDTH;
const H = GAME_HEIGHT;

const ANIM_LABELS: Record<string, string> = {
  idle: 'IDLE', walk: 'WALK', high_punch: 'H.PUNCH', low_punch: 'L.PUNCH',
  high_kick: 'H.KICK', low_kick: 'L.KICK', jump: 'JUMP', crouch: 'CROUCH',
  hit: 'HIT', ko: 'K.O.',
};

// Layout constants
const HEADER_Y = 22;
const COUNTER_Y = 44;

const THUMB_COL_X = 75;
const THUMB_SIZE = 60;
const THUMB_STEP = 82;
const THUMB_LABEL_OFFSET = -38;
const THUMB_START_Y = 100;

const INFO_X = 170;
const INFO_TOP = 68;

const GRID_X = 170;
const GRID_TOP = 160;
const GRID_CELL_W = 94;
const GRID_CELL_H = 26;
const GRID_COLS = 2;

const PREVIEW_X = 785;
const PREVIEW_Y = 290;
const PREVIEW_SIZE = 280;

const BTN_Y = H - 26;

export class GalleryScene extends Phaser.Scene {
  private metas: CachedMeta[] = [];
  private sprites: CachedSprite[] = [];
  private currentIndex = 0;
  private selectedAnimIndex = 0;
  private transitioning = false;

  private dynamicObjects: Phaser.GameObjects.GameObject[] = [];

  private counterText!: Phaser.GameObjects.Text;
  private nameText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;
  private emptyGroup!: Phaser.GameObjects.Container;
  private contentGroup!: Phaser.GameObjects.Container;

  private bigPreviewSprite: Phaser.GameObjects.Sprite | null = null;
  private bigPreviewImage: Phaser.GameObjects.Image | null = null;
  private animNameText!: Phaser.GameObjects.Text;
  private animGridContainer!: Phaser.GameObjects.Container;
  private downloadBtn!: Phaser.GameObjects.Text;
  private downloadRawBtn!: Phaser.GameObjects.Text;
  private downloadGifBtn!: Phaser.GameObjects.Text;
  private downloadAllBtn!: Phaser.GameObjects.Text;
  private retryAnimBtn!: Phaser.GameObjects.Text;
  private currentPreviewBlob: Blob | null = null;
  private currentRawBlob: Blob | null = null;
  private currentPreviewAnimName = '';
  private thumbBlobs: { label: string; blob: Blob }[] = [];

  private fileInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;

  constructor() {
    super({ key: 'GalleryScene' });
  }

  async create(): Promise<void> {
    this.transitioning = false;
    this.currentIndex = 0;
    this.selectedAnimIndex = 0;
    this.dynamicObjects = [];

    this.drawBackground();
    this.createHeader();
    this.createEmptyState();
    this.createContentLayout();
    this.createBottomUI();
    this.createFileInput();
    this.setupInput();
    this.cameras.main.fadeIn(300, 0, 0, 0);

    await this.loadCharacters();
  }

  // ─── Background ──────────────────────────────────────────────

  private drawBackground(): void {
    const bg = this.add.graphics().setDepth(0);
    for (let y = 0; y < H; y++) {
      const t = y / H;
      const r = Math.floor(5 + t * 8);
      const g = Math.floor(4 + t * 10);
      const b = Math.floor(14 + t * 22);
      bg.fillStyle(Phaser.Display.Color.GetColor(r, g, b));
      bg.fillRect(0, y, W, 1);
    }
    const scanlines = this.add.graphics().setDepth(1);
    scanlines.fillStyle(0x000000, 0.04);
    for (let y = 0; y < H; y += 4) scanlines.fillRect(0, y, W, 2);
  }

  // ─── Header ──────────────────────────────────────────────────

  private createHeader(): void {
    this.add.text(W / 2, HEADER_Y, 'FIGHTER GALLERY', {
      fontFamily: FONT, fontSize: '20px', color: '#ffcc00',
      stroke: '#000000', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(10);

    this.counterText = this.add.text(W / 2, COUNTER_Y, '', {
      fontFamily: FONT, fontSize: '8px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);
  }

  // ─── Empty State ─────────────────────────────────────────────

  private createEmptyState(): void {
    this.emptyGroup = this.add.container(0, 0).setDepth(10).setVisible(false);

    const emptyTitle = this.add.text(W / 2, H / 2 - 40, 'NO FIGHTERS CREATED YET', {
      fontFamily: FONT, fontSize: '14px', color: '#555555',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5);
    this.emptyGroup.add(emptyTitle);

    const createBtn = this.add.text(W / 2, H / 2 + 20, '+ CREATE NEW FIGHTER', {
      fontFamily: FONT, fontSize: '12px', color: '#44ff44',
      stroke: '#000000', strokeThickness: 4,
      backgroundColor: '#0a2a0a',
      padding: { x: 20, y: 12 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    createBtn.on('pointerover', () => createBtn.setColor('#88ff88'));
    createBtn.on('pointerout', () => createBtn.setColor('#44ff44'));
    createBtn.on('pointerdown', () => this.createNewFighter());
    this.emptyGroup.add(createBtn);

    this.tweens.add({
      targets: createBtn,
      alpha: { from: 1, to: 0.5 },
      duration: 800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  // ─── Content Layout ──────────────────────────────────────────

  private createContentLayout(): void {
    this.contentGroup = this.add.container(0, 0).setDepth(10).setVisible(false);

    // --- Left column: 5 thumbnail boxes with labels (clickable) ---
    const thumbLabels = ['ORIGINAL', 'SIDE VIEW', 'SIDE CLEAN', 'CROUCH', 'CROUCH CLEAN'];
    const thumbCount = thumbLabels.length;

    for (let i = 0; i < thumbCount; i++) {
      const ty = THUMB_START_Y + i * THUMB_STEP;
      this.add.text(THUMB_COL_X, ty + THUMB_LABEL_OFFSET, thumbLabels[i], {
        fontFamily: FONT, fontSize: '5px', color: '#666666',
      }).setOrigin(0.5).setDepth(10);

      const box = this.add.graphics().setDepth(8);
      const half = THUMB_SIZE / 2;
      box.fillStyle(0x0a0a1e, 0.9);
      box.fillRoundedRect(THUMB_COL_X - half, ty - half, THUMB_SIZE, THUMB_SIZE, 5);
      box.lineStyle(1, 0x333366, 0.6);
      box.strokeRoundedRect(THUMB_COL_X - half, ty - half, THUMB_SIZE, THUMB_SIZE, 5);

      const hitArea = this.add.rectangle(THUMB_COL_X, ty, THUMB_SIZE, THUMB_SIZE)
        .setInteractive({ useHandCursor: true }).setAlpha(0.001).setDepth(15);
      const thumbIdx = i;
      hitArea.on('pointerdown', () => this.selectThumb(thumbIdx));
    }

    // --- Center column: character info + animation grid ---
    this.nameText = this.add.text(INFO_X, INFO_TOP, '', {
      fontFamily: FONT, fontSize: '14px', color: '#ffffff',
      stroke: ACCENT, strokeThickness: 3,
      wordWrap: { width: 380 },
    }).setOrigin(0, 0).setDepth(10);

    this.statusText = this.add.text(INFO_X, INFO_TOP + 22, '', {
      fontFamily: FONT, fontSize: '8px', color: '#44ff44',
    }).setOrigin(0, 0).setDepth(10);

    this.infoText = this.add.text(INFO_X, INFO_TOP + 40, '', {
      fontFamily: FONT, fontSize: '6px', color: '#aaaaaa',
      lineSpacing: 6, wordWrap: { width: 380 },
    }).setOrigin(0, 0).setDepth(10);

    // Animation selector grid
    this.animGridContainer = this.add.container(0, 0).setDepth(10);
    this.buildAnimGrid();

    // --- Right column: sprite preview ---
    const previewBg = this.add.graphics().setDepth(8);
    const phalf = PREVIEW_SIZE / 2;
    previewBg.fillStyle(0x0a0a1a, 0.9);
    previewBg.fillRoundedRect(PREVIEW_X - phalf, PREVIEW_Y - phalf, PREVIEW_SIZE, PREVIEW_SIZE, 8);
    previewBg.lineStyle(2, 0x333366);
    previewBg.strokeRoundedRect(PREVIEW_X - phalf, PREVIEW_Y - phalf, PREVIEW_SIZE, PREVIEW_SIZE, 8);

    this.animNameText = this.add.text(PREVIEW_X, PREVIEW_Y - phalf - 14, 'SELECT ANIMATION', {
      fontFamily: FONT, fontSize: '7px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);

    this.downloadBtn = this.add.text(PREVIEW_X - 90, PREVIEW_Y + phalf + 14, 'SAVE PNG', {
      fontFamily: FONT, fontSize: '6px', color: '#44aaff',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadBtn.on('pointerover', () => this.downloadBtn.setColor('#88ccff'));
    this.downloadBtn.on('pointerout', () => this.downloadBtn.setColor('#44aaff'));
    this.downloadBtn.on('pointerdown', () => this.downloadCurrentSprite());

    this.downloadRawBtn = this.add.text(PREVIEW_X - 30, PREVIEW_Y + phalf + 14, 'SAVE RAW', {
      fontFamily: FONT, fontSize: '6px', color: '#aa44ff',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadRawBtn.on('pointerover', () => this.downloadRawBtn.setColor('#cc88ff'));
    this.downloadRawBtn.on('pointerout', () => this.downloadRawBtn.setColor('#aa44ff'));
    this.downloadRawBtn.on('pointerdown', () => this.downloadRawSprite());

    this.downloadGifBtn = this.add.text(PREVIEW_X + 30, PREVIEW_Y + phalf + 14, 'SAVE GIF', {
      fontFamily: FONT, fontSize: '6px', color: '#44ff88',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadGifBtn.on('pointerover', () => this.downloadGifBtn.setColor('#88ffbb'));
    this.downloadGifBtn.on('pointerout', () => this.downloadGifBtn.setColor('#44ff88'));
    this.downloadGifBtn.on('pointerdown', () => this.downloadGif());

    this.downloadAllBtn = this.add.text(PREVIEW_X + 90, PREVIEW_Y + phalf + 14, 'SAVE ALL', {
      fontFamily: FONT, fontSize: '6px', color: '#aaaa44',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadAllBtn.on('pointerover', () => this.downloadAllBtn.setColor('#dddd88'));
    this.downloadAllBtn.on('pointerout', () => this.downloadAllBtn.setColor('#aaaa44'));
    this.downloadAllBtn.on('pointerdown', () => this.downloadAllSprites());

    this.retryAnimBtn = this.add.text(PREVIEW_X, PREVIEW_Y + phalf + 28, '\u21bb RETRY THIS ANIMATION', {
      fontFamily: FONT, fontSize: '6px', color: '#ff8844',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.retryAnimBtn.on('pointerover', () => this.retryAnimBtn.setColor('#ffbb88'));
    this.retryAnimBtn.on('pointerout', () => this.retryAnimBtn.setColor('#ff8844'));
    this.retryAnimBtn.on('pointerdown', () => this.retryCurrentAnimation());
  }

  private buildAnimGrid(): void {
    const anims = getAnimationList();

    for (let i = 0; i < anims.length; i++) {
      const anim = anims[i];
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const cx = GRID_X + col * GRID_CELL_W + GRID_CELL_W / 2;
      const cy = GRID_TOP + row * GRID_CELL_H + GRID_CELL_H / 2;

      const bg = this.add.graphics().setDepth(8);
      bg.fillStyle(0x111122, 0.7);
      bg.fillRoundedRect(cx - GRID_CELL_W / 2 + 2, cy - GRID_CELL_H / 2 + 1, GRID_CELL_W - 4, GRID_CELL_H - 2, 3);
      bg.lineStyle(1, 0x333355);
      bg.strokeRoundedRect(cx - GRID_CELL_W / 2 + 2, cy - GRID_CELL_H / 2 + 1, GRID_CELL_W - 4, GRID_CELL_H - 2, 3);
      this.animGridContainer.add(bg);

      const label = ANIM_LABELS[anim.name] || anim.name.toUpperCase();
      const text = this.add.text(cx, cy, label, {
        fontFamily: FONT, fontSize: '6px', color: '#666666',
      }).setOrigin(0.5).setDepth(12).setName(`animlabel_${i}`);
      this.animGridContainer.add(text);

      const hitArea = this.add.rectangle(cx, cy, GRID_CELL_W - 4, GRID_CELL_H - 2)
        .setInteractive({ useHandCursor: true }).setAlpha(0.001).setDepth(15);
      hitArea.on('pointerdown', () => this.selectAnim(i));
      this.animGridContainer.add(hitArea);
    }
  }

  // ─── Bottom UI ───────────────────────────────────────────────

  private createBottomUI(): void {
    const barBg = this.add.graphics().setDepth(18);
    barBg.fillStyle(0x000000, 0.7);
    barBg.fillRect(0, H - 50, W, 50);

    const backBtn = this.add.text(60, BTN_Y, '< BACK', {
      fontFamily: FONT, fontSize: '10px', color: '#aaaaaa',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#ffffff'));
    backBtn.on('pointerout', () => backBtn.setColor('#aaaaaa'));
    backBtn.on('pointerdown', () => this.goBack());

    const prevBtn = this.add.text(W / 2 - 120, BTN_Y, '< PREV', {
      fontFamily: FONT, fontSize: '10px', color: '#44aaff',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    prevBtn.on('pointerover', () => prevBtn.setColor('#88ccff'));
    prevBtn.on('pointerout', () => prevBtn.setColor('#44aaff'));
    prevBtn.on('pointerdown', () => this.navigate(-1));

    const createBtn = this.add.text(W / 2, BTN_Y, '+ CREATE', {
      fontFamily: FONT, fontSize: '10px', color: '#44ff44',
      stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#0a2a0a',
      padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    createBtn.on('pointerover', () => createBtn.setColor('#88ff88'));
    createBtn.on('pointerout', () => createBtn.setColor('#44ff44'));
    createBtn.on('pointerdown', () => this.createNewFighter());

    const nextBtn = this.add.text(W / 2 + 120, BTN_Y, 'NEXT >', {
      fontFamily: FONT, fontSize: '10px', color: '#44aaff',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    nextBtn.on('pointerover', () => nextBtn.setColor('#88ccff'));
    nextBtn.on('pointerout', () => nextBtn.setColor('#44aaff'));
    nextBtn.on('pointerdown', () => this.navigate(1));

    const rebuildBtn = this.add.text(W - 150, BTN_Y, 'REBUILD', {
      fontFamily: FONT, fontSize: '10px', color: '#ffaa00',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    rebuildBtn.on('pointerover', () => rebuildBtn.setColor('#ffcc44'));
    rebuildBtn.on('pointerout', () => rebuildBtn.setColor('#ffaa00'));
    rebuildBtn.on('pointerdown', () => this.rebuildCurrent(rebuildBtn));

    const deleteBtn = this.add.text(W - 60, BTN_Y, 'DELETE', {
      fontFamily: FONT, fontSize: '10px', color: ACCENT,
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    deleteBtn.on('pointerover', () => deleteBtn.setColor('#ff8888'));
    deleteBtn.on('pointerout', () => deleteBtn.setColor(ACCENT));
    deleteBtn.on('pointerdown', () => this.deleteCurrent());
  }

  // ─── File Input (for create) ─────────────────────────────────

  private createFileInput(): void {
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.style.display = 'none';
    document.body.appendChild(this.fileInput);

    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'Fighter name...';
    this.nameInput.maxLength = 20;
    this.nameInput.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;font-family:monospace;font-size:18px;padding:12px 20px;background:#111;color:#fff;border:2px solid #ff4444;border-radius:6px;text-align:center;outline:none;display:none;';
    document.body.appendChild(this.nameInput);

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      this.fileInput.value = '';

      this.nameInput.style.display = 'block';
      this.nameInput.value = '';
      this.nameInput.focus();

      const handleName = () => {
        const name = this.nameInput.value.trim() || 'Fighter';
        this.nameInput.style.display = 'none';
        this.nameInput.removeEventListener('keydown', onKeydown);
        this.cleanupHTML();
        this.cameras.main.fadeOut(300, 0, 0, 0);
        this.cameras.main.once('camerafadeoutcomplete', () => {
          this.scene.start('CharacterCreationScene', {
            file, characterName: name, slotIndex: 0, returnScene: 'GalleryScene',
          });
        });
      };

      const onKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') handleName();
        if (e.key === 'Escape') {
          this.nameInput.style.display = 'none';
          this.nameInput.removeEventListener('keydown', onKeydown);
        }
        e.stopPropagation();
      };
      this.nameInput.addEventListener('keydown', onKeydown);
    });
  }

  private createNewFighter(): void {
    this.fileInput.click();
  }

  // ─── Input ───────────────────────────────────────────────────

  private setupInput(): void {
    const leftKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    const rightKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    const escKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    leftKey.on('down', () => this.navigate(-1));
    rightKey.on('down', () => this.navigate(1));
    escKey.on('down', () => this.goBack());
  }

  // ─── Data Loading ────────────────────────────────────────────

  private async loadCharacters(): Promise<void> {
    try {
      const all = await getAllCachedMetas();
      this.metas = all
        .filter((m) => m.version === CACHE_VERSION)
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      this.metas = [];
    }

    if (this.currentIndex >= this.metas.length) {
      this.currentIndex = Math.max(0, this.metas.length - 1);
    }
    this.showCurrent();
  }

  // ─── Display ─────────────────────────────────────────────────

  private clearDynamic(): void {
    for (const obj of this.dynamicObjects) obj.destroy();
    this.dynamicObjects = [];
    if (this.bigPreviewSprite) { this.bigPreviewSprite.destroy(); this.bigPreviewSprite = null; }
    if (this.bigPreviewImage) { this.bigPreviewImage.destroy(); this.bigPreviewImage = null; }
  }

  private showCurrent(): void {
    this.clearDynamic();
    this.selectedAnimIndex = -1;

    if (this.metas.length === 0) {
      this.emptyGroup.setVisible(true);
      this.contentGroup.setVisible(false);
      this.counterText.setText('0 FIGHTERS');
      this.nameText.setText('');
      this.statusText.setText('');
      this.infoText.setText('');
      this.animNameText.setText('');
      this.resetAnimGridColors();
      return;
    }

    this.emptyGroup.setVisible(false);
    this.contentGroup.setVisible(true);

    const meta = this.metas[this.currentIndex];
    this.counterText.setText(`FIGHTER ${this.currentIndex + 1} / ${this.metas.length}`);
    this.nameText.setText(meta.characterName.toUpperCase());

    const statusMap: Record<string, { label: string; color: string }> = {
      ready: { label: 'READY', color: '#44ff44' },
      pending: { label: 'PENDING', color: '#ffcc00' },
      sprites_generating: { label: 'GENERATING...', color: '#ffaa00' },
      error: { label: 'ERROR', color: '#ff4444' },
    };
    const st = statusMap[meta.status] || { label: meta.status.toUpperCase(), color: '#aaaaaa' };
    this.statusText.setText(`STATUS: ${st.label}`).setColor(st.color);

    const date = new Date(meta.createdAt);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const animCount = meta.animationsReady?.length || 0;
    this.infoText.setText(
      `CREATED: ${dateStr}  |  ANIMS: ${animCount}  |  ${meta.photoHash.slice(0, 10)}...`
    );

    this.animNameText.setText('SELECT ANIMATION').setColor('#888888');
    this.downloadBtn.setVisible(false);
    this.downloadRawBtn.setVisible(false);
    this.downloadGifBtn.setVisible(false);
    this.retryAnimBtn.setVisible(false);
    this.currentPreviewBlob = null;
    this.currentRawBlob = null;
    this.downloadAllBtn.setVisible(this.sprites.length > 0 || meta.status === 'ready');

    this.thumbBlobs = [];
    const thumbSlots: { label: string; blob: Blob | null }[] = [
      { label: 'original', blob: meta.originalPhotoBlob },
      { label: 'side_view', blob: meta.sideViewBlob },
      { label: 'side_view_clean', blob: meta.sideViewCleanBlob || null },
      { label: 'crouch', blob: meta.crouchViewBlob },
      { label: 'crouch_clean', blob: meta.crouchViewCleanBlob || null },
    ];

    for (let i = 0; i < thumbSlots.length; i++) {
      const slot = thumbSlots[i];
      if (slot.blob) {
        this.thumbBlobs[i] = { label: slot.label, blob: slot.blob };
        const ty = THUMB_START_Y + i * THUMB_STEP;
        this.loadBlobImage(slot.blob, THUMB_COL_X, ty, THUMB_SIZE - 6, meta.photoHash + '_' + slot.label);
      }
    }

    this.loadSpriteData(meta.photoHash);
    this.resetAnimGridColors();
    this.highlightAvailableAnims(meta.animationsReady || []);
  }

  private loadBlobImage(blob: Blob, cx: number, cy: number, size: number, keyHint: string): void {
    const url = URL.createObjectURL(blob);
    const htmlImg = new Image();
    htmlImg.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const scale = Math.min(size / htmlImg.width, size / htmlImg.height);
      const dw = htmlImg.width * scale;
      const dh = htmlImg.height * scale;
      ctx.drawImage(htmlImg, (size - dw) / 2, (size - dh) / 2, dw, dh);

      const texKey = `gallery_${keyHint}_${Date.now()}`;
      if (this.textures.exists(texKey)) this.textures.remove(texKey);
      this.textures.addCanvas(texKey, canvas);

      const sprite = this.add.image(cx, cy, texKey).setDepth(11);
      this.dynamicObjects.push(sprite);
    };
    htmlImg.src = url;
  }

  private async loadSpriteData(photoHash: string): Promise<void> {
    try {
      this.sprites = await getAllSpritesForHash(photoHash);
    } catch {
      this.sprites = [];
    }
    this.downloadAllBtn.setVisible(this.sprites.length > 0);
  }

  private resetAnimGridColors(): void {
    const anims = getAnimationList();
    for (let i = 0; i < anims.length; i++) {
      const label = this.animGridContainer.getByName(`animlabel_${i}`) as Phaser.GameObjects.Text;
      if (label) label.setColor('#444444');
    }
  }

  private highlightAvailableAnims(readyNames: string[]): void {
    const anims = getAnimationList();
    for (let i = 0; i < anims.length; i++) {
      const label = this.animGridContainer.getByName(`animlabel_${i}`) as Phaser.GameObjects.Text;
      if (label && readyNames.includes(anims[i].name)) {
        label.setColor('#aaaaaa');
      }
    }
  }

  // ─── Thumbnail Preview ───────────────────────────────────────

  private selectThumb(thumbIndex: number): void {
    const entry = this.thumbBlobs[thumbIndex];
    if (!entry) return;

    this.selectedAnimIndex = -1;
    this.resetAnimGridColors();
    const meta = this.metas[this.currentIndex];
    if (meta) this.highlightAvailableAnims(meta.animationsReady || []);

    if (this.bigPreviewSprite) { this.bigPreviewSprite.destroy(); this.bigPreviewSprite = null; }
    if (this.bigPreviewImage) { this.bigPreviewImage.destroy(); this.bigPreviewImage = null; }

    this.currentPreviewBlob = entry.blob;
    this.currentRawBlob = null;
    this.currentPreviewAnimName = entry.label;
    this.downloadRawBtn.setVisible(false);
    this.downloadGifBtn.setVisible(false);

    const canRetrySide = thumbIndex === 1 || thumbIndex === 2;
    const canRetryCrouch = thumbIndex === 3 || thumbIndex === 4;
    if (canRetrySide) {
      this.retryAnimBtn.setText('\u21bb RETRY SIDE VIEW');
      this.retryAnimBtn.setVisible(true);
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryBase('side'));
    } else if (canRetryCrouch) {
      this.retryAnimBtn.setText('\u21bb RETRY CROUCH');
      this.retryAnimBtn.setVisible(true);
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryBase('crouch'));
    } else {
      this.retryAnimBtn.setVisible(false);
    }

    const thumbDisplayLabels = ['ORIGINAL', 'SIDE VIEW', 'SIDE CLEAN', 'CROUCH', 'CROUCH CLEAN'];
    this.animNameText.setText(thumbDisplayLabels[thumbIndex] || entry.label.toUpperCase()).setColor('#44aaff');

    const url = URL.createObjectURL(entry.blob);
    const htmlImg = new Image();
    htmlImg.onload = () => {
      URL.revokeObjectURL(url);

      const texKey = `gallery_thumbprev_${thumbIndex}_${Date.now()}`;
      if (this.textures.exists(texKey)) this.textures.remove(texKey);

      const canvas = document.createElement('canvas');
      canvas.width = htmlImg.width;
      canvas.height = htmlImg.height;
      canvas.getContext('2d')!.drawImage(htmlImg, 0, 0);
      this.textures.addCanvas(texKey, canvas);

      if (this.bigPreviewImage) this.bigPreviewImage.destroy();
      const maxDim = PREVIEW_SIZE - 20;
      const scale = Math.min(maxDim / htmlImg.width, maxDim / htmlImg.height);
      this.bigPreviewImage = this.add.image(PREVIEW_X, PREVIEW_Y, texKey).setDepth(12).setScale(scale);
      this.dynamicObjects.push(this.bigPreviewImage);

      this.animNameText.setText(
        `${thumbDisplayLabels[thumbIndex]}  ${htmlImg.width}x${htmlImg.height}`
      );
      this.downloadBtn.setVisible(true);
    };
    htmlImg.src = url;
  }

  // ─── Sprite Preview ──────────────────────────────────────────

  private selectAnim(index: number): void {
    const anims = getAnimationList();
    if (index < 0 || index >= anims.length) return;

    this.selectedAnimIndex = index;
    const animName = anims[index].name;
    const label = ANIM_LABELS[animName] || animName.toUpperCase();

    this.resetAnimGridColors();
    const meta = this.metas[this.currentIndex];
    if (meta) this.highlightAvailableAnims(meta.animationsReady || []);

    const selectedLabel = this.animGridContainer.getByName(`animlabel_${index}`) as Phaser.GameObjects.Text;
    if (selectedLabel) selectedLabel.setColor('#ffffff');

    this.animNameText.setText(label);

    if (this.bigPreviewSprite) { this.bigPreviewSprite.destroy(); this.bigPreviewSprite = null; }
    if (this.bigPreviewImage) { this.bigPreviewImage.destroy(); this.bigPreviewImage = null; }

    const cached = this.sprites.find(s => s.animationName === animName);
    if (cached) {
      this.showBigPreview(cached, animName);
    } else {
      this.animNameText.setColor('#555555');
      this.animNameText.setText(label + ' (NOT FOUND)');
      this.downloadBtn.setVisible(false);
      this.downloadRawBtn.setVisible(false);
      this.downloadGifBtn.setVisible(false);
      this.retryAnimBtn.setText('\u21bb RETRY THIS ANIMATION');
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryCurrentAnimation());
      this.retryAnimBtn.setVisible(true);
      this.currentPreviewBlob = null;
      this.currentRawBlob = null;
    }
  }

  private async showBigPreview(cached: CachedSprite, animName: string): Promise<void> {
    this.currentPreviewBlob = cached.pngBlob;
    this.currentRawBlob = (cached as any).rawPngBlob || null;
    this.currentPreviewAnimName = animName;

    const texKey = `gallery_bigprev_${animName}_${Date.now()}`;
    const animKey = `gallery_anim_${animName}_${Date.now()}`;

    try {
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

      if (this.textures.exists(texKey)) this.textures.remove(texKey);
      this.textures.addSpriteSheet(texKey, canvas as unknown as HTMLImageElement, {
        frameWidth: frameW, frameHeight: frameH,
      });

      if (this.anims.exists(animKey)) this.anims.remove(animKey);
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(texKey, { start: 0, end: frameCount - 1 }),
        frameRate: 10, repeat: -1,
      });

      if (this.bigPreviewSprite) this.bigPreviewSprite.destroy();
      const maxDim = PREVIEW_SIZE - 40;
      const scale = Math.min(maxDim / frameW, maxDim / frameH);
      this.bigPreviewSprite = this.add.sprite(PREVIEW_X, PREVIEW_Y, texKey).setDepth(12).setScale(scale);
      this.bigPreviewSprite.play(animKey);
      this.dynamicObjects.push(this.bigPreviewSprite);

      this.animNameText.setColor('#44ff44');
      this.animNameText.setText(
        `${ANIM_LABELS[animName] || animName.toUpperCase()}  ${frameW}x${frameH}  ${frameCount}f`
      );
      this.downloadBtn.setVisible(true);
      this.downloadRawBtn.setVisible(!!this.currentRawBlob);
      this.downloadGifBtn.setVisible(true);
      this.retryAnimBtn.setText('\u21bb RETRY THIS ANIMATION');
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryCurrentAnimation());
      this.retryAnimBtn.setVisible(true);
    } catch {
      this.animNameText.setColor('#ff4444');
      this.animNameText.setText('LOAD ERROR');
      this.downloadBtn.setVisible(false);
      this.downloadRawBtn.setVisible(false);
      this.downloadGifBtn.setVisible(false);
      this.retryAnimBtn.setText('\u21bb RETRY THIS ANIMATION');
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryCurrentAnimation());
      this.retryAnimBtn.setVisible(true);
    }
  }

  // ─── Navigation ──────────────────────────────────────────────

  private navigate(dir: number): void {
    if (this.metas.length <= 1) return;
    this.currentIndex = (this.currentIndex + dir + this.metas.length) % this.metas.length;
    this.showCurrent();
  }

  private async deleteCurrent(): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    await deleteCharacter(meta.photoHash);
    await this.loadCharacters();
  }

  private goBack(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.cleanupHTML();
    this.cameras.main.fadeOut(300, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.start('TitleScene');
    });
  }

  private downloadCurrentSprite(): void {
    if (!this.currentPreviewBlob) return;
    const meta = this.metas[this.currentIndex];
    const safeName = (meta?.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
    downloadBlob(this.currentPreviewBlob, `${safeName}_${this.currentPreviewAnimName}.png`);
  }

  private downloadRawSprite(): void {
    if (!this.currentRawBlob) return;
    const meta = this.metas[this.currentIndex];
    const safeName = (meta?.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
    downloadBlob(this.currentRawBlob, `${safeName}_${this.currentPreviewAnimName}_RAW.png`);
  }

  private async downloadGif(): Promise<void> {
    if (!this.currentPreviewBlob) return;
    const meta = this.metas[this.currentIndex];
    const safeName = (meta?.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
    const animName = this.currentPreviewAnimName;
    const cached = this.sprites.find(s => s.animationName === animName);
    if (!cached) return;

    try {
      this.downloadGifBtn.setText('...');
      const img = await blobToImage(cached.pngBlob);
      const frameW = cached.frameWidth;
      const frameH = cached.frameHeight;
      const gridCols = Math.round(img.width / frameW);
      const frameCount = cached.frameCount;
      const delay = Math.round(100 / 10); // 10fps → 100ms per frame

      const gif = GIFEncoder();
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = frameW;
      tempCanvas.height = frameH;
      const tempCtx = tempCanvas.getContext('2d')!;

      for (let f = 0; f < frameCount; f++) {
        const sc = f % gridCols;
        const sr = Math.floor(f / gridCols);
        tempCtx.clearRect(0, 0, frameW, frameH);
        tempCtx.fillStyle = '#000000';
        tempCtx.fillRect(0, 0, frameW, frameH);
        tempCtx.drawImage(img, sc * frameW, sr * frameH, frameW, frameH, 0, 0, frameW, frameH);

        const imageData = tempCtx.getImageData(0, 0, frameW, frameH);
        const palette = quantize(imageData.data, 256);
        const index = applyPalette(imageData.data, palette);
        const frameOpts: Record<string, unknown> = { palette, delay };
        if (f === 0) frameOpts.repeat = 0;
        gif.writeFrame(index, frameW, frameH, frameOpts as any);
      }

      gif.finish();
      const gifBytes = gif.bytes();
      const blob = new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' });
      downloadBlob(blob, `${safeName}_${animName}.gif`);
    } catch (err: any) {
      console.error('[Gallery] GIF export failed:', err);
    } finally {
      this.downloadGifBtn.setText('SAVE GIF');
    }
  }

  private downloadAllSprites(): void {
    const meta = this.metas[this.currentIndex];
    if (!meta) return;
    const safeName = (meta.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');

    if (meta.originalPhotoBlob)  downloadBlob(meta.originalPhotoBlob, `${safeName}_original.png`);
    if (meta.sideViewBlob)       downloadBlob(meta.sideViewBlob, `${safeName}_side_view.png`);
    if (meta.sideViewCleanBlob)  downloadBlob(meta.sideViewCleanBlob, `${safeName}_side_view_clean.png`);
    if (meta.crouchViewBlob)     downloadBlob(meta.crouchViewBlob, `${safeName}_crouch.png`);
    if (meta.crouchViewCleanBlob) downloadBlob(meta.crouchViewCleanBlob, `${safeName}_crouch_clean.png`);

    for (const sp of this.sprites) {
      downloadBlob(sp.pngBlob, `${safeName}_${sp.animationName}.png`);
      if (sp.rawPngBlob) downloadBlob(sp.rawPngBlob, `${safeName}_${sp.animationName}_RAW.png`);
    }
  }

  private async rebuildCurrent(btn: Phaser.GameObjects.Text): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];

    btn.setText('REBUILDING...').disableInteractive();
    this.statusText.setText('Re-processing sprites from raw data...').setColor('#ffaa00');

    try {
      await rebuildCharacter(meta.photoHash, (status) => {
        if (status.stage === 'generating_sprites') {
          this.statusText.setText(`Rebuilding ${status.animation} (${status.current}/${status.total})...`);
        } else if (status.stage === 'sprite_ready') {
          this.statusText.setText(`Rebuilt ${status.animation} (${status.current}/${status.total})`);
        } else if (status.stage === 'done') {
          this.statusText.setText('Rebuild complete!').setColor('#44ff44');
        }
      });
      await this.loadCharacters();
    } catch (err: any) {
      this.statusText.setText(`Rebuild failed: ${err.message}`).setColor(ACCENT);
    } finally {
      btn.setText('REBUILD').setInteractive({ useHandCursor: true });
    }
  }

  private async retryCurrentAnimation(): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    const animName = this.currentPreviewAnimName;
    if (!animName) return;

    this.retryAnimBtn.setText('RETRYING...').disableInteractive();
    this.statusText.setText(`Regenerating ${animName}...`).setColor('#ffaa00');

    try {
      await retryAnimation(meta.photoHash, animName, (status) => {
        if (status.stage === 'generating_sprites') {
          this.statusText.setText(`Calling Gemini for ${status.animation}...`);
        } else if (status.stage === 'sprite_ready') {
          this.statusText.setText(`${status.animation} regenerated!`);
        } else if (status.stage === 'done') {
          this.statusText.setText('Retry complete!').setColor('#44ff44');
        }
      });
      await this.loadCharacters();
      const cached = this.sprites.find(s => s.animationName === animName);
      if (cached) this.showBigPreview(cached, animName);
    } catch (err: any) {
      this.statusText.setText(`Retry failed: ${err.message}`).setColor(ACCENT);
    } finally {
      this.retryAnimBtn.setText('\u21bb RETRY THIS ANIMATION').setInteractive({ useHandCursor: true });
    }
  }

  private async retryBase(which: 'side' | 'crouch'): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    const label = which === 'side' ? 'SIDE VIEW' : 'CROUCH';

    this.retryAnimBtn.setText('RETRYING...').disableInteractive();
    this.statusText.setText(`Regenerating ${label}...`).setColor('#ffaa00');

    try {
      const fn = which === 'side' ? retrySideView : retryCrouchView;
      await fn(meta.photoHash, (status) => {
        if (status.stage === 'converting_side_view') {
          this.statusText.setText('Calling Gemini for new side view...');
        } else if (status.stage === 'converting_crouch_view') {
          this.statusText.setText('Calling Gemini for new crouch view...');
        } else if (status.stage === 'done') {
          this.statusText.setText(`${label} regenerated!`).setColor('#44ff44');
        }
      });
      await this.loadCharacters();
    } catch (err: any) {
      this.statusText.setText(`Retry failed: ${err.message}`).setColor(ACCENT);
    } finally {
      const btnLabel = which === 'side' ? '\u21bb RETRY SIDE VIEW' : '\u21bb RETRY CROUCH';
      this.retryAnimBtn.setText(btnLabel).setInteractive({ useHandCursor: true });
    }
  }

  private cleanupHTML(): void {
    this.nameInput?.remove();
    this.fileInput?.remove();
  }

  shutdown(): void {
    this.cleanupHTML();
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
