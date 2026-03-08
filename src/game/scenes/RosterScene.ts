import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.ts';
import { getAllCachedMetas, deleteCharacter, CACHE_VERSION, type CachedMeta } from '../../services/SpriteCache.ts';

const FONT = '"Press Start 2P", monospace';
const ACCENT = '#ff4444';
const W = GAME_WIDTH;
const H = GAME_HEIGHT;

const SLOT_Y = 60;
const SLOT_W = 200;
const SLOT_H = 200;
const GRID_TOP = 360;
const GRID_BOTTOM = H - 50;

interface SlotState {
  photoHash: string | null;
  characterName: string;
}

interface InitData {
  completedSlot?: number;
  photoHash?: string;
  characterName?: string;
  vsAI?: boolean;
  cpuVsCpu?: boolean;
}

export class RosterScene extends Phaser.Scene {
  private p1Slot: SlotState = { photoHash: null, characterName: 'P1' };
  private p2Slot: SlotState = { photoHash: null, characterName: 'P2' };
  private selectingSlot: 0 | 1 = 0;
  private metas: CachedMeta[] = [];
  private rosterContainer!: Phaser.GameObjects.Container;
  private p1Preview: Phaser.GameObjects.Image | null = null;
  private p2Preview: Phaser.GameObjects.Image | null = null;
  private p1NameText!: Phaser.GameObjects.Text;
  private p2NameText!: Phaser.GameObjects.Text;
  private fightBtn!: Phaser.GameObjects.Text;
  private createBtn!: Phaser.GameObjects.Text;
  private slotIndicators: Phaser.GameObjects.Text[] = [];
  private fileInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private vsAI = true;
  private cpuVsCpu = false;

  constructor() {
    super({ key: 'RosterScene' });
  }

