import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';
import {
  getAllCachedMetas,
  getAllSpritesForHash,
  getAllCachedStageBackgrounds,
  deleteCharacter,
  deleteCachedIntro,
  deleteCachedStageBackground,
  getCachedIntro,
  renameCharacter,
  renameCachedStageBackground,
  updateCharacterIntroConfig,
  CACHE_VERSION,
  type CachedMeta,
  type CachedIntro,
  type CachedIntroVariant,
  type CachedSprite,
  type CachedStageBackground,
} from '../../services/SpriteCache.ts';
import {
  getAnimationList,
  rebuildCharacter,
  retryAnimation,
  retrySideView,
  retryUprightView,
  retryCrouchView,
  type StatusCallback,
} from '../../services/CharacterPipeline.ts';
import { createDirectPhotoStage, createPhotoStage } from '../../services/StageBackgroundService.ts';
import { DEBUG_EVENT_NAME, clearDebugLog, getDebugLogLines } from '../../services/DebugLog.ts';
import { exportAnimationGif } from '../../services/GifExportService.ts';
import { generateCharacterIntroVideo } from '../../services/IntroVideoService.ts';

const FONT = '"Press Start 2P", monospace';
const ACCENT = '#ff4444';
const W = GAME_WIDTH;
const H = GAME_HEIGHT;

