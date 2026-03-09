import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';
import { getAllCachedMetas, deleteCharacter, CACHE_VERSION, type CachedMeta } from '../../services/SpriteCache.ts';
import {
  getDefaultPersonalityId,
  getFighterPersonality,
  nextFighterPersonalityId,
  type FighterPersonalityId,
  type MatchSceneData,
} from '../match/MatchConfig.ts';
import {
  getStageChoiceBlurb,
  getStageChoiceLabel,
  nextStageThemeId,
  type StageThemeId,
} from '../match/StageConfig.ts';

const FONT = '"Press Start 2P", monospace';
const ACCENT = '#ff4444';
const W = GAME_WIDTH;
const H = GAME_HEIGHT;

const SLOT_Y = 60;
const SLOT_W = 200;
const SLOT_H = 200;
const GRID_TOP = 320;
const GRID_BOTTOM = H - 26;
const CONTROL_PANEL_W = 240;
const CONTROL_PANEL_X = W - 140;

interface SlotState {
  photoHash: string | null;
  characterName: string;
  personalityId: FighterPersonalityId;
}

interface InitData extends MatchSceneData {
  completedSlot?: number;
  photoHash?: string;
  characterName?: string;
}

export class RosterScene extends Phaser.Scene {
  private p1Slot: SlotState = { photoHash: null, characterName: 'P1', personalityId: getDefaultPersonalityId(0) };
  private p2Slot: SlotState = { photoHash: null, characterName: 'P2', personalityId: getDefaultPersonalityId(1) };
  private selectingSlot: 0 | 1 = 0;
  private metas: CachedMeta[] = [];
  private rosterContainer!: Phaser.GameObjects.Container;
  private rosterTitleText?: Phaser.GameObjects.Text;
  private rosterHintText?: Phaser.GameObjects.Text;
  private rosterMaskGfx?: Phaser.GameObjects.Graphics;
  private rosterScrollY = 0;
  private rosterMaxScroll = 0;
  private p1Preview: Phaser.GameObjects.Image | null = null;
  private p2Preview: Phaser.GameObjects.Image | null = null;
  private p1NameText!: Phaser.GameObjects.Text;
  private p2NameText!: Phaser.GameObjects.Text;
  private p1StyleText!: Phaser.GameObjects.Text;
  private p2StyleText!: Phaser.GameObjects.Text;
  private fightBtn!: Phaser.GameObjects.Text;
  private stageText!: Phaser.GameObjects.Text;
  private stageHintText!: Phaser.GameObjects.Text;
  private slotIndicators: Phaser.GameObjects.Text[] = [];
  private vsAI = true;
  private cpuVsCpu = false;
  private stageId: StageThemeId | null = null;

  constructor() {
    super({ key: 'RosterScene' });
  }

  init(data?: InitData): void {
    if (data?.vsAI !== undefined) this.vsAI = data.vsAI;
    if (data?.cpuVsCpu !== undefined) this.cpuVsCpu = data.cpuVsCpu;
    if (data?.p1PersonalityId) this.p1Slot.personalityId = data.p1PersonalityId;
    if (data?.p2PersonalityId) this.p2Slot.personalityId = data.p2PersonalityId;
    this.stageId = data?.stageId ?? this.stageId;
    if (data?.completedSlot !== undefined && data.photoHash) {
      const slot = data.completedSlot === 0 ? this.p1Slot : this.p2Slot;
      slot.photoHash = data.photoHash;
      slot.characterName = data.characterName || 'Fighter';
    }
  }

  async create(): Promise<void> {
    this.drawBackground();
    this.createHeader();
    this.createSlots();
    this.createBottomBar();
    this.input.on('wheel', this.handleRosterWheel, this);
    this.input.keyboard?.on('keydown-UP', this.scrollRosterUp, this);
    this.input.keyboard?.on('keydown-DOWN', this.scrollRosterDown, this);
    this.cameras.main.fadeIn(300, 0, 0, 0);
    await this.loadRoster();
  }

  // ─── Background ─────────────────────────────────────────────────────

  private drawBackground(): void {
    const bg = this.add.graphics().setDepth(0);
    for (let y = 0; y < H; y++) {
      const t = y / H;
      const r = Math.floor(5 + t * 10);
      const g = Math.floor(2 + t * 6);
      const b = Math.floor(12 + t * 25);
      bg.fillStyle(Phaser.Display.Color.GetColor(r, g, b));
      bg.fillRect(0, y, W, 1);
    }

    const scanlines = this.add.graphics().setDepth(1);
    scanlines.fillStyle(0x000000, 0.04);
    for (let y = 0; y < H; y += 4) {
      scanlines.fillRect(0, y, W, 2);
    }
  }