  init(data?: InitData): void {
    if (data?.vsAI !== undefined) this.vsAI = data.vsAI;
    if (data?.cpuVsCpu !== undefined) this.cpuVsCpu = data.cpuVsCpu;
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
    this.createFileInput();
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
    this.add.text(W / 2, 26, 'SELECT YOUR FIGHTERS', {
      fontFamily: FONT, fontSize: '24px', color: ACCENT,
      stroke: '#000000', strokeThickness: 5,
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

    this.add.text(W / 2, SLOT_Y + SLOT_H / 2, 'VS', {
      fontFamily: FONT, fontSize: '36px', color: ACCENT,
      stroke: '#000000', strokeThickness: 8,
    }).setOrigin(0.5).setDepth(10);

    this.drawSlotBox(p2X, SLOT_Y, SLOT_W, SLOT_H, p2Label, 1);
    this.p2NameText = this.add.text(p2X, SLOT_Y + SLOT_H - 14, this.p2Slot.characterName.toUpperCase(), {
      fontFamily: FONT, fontSize: '12px', color: '#44aaff',
    }).setOrigin(0.5).setDepth(12);

    const ind1 = this.add.text(p1X, SLOT_Y - 14, '\u25BC SELECTING', {
      fontFamily: FONT, fontSize: '9px', color: '#ffcc00',
    }).setOrigin(0.5).setDepth(12);
    const ind2 = this.add.text(p2X, SLOT_Y - 14, '', {
      fontFamily: FONT, fontSize: '9px', color: '#44aaff',
    }).setOrigin(0.5).setDepth(12);
    this.slotIndicators = [ind1, ind2];
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

  // ─── Bottom Bar (Create / Fight / Back) ─────────────────────────────

  private createBottomBar(): void {
    this.createBtn = this.add.text(W / 2, 320, '+ CREATE NEW FIGHTER', {
      fontFamily: FONT, fontSize: '14px', color: '#44ff44',
      stroke: '#000000', strokeThickness: 4,
      backgroundColor: '#0a2a0a',
      padding: { x: 20, y: 12 },
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    this.createBtn.on('pointerover', () => this.createBtn.setColor('#88ff88'));
    this.createBtn.on('pointerout', () => this.createBtn.setColor('#44ff44'));
    this.createBtn.on('pointerdown', () => this.createNewFighter());

    this.fightBtn = this.add.text(W / 2, H - 30, 'FIGHT!', {
      fontFamily: FONT, fontSize: '20px', color: '#555555',
      stroke: '#000000', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(20);
    this.updateFightButton();

    const backBtn = this.add.text(80, H - 30, '< BACK', {
      fontFamily: FONT, fontSize: '12px', color: '#aaaaaa',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(20).setInteractive({ useHandCursor: true });
    backBtn.on('pointerover', () => backBtn.setColor('#ffffff'));
    backBtn.on('pointerout', () => backBtn.setColor('#aaaaaa'));
    backBtn.on('pointerdown', () => {
      this.cleanupHTML();
      this.cameras.main.fadeOut(300, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this.scene.start('TitleScene');
      });
    });
  }

  private updateFightButton(): void {
    if (!this.fightBtn) return;
    const ready = this.p1Slot.photoHash !== null && this.p2Slot.photoHash !== null;
    this.fightBtn.setColor(ready ? ACCENT : '#333333');

    if (ready && !this.fightBtn.input?.enabled) {
      this.fightBtn.setInteractive({ useHandCursor: true });
      this.fightBtn.on('pointerover', () => this.fightBtn.setColor('#ff8888'));
      this.fightBtn.on('pointerout', () => this.fightBtn.setColor(ACCENT));
      this.fightBtn.on('pointerdown', () => this.startFight());
    }
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
    this.rosterContainer = this.add.container(0, 0).setDepth(10);

    const thumbSize = 80;
    const gap = 12;
    const maxCols = 7;
    const totalItems = this.metas.length;

    if (totalItems === 0) {
      return;
    }

    this.add.text(W / 2, GRID_TOP - 16, 'YOUR ROSTER (click to assign)', {
      fontFamily: FONT, fontSize: '10px', color: '#888888',
    }).setOrigin(0.5).setDepth(10);

    const cols = Math.min(totalItems, maxCols);
    const totalW = cols * (thumbSize + gap) - gap;
    const startX = W / 2 - totalW / 2;

    for (let i = 0; i < totalItems; i++) {
      const meta = this.metas[i];
      const col = i % maxCols;
      const row = Math.floor(i / maxCols);
      const cx = startX + col * (thumbSize + gap) + thumbSize / 2;
      const cy = GRID_TOP + row * (thumbSize + gap + 22) + thumbSize / 2;

      if (cy + thumbSize / 2 + 22 > GRID_BOTTOM) break;

      const g = this.add.graphics().setDepth(8);
      g.fillStyle(0x111133, 0.8);
      g.fillRoundedRect(cx - thumbSize / 2, cy - thumbSize / 2, thumbSize, thumbSize + 20, 5);
      g.lineStyle(2, 0x333366);
      g.strokeRoundedRect(cx - thumbSize / 2, cy - thumbSize / 2, thumbSize, thumbSize + 20, 5);
      this.rosterContainer.add(g);

      if (meta.originalPhotoBlob) {
        this.loadThumbnail(meta, cx, cy, thumbSize);
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

    this.refreshSlotPreview(0);
    this.refreshSlotPreview(1);
  }

  private loadThumbnail(meta: CachedMeta, cx: number, cy: number, size: number): void {
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

      const sprite = this.add.image(cx, cy - 4, texKey).setDepth(11);
      this.rosterContainer.add(sprite);
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

  // ─── Create New Fighter ─────────────────────────────────────────────

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
            file,
            characterName: name,
            slotIndex: this.selectingSlot,
            returnScene: 'RosterScene',
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

  // ─── Fight ──────────────────────────────────────────────────────────

  private startFight(): void {
    if (!this.p1Slot.photoHash || !this.p2Slot.photoHash) return;

    this.cleanupHTML();
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
        });
      });
    });
  }

  private cleanupHTML(): void {
    this.nameInput?.remove();
    this.fileInput?.remove();
  }

  shutdown(): void {
    this.cleanupHTML();
  }

  destroy(): void {
    this.cleanupHTML();
  }
}