const ANIM_LABELS: Record<string, string> = {
  idle: 'IDLE', walk: 'WALK', high_punch: 'PUNCH', low_punch: 'C.PUNCH',
  high_kick: 'KICK', low_kick: 'C.KICK', jump: 'JUMP', crouch: 'CROUCH',
  hit: 'HIT', ko: 'K.O.', victory: 'WIN',
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
const STAGE_PREVIEW_X = W / 2;
const STAGE_PREVIEW_Y = 320;
const STAGE_PREVIEW_W = 660;
const STAGE_PREVIEW_H = 320;

const BTN_Y = H - 26;
const THUMB_DISPLAY_LABELS = ['ORIGINAL', 'SIDE VIEW', 'UPRIGHT', 'CROUCH'];
const INTRO_VIDEO_PROVIDER = ((import.meta.env.VITE_INTRO_VIDEO_PROVIDER as string | undefined) ?? 'fal').trim().toLowerCase();

export class GalleryScene extends Phaser.Scene {
  private activeTab: 'characters' | 'stages' = 'characters';
  private metas: CachedMeta[] = [];
  private sprites: CachedSprite[] = [];
  private stages: CachedStageBackground[] = [];
  private currentIndex = 0;
  private currentStageIndex = 0;
  private selectedAnimIndex = 0;
  private transitioning = false;

  private dynamicObjects: Phaser.GameObjects.GameObject[] = [];

  private counterText!: Phaser.GameObjects.Text;
  private titleText!: Phaser.GameObjects.Text;
  private charactersTabBtn!: Phaser.GameObjects.Text;
  private stagesTabBtn!: Phaser.GameObjects.Text;
  private nameText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;
  private emptyGroup!: Phaser.GameObjects.Container;
  private contentGroup!: Phaser.GameObjects.Container;
  private stageGroup!: Phaser.GameObjects.Container;

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

  private stageNameText!: Phaser.GameObjects.Text;
  private stageInfoText!: Phaser.GameObjects.Text;
  private stageMetaText!: Phaser.GameObjects.Text;
  private stagePreviewLabelText!: Phaser.GameObjects.Text;
  private stagePreviewImage: Phaser.GameObjects.Image | null = null;
  private stagePreviewTextureKey?: string;
  private stagePrevBtn!: Phaser.GameObjects.Text;
  private stageNextBtn!: Phaser.GameObjects.Text;
  private stageDownloadBtn!: Phaser.GameObjects.Text;
  private stageRenameBtn!: Phaser.GameObjects.Text;
  private stageDeleteBtn!: Phaser.GameObjects.Text;
  private stageForgeBtn!: Phaser.GameObjects.Text;
  private stageDirectBtn!: Phaser.GameObjects.Text;
  private openRosterBtn!: Phaser.GameObjects.Text;

  private fileInput!: HTMLInputElement;
  private stageFileInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private introRefInput!: HTMLInputElement;
  private introBriefInput!: HTMLTextAreaElement;
  private stageFileMode: 'forge' | 'direct' = 'forge';
  private prevBtn!: Phaser.GameObjects.Text;
  private createBtn!: Phaser.GameObjects.Text;
  private nextBtn!: Phaser.GameObjects.Text;
  private renameBtn!: Phaser.GameObjects.Text;
  private rebuildBtn!: Phaser.GameObjects.Text;
  private deleteBtn!: Phaser.GameObjects.Text;
  private introVideoBtn!: Phaser.GameObjects.Text;
  private introOverlay?: Phaser.GameObjects.Container;
  private introOverlaySummaryText?: Phaser.GameObjects.Text;
  private introOverlayStatusText?: Phaser.GameObjects.Text;
  private introOverlayAdvanced = false;
  private introVideoLoading = false;
  private introVideoStatusMessage = 'Ready to generate. Add a brief only if you want to steer the shot.';
  private introVideoStatusColor = '#b7dfff';
  private debugListener?: (event: Event) => void;
  private currentIntro: CachedIntro | null = null;
  private introOverlayVideo?: HTMLVideoElement;
  private introOverlayVideoUrl?: string;
  private introInlineVideo?: HTMLVideoElement;
  private introInlineVideoUrl?: string;

  constructor() {
    super({ key: 'GalleryScene' });
  }

  async create(): Promise<void> {
    this.transitioning = false;
    this.currentIndex = 0;
    this.currentStageIndex = 0;
    this.selectedAnimIndex = 0;
    this.dynamicObjects = [];
    this.activeTab = 'characters';

    this.drawBackground();
    this.createHeader();
    this.createEmptyState();
    this.createContentLayout();
    this.createStageLayout();
    this.createBottomUI();
    this.createFileInputs();
    this.setupInput();
    this.setupDebugFeed();
    this.cameras.main.fadeIn(300, 0, 0, 0);

    await Promise.all([this.loadCharacters(), this.loadStages()]);
    this.refreshActiveTab();
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
    this.titleText = this.add.text(W / 2, HEADER_Y, 'GALLERY', {
      fontFamily: FONT, fontSize: '20px', color: '#ffcc00',
      stroke: '#000000', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(10);

    this.counterText = this.add.text(W / 2, COUNTER_Y, '', {
      fontFamily: FONT, fontSize: '8px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);

    this.charactersTabBtn = this.add.text(W / 2 - 70, 62, 'CHARACTERS', {
      fontFamily: FONT, fontSize: '8px', color: '#ffffff',
      stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#291110', padding: { x: 10, y: 6 },
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });
    this.charactersTabBtn.on('pointerdown', () => this.switchTab('characters'));

    this.stagesTabBtn = this.add.text(W / 2 + 70, 62, 'STAGES', {
      fontFamily: FONT, fontSize: '8px', color: '#888888',
      stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#111827', padding: { x: 10, y: 6 },
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });
    this.stagesTabBtn.on('pointerdown', () => this.switchTab('stages'));
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

    // --- Left column: primary source poses only ---
    const thumbLabels = THUMB_DISPLAY_LABELS;
    const thumbCount = thumbLabels.length;

    for (let i = 0; i < thumbCount; i++) {
      const ty = THUMB_START_Y + i * THUMB_STEP;
      const thumbLabel = this.add.text(THUMB_COL_X, ty + THUMB_LABEL_OFFSET, thumbLabels[i], {
        fontFamily: FONT, fontSize: '5px', color: '#666666',
      }).setOrigin(0.5).setDepth(10);
      this.contentGroup.add(thumbLabel);

      const box = this.add.graphics().setDepth(8);
      const half = THUMB_SIZE / 2;
      box.fillStyle(0x0a0a1e, 0.9);
      box.fillRoundedRect(THUMB_COL_X - half, ty - half, THUMB_SIZE, THUMB_SIZE, 5);
      box.lineStyle(1, 0x333366, 0.6);
      box.strokeRoundedRect(THUMB_COL_X - half, ty - half, THUMB_SIZE, THUMB_SIZE, 5);
      this.contentGroup.add(box);

      const hitArea = this.add.rectangle(THUMB_COL_X, ty, THUMB_SIZE, THUMB_SIZE)
        .setInteractive({ useHandCursor: true }).setAlpha(0.001).setDepth(15);
      const thumbIdx = i;
      hitArea.on('pointerdown', () => this.selectThumb(thumbIdx));
      this.contentGroup.add(hitArea);
    }

    // --- Center column: character info + animation grid ---
    this.nameText = this.add.text(INFO_X, INFO_TOP, '', {
      fontFamily: FONT, fontSize: '14px', color: '#ffffff',
      stroke: ACCENT, strokeThickness: 3,
      wordWrap: { width: 380 },
    }).setOrigin(0, 0).setDepth(10);
    this.contentGroup.add(this.nameText);

    this.statusText = this.add.text(INFO_X, INFO_TOP + 22, '', {
      fontFamily: FONT, fontSize: '8px', color: '#44ff44',
    }).setOrigin(0, 0).setDepth(10);
    this.contentGroup.add(this.statusText);

    this.debugText = this.add.text(INFO_X, INFO_TOP + 56, '', {
      fontFamily: FONT, fontSize: '5px', color: '#77d7ff',
      lineSpacing: 3, wordWrap: { width: 390 },
    }).setOrigin(0, 0).setDepth(10);
    this.contentGroup.add(this.debugText);

    this.infoText = this.add.text(INFO_X, INFO_TOP + 108, '', {
      fontFamily: FONT, fontSize: '6px', color: '#aaaaaa',
      lineSpacing: 6, wordWrap: { width: 380 },
    }).setOrigin(0, 0).setDepth(10);
    this.contentGroup.add(this.infoText);

    // Animation selector grid
    this.animGridContainer = this.add.container(0, 0).setDepth(10);
    this.buildAnimGrid();
    this.contentGroup.add(this.animGridContainer);

    // --- Right column: sprite preview ---
    const previewBg = this.add.graphics().setDepth(8);
    const phalf = PREVIEW_SIZE / 2;
    previewBg.fillStyle(0x0a0a1a, 0.9);
    previewBg.fillRoundedRect(PREVIEW_X - phalf, PREVIEW_Y - phalf, PREVIEW_SIZE, PREVIEW_SIZE, 8);
    previewBg.lineStyle(2, 0x333366);
    previewBg.strokeRoundedRect(PREVIEW_X - phalf, PREVIEW_Y - phalf, PREVIEW_SIZE, PREVIEW_SIZE, 8);
    this.contentGroup.add(previewBg);

    this.animNameText = this.add.text(PREVIEW_X, PREVIEW_Y - phalf - 14, 'SELECT ANIMATION', {
      fontFamily: FONT, fontSize: '7px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);
    this.contentGroup.add(this.animNameText);

    this.downloadBtn = this.add.text(PREVIEW_X - 90, PREVIEW_Y + phalf + 14, 'SAVE PNG', {
      fontFamily: FONT, fontSize: '6px', color: '#44aaff',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadBtn.on('pointerover', () => this.downloadBtn.setColor('#88ccff'));
    this.downloadBtn.on('pointerout', () => this.downloadBtn.setColor('#44aaff'));
    this.downloadBtn.on('pointerdown', () => this.downloadCurrentSprite());
    this.contentGroup.add(this.downloadBtn);

    this.downloadRawBtn = this.add.text(PREVIEW_X - 30, PREVIEW_Y + phalf + 14, 'SAVE RAW', {
      fontFamily: FONT, fontSize: '6px', color: '#aa44ff',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadRawBtn.on('pointerover', () => this.downloadRawBtn.setColor('#cc88ff'));
    this.downloadRawBtn.on('pointerout', () => this.downloadRawBtn.setColor('#aa44ff'));
    this.downloadRawBtn.on('pointerdown', () => this.downloadRawSprite());
    this.contentGroup.add(this.downloadRawBtn);

    this.downloadGifBtn = this.add.text(PREVIEW_X + 30, PREVIEW_Y + phalf + 14, 'SAVE GIF', {
      fontFamily: FONT, fontSize: '6px', color: '#44ff88',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadGifBtn.on('pointerover', () => this.downloadGifBtn.setColor('#88ffbb'));
    this.downloadGifBtn.on('pointerout', () => this.downloadGifBtn.setColor('#44ff88'));
    this.downloadGifBtn.on('pointerdown', () => this.downloadGif());
    this.contentGroup.add(this.downloadGifBtn);

    this.downloadAllBtn = this.add.text(PREVIEW_X + 90, PREVIEW_Y + phalf + 14, 'SAVE ALL', {
      fontFamily: FONT, fontSize: '6px', color: '#aaaa44',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.downloadAllBtn.on('pointerover', () => this.downloadAllBtn.setColor('#dddd88'));
    this.downloadAllBtn.on('pointerout', () => this.downloadAllBtn.setColor('#aaaa44'));
    this.downloadAllBtn.on('pointerdown', () => this.downloadAllSprites());
    this.contentGroup.add(this.downloadAllBtn);

    this.retryAnimBtn = this.add.text(PREVIEW_X, PREVIEW_Y + phalf + 28, '\u21bb RETRY THIS ANIMATION', {
      fontFamily: FONT, fontSize: '6px', color: '#ff8844',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true }).setVisible(false);
    this.retryAnimBtn.on('pointerover', () => this.retryAnimBtn.setColor('#ffbb88'));
    this.retryAnimBtn.on('pointerout', () => this.retryAnimBtn.setColor('#ff8844'));
    this.retryAnimBtn.on('pointerdown', () => this.retryCurrentAnimation());
    this.contentGroup.add(this.retryAnimBtn);

    this.introVideoBtn = this.add.text(PREVIEW_X, PREVIEW_Y + phalf + 48, 'INTRO VIDEO', {
      fontFamily: FONT, fontSize: '6px', color: '#ffe8aa',
      stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#2a1f0d',
      padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.introVideoBtn.on('pointerover', () => this.introVideoBtn.setColor('#fff4cc'));
    this.introVideoBtn.on('pointerout', () => this.introVideoBtn.setColor('#ffe8aa'));
    this.introVideoBtn.on('pointerdown', () => this.openIntroVideoOverlay());
    this.contentGroup.add(this.introVideoBtn);
  }

  private createStageLayout(): void {
    this.stageGroup = this.add.container(0, 0).setDepth(21).setVisible(false);

    const previewW = STAGE_PREVIEW_W;
    const previewH = STAGE_PREVIEW_H;
    const previewX = STAGE_PREVIEW_X;
    const previewY = STAGE_PREVIEW_Y;

    this.stageNameText = this.add.text(W / 2, 96, '', {
      fontFamily: FONT, fontSize: '14px', color: '#ffffff',
      stroke: '#44aaff', strokeThickness: 3, wordWrap: { width: 820 }, align: 'center',
    }).setOrigin(0.5, 0).setDepth(10);
    this.stageGroup.add(this.stageNameText);

    this.stageInfoText = this.add.text(W / 2, 124, '', {
      fontFamily: FONT, fontSize: '8px', color: '#66ddff',
      wordWrap: { width: 760 }, lineSpacing: 4, align: 'center',
    }).setOrigin(0.5, 0).setDepth(10);
    this.stageGroup.add(this.stageInfoText);

    this.stageMetaText = this.add.text(W / 2, 148, '', {
      fontFamily: FONT, fontSize: '6px', color: '#aaaaaa',
      wordWrap: { width: 760 }, lineSpacing: 6, align: 'center',
    }).setOrigin(0.5, 0).setDepth(10);
    this.stageGroup.add(this.stageMetaText);

    const previewBg = this.add.graphics().setDepth(8);
    previewBg.fillStyle(0x0a0a1a, 0.92);
    previewBg.fillRoundedRect(previewX - previewW / 2, previewY - previewH / 2, previewW, previewH, 10);
    previewBg.lineStyle(2, 0x335577, 0.9);
    previewBg.strokeRoundedRect(previewX - previewW / 2, previewY - previewH / 2, previewW, previewH, 10);
    this.stageGroup.add(previewBg);

    this.stagePreviewLabelText = this.add.text(previewX, 172, 'SELECT STAGE', {
      fontFamily: FONT, fontSize: '7px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);
    this.stageGroup.add(this.stagePreviewLabelText);

    this.stagePrevBtn = this.add.text(previewX - previewW / 2 + 16, previewY, '<', {
      fontFamily: FONT, fontSize: '16px', color: '#ffe8aa',
      stroke: '#000000', strokeThickness: 4,
      backgroundColor: '#23160d',
      padding: { x: 8, y: 10 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.stagePrevBtn.on('pointerover', () => this.stagePrevBtn.setColor('#fff4cc'));
    this.stagePrevBtn.on('pointerout', () => this.stagePrevBtn.setColor('#ffe8aa'));
    this.stagePrevBtn.on('pointerdown', () => this.navigateStage(-1));
    this.stageGroup.add(this.stagePrevBtn);

    this.stageNextBtn = this.add.text(previewX + previewW / 2 - 16, previewY, '>', {
      fontFamily: FONT, fontSize: '16px', color: '#ffe8aa',
      stroke: '#000000', strokeThickness: 4,
      backgroundColor: '#23160d',
      padding: { x: 8, y: 10 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.stageNextBtn.on('pointerover', () => this.stageNextBtn.setColor('#fff4cc'));
    this.stageNextBtn.on('pointerout', () => this.stageNextBtn.setColor('#ffe8aa'));
    this.stageNextBtn.on('pointerdown', () => this.navigateStage(1));
    this.stageGroup.add(this.stageNextBtn);

    const actionPanel = this.add.graphics().setDepth(9);
    actionPanel.fillStyle(0x081018, 0.95);
    actionPanel.fillRoundedRect(previewX - 300, 498, 600, 48, 10);
    actionPanel.lineStyle(2, 0x223a55, 0.9);
    actionPanel.strokeRoundedRect(previewX - 300, 498, 600, 48, 10);
    this.stageGroup.add(actionPanel);

    this.stageDownloadBtn = this.add.text(previewX - 190, 522, 'SAVE PNG', {
      fontFamily: FONT, fontSize: '9px', color: '#e4f6ff',
      stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#1a4f78',
      padding: { x: 16, y: 10 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.stageDownloadBtn.on('pointerover', () => this.stageDownloadBtn.setColor('#d4efff'));
    this.stageDownloadBtn.on('pointerout', () => this.stageDownloadBtn.setColor('#9ed8ff'));
    this.stageDownloadBtn.on('pointerdown', () => this.downloadCurrentStageFromGallery());
    this.stageGroup.add(this.stageDownloadBtn);

    this.stageRenameBtn = this.add.text(previewX, 522, 'RENAME', {
      fontFamily: FONT, fontSize: '9px', color: '#fff0d4',
      stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#6a3a18',
      padding: { x: 16, y: 10 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.stageRenameBtn.on('pointerover', () => this.stageRenameBtn.setColor('#ffebc7'));
    this.stageRenameBtn.on('pointerout', () => this.stageRenameBtn.setColor('#ffd8a0'));
    this.stageRenameBtn.on('pointerdown', () => this.renameCurrentStageFromGallery());
    this.stageGroup.add(this.stageRenameBtn);

    this.stageDeleteBtn = this.add.text(previewX + 190, 522, 'DELETE', {
      fontFamily: FONT, fontSize: '9px', color: '#ffe0e0',
      stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#6a1c1c',
      padding: { x: 16, y: 10 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.stageDeleteBtn.on('pointerover', () => this.stageDeleteBtn.setColor('#ffc7c7'));
    this.stageDeleteBtn.on('pointerout', () => this.stageDeleteBtn.setColor('#ff9d9d'));
    this.stageDeleteBtn.on('pointerdown', () => this.deleteCurrentStageFromGallery());
    this.stageGroup.add(this.stageDeleteBtn);

    this.stageForgeBtn = this.add.text(previewX - 120, 542, 'FORGE WITH GEMINI', {
      fontFamily: FONT, fontSize: '7px', color: '#f4ffd2',
      stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#2a5a18',
      padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.stageForgeBtn.on('pointerover', () => this.stageForgeBtn.setColor('#ffffff'));
    this.stageForgeBtn.on('pointerout', () => this.stageForgeBtn.setColor('#f4ffd2'));
    this.stageForgeBtn.on('pointerdown', () => this.createNewStage('forge'));
    this.stageGroup.add(this.stageForgeBtn);

    this.stageDirectBtn = this.add.text(previewX + 120, 542, 'USE PHOTO AS-IS', {
      fontFamily: FONT, fontSize: '7px', color: '#d9f6ff',
      stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#184c66',
      padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.stageDirectBtn.on('pointerover', () => this.stageDirectBtn.setColor('#ffffff'));
    this.stageDirectBtn.on('pointerout', () => this.stageDirectBtn.setColor('#d9f6ff'));
    this.stageDirectBtn.on('pointerdown', () => this.createNewStage('direct'));
    this.stageGroup.add(this.stageDirectBtn);

    this.openRosterBtn = this.add.text(previewX, 574, 'OPEN MATCH SETUP', {
      fontFamily: FONT, fontSize: '7px', color: '#d2ffd4',
      stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#17321a',
      padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });
    this.openRosterBtn.on('pointerover', () => this.openRosterBtn.setColor('#d3ffd4'));
    this.openRosterBtn.on('pointerout', () => this.openRosterBtn.setColor('#a8ffab'));
    this.openRosterBtn.on('pointerdown', () => {
      this.scene.start('RosterScene');
    });
    this.stageGroup.add(this.openRosterBtn);
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

    this.prevBtn = this.add.text(W / 2 - 180, BTN_Y, '< PREV', {
      fontFamily: FONT, fontSize: '10px', color: '#44aaff',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.prevBtn.on('pointerover', () => this.prevBtn.setColor('#88ccff'));
    this.prevBtn.on('pointerout', () => this.prevBtn.setColor('#44aaff'));
    this.prevBtn.on('pointerdown', () => this.navigate(-1));

    this.createBtn = this.add.text(W / 2 - 60, BTN_Y, '+ CREATE', {
      fontFamily: FONT, fontSize: '10px', color: '#44ff44',
      stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#0a2a0a',
      padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.createBtn.on('pointerover', () => this.createBtn.setColor('#88ff88'));
    this.createBtn.on('pointerout', () => this.createBtn.setColor('#44ff44'));
    this.createBtn.on('pointerdown', () => this.createNewFighter());

    this.nextBtn = this.add.text(W / 2 + 60, BTN_Y, 'NEXT >', {
      fontFamily: FONT, fontSize: '10px', color: '#44aaff',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.nextBtn.on('pointerover', () => this.nextBtn.setColor('#88ccff'));
    this.nextBtn.on('pointerout', () => this.nextBtn.setColor('#44aaff'));
    this.nextBtn.on('pointerdown', () => this.navigate(1));

    this.renameBtn = this.add.text(W / 2 + 180, BTN_Y, 'RENAME', {
      fontFamily: FONT, fontSize: '10px', color: '#ffcc88',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.renameBtn.on('pointerover', () => this.renameBtn.setColor('#ffe0b0'));
    this.renameBtn.on('pointerout', () => this.renameBtn.setColor('#ffcc88'));
    this.renameBtn.on('pointerdown', () => {
      void this.renameCurrentCharacter();
    });

    this.rebuildBtn = this.add.text(W - 150, BTN_Y, 'REBUILD', {
      fontFamily: FONT, fontSize: '10px', color: '#ffaa00',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.rebuildBtn.on('pointerover', () => this.rebuildBtn.setColor('#ffcc44'));
    this.rebuildBtn.on('pointerout', () => this.rebuildBtn.setColor('#ffaa00'));
    this.rebuildBtn.on('pointerdown', () => this.rebuildCurrent(this.rebuildBtn));

    this.deleteBtn = this.add.text(W - 60, BTN_Y, 'DELETE', {
      fontFamily: FONT, fontSize: '10px', color: ACCENT,
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.deleteBtn.on('pointerover', () => this.deleteBtn.setColor('#ff8888'));
    this.deleteBtn.on('pointerout', () => this.deleteBtn.setColor(ACCENT));
    this.deleteBtn.on('pointerdown', () => this.deleteCurrent());
  }

  // ─── File Input (for create) ─────────────────────────────────

  private createFileInputs(): void {
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.style.display = 'none';
    document.body.appendChild(this.fileInput);

    this.stageFileInput = document.createElement('input');
    this.stageFileInput.type = 'file';
    this.stageFileInput.accept = 'image/png,image/jpeg,image/webp';
    this.stageFileInput.style.display = 'none';
    document.body.appendChild(this.stageFileInput);

    this.introRefInput = document.createElement('input');
    this.introRefInput.type = 'file';
    this.introRefInput.accept = 'image/png,image/jpeg,image/webp';
    this.introRefInput.multiple = true;
    this.introRefInput.style.display = 'none';
    document.body.appendChild(this.introRefInput);

    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'Fighter name...';
    this.nameInput.maxLength = 20;
    this.nameInput.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;font-family:monospace;font-size:18px;padding:12px 20px;background:#111;color:#fff;border:2px solid #ff4444;border-radius:6px;text-align:center;outline:none;display:none;';
    document.body.appendChild(this.nameInput);

    this.introBriefInput = document.createElement('textarea');
    this.introBriefInput.placeholder = 'Describe camera move, attitude, mood, and final pose...';
    this.introBriefInput.maxLength = 500;
    this.introBriefInput.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;width:640px;max-width:82vw;height:220px;font-family:monospace;font-size:16px;line-height:1.45;padding:14px 16px;background:#0b1020;color:#fff;border:2px solid #44aaff;border-radius:8px;outline:none;display:none;resize:none;box-shadow:0 18px 40px rgba(0,0,0,.45);';
    document.body.appendChild(this.introBriefInput);

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      this.fileInput.value = '';
      void this.beginCreateCharacter(file);
    });

    this.stageFileInput.addEventListener('change', () => {
      const file = this.stageFileInput.files?.[0];
      if (!file) return;
      this.stageFileInput.value = '';
      if (this.stageFileMode === 'direct') {
        void this.beginCreateDirectStage(file);
      } else {
        void this.beginCreateStage(file);
      }
    });

    this.introRefInput.addEventListener('change', () => {
      const files = Array.from(this.introRefInput.files ?? []);
      this.introRefInput.value = '';
      if (files.length === 0) return;
      void this.addIntroReferenceImages(files);
    });
  }

  private createNewFighter(): void {
    this.fileInput.click();
  }

  private createNewStage(mode: 'forge' | 'direct'): void {
    this.stageFileMode = mode;
    this.stageFileInput.click();
  }

  private async beginCreateCharacter(file: File): Promise<void> {
    const name = await this.promptForText('', 'Fighter name...', 20);
    if (!name) return;
    this.cameras.main.fadeOut(300, 0, 0, 0);
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.start('CharacterCreationScene', {
        file, characterName: name, slotIndex: 0, returnScene: 'GalleryScene',
      });
    });
  }

  private async beginCreateStage(file: File): Promise<void> {
    this.stagePreviewLabelText.setText('FORGING STAGE...').setColor('#ffd36d');
    this.stageInfoText.setText('RUNNING GEMINI ON YOUR PHOTO. THIS CAN TAKE A MOMENT.');
    this.setStageCreateButtonsEnabled(false);

    try {
      const cached = await createPhotoStage(file, file.name);
      await this.loadStages();
      const nextIndex = this.stages.findIndex((stage) => stage.stageKey === cached.stageKey);
      if (nextIndex >= 0) this.currentStageIndex = nextIndex;
      this.showCurrentStage();
    } catch (err: any) {
      this.stagePreviewLabelText.setText('FORGE FAILED').setColor(ACCENT);
      this.stageInfoText.setText(err?.message ? `FAILED: ${err.message}` : 'FAILED TO FORGE STAGE FROM PHOTO.');
    } finally {
      this.setStageCreateButtonsEnabled(true);
    }
  }

  private async beginCreateDirectStage(file: File): Promise<void> {
    this.stagePreviewLabelText.setText('SAVING PHOTO STAGE...').setColor('#66ddff');
    this.stageInfoText.setText('USING YOUR PHOTO DIRECTLY AS THE ARENA. NO GEMINI STEP.');
    this.setStageCreateButtonsEnabled(false);

    try {
      const cached = await createDirectPhotoStage(file, file.name);
      await this.loadStages();
      const nextIndex = this.stages.findIndex((stage) => stage.stageKey === cached.stageKey);
      if (nextIndex >= 0) this.currentStageIndex = nextIndex;
      this.showCurrentStage();
    } catch (err: any) {
      this.stagePreviewLabelText.setText('SAVE FAILED').setColor(ACCENT);
      this.stageInfoText.setText(err?.message ? `FAILED: ${err.message}` : 'FAILED TO SAVE PHOTO STAGE.');
    } finally {
      this.setStageCreateButtonsEnabled(true);
    }
  }

  private setStageCreateButtonsEnabled(enabled: boolean): void {
    const alpha = enabled ? 1 : 0.6;
    this.stageForgeBtn.setAlpha(alpha);
    this.stageDirectBtn.setAlpha(alpha);
    if (enabled) {
      this.stageForgeBtn.setInteractive({ useHandCursor: true });
      this.stageDirectBtn.setInteractive({ useHandCursor: true });
    } else {
      this.stageForgeBtn.disableInteractive();
      this.stageDirectBtn.disableInteractive();
    }
  }

  // ─── Input ───────────────────────────────────────────────────

  private setupInput(): void {
    const leftKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    const rightKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    const tabKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
    const escKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    leftKey.on('down', () => this.activeTab === 'characters' ? this.navigate(-1) : this.navigateStage(-1));
    rightKey.on('down', () => this.activeTab === 'characters' ? this.navigate(1) : this.navigateStage(1));
    tabKey.on('down', () => this.switchTab(this.activeTab === 'characters' ? 'stages' : 'characters'));
    escKey.on('down', () => this.goBack());
  }

  private setupDebugFeed(): void {
    this.debugListener = () => {
      this.renderDebugLog();
    };
    window.addEventListener(DEBUG_EVENT_NAME, this.debugListener);
    this.renderDebugLog();
  }

  private renderDebugLog(): void {
    if (!this.debugText) return;
    const lines = getDebugLogLines();
    this.debugText.setText(lines.slice(-6).join('\n'));
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
    if (this.activeTab === 'characters') this.showCurrent();
  }

  private async loadStages(): Promise<void> {
    try {
      const all = await getAllCachedStageBackgrounds();
      this.stages = all
        .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      this.stages = [];
    }

    if (this.currentStageIndex >= this.stages.length) {
      this.currentStageIndex = Math.max(0, this.stages.length - 1);
    }
    if (this.activeTab === 'stages') this.showCurrentStage();
  }

  // ─── Display ─────────────────────────────────────────────────

  private clearDynamic(): void {
    for (const obj of this.dynamicObjects) obj.destroy();
    this.dynamicObjects = [];
    if (this.bigPreviewSprite) { this.bigPreviewSprite.destroy(); this.bigPreviewSprite = null; }
    if (this.bigPreviewImage) { this.bigPreviewImage.destroy(); this.bigPreviewImage = null; }
    this.destroyInlineIntroVideoPreview();
  }

  private showCurrent(): void {
    if (this.activeTab !== 'characters') return;
    this.clearDynamic();
    this.selectedAnimIndex = -1;

    if (this.metas.length === 0) {
      this.emptyGroup.setVisible(true);
      this.contentGroup.setVisible(false);
      this.counterText.setText('0 FIGHTERS');
      this.prevBtn.setVisible(false);
      this.nextBtn.setVisible(false);
      this.renameBtn.setVisible(false);
      this.rebuildBtn.setVisible(false);
      this.deleteBtn.setVisible(false);
      this.nameText.setText('');
      this.statusText.setText('');
      this.debugText.setText('');
      this.infoText.setText('');
      this.currentIntro = null;
      this.refreshIntroVideoUI();
      this.animNameText.setText('');
      this.resetAnimGridColors();
      return;
    }

    this.emptyGroup.setVisible(false);
    this.contentGroup.setVisible(true);
    this.prevBtn.setVisible(true);
    this.nextBtn.setVisible(true);
    this.renameBtn.setVisible(true);
    this.rebuildBtn.setVisible(true);
    this.deleteBtn.setVisible(true);

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
    this.renderDebugLog();

    const date = new Date(meta.createdAt);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const animCount = meta.animationsReady?.length || 0;
    this.infoText.setText(
      `CREATED: ${dateStr}  |  ANIMS: ${animCount}  |  ${meta.photoHash.slice(0, 10)}...`
    );
    void this.loadIntroData(meta.photoHash);

    this.animNameText.setText('SELECT ANIMATION').setColor('#888888');
    this.downloadBtn.setVisible(false);
    this.downloadRawBtn.setVisible(false);
    this.downloadGifBtn.setVisible(false);
    this.retryAnimBtn.setVisible(false);
    this.currentPreviewBlob = null;
    this.currentRawBlob = null;
    this.currentPreviewAnimName = '';
    this.downloadAllBtn.setVisible(this.sprites.length > 0 || meta.status === 'ready');

    this.thumbBlobs = [];
    const thumbSlots: { label: string; blob: Blob | null }[] = [
      { label: 'original', blob: meta.originalPhotoBlob },
      { label: 'side_view', blob: meta.sideViewBlob },
      { label: 'upright', blob: meta.uprightViewBlob },
      { label: 'crouch', blob: meta.crouchViewBlob },
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

  private showCurrentStage(): void {
    if (this.activeTab !== 'stages') return;

    this.clearStagePreview();
    if (this.stages.length === 0) {
      this.counterText.setText('0 STAGES');
      this.stageNameText.setText('NO SAVED CUSTOM STAGES');
      this.stageInfoText.setText('MAKE A STAGE FROM A PHOTO HERE. EITHER FORGE IT WITH GEMINI OR USE THE PHOTO AS-IS.');
      this.stageMetaText.setText('UPLOAD A REAL PLACE, SAVE IT DIRECTLY, OR LET GEMINI TURN IT INTO A 2D ARENA. THEN RENAME, DOWNLOAD, OR DELETE IT HERE.');
      this.stagePreviewLabelText.setText('NO STAGE SELECTED').setColor('#888888');
      this.stageDownloadBtn.setVisible(false);
      this.stageRenameBtn.setVisible(false);
      this.stageDeleteBtn.setVisible(false);
      this.stagePrevBtn.setVisible(false);
      this.stageNextBtn.setVisible(false);
      return;
    }

    const stage = this.stages[this.currentStageIndex];
    const isDirectStage = stage.kind === 'photo-direct';
    this.counterText.setText(`STAGE ${this.currentStageIndex + 1} / ${this.stages.length}`);
    this.stageNameText.setText((stage.label ?? 'PHOTO STAGE').toUpperCase());
    this.stageInfoText.setText(isDirectStage ? 'DIRECT PHOTO STAGE' : 'FORGED CUSTOM STAGE');
    const dateStr = new Date(stage.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    this.stageMetaText.setText(
      `CREATED: ${dateStr}  |  ${stage.stageKey.slice(0, 14)}...\n${isDirectStage ? 'USING YOUR ORIGINAL PHOTO AS THE STAGE.' : 'GEMINI-FORGED FROM YOUR PHOTO.'} DOWNLOAD, RENAME, OR DELETE THIS SAVED ARENA.`
    );
    this.stagePreviewLabelText
      .setText(isDirectStage ? 'DIRECT PHOTO PREVIEW' : 'FORGED ARENA PREVIEW')
      .setColor(isDirectStage ? '#8fe4ff' : '#66ddff');
    this.stageDownloadBtn.setVisible(true);
    this.stageRenameBtn.setVisible(true);
    this.stageDeleteBtn.setVisible(true);
    this.stagePrevBtn.setVisible(this.stages.length > 1);
    this.stageNextBtn.setVisible(this.stages.length > 1);
    void this.renderCurrentStagePreview(stage.pngBlob);
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
      this.contentGroup.add(sprite);
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

  private async loadIntroData(photoHash: string): Promise<void> {
    try {
      this.currentIntro = await getCachedIntro(photoHash);
    } catch {
      this.currentIntro = null;
    }
    this.refreshIntroVideoUI();
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
    this.destroyInlineIntroVideoPreview();
    const entry = this.thumbBlobs[thumbIndex];

    this.selectedAnimIndex = -1;
    this.resetAnimGridColors();
    const meta = this.metas[this.currentIndex];
    if (meta) this.highlightAvailableAnims(meta.animationsReady || []);

    if (this.bigPreviewSprite) { this.bigPreviewSprite.destroy(); this.bigPreviewSprite = null; }
    if (this.bigPreviewImage) { this.bigPreviewImage.destroy(); this.bigPreviewImage = null; }

    this.currentPreviewBlob = entry?.blob ?? null;
    this.currentRawBlob = null;
    this.currentPreviewAnimName = entry?.label ?? (
      thumbIndex === 0
        ? 'original'
        : thumbIndex === 1
          ? 'side_view'
          : thumbIndex === 2
            ? 'upright'
            : 'crouch'
    );
    if (thumbIndex === 1 && meta?.sideViewRawBlob) {
      this.currentRawBlob = meta.sideViewRawBlob;
    } else if (thumbIndex === 2 && meta?.uprightViewRawBlob) {
      this.currentRawBlob = meta.uprightViewRawBlob;
    } else if (thumbIndex === 3 && meta?.crouchViewRawBlob) {
      this.currentRawBlob = meta.crouchViewRawBlob;
    }
    this.downloadRawBtn.setVisible(!!this.currentRawBlob);
    this.downloadGifBtn.setVisible(false);

    const canRetrySide = thumbIndex === 1;
    const canRetryUpright = thumbIndex === 2;
    const canRetryCrouch = thumbIndex === 3;
    if (canRetrySide) {
      this.retryAnimBtn.setText('\u21bb RETRY SIDE VIEW');
      this.retryAnimBtn.setVisible(true);
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryBase('side'));
    } else if (canRetryUpright) {
      this.retryAnimBtn.setText('\u21bb RETRY UPRIGHT');
      this.retryAnimBtn.setVisible(true);
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryBase('upright'));
    } else if (canRetryCrouch) {
      this.retryAnimBtn.setText('\u21bb RETRY CROUCH');
      this.retryAnimBtn.setVisible(true);
      this.retryAnimBtn.off('pointerdown');
      this.retryAnimBtn.on('pointerdown', () => this.retryBase('crouch'));
    } else {
      this.retryAnimBtn.setVisible(false);
    }

    const thumbLabel = THUMB_DISPLAY_LABELS[thumbIndex] || this.currentPreviewAnimName.toUpperCase();
    this.animNameText.setText(thumbLabel).setColor('#44aaff');

    if (!entry?.blob) {
      this.animNameText.setColor('#555555').setText(`${thumbLabel} (NOT FOUND)`);
      this.downloadBtn.setVisible(false);
      this.downloadRawBtn.setVisible(!!this.currentRawBlob);
      return;
    }

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
      this.contentGroup.add(this.bigPreviewImage);
      this.dynamicObjects.push(this.bigPreviewImage);

      this.animNameText.setText(
        `${THUMB_DISPLAY_LABELS[thumbIndex]}  ${htmlImg.width}x${htmlImg.height}`
      );
      this.downloadBtn.setVisible(true);
    };
    htmlImg.src = url;
  }

  // ─── Sprite Preview ──────────────────────────────────────────

  private selectAnim(index: number): void {
    this.destroyInlineIntroVideoPreview();
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
      this.currentPreviewAnimName = animName;
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
      this.contentGroup.add(this.bigPreviewSprite);
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

  private navigateStage(dir: number): void {
    if (this.stages.length <= 1) return;
    this.currentStageIndex = (this.currentStageIndex + dir + this.stages.length) % this.stages.length;
    this.showCurrentStage();
  }

  private switchTab(tab: 'characters' | 'stages'): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.refreshActiveTab();
  }

  private refreshActiveTab(): void {
    const characterTab = this.activeTab === 'characters';
    this.charactersTabBtn
      .setColor(characterTab ? '#ffffff' : '#888888')
      .setBackgroundColor(characterTab ? '#291110' : '#171717');
    this.stagesTabBtn
      .setColor(characterTab ? '#888888' : '#ffffff')
      .setBackgroundColor(characterTab ? '#111827' : '#14263a');

    this.emptyGroup.setVisible(characterTab && this.metas.length === 0);
    this.contentGroup.setVisible(characterTab && this.metas.length > 0);
    this.stageGroup.setVisible(!characterTab);

    this.prevBtn.setVisible(characterTab);
    this.createBtn.setVisible(characterTab);
    this.nextBtn.setVisible(characterTab);
    this.renameBtn.setVisible(characterTab);
    this.rebuildBtn.setVisible(characterTab);
    this.deleteBtn.setVisible(characterTab);

    if (characterTab) {
      this.showCurrent();
    } else {
      this.clearDynamic();
      this.showCurrentStage();
    }
  }

  private async renameCurrentCharacter(): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    const nextName = await this.promptForText(meta.characterName, 'Fighter name...', 20);
    if (!nextName) return;
    await renameCharacter(meta.photoHash, nextName);
    await this.loadCharacters();
    this.currentIndex = this.metas.findIndex((entry) => entry.photoHash === meta.photoHash);
    if (this.currentIndex < 0) this.currentIndex = 0;
    this.showCurrent();
  }

  private downloadCurrentStageFromGallery(): void {
    if (this.stages.length === 0) return;
    const stage = this.stages[this.currentStageIndex];
    const safeName = ((stage.label ?? 'photo_stage').toLowerCase().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')) || 'photo_stage';
    downloadBlob(stage.pngBlob, `${safeName}.png`);
  }

  private async renameCurrentStageFromGallery(): Promise<void> {
    if (this.stages.length === 0) return;
    const stage = this.stages[this.currentStageIndex];
    const nextName = await this.promptForText(stage.label ?? 'PHOTO STAGE', 'Stage name...', 28);
    if (!nextName) return;
    await renameCachedStageBackground(stage.stageKey, nextName);
    await this.loadStages();
    this.currentStageIndex = this.stages.findIndex((entry) => entry.stageKey === stage.stageKey);
    if (this.currentStageIndex < 0) this.currentStageIndex = 0;
    this.showCurrentStage();
  }

  private async deleteCurrentStageFromGallery(): Promise<void> {
    if (this.stages.length === 0) return;
    const stage = this.stages[this.currentStageIndex];
    await deleteCachedStageBackground(stage.stageKey);
    await this.loadStages();
    this.currentStageIndex = Math.min(this.currentStageIndex, Math.max(0, this.stages.length - 1));
    this.showCurrentStage();
  }

  private clearStagePreview(): void {
    if (this.stagePreviewImage) {
      this.stagePreviewImage.destroy();
      this.stagePreviewImage = null;
    }
    if (this.stagePreviewTextureKey && this.textures.exists(this.stagePreviewTextureKey)) {
      this.textures.remove(this.stagePreviewTextureKey);
      this.stagePreviewTextureKey = undefined;
    }
  }

  private async renderCurrentStagePreview(blob: Blob): Promise<void> {
    this.clearStagePreview();
    const img = await blobToImage(blob);
    const canvas = document.createElement('canvas');
    const width = STAGE_PREVIEW_W - 8;
    const height = STAGE_PREVIEW_H - 8;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const scale = Math.max(width / img.width, height / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    ctx.drawImage(img, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);

    const texKey = `gallery_stage_${Date.now()}`;
    if (this.textures.exists(texKey)) this.textures.remove(texKey);
    this.textures.addCanvas(texKey, canvas);
    this.stagePreviewTextureKey = texKey;
    this.stagePreviewImage = this.add.image(STAGE_PREVIEW_X, STAGE_PREVIEW_Y, texKey).setDepth(12);
    this.stageGroup.add(this.stagePreviewImage);
  }

  private getIntroSummary(meta: CachedMeta): string {
    const extraRefs = meta.introVideoReferenceBlobs?.length ?? 0;
    const brief = (meta.introVideoPrompt ?? '').trim();
    const hasOriginal = !!meta.originalPhotoBlob;
    const activeVariant = this.getActiveIntroVariant();
    const model = activeVariant?.model ?? meta.introVideoModel ?? 'fal-ltx-v2-3-fast';
    const videoState = this.currentIntro ? 'Video ready' : 'No cached video yet';
    const briefState = brief ? `Brief: ${brief.length} chars` : 'Brief: using default cinematic prompt';
    const modelLabel =
      model === 'runway-gen4-turbo'
        ? 'Provider: Runway Gen-4 Turbo'
        : model === 'fal-ltx-v2-3-fast'
          ? 'Provider: fal LTX 2.3 Fast'
        : model === 'fal-kling-v2-6-pro' || model === 'fal-vidu-q3'
          ? 'Provider: fal Kling 2.6 Pro'
          : model === 'freepik-auto'
            ? 'Provider: Freepik Auto'
            : model === 'veo-3-1'
              ? 'Provider: Freepik Veo 3.1'
              : 'Provider: Freepik Kling 2.1';
    return [
      `${videoState}`,
      `${briefState}`,
      `Preview: ${activeVariant?.label ?? 'VIDEO'}`,
      `Automatic base image: ${hasOriginal ? 'original photo' : 'best available character image'}`,
      `Extra ref images: ${extraRefs}/2`,
      `${modelLabel}`,
    ].join('\n');
  }

  private getIntroVariants(): CachedIntroVariant[] {
    return this.currentIntro?.variants ?? [];
  }

  private getActiveIntroVariant(): CachedIntroVariant | null {
    const variants = this.getIntroVariants();
    if (variants.length === 0) return null;
    const activeId = this.currentIntro?.activeVariantId;
    return variants.find((variant) => variant.id === activeId) ?? variants[0];
  }

  private refreshIntroOverlaySummary(): void {
    if (!this.introOverlaySummaryText || this.metas.length === 0) return;
    this.introOverlaySummaryText.setText(this.getIntroSummary(this.metas[this.currentIndex]));
  }

  private refreshIntroOverlayStatus(): void {
    if (!this.introOverlayStatusText) return;
    this.introOverlayStatusText.setText(this.introVideoStatusMessage).setColor(this.introVideoStatusColor);
  }

  private getIntroVideoProviderLabel(): string {
    switch (INTRO_VIDEO_PROVIDER) {
      case 'runway':
      case 'runway-gen4':
      case 'runway-gen4-turbo':
        return 'RUNWAY';
      case 'fal':
      case 'fal-kling':
      case 'fal-kling-v2-6-pro':
      case 'fal-vidu':
      case 'fal-vidu-q3':
        return 'FAL';
      case 'freepik':
      case 'freepik-auto':
      case 'kling':
      case 'kling-v2-1-std':
      case 'veo':
      case 'veo-3-1':
      default:
        return 'FREEPIK';
    }
  }

  private refreshIntroVideoUI(): void {
    if (this.introVideoBtn) {
      this.introVideoBtn.setText(this.currentIntro ? 'EDIT VIDEO' : 'INTRO VIDEO');
    }
    if (
      this.activeTab === 'characters' &&
      this.metas.length > 0 &&
      this.selectedAnimIndex === -1 &&
      !this.currentPreviewBlob &&
      !this.currentPreviewAnimName
    ) {
      this.showInlineIntroPreview();
      return;
    }
    this.destroyInlineIntroVideoPreview();
  }

  private closeIntroVideoOverlay(): void {
    this.introOverlay?.destroy(true);
    this.introOverlay = undefined;
    this.introOverlaySummaryText = undefined;
    this.introOverlayStatusText = undefined;
    this.destroyOverlayIntroVideoPreview();
  }

  private destroyOverlayIntroVideoPreview(): void {
    if (this.introOverlayVideo) {
      this.introOverlayVideo.pause();
      this.introOverlayVideo.removeAttribute('src');
      this.introOverlayVideo.load();
      this.introOverlayVideo.remove();
      this.introOverlayVideo = undefined;
    }
    if (this.introOverlayVideoUrl) {
      URL.revokeObjectURL(this.introOverlayVideoUrl);
      this.introOverlayVideoUrl = undefined;
    }
  }

  private destroyInlineIntroVideoPreview(): void {
    if (this.introInlineVideo) {
      this.introInlineVideo.pause();
      this.introInlineVideo.removeAttribute('src');
      this.introInlineVideo.load();
      this.introInlineVideo.remove();
      this.introInlineVideo = undefined;
    }
    if (this.introInlineVideoUrl) {
      URL.revokeObjectURL(this.introInlineVideoUrl);
      this.introInlineVideoUrl = undefined;
    }
  }

  private mountOverlayIntroVideoPreview(cx: number, cy: number, width: number, height: number): void {
    this.destroyOverlayIntroVideoPreview();
    const activeVariant = this.getActiveIntroVariant();
    if (!activeVariant) return;

    const container = document.getElementById('game-container') ?? this.game.canvas.parentElement ?? this.game.canvas;
    const rect = container.getBoundingClientRect();
    const scaleX = rect.width / W;
    const scaleY = rect.height / H;
    const left = rect.left + (cx - width / 2) * scaleX;
    const top = rect.top + (cy - height / 2) * scaleY;

    this.introOverlayVideoUrl = URL.createObjectURL(activeVariant.videoBlob);
    const video = document.createElement('video');
    video.src = this.introOverlayVideoUrl;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.controls = true;
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.left = `${left}px`;
    video.style.top = `${top}px`;
    video.style.width = `${width * scaleX}px`;
    video.style.height = `${height * scaleY}px`;
    video.style.objectFit = 'contain';
    video.style.background = '#050812';
    video.style.border = '2px solid #40658b';
    video.style.borderRadius = '8px';
    video.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)';
    video.style.zIndex = '1100';
    container.appendChild(video);
    this.introOverlayVideo = video;
    void video.play().catch(() => {});
  }

  private mountInlineIntroVideoPreview(cx: number, cy: number, width: number, height: number): void {
    this.destroyInlineIntroVideoPreview();
    const activeVariant = this.getActiveIntroVariant();
    if (!activeVariant) return;

    const container = document.getElementById('game-container') ?? this.game.canvas.parentElement ?? this.game.canvas;
    const rect = container.getBoundingClientRect();
    const scaleX = rect.width / W;
    const scaleY = rect.height / H;
    const left = rect.left + (cx - width / 2) * scaleX;
    const top = rect.top + (cy - height / 2) * scaleY;

    this.introInlineVideoUrl = URL.createObjectURL(activeVariant.videoBlob);
    const video = document.createElement('video');
    video.src = this.introInlineVideoUrl;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.controls = false;
    video.playsInline = true;
    video.style.position = 'fixed';
    video.style.left = `${left}px`;
    video.style.top = `${top}px`;
    video.style.width = `${width * scaleX}px`;
    video.style.height = `${height * scaleY}px`;
    video.style.objectFit = 'contain';
    video.style.background = '#050812';
    video.style.border = '2px solid #40658b';
    video.style.borderRadius = '8px';
    video.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
    video.style.zIndex = '120';
    video.style.cursor = 'pointer';
    video.addEventListener('click', () => this.openIntroVideoOverlay());
    container.appendChild(video);
    this.introInlineVideo = video;
    void video.play().catch(() => {});
  }

  private showInlineIntroPreview(): void {
    if (!this.currentIntro) {
      this.destroyInlineIntroVideoPreview();
      return;
    }
    if (this.bigPreviewSprite) { this.bigPreviewSprite.destroy(); this.bigPreviewSprite = null; }
    if (this.bigPreviewImage) { this.bigPreviewImage.destroy(); this.bigPreviewImage = null; }
    this.currentPreviewBlob = null;
    this.currentRawBlob = null;
    this.currentPreviewAnimName = '';
    this.downloadBtn.setVisible(false);
    this.downloadRawBtn.setVisible(false);
    this.downloadGifBtn.setVisible(false);
    this.retryAnimBtn.setVisible(false);
    this.animNameText.setText('INTRO VIDEO READY').setColor('#ffdd66');
    this.mountInlineIntroVideoPreview(PREVIEW_X, PREVIEW_Y, PREVIEW_SIZE - 18, PREVIEW_SIZE - 18);
  }

  private openIntroVideoOverlay(): void {
    if (this.metas.length === 0) return;
    this.closeIntroVideoOverlay();
    this.destroyInlineIntroVideoPreview();

    const meta = this.metas[this.currentIndex];
    const extraRefs = meta.introVideoReferenceBlobs?.length ?? 0;
    const brief = (meta.introVideoPrompt ?? '').trim();
    const isLoading = this.introVideoLoading;
    const providerLabel = this.getIntroVideoProviderLabel();
    const hasVideoPreview = !!this.currentIntro;
    const activeVariant = this.getActiveIntroVariant();
    const overlay = this.add.container(0, 0).setDepth(200);
    this.introOverlay = overlay;

    const dim = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.72).setDepth(200);
    overlay.add(dim);

    const panelWidth = hasVideoPreview ? 840 : 700;
    const panelHeight = hasVideoPreview
      ? (this.introOverlayAdvanced ? 560 : 520)
      : (this.introOverlayAdvanced ? 420 : 330);
    const panelTop = hasVideoPreview ? 18 : 42;
    const panelLeft = W / 2 - panelWidth / 2;
    const panel = this.add.graphics().setDepth(201);
    panel.fillStyle(0x091120, 0.98);
    panel.fillRoundedRect(panelLeft, panelTop, panelWidth, panelHeight, 12);
    panel.lineStyle(2, 0x335577, 1);
    panel.strokeRoundedRect(panelLeft, panelTop, panelWidth, panelHeight, 12);
    overlay.add(panel);

    const title = this.add.text(W / 2, panelTop + 24, 'INTRO VIDEO', {
      fontFamily: FONT, fontSize: '12px', color: '#ffdd66',
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(202);
    overlay.add(title);

    const closeBtn = this.add.text(panelLeft + panelWidth - 28, panelTop + 24, 'X', {
      fontFamily: FONT, fontSize: '10px', color: '#ffffff',
      stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#3a1515', padding: { x: 8, y: 6 },
    }).setOrigin(0.5).setDepth(203);
    if (!isLoading) closeBtn.setInteractive({ useHandCursor: true });
    closeBtn.on('pointerdown', () => {
      this.closeIntroVideoOverlay();
      this.refreshIntroVideoUI();
    });
    overlay.add(closeBtn);

    const guide = this.add.text(W / 2, panelTop + 54,
      'THE ORIGINAL PHOTO IS USED AUTOMATICALLY. ADD A BRIEF ONLY IF YOU WANT TO STEER THE SHOT.',
      {
        fontFamily: FONT, fontSize: '6px', color: '#a7dfff',
        stroke: '#000000', strokeThickness: 2, align: 'center', lineSpacing: 6,
        wordWrap: { width: panelWidth - 60 },
      }).setOrigin(0.5, 0).setDepth(202);
    overlay.add(guide);

    const wideLayout = hasVideoPreview;
    const rightColW = 270;
    const rightColCenterX = panelLeft + panelWidth - 44 - rightColW / 2;
    const videoCx = panelLeft + 210;
    const videoCy = panelTop + 272;
    const videoW = 340;
    const videoH = 400;
    const promptCardX = wideLayout ? (rightColCenterX - rightColW / 2) : (W / 2 - 280);
    const promptCardY = panelTop + 92;
    const promptCardW = wideLayout ? rightColW : 560;
    const promptCardH = wideLayout ? 110 : 78;

    if (hasVideoPreview) {
      const previewLabel = this.add.text(videoCx, panelTop + 86, 'VIDEO PREVIEW', {
        fontFamily: FONT, fontSize: '7px', color: '#ffdd66',
        stroke: '#000000', strokeThickness: 2,
      }).setOrigin(0.5).setDepth(202);
      overlay.add(previewLabel);
      this.mountOverlayIntroVideoPreview(videoCx, videoCy, videoW, videoH);
    }

    const promptCard = this.add.graphics().setDepth(201);
    promptCard.fillStyle(0x101a2e, 1);
    promptCard.fillRoundedRect(promptCardX, promptCardY, promptCardW, promptCardH, 10);
    promptCard.lineStyle(2, 0x40658b, 1);
    promptCard.strokeRoundedRect(promptCardX, promptCardY, promptCardW, promptCardH, 10);
    overlay.add(promptCard);

    const promptLabel = this.add.text(promptCardX + promptCardW / 2, promptCardY + 12, 'OPTIONAL BRIEF', {
      fontFamily: FONT, fontSize: '7px', color: '#ffdd66',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 0).setDepth(202);
    overlay.add(promptLabel);

    const promptText = this.add.text(promptCardX + promptCardW / 2, promptCardY + 32,
      brief
        ? `"${brief.slice(0, wideLayout ? 110 : 130)}${brief.length > (wideLayout ? 110 : 130) ? '...' : ''}"`
        : 'No custom brief yet. Click here to describe camera, attitude, motion or final pose.',
      {
        fontFamily: FONT, fontSize: '6px', color: brief ? '#ffffff' : '#9fd3ff',
        stroke: '#000000', strokeThickness: 2, align: 'center', lineSpacing: 6,
        wordWrap: { width: promptCardW - 34 },
      }).setOrigin(0.5, 0).setDepth(202);
    overlay.add(promptText);

    const promptHint = this.add.text(promptCardX + promptCardW / 2, promptCardY + promptCardH - 16,
      'CLICK TO EDIT',
      {
        fontFamily: FONT, fontSize: '5px', color: '#ffe2a8',
        stroke: '#000000', strokeThickness: 2, align: 'center',
      }).setOrigin(0.5, 1).setDepth(202);
    overlay.add(promptHint);

    const promptClickZone = this.add.zone(promptCardX + promptCardW / 2, promptCardY + promptCardH / 2, promptCardW, promptCardH)
      .setDepth(203);
    if (!isLoading) promptClickZone.setInteractive({ useHandCursor: true });
    promptClickZone.on('pointerdown', () => {
      void this.editIntroBrief();
    });
    overlay.add(promptClickZone);

    const statusX = wideLayout ? rightColCenterX : W / 2;
    const statusY = wideLayout ? (promptCardY + promptCardH + 20) : (panelTop + 232);
    this.introOverlayStatusText = this.add.text(statusX, statusY, this.introVideoStatusMessage, {
      fontFamily: FONT, fontSize: '7px', color: '#ffffff',
      stroke: '#000000', strokeThickness: 2, align: 'center', lineSpacing: 8,
      wordWrap: { width: wideLayout ? (rightColW - 10) : (panelWidth - 70) },
    }).setOrigin(0.5, 0).setDepth(202);
    this.refreshIntroOverlayStatus();
    overlay.add(this.introOverlayStatusText);

    if (this.introOverlayAdvanced) {
      const summaryY = wideLayout ? (statusY + 70) : (panelTop + 272);
      this.introOverlaySummaryText = this.add.text(wideLayout ? rightColCenterX : W / 2, summaryY, this.getIntroSummary(meta), {
        fontFamily: FONT, fontSize: '7px', color: '#ffffff',
        stroke: '#000000', strokeThickness: 2, align: 'center', lineSpacing: 8,
        wordWrap: { width: wideLayout ? (rightColW - 10) : (panelWidth - 70) },
      }).setOrigin(0.5, 0).setDepth(202);
      overlay.add(this.introOverlaySummaryText);
    }

    const makeBtn = (
      x: number,
      y: number,
      label: string,
      color: string,
      bg: string,
      onClick: () => void,
      enabled = true,
    ) => {
      const btn = this.add.text(x, y, label, {
        fontFamily: FONT, fontSize: '7px', color,
        stroke: '#000000', strokeThickness: 2,
        backgroundColor: bg,
        padding: { x: 12, y: 8 },
      }).setOrigin(0.5).setDepth(203);
      if (enabled) {
        btn.setInteractive({ useHandCursor: true });
        btn.on('pointerdown', onClick);
      } else {
        btn.setAlpha(0.55);
      }
      overlay.add(btn);
      return btn;
    };

    const primaryButtonsY = wideLayout ? (this.introOverlayAdvanced ? panelTop + 428 : panelTop + 360) : (panelTop + 346);
    makeBtn(wideLayout ? (rightColCenterX - 78) : (W / 2 - 90), primaryButtonsY, isLoading ? 'GENERATING...' : (this.currentIntro ? 'REGENERATE VIDEO' : 'GENERATE VIDEO'), '#fff6d2', '#6a5316', () => {
      void this.generateIntroVideoFromOverlay();
    }, !isLoading);
    makeBtn(wideLayout ? (rightColCenterX + 78) : (W / 2 + 110), primaryButtonsY, this.introOverlayAdvanced ? 'HIDE ADVANCED' : 'ADVANCED', '#f4ffd2', '#2a5a18', () => {
      this.introOverlayAdvanced = !this.introOverlayAdvanced;
      this.openIntroVideoOverlay();
    }, !isLoading);

    if (this.introOverlayAdvanced) {
      const advancedTop = wideLayout ? (primaryButtonsY + 32) : (panelTop + 388);
      const advancedLabel = this.add.text(wideLayout ? rightColCenterX : W / 2, advancedTop, 'ADVANCED', {
        fontFamily: FONT, fontSize: '7px', color: '#ffdd66',
        stroke: '#000000', strokeThickness: 2,
      }).setOrigin(0.5).setDepth(202);
      overlay.add(advancedLabel);

      const advancedSummary = this.add.text(wideLayout ? rightColCenterX : W / 2, advancedTop + 16,
        `Provider: ${providerLabel}  |  Extra refs: ${extraRefs}/2${this.currentIntro ? '  |  Video ready to download' : ''}`,
        {
          fontFamily: FONT, fontSize: '6px', color: '#b7dfff',
          stroke: '#000000', strokeThickness: 2, align: 'center',
          wordWrap: { width: wideLayout ? (rightColW - 10) : 560 },
        }).setOrigin(0.5).setDepth(202);
      overlay.add(advancedSummary);

      const advancedButtonsY = advancedTop + 54;
      makeBtn(this.currentIntro ? (wideLayout ? rightColCenterX - 78 : W / 2 - 90) : (wideLayout ? rightColCenterX : W / 2 - 40), advancedButtonsY, 'ADD REF IMAGE', '#f4ffd2', '#2a5a18', () => {
        this.introRefInput.click();
      }, !isLoading);
      if (extraRefs > 0) {
        makeBtn(this.currentIntro ? (wideLayout ? rightColCenterX + 78 : W / 2 + 90) : (wideLayout ? rightColCenterX + 100 : W / 2 + 110), advancedButtonsY, 'CLEAR REFS', '#ffe0e0', '#6a1c1c', () => {
          void this.clearIntroReferenceImages();
        }, !isLoading);
      }
      if (this.currentIntro) {
        makeBtn(wideLayout ? rightColCenterX : (W / 2 + 170), advancedButtonsY + 40, 'DOWNLOAD VIDEO', '#d4e8ff', '#1a4f78', () => {
          this.downloadCurrentIntroVideo();
        }, !isLoading);
      }
    }
  }

  private async editIntroBrief(): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    const nextBrief = await this.promptForMultilineText(
      meta.introVideoPrompt ?? '',
      'Describe camera move, emotion, tiny action, and final pose. Cmd/Ctrl+Enter to save. Leave empty to remove it.',
      500,
    );
    if (nextBrief === null) return;
    await updateCharacterIntroConfig(meta.photoHash, {
      introVideoPrompt: nextBrief,
    });
    await deleteCachedIntro(meta.photoHash);
    await this.loadCharacters();
    this.currentIndex = this.metas.findIndex((entry) => entry.photoHash === meta.photoHash);
    if (this.currentIndex < 0) this.currentIndex = 0;
    await this.loadIntroData(meta.photoHash);
    this.refreshIntroOverlaySummary();
  }

  private async addIntroReferenceImages(files: File[]): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    const current = meta.introVideoReferenceBlobs ?? [];
    const next = [...current, ...files].slice(0, 2);
    await updateCharacterIntroConfig(meta.photoHash, {
      introVideoReferenceBlobs: next,
    });
    await deleteCachedIntro(meta.photoHash);
    await this.loadCharacters();
    this.currentIndex = this.metas.findIndex((entry) => entry.photoHash === meta.photoHash);
    if (this.currentIndex < 0) this.currentIndex = 0;
    await this.loadIntroData(meta.photoHash);
    this.refreshIntroOverlaySummary();
  }

  private async clearIntroReferenceImages(): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    await updateCharacterIntroConfig(meta.photoHash, {
      introVideoReferenceBlobs: [],
    });
    await deleteCachedIntro(meta.photoHash);
    await this.loadCharacters();
    this.currentIndex = this.metas.findIndex((entry) => entry.photoHash === meta.photoHash);
    if (this.currentIndex < 0) this.currentIndex = 0;
    await this.loadIntroData(meta.photoHash);
    this.refreshIntroOverlaySummary();
  }

  private async generateIntroVideoFromOverlay(): Promise<void> {
    if (this.metas.length === 0 || this.introVideoLoading) return;
    const meta = this.metas[this.currentIndex];
    this.introVideoLoading = true;
    this.introVideoStatusMessage = 'Preparing intro video...';
    this.introVideoStatusColor = '#ffd36d';
    if (this.introOverlay) this.openIntroVideoOverlay();
    this.statusText.setText('Generating intro video...').setColor('#ffaa00');

    try {
      if (this.currentIntro) {
        this.statusText.setText('Refreshing intro video...').setColor('#ffaa00');
        await deleteCachedIntro(meta.photoHash);
        this.currentIntro = null;
        this.refreshIntroOverlaySummary();
      }
      this.currentIntro = await generateCharacterIntroVideo(meta.photoHash, (status) => {
        switch (status.stage) {
          case 'preparing':
            this.statusText.setText('Preparing intro inputs...');
            this.introVideoStatusMessage = 'Preparing intro inputs...';
            break;
          case 'uploading_inputs':
            this.statusText.setText(`Uploading intro inputs (${status.count})...`);
            this.introVideoStatusMessage = `Uploading inputs (${status.count})...`;
            break;
          case 'creating_task':
            this.statusText.setText(`Creating ${status.model} video task...`);
            this.introVideoStatusMessage = `Creating ${status.model} task...`;
            break;
          case 'polling':
            this.statusText.setText(`${status.model} status: ${status.status}`);
            this.introVideoStatusMessage = `Rendering video... ${status.status}`;
            break;
          case 'fetching_result':
            this.statusText.setText('Fetching intro video...');
            this.introVideoStatusMessage = 'Fetching rendered video...';
            break;
          case 'cached':
            this.statusText.setText('Intro video already cached.').setColor('#44ff44');
            this.introVideoStatusMessage = 'Video already cached.';
            this.introVideoStatusColor = '#44ff44';
            break;
          case 'done':
            this.statusText.setText('Intro video ready!').setColor('#44ff44');
            this.introVideoStatusMessage = 'Video ready. Regenerate it or open advanced to download the current one.';
            this.introVideoStatusColor = '#44ff44';
            break;
          case 'error':
            this.statusText.setText(`Intro video failed: ${status.message}`).setColor(ACCENT);
            this.introVideoStatusMessage = `Failed: ${status.message}`;
            this.introVideoStatusColor = ACCENT;
            break;
        }
        this.refreshIntroOverlayStatus();
      });
      this.refreshIntroOverlaySummary();
      this.refreshIntroVideoUI();
    } catch (err: any) {
      this.statusText.setText(`Intro video failed: ${err?.message || 'unknown error'}`).setColor(ACCENT);
      this.introVideoStatusMessage = `Failed: ${err?.message || 'unknown error'}`;
      this.introVideoStatusColor = ACCENT;
      this.refreshIntroOverlayStatus();
    } finally {
      this.introVideoLoading = false;
      if (this.introOverlay) this.openIntroVideoOverlay();
    }
  }

  private downloadCurrentIntroVideo(): void {
    const activeVariant = this.getActiveIntroVariant();
    if (!activeVariant || this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    const safeName = (meta.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
    const ext = activeVariant.mimeType.includes('webm') ? 'webm' : 'mp4';
    downloadBlob(activeVariant.videoBlob, `${safeName}_intro.${ext}`);
  }

  private promptForText(initialValue: string, placeholder: string, maxLength: number): Promise<string | null> {
    return new Promise((resolve) => {
      this.nameInput.placeholder = placeholder;
      this.nameInput.maxLength = maxLength;
      this.nameInput.value = initialValue;
      this.nameInput.style.display = 'block';
      this.nameInput.focus();
      this.nameInput.select();

      const cleanup = () => {
        this.nameInput.style.display = 'none';
        this.nameInput.removeEventListener('keydown', onKeydown);
        this.nameInput.removeEventListener('blur', onBlur);
      };

      const submit = () => {
        const value = this.nameInput.value.trim().slice(0, maxLength);
        cleanup();
        resolve(value || null);
      };

      const cancel = () => {
        cleanup();
        resolve(null);
      };

      const onKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') submit();
        else if (e.key === 'Escape') cancel();
        e.stopPropagation();
      };
      const onBlur = () => submit();

      this.nameInput.addEventListener('keydown', onKeydown);
      this.nameInput.addEventListener('blur', onBlur, { once: true });
    });
  }

  private promptForMultilineText(initialValue: string, placeholder: string, maxLength: number): Promise<string | null> {
    return new Promise((resolve) => {
      this.introBriefInput.placeholder = placeholder;
      this.introBriefInput.maxLength = maxLength;
      this.introBriefInput.value = initialValue;
      this.introBriefInput.style.display = 'block';
      this.introBriefInput.focus();
      this.introBriefInput.select();

      const cleanup = () => {
        this.introBriefInput.style.display = 'none';
        this.introBriefInput.removeEventListener('keydown', onKeydown);
        this.introBriefInput.removeEventListener('blur', onBlur);
      };

      const submit = () => {
        const value = this.introBriefInput.value.trim().slice(0, maxLength);
        cleanup();
        resolve(value);
      };

      const cancel = () => {
        cleanup();
        resolve(null);
      };

      const onKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
        e.stopPropagation();
      };
      const onBlur = () => submit();

      this.introBriefInput.addEventListener('keydown', onKeydown);
      this.introBriefInput.addEventListener('blur', onBlur, { once: true });
    });
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
      this.downloadGifBtn.setText('COMPOSING...');
      const blob = await exportAnimationGif(cached, animName);
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
    if (meta.sideViewRawBlob)    downloadBlob(meta.sideViewRawBlob, `${safeName}_side_view_RAW.png`);
    if (meta.uprightViewBlob)    downloadBlob(meta.uprightViewBlob, `${safeName}_upright.png`);
    if (meta.uprightViewRawBlob) downloadBlob(meta.uprightViewRawBlob, `${safeName}_upright_RAW.png`);
    if (meta.crouchViewBlob)     downloadBlob(meta.crouchViewBlob, `${safeName}_crouch.png`);
    if (meta.crouchViewRawBlob)  downloadBlob(meta.crouchViewRawBlob, `${safeName}_crouch_RAW.png`);

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
    const selectedAnim =
      this.selectedAnimIndex >= 0 ? getAnimationList()[this.selectedAnimIndex] : null;
    const animName = selectedAnim?.name || this.currentPreviewAnimName;
    if (!animName) return;
    const label = ANIM_LABELS[animName] || animName.toUpperCase();

    this.retryAnimBtn.setText('RETRYING...').disableInteractive();
    this.statusText.setText(`Regenerating ${animName}...`).setColor('#ffaa00');
    clearDebugLog();
    this.renderDebugLog();
    this.animNameText.setColor('#ffaa00').setText(`${label}  RETRYING...`);
    this.downloadBtn.setVisible(false);
    this.downloadRawBtn.setVisible(false);
    this.downloadGifBtn.setVisible(false);

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
      await this.loadSpriteData(meta.photoHash);
      const cached = this.sprites.find(s => s.animationName === animName);
      if (cached) await this.showBigPreview(cached, animName);
    } catch (err: any) {
      this.statusText.setText(`Retry failed: ${err.message}`).setColor(ACCENT);
    } finally {
      this.retryAnimBtn.setText('\u21bb RETRY THIS ANIMATION').setInteractive({ useHandCursor: true });
    }
  }

  private async retryBase(which: 'side' | 'upright' | 'crouch'): Promise<void> {
    if (this.metas.length === 0) return;
    const meta = this.metas[this.currentIndex];
    const label =
      which === 'crouch'
        ? 'CROUCH'
        : which === 'upright'
          ? 'UPRIGHT'
          : 'SIDE VIEW';

    this.retryAnimBtn.setText('RETRYING...').disableInteractive();
    this.statusText.setText(`Regenerating ${label}...`).setColor('#ffaa00');
    clearDebugLog();
    this.renderDebugLog();

    try {
      if (which === 'crouch') {
        await retryCrouchView(meta.photoHash, (status) => {
          if (status.stage === 'converting_upright_view') {
            this.statusText.setText('Straightening stance before crouch...');
          } else if (status.stage === 'converting_crouch_view') {
            this.statusText.setText('Calling Gemini for new crouch...');
          } else if (status.stage === 'done') {
            this.statusText.setText(`${label} regenerated!`).setColor('#44ff44');
          }
        });
      } else if (which === 'upright') {
        await retryUprightView(meta.photoHash, (status) => {
          if (status.stage === 'converting_upright_view') {
            this.statusText.setText('Calling Gemini for new upright view...');
          } else if (status.stage === 'done') {
            this.statusText.setText(`${label} regenerated!`).setColor('#44ff44');
          }
        });
      } else {
        await retrySideView(meta.photoHash, (status) => {
          if (status.stage === 'converting_side_view') {
            this.statusText.setText('Calling Gemini for new side view...');
          } else if (status.stage === 'done') {
            this.statusText.setText(`${label} regenerated!`).setColor('#44ff44');
          }
        });
      }
      await this.loadCharacters();
      if (which === 'crouch') this.selectThumb(3);
    } catch (err: any) {
      this.statusText.setText(`Retry failed: ${err.message}`).setColor(ACCENT);
    } finally {
      this.retryAnimBtn
        .setText(
          which === 'crouch'
            ? '\u21bb RETRY CROUCH'
            : which === 'upright'
              ? '\u21bb RETRY UPRIGHT'
              : '\u21bb RETRY SIDE VIEW'
        )
        .setInteractive({ useHandCursor: true });
    }
  }

  private cleanupHTML(): void {
    this.closeIntroVideoOverlay();
    this.destroyInlineIntroVideoPreview();
    this.nameInput?.remove();
    this.fileInput?.remove();
    this.stageFileInput?.remove();
    this.introRefInput?.remove();
    this.introBriefInput?.remove();
  }

  shutdown(): void {
    if (this.debugListener) {
      window.removeEventListener(DEBUG_EVENT_NAME, this.debugListener);
      this.debugListener = undefined;
    }
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