  // ─── Header ─────────────────────────────────────────────────────────

  private createHeader(): void {
    const title = this.cpuVsCpu ? 'BUILD THE MATCHUP' : 'SELECT YOUR FIGHTERS';
    const subtitle = this.cpuVsCpu
      ? 'Pick two fighters, choose their styles, then watch the signature match.'
      : 'Pick your fighters and lock in how the CPU should behave.';

    this.add.text(W / 2, 26, title, {
      fontFamily: FONT, fontSize: '24px', color: ACCENT,
      stroke: '#000000', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(10);
    this.add.text(W / 2, 54, subtitle, {
      fontFamily: FONT, fontSize: '8px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);
  }

  // ─── P1 / P2 Slots ─────────────────────────────────────────────────

  private createSlots(): void {
    const p1X = W / 2 - 170;
    const p2X = W / 2 + 170;

    const p1Label = this.cpuVsCpu ? 'CPU 1' : 'PLAYER 1';
    const p2Label = this.cpuVsCpu ? 'CPU 2' : (this.vsAI ? 'CPU' : 'PLAYER 2');

    this.drawSlotBox(p1X, SLOT_Y, SLOT_W, SLOT_H, p1Label, 0);
    this.p1NameText = this.add.text(p1X, SLOT_Y + SLOT_H - 14, this.p1Slot.characterName.toUpperCase(), {
      fontFamily: FONT, fontSize: '12px', color: '#ffcc00',
    }).setOrigin(0.5).setDepth(12);
    this.p1StyleText = this.createStyleText(p1X, 0, '#ffcc00');

    this.add.text(W / 2, SLOT_Y + SLOT_H / 2, 'VS', {
      fontFamily: FONT, fontSize: '36px', color: ACCENT,
      stroke: '#000000', strokeThickness: 8,
    }).setOrigin(0.5).setDepth(10);

    this.drawSlotBox(p2X, SLOT_Y, SLOT_W, SLOT_H, p2Label, 1);
    this.p2NameText = this.add.text(p2X, SLOT_Y + SLOT_H - 14, this.p2Slot.characterName.toUpperCase(), {
      fontFamily: FONT, fontSize: '12px', color: '#44aaff',
    }).setOrigin(0.5).setDepth(12);
    this.p2StyleText = this.createStyleText(p2X, 1, '#44aaff');

    const ind1 = this.add.text(p1X, SLOT_Y - 14, '\u25BC SELECTING', {
      fontFamily: FONT, fontSize: '9px', color: '#ffcc00',
    }).setOrigin(0.5).setDepth(12);
    const ind2 = this.add.text(p2X, SLOT_Y - 14, '', {
      fontFamily: FONT, fontSize: '9px', color: '#44aaff',
    }).setOrigin(0.5).setDepth(12);
    this.slotIndicators = [ind1, ind2];
    this.refreshStyleTexts();
    this.updateSlotIndicators();
  }

  private drawSlotBox(cx: number, cy: number, w: number, h: number, label: string, slotIdx: number): void {
    const g = this.add.graphics().setDepth(8);
    g.fillStyle(0x0a0a1e, 0.85);
    g.fillRoundedRect(cx - w / 2, cy, w, h, 8);
    g.lineStyle(3, slotIdx === 0 ? 0xffcc00 : 0x4488ff, 0.7);
    g.strokeRoundedRect(cx - w / 2, cy, w, h, 8);

    this.add.text(cx, cy + 18, label, {
      fontFamily: FONT, fontSize: '11px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);

    const hitArea = this.add.rectangle(cx, cy + h / 2, w, h)
      .setInteractive({ useHandCursor: true }).setAlpha(0.001).setDepth(15);
    hitArea.on('pointerdown', () => {
      this.selectingSlot = slotIdx as 0 | 1;
      this.updateSlotIndicators();
    });
  }

  private updateSlotIndicators(): void {
    this.slotIndicators[0].setText(this.selectingSlot === 0 ? '\u25BC SELECTING' : '');
    this.slotIndicators[1].setText(this.selectingSlot === 1 ? '\u25BC SELECTING' : '');
    this.updateFightButton();
  }

  private createStyleText(cx: number, slotIdx: 0 | 1, color: string): Phaser.GameObjects.Text {
    const text = this.add.text(cx, SLOT_Y + SLOT_H + 24, '', {
      fontFamily: FONT,
      fontSize: '9px',
      color,
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });

    text.on('pointerover', () => text.setScale(1.04));
    text.on('pointerout', () => text.setScale(1));
    text.on('pointerdown', () => {
      const slot = slotIdx === 0 ? this.p1Slot : this.p2Slot;
      slot.personalityId = nextFighterPersonalityId(slot.personalityId);
      this.refreshStyleTexts();
    });

    return text;
  }

  private refreshStyleTexts(): void {
    if (!this.p1StyleText || !this.p2StyleText) return;

    const p1Style = getFighterPersonality(this.p1Slot.personalityId);
    const p2Style = getFighterPersonality(this.p2Slot.personalityId);

    this.p1StyleText.setText(`STYLE: ${p1Style.label}`);
    this.p1StyleText.setData('hint', p1Style.blurb);
    this.p2StyleText.setText(`STYLE: ${p2Style.label}`);
    this.p2StyleText.setData('hint', p2Style.blurb);
  }

  // ─── Bottom Bar (Create / Fight / Back) ─────────────────────────────

  private createBottomBar(): void {
    const panel = this.add.graphics().setDepth(19);
    const panelTop = GRID_TOP - 8;
    const panelHeight = GRID_BOTTOM - panelTop;
    panel.fillStyle(0x0a0a20, 0.88);
    panel.fillRoundedRect(CONTROL_PANEL_X - CONTROL_PANEL_W / 2, panelTop, CONTROL_PANEL_W, panelHeight, 10);
    panel.lineStyle(2, 0x334477, 0.75);
    panel.strokeRoundedRect(CONTROL_PANEL_X - CONTROL_PANEL_W / 2, panelTop, CONTROL_PANEL_W, panelHeight, 10);

    this.add.text(CONTROL_PANEL_X, GRID_TOP + 14, 'MATCH SETUP', {
      fontFamily: FONT,
      fontSize: '10px',
      color: '#888888',
    }).setOrigin(0.5).setDepth(20);

    this.updateFightButton();

    const backBtn = this.add.text(CONTROL_PANEL_X, GRID_BOTTOM - 22, '< BACK', {
      fontFamily: FONT, fontSize: '11px', color: '#aaaaaa',
      stroke: '#000000', strokeThickness: 3,
      backgroundColor: '#161629',
      padding: { x: 12, y: 8 },
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#ffffff'));
    backBtn.on('pointerout', () => backBtn.setColor('#aaaaaa'));
    backBtn.on('pointerdown', () => {
      this.cameras.main.fadeOut(300, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this.scene.start('TitleScene');
      });
    });

    this.stageText = this.add.text(CONTROL_PANEL_X, GRID_TOP + 56, '', {
      fontFamily: FONT,
      fontSize: '9px',
      color: '#66ddff',
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.stageHintText = this.add.text(CONTROL_PANEL_X, GRID_TOP + 82, '', {
      fontFamily: FONT,
      fontSize: '7px',
      color: '#888888',
      align: 'center',
      wordWrap: { width: CONTROL_PANEL_W - 40 },
      lineSpacing: 4,
    }).setOrigin(0.5, 0).setDepth(20);

    this.stageText.on('pointerover', () => this.stageText.setScale(1.03));
    this.stageText.on('pointerout', () => this.stageText.setScale(1));
    this.stageText.on('pointerdown', () => {
      this.stageId = nextStageThemeId(this.stageId);
      this.refreshStageTexts();
    });
    this.refreshStageTexts();

    this.add.text(CONTROL_PANEL_X, GRID_TOP + 154, 'CLICK STYLE ABOVE THE PORTRAITS TO CHANGE AI', {
      fontFamily: FONT,
      fontSize: '7px',
      color: '#777777',
      align: 'center',
      wordWrap: { width: CONTROL_PANEL_W - 42 },
      lineSpacing: 4,
    }).setOrigin(0.5, 0).setDepth(20);

    this.fightBtn = this.add.text(CONTROL_PANEL_X, GRID_TOP + 212, 'FIGHT!', {
      fontFamily: FONT,
      fontSize: '18px',
      color: '#555555',
      stroke: '#000000',
      strokeThickness: 5,
      backgroundColor: '#2a0808',
      padding: { x: 18, y: 12 },
    }).setOrigin(0.5).setDepth(20);
    this.updateFightButton();
  }

  private updateFightButton(): void {
    if (!this.fightBtn) return;
    const ready = this.p1Slot.photoHash !== null && this.p2Slot.photoHash !== null;
    this.fightBtn.setText(this.cpuVsCpu ? 'WATCH MATCH' : 'FIGHT!');
    this.fightBtn.setColor(ready ? ACCENT : '#333333');

    if (ready && !this.fightBtn.input?.enabled) {
      this.fightBtn.setInteractive({ useHandCursor: true });
      this.fightBtn.on('pointerover', () => this.fightBtn.setColor('#ff8888'));
      this.fightBtn.on('pointerout', () => this.fightBtn.setColor(ACCENT));
      this.fightBtn.on('pointerdown', () => this.startFight());
    }
  }

  private refreshStageTexts(): void {
    if (!this.stageText || !this.stageHintText) return;

    this.stageText.setText(`STAGE: ${getStageChoiceLabel(this.stageId)}`);
    this.stageHintText.setText(getStageChoiceBlurb(this.stageId));
  }

  // ─── Roster Grid ────────────────────────────────────────────────────

  private async loadRoster(): Promise<void> {
    try {
      const all = await getAllCachedMetas();
      this.metas = all.filter((m) => m.status === 'ready' && m.version === CACHE_VERSION);
    } catch {
      this.metas = [];
    }

    this.rosterContainer?.destroy();
    this.rosterTitleText?.destroy();
    this.rosterHintText?.destroy();
    this.rosterMaskGfx?.destroy();

    this.rosterContainer = this.add.container(0, 0).setDepth(10);
    this.rosterScrollY = 0;
    this.rosterMaxScroll = 0;

    const thumbSize = 80;
    const gap = 12;
    const maxCols = 7;
    const totalItems = this.metas.length;
    const rowHeight = thumbSize + gap + 22;
    const cardHeight = thumbSize + 20;
    const viewportBounds = this.getRosterViewportBounds();

    this.rosterTitleText = this.add.text(viewportBounds.centerX, GRID_TOP - 18, 'YOUR ROSTER (click to assign)', {
      fontFamily: FONT, fontSize: '10px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);

    this.rosterHintText = this.add.text(viewportBounds.centerX, GRID_TOP - 2, '', {
      fontFamily: FONT, fontSize: '7px', color: '#666666',
    }).setOrigin(0.5).setDepth(10);

    this.rosterMaskGfx = this.add.graphics().setVisible(false);
    this.rosterMaskGfx.fillStyle(0xffffff);
    this.rosterMaskGfx.fillRect(viewportBounds.x, viewportBounds.y, viewportBounds.width, viewportBounds.height);
    this.rosterContainer.setMask(this.rosterMaskGfx.createGeometryMask());

    if (totalItems === 0) {
      this.rosterHintText.setText('CREATE A FIGHTER TO FILL THE ROSTER');
      return;
    }

    const cols = Math.min(totalItems, maxCols);
    const totalW = cols * (thumbSize + gap) - gap;
    const startX = viewportBounds.centerX - totalW / 2;
    const totalRows = Math.ceil(totalItems / maxCols);
    const contentHeight = (totalRows - 1) * rowHeight + cardHeight;
    this.rosterMaxScroll = Math.max(0, contentHeight - viewportBounds.height);

    for (let i = 0; i < totalItems; i++) {
      const meta = this.metas[i];
      const col = i % maxCols;
      const row = Math.floor(i / maxCols);
      const cx = startX + col * (thumbSize + gap) + thumbSize / 2;
      const cy = GRID_TOP + row * rowHeight + thumbSize / 2;

      const g = this.add.graphics().setDepth(8);
      g.fillStyle(0x111133, 0.8);
      g.fillRoundedRect(cx - thumbSize / 2, cy - thumbSize / 2, thumbSize, thumbSize + 20, 5);
      g.lineStyle(2, 0x333366);
      g.strokeRoundedRect(cx - thumbSize / 2, cy - thumbSize / 2, thumbSize, thumbSize + 20, 5);
      this.rosterContainer.add(g);

      if (meta.originalPhotoBlob) {
        this.loadThumbnail(meta, cx, cy, thumbSize, this.rosterContainer);
      }

      const nameLabel = this.add.text(cx, cy + thumbSize / 2 + 8, (meta.characterName || 'Fighter').slice(0, 10).toUpperCase(), {
        fontFamily: FONT, fontSize: '7px', color: '#aaaaaa',
      }).setOrigin(0.5).setDepth(12);
      this.rosterContainer.add(nameLabel);

      const hitArea = this.add.rectangle(cx, cy, thumbSize, thumbSize + 20)
        .setInteractive({ useHandCursor: true }).setAlpha(0.001).setDepth(15);
      hitArea.on('pointerdown', () => this.assignToSlot(meta));
      this.rosterContainer.add(hitArea);

      const delBtn = this.add.text(cx + thumbSize / 2 - 4, cy - thumbSize / 2 + 2, 'X', {
        fontFamily: FONT, fontSize: '9px', color: '#ff4444',
        stroke: '#000000', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(16).setInteractive({ useHandCursor: true });
      delBtn.on('pointerover', () => delBtn.setColor('#ff8888').setScale(1.3));
      delBtn.on('pointerout', () => delBtn.setColor('#ff4444').setScale(1));
      delBtn.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        this.deleteAndReload(meta.photoHash);
      });
      this.rosterContainer.add(delBtn);
    }

    this.applyRosterScroll(0);
    this.refreshRosterScrollHint();
    this.refreshSlotPreview(0);
    this.refreshSlotPreview(1);
  }

  private getRosterViewportBounds(): Phaser.Geom.Rectangle {
    const left = 36;
    const right = CONTROL_PANEL_X - CONTROL_PANEL_W / 2 - 24;
    return new Phaser.Geom.Rectangle(left, GRID_TOP, right - left, GRID_BOTTOM - GRID_TOP);
  }

  private handleRosterWheel(
    pointer: Phaser.Input.Pointer,
    _gameObjects: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ): void {
    if (this.rosterMaxScroll <= 0) return;

    const bounds = this.getRosterViewportBounds();
    if (!Phaser.Geom.Rectangle.Contains(bounds, pointer.x, pointer.y)) return;

    const amount = Math.sign(deltaY) * Math.max(28, Math.abs(deltaY) * 0.35);
    this.applyRosterScroll(amount);
  }

  private scrollRosterUp(): void {
    this.applyRosterScroll(-72);
  }

  private scrollRosterDown(): void {
    this.applyRosterScroll(72);
  }

  private applyRosterScroll(delta: number): void {
    if (!this.rosterContainer) return;
    this.rosterScrollY = Phaser.Math.Clamp(this.rosterScrollY + delta, 0, this.rosterMaxScroll);
    this.rosterContainer.y = -this.rosterScrollY;
    this.refreshRosterScrollHint();
  }

  private refreshRosterScrollHint(): void {
    if (!this.rosterHintText) return;
    if (this.metas.length === 0) {
      this.rosterHintText.setText('CREATE A FIGHTER TO FILL THE ROSTER');
      return;
    }
    if (this.rosterMaxScroll <= 0) {
      this.rosterHintText.setText(`${this.metas.length} FIGHTER${this.metas.length === 1 ? '' : 'S'} READY`);
      return;
    }

    if (this.rosterScrollY <= 0) {
      this.rosterHintText.setText('MOUSE WHEEL OR DOWN ARROW TO SEE MORE');
      return;
    }
    if (this.rosterScrollY >= this.rosterMaxScroll) {
      this.rosterHintText.setText('UP ARROW OR WHEEL UP TO GO BACK');
      return;
    }
    this.rosterHintText.setText('MOUSE WHEEL OR ARROW KEYS TO SCROLL THE ROSTER');
  }

  private loadThumbnail(
    meta: CachedMeta,
    cx: number,
    cy: number,
    size: number,
    targetContainer: Phaser.GameObjects.Container,
  ): void {
    const blob = meta.originalPhotoBlob!;
    const url = URL.createObjectURL(blob);
    const htmlImg = new Image();
    htmlImg.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = size - 8;
      canvas.height = size - 8;
      const ctx = canvas.getContext('2d')!;
      const scale = Math.min(canvas.width / htmlImg.width, canvas.height / htmlImg.height);
      const dw = htmlImg.width * scale;
      const dh = htmlImg.height * scale;
      ctx.drawImage(htmlImg, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);

      const texKey = `roster_thumb_${meta.photoHash.slice(0, 8)}`;
      if (this.textures.exists(texKey)) this.textures.remove(texKey);
      this.textures.addCanvas(texKey, canvas);

      if (!targetContainer.scene) {
        this.textures.remove(texKey);
        return;
      }
      const sprite = this.add.image(cx, cy - 4, texKey).setDepth(11);
      targetContainer.add(sprite);
    };
    htmlImg.src = url;
  }

  private assignToSlot(meta: CachedMeta): void {
    const slot = this.selectingSlot === 0 ? this.p1Slot : this.p2Slot;
    slot.photoHash = meta.photoHash;
    slot.characterName = meta.characterName || 'Fighter';

    if (this.selectingSlot === 0) {
      this.p1NameText.setText(slot.characterName.toUpperCase());
    } else {
      this.p2NameText.setText(slot.characterName.toUpperCase());
    }

    this.refreshSlotPreview(this.selectingSlot);

    if (this.selectingSlot === 0 && !this.p2Slot.photoHash) {
      this.selectingSlot = 1;
    } else if (this.selectingSlot === 1 && !this.p1Slot.photoHash) {
      this.selectingSlot = 0;
    }
    this.updateSlotIndicators();
  }

  private refreshSlotPreview(slotIdx: number): void {
    const slot = slotIdx === 0 ? this.p1Slot : this.p2Slot;
    const p1X = W / 2 - 170;
    const p2X = W / 2 + 170;
    const cx = slotIdx === 0 ? p1X : p2X;
    const cy = SLOT_Y + SLOT_H / 2;

    const existingPreview = slotIdx === 0 ? this.p1Preview : this.p2Preview;
    if (existingPreview) existingPreview.destroy();

    if (!slot.photoHash) return;

    const meta = this.metas.find((m) => m.photoHash === slot.photoHash);
    if (!meta?.originalPhotoBlob) return;

    const blob = meta.originalPhotoBlob;
    const url = URL.createObjectURL(blob);
    const htmlImg = new Image();
    htmlImg.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const size = 150;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const scale = Math.min(size / htmlImg.width, size / htmlImg.height);
      const dw = htmlImg.width * scale;
      const dh = htmlImg.height * scale;
      ctx.drawImage(htmlImg, (size - dw) / 2, (size - dh) / 2, dw, dh);

      const texKey = `slot_preview_${slotIdx}_${slot.photoHash!.slice(0, 8)}`;
      if (this.textures.exists(texKey)) this.textures.remove(texKey);
      this.textures.addCanvas(texKey, canvas);

      const sprite = this.add.image(cx, cy, texKey).setDepth(11);
      if (slotIdx === 0) this.p1Preview = sprite;
      else this.p2Preview = sprite;
    };
    htmlImg.src = url;
  }

  private async deleteAndReload(photoHash: string): Promise<void> {
    if (this.p1Slot.photoHash === photoHash) {
      this.p1Slot.photoHash = null;
      this.p1NameText.setText('P1');
      if (this.p1Preview) { this.p1Preview.destroy(); this.p1Preview = null; }
    }
    if (this.p2Slot.photoHash === photoHash) {
      this.p2Slot.photoHash = null;
      this.p2NameText.setText('P2');
      if (this.p2Preview) { this.p2Preview.destroy(); this.p2Preview = null; }
    }

    await deleteCharacter(photoHash);
    await this.loadRoster();
    this.updateFightButton();
  }

  // ─── Fight ──────────────────────────────────────────────────────────

  private startFight(): void {
    if (!this.p1Slot.photoHash || !this.p2Slot.photoHash) return;

    this.cameras.main.flash(300, 255, 68, 68);
    this.time.delayedCall(300, () => {
      this.cameras.main.fadeOut(400, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this.scene.start('FightScene', {
          vsAI: this.vsAI,
          cpuVsCpu: this.cpuVsCpu,
          p1PhotoHash: this.p1Slot.photoHash,
          p2PhotoHash: this.p2Slot.photoHash,
          p1Name: this.p1Slot.characterName,
          p2Name: this.p2Slot.characterName,
          p1PersonalityId: this.p1Slot.personalityId,
          p2PersonalityId: this.p2Slot.personalityId,
          stageId: this.stageId ?? undefined,
        });
      });
    });
  }

  shutdown(): void {
    this.input.off('wheel', this.handleRosterWheel, this);
    this.input.keyboard?.off('keydown-UP', this.scrollRosterUp, this);
    this.input.keyboard?.off('keydown-DOWN', this.scrollRosterDown, this);
  }

  destroy(): void {
    this.input.off('wheel', this.handleRosterWheel, this);
    this.input.keyboard?.off('keydown-UP', this.scrollRosterUp, this);
    this.input.keyboard?.off('keydown-DOWN', this.scrollRosterDown, this);
  }
}
