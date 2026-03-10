import Phaser from "phaser";
import { GAME_WIDTH, GAME_HEIGHT } from "../constants.ts";
import {
  getAllCachedMetas,
  getAllCachedStageBackgrounds,
  deleteCachedStageBackground,
  deleteCharacter,
  CACHE_VERSION,
  type CachedMeta,
  type CachedStageBackground,
} from "../../services/SpriteCache.ts";
import {
  getDefaultPersonalityId,
  getFighterPersonality,
  nextFighterPersonalityId,
  type FighterPersonalityId,
  type MatchSceneData,
} from "../match/MatchConfig.ts";
import {
  getStageChoiceBlurb,
  getStageChoiceLabel,
  STAGE_THEMES,
  type StageThemeId,
} from "../match/StageConfig.ts";
import { createPhotoStage } from "../../services/StageBackgroundService.ts";

const FONT = '"Press Start 2P", monospace';
const ACCENT = "#ff4444";
const W = GAME_WIDTH;
const H = GAME_HEIGHT;

const SLOT_Y = 60;
const SLOT_W = 200;
const SLOT_H = 200;
const SLOT_P1_X = 184;
const SLOT_P2_X = 434;
const VS_X = 310;
const GRID_TOP = 320;
const GRID_BOTTOM = H - 26;
const STAGE_PANEL_W = 286;
const STAGE_PANEL_X = W - 150;
const STAGE_PANEL_TOP = 62;
const STAGE_PANEL_BOTTOM = H - 24;

interface StageCarouselOption {
  key: string;
  kind: "built-in" | "photo";
  label: string;
  blurb: string;
  stageId?: StageThemeId | null;
  customStageKey?: string;
  previewBlob?: Blob;
}

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
  private p1Slot: SlotState = {
    photoHash: null,
    characterName: "P1",
    personalityId: getDefaultPersonalityId(0),
  };
  private p2Slot: SlotState = {
    photoHash: null,
    characterName: "P2",
    personalityId: getDefaultPersonalityId(1),
  };
  private selectingSlot: 0 | 1 = 0;
  private metas: CachedMeta[] = [];
  private cachedPhotoStages: CachedStageBackground[] = [];
  private rosterContainer!: Phaser.GameObjects.Container;
  // private rosterTitleText?: Phaser.GameObjects.Text;
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
  private stageUploadBtn!: Phaser.GameObjects.Text;
  private clearStageBtn!: Phaser.GameObjects.Text;
  private stagePreviewFrame!: Phaser.GameObjects.Graphics;
  private stagePreviewFill!: Phaser.GameObjects.Graphics;
  private stagePreviewImage: Phaser.GameObjects.Image | null = null;
  private stagePreviewMetaText!: Phaser.GameObjects.Text;
  private stageCarouselCounterText!: Phaser.GameObjects.Text;
  private stagePrevBtn!: Phaser.GameObjects.Text;
  private stageNextBtn!: Phaser.GameObjects.Text;
  private stageDeleteBtn!: Phaser.GameObjects.Text;
  private stageCarouselOptions: StageCarouselOption[] = [];
  private stageCarouselIndex = 0;
  private stagePreviewTextureKey?: string;
  private stagePreviewLoadId = 0;
  private slotIndicators: Phaser.GameObjects.Text[] = [];
  private vsAI = true;
  private cpuVsCpu = false;
  private stageId: StageThemeId | null = null;
  private customStageKey: string | null = null;
  private customStageLabel: string | null = null;
  private stageFileInput!: HTMLInputElement;

  constructor() {
    super({ key: "RosterScene" });
  }

  init(data?: InitData): void {
    if (data?.vsAI !== undefined) this.vsAI = data.vsAI;
    if (data?.cpuVsCpu !== undefined) this.cpuVsCpu = data.cpuVsCpu;
    if (data?.p1PersonalityId) this.p1Slot.personalityId = data.p1PersonalityId;
    if (data?.p2PersonalityId) this.p2Slot.personalityId = data.p2PersonalityId;
    this.stageId = data?.stageId ?? this.stageId;
    this.customStageKey = data?.customStageKey ?? this.customStageKey;
    this.customStageLabel = data?.customStageLabel ?? this.customStageLabel;
    if (data?.completedSlot !== undefined && data.photoHash) {
      const slot = data.completedSlot === 0 ? this.p1Slot : this.p2Slot;
      slot.photoHash = data.photoHash;
      slot.characterName = data.characterName || "Fighter";
    }
  }

  async create(): Promise<void> {
    this.drawBackground();
    this.createHeader();
    this.createSlots();
    this.createStageFileInput();
    this.createBottomBar();
    this.input.on("wheel", this.handleRosterWheel, this);
    this.input.keyboard?.on("keydown-UP", this.scrollRosterUp, this);
    this.input.keyboard?.on("keydown-DOWN", this.scrollRosterDown, this);
    this.cameras.main.fadeIn(300, 0, 0, 0);
    await Promise.all([this.loadRoster(), this.loadCachedPhotoStages()]);
    this.refreshStageTexts();
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
    const title = this.cpuVsCpu ? "BUILD THE MATCHUP" : "SELECT YOUR FIGHTERS";
    // const subtitle = this.cpuVsCpu
    //   ? 'Pick two fighters, choose their styles, then watch the signature match.'
    //   : 'Pick your fighters and lock in how the CPU should behave.';

    this.add
      .text(W / 2, 26, title, {
        fontFamily: FONT,
        fontSize: "24px",
        color: ACCENT,
        stroke: "#000000",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setDepth(10);
    // this.add.text(W / 2, 54, subtitle, {
    //   fontFamily: FONT, fontSize: '8px', color: '#888888',
    // }).setOrigin(0.5).setDepth(10);
  }

  // ─── P1 / P2 Slots ─────────────────────────────────────────────────

  private createSlots(): void {
    const p1Label = this.cpuVsCpu ? "CPU 1" : "PLAYER 1";
    const p2Label = this.cpuVsCpu ? "CPU 2" : this.vsAI ? "CPU" : "PLAYER 2";

    this.drawSlotBox(SLOT_P1_X, SLOT_Y, SLOT_W, SLOT_H, p1Label, 0);
    this.p1NameText = this.add
      .text(
        SLOT_P1_X,
        SLOT_Y + SLOT_H - 14,
        this.p1Slot.characterName.toUpperCase(),
        {
          fontFamily: FONT,
          fontSize: "12px",
          color: "#ffcc00",
        },
      )
      .setOrigin(0.5)
      .setDepth(12);
    this.p1StyleText = this.createStyleText(SLOT_P1_X, 0, "#ffcc00");

    this.add
      .text(VS_X, SLOT_Y + SLOT_H / 2, "VS", {
        fontFamily: FONT,
        fontSize: "36px",
        color: ACCENT,
        stroke: "#000000",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.drawSlotBox(SLOT_P2_X, SLOT_Y, SLOT_W, SLOT_H, p2Label, 1);
    this.p2NameText = this.add
      .text(
        SLOT_P2_X,
        SLOT_Y + SLOT_H - 14,
        this.p2Slot.characterName.toUpperCase(),
        {
          fontFamily: FONT,
          fontSize: "12px",
          color: "#44aaff",
        },
      )
      .setOrigin(0.5)
      .setDepth(12);
    this.p2StyleText = this.createStyleText(SLOT_P2_X, 1, "#44aaff");

    const ind1 = this.add
      .text(SLOT_P1_X, SLOT_Y - 14, "\u25BC SELECTING", {
        fontFamily: FONT,
        fontSize: "9px",
        color: "#ffcc00",
      })
      .setOrigin(0.5)
      .setDepth(12);
    const ind2 = this.add
      .text(SLOT_P2_X, SLOT_Y - 14, "", {
        fontFamily: FONT,
        fontSize: "9px",
        color: "#44aaff",
      })
      .setOrigin(0.5)
      .setDepth(12);
    this.slotIndicators = [ind1, ind2];
    this.refreshStyleTexts();
    this.updateSlotIndicators();
  }

  private drawSlotBox(
    cx: number,
    cy: number,
    w: number,
    h: number,
    label: string,
    slotIdx: number,
  ): void {
    const g = this.add.graphics().setDepth(8);
    g.fillStyle(0x0a0a1e, 0.85);
    g.fillRoundedRect(cx - w / 2, cy, w, h, 8);
    g.lineStyle(3, slotIdx === 0 ? 0xffcc00 : 0x4488ff, 0.7);
    g.strokeRoundedRect(cx - w / 2, cy, w, h, 8);

    this.add
      .text(cx, cy + 18, label, {
        fontFamily: FONT,
        fontSize: "11px",
        color: "#888888",
      })
      .setOrigin(0.5)
      .setDepth(10);

    const hitArea = this.add
      .rectangle(cx, cy + h / 2, w, h)
      .setInteractive({ useHandCursor: true })
      .setAlpha(0.001)
      .setDepth(15);
    hitArea.on("pointerdown", () => {
      this.selectingSlot = slotIdx as 0 | 1;
      this.updateSlotIndicators();
    });
  }

  private updateSlotIndicators(): void {
    this.slotIndicators[0].setText(
      this.selectingSlot === 0 ? "\u25BC SELECTING" : "",
    );
    this.slotIndicators[1].setText(
      this.selectingSlot === 1 ? "\u25BC SELECTING" : "",
    );
    this.updateFightButton();
  }

  private createStyleText(
    cx: number,
    slotIdx: 0 | 1,
    color: string,
  ): Phaser.GameObjects.Text {
    const text = this.add
      .text(cx, SLOT_Y + SLOT_H + 24, "", {
        fontFamily: FONT,
        fontSize: "9px",
        color,
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(12)
      .setInteractive({ useHandCursor: true });

    text.on("pointerover", () => text.setScale(1.04));
    text.on("pointerout", () => text.setScale(1));
    text.on("pointerdown", () => {
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
    this.p1StyleText.setData("hint", p1Style.blurb);
    this.p2StyleText.setText(`STYLE: ${p2Style.label}`);
    this.p2StyleText.setData("hint", p2Style.blurb);
  }

  // ─── Bottom Bar ─────────────────────────────────────────────────────

  private createBottomBar(): void {
    const panel = this.add.graphics().setDepth(19);
    const panelTop = STAGE_PANEL_TOP;
    const panelHeight = STAGE_PANEL_BOTTOM - panelTop;
    panel.fillStyle(0x0a0a20, 0.88);
    panel.fillRoundedRect(
      STAGE_PANEL_X - STAGE_PANEL_W / 2,
      panelTop,
      STAGE_PANEL_W,
      panelHeight,
      10,
    );

    this.add
      .text(STAGE_PANEL_X, panelTop + 14, "STAGE SELECTOR", {
        fontFamily: FONT,
        fontSize: "10px",
        color: "#888888",
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.updateFightButton();

    this.stageText = this.add
      .text(STAGE_PANEL_X, panelTop + 38, "", {
        fontFamily: FONT,
        fontSize: "9px",
        color: "#66ddff",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(20)
      .setInteractive({ useHandCursor: true });
    this.stageHintText = this.add
      .text(STAGE_PANEL_X, panelTop + 60, "", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#888888",
        align: "center",
        wordWrap: { width: STAGE_PANEL_W - 44 },
        lineSpacing: 4,
      })
      .setOrigin(0.5, 0)
      .setDepth(20);

    const previewW = STAGE_PANEL_W - 52;
    const previewH = Math.round(previewW * 9 / 16);
    const previewX = STAGE_PANEL_X;
    const previewY = panelTop + 160;

    this.stagePreviewFrame = this.add.graphics().setDepth(20);
    this.stagePreviewFill = this.add.graphics().setDepth(20);
    this.drawStagePreviewFrame(previewX, previewY, previewW, previewH);

    this.stagePrevBtn = this.add
      .text(previewX - previewW / 2 - 18, previewY, "<", {
        fontFamily: FONT,
        fontSize: "14px",
        color: "#ffd36d",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });
    this.stagePrevBtn.on("pointerover", () => this.stagePrevBtn.setColor("#fff0b0"));
    this.stagePrevBtn.on("pointerout", () => this.stagePrevBtn.setColor("#ffd36d"));
    this.stagePrevBtn.on("pointerdown", () => this.stepStageCarousel(-1));

    this.stageNextBtn = this.add
      .text(previewX + previewW / 2 + 18, previewY, ">", {
        fontFamily: FONT,
        fontSize: "14px",
        color: "#ffd36d",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });
    this.stageNextBtn.on("pointerover", () => this.stageNextBtn.setColor("#fff0b0"));
    this.stageNextBtn.on("pointerout", () => this.stageNextBtn.setColor("#ffd36d"));
    this.stageNextBtn.on("pointerdown", () => this.stepStageCarousel(1));

    this.stageDeleteBtn = this.add
      .text(previewX + previewW / 2 - 8, previewY - previewH / 2 + 10, "X", {
        fontFamily: FONT,
        fontSize: "9px",
        color: "#ff4444",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(22)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    this.stageDeleteBtn.on("pointerover", () => this.stageDeleteBtn.setColor("#ff8888").setScale(1.2));
    this.stageDeleteBtn.on("pointerout", () => this.stageDeleteBtn.setColor("#ff4444").setScale(1));
    this.stageDeleteBtn.on("pointerdown", () => {
      void this.deleteCurrentPhotoStage();
    });

    this.stageCarouselCounterText = this.add
      .text(STAGE_PANEL_X, previewY + previewH / 2 + 18, "", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#777777",
      })
      .setOrigin(0.5)
      .setDepth(21);

    this.stagePreviewMetaText = this.add
      .text(STAGE_PANEL_X, previewY + previewH / 2 + 38, "", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#aaaaaa",
        align: "center",
        wordWrap: { width: STAGE_PANEL_W - 44 },
        lineSpacing: 4,
      })
      .setOrigin(0.5, 0)
      .setDepth(21);

    this.stageUploadBtn = this.add
      .text(STAGE_PANEL_X, panelTop + 304, "FORGE STAGE FROM PHOTO", {
        fontFamily: FONT,
        fontSize: "9px",
        color: "#ffd36d",
        stroke: "#000000",
        strokeThickness: 3,
        backgroundColor: "#1f1631",
        padding: { x: 10, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(20)
      .setInteractive({ useHandCursor: true });
    this.stageUploadBtn.on("pointerover", () => this.stageUploadBtn.setColor("#fff0b0"));
    this.stageUploadBtn.on("pointerout", () => this.stageUploadBtn.setColor("#ffd36d"));
    this.stageUploadBtn.on("pointerdown", () => this.openStageFileDialog());

    this.clearStageBtn = this.add
      .text(STAGE_PANEL_X, panelTop + 340, "USE BUILT-IN / AUTO", {
        fontFamily: FONT,
        fontSize: "8px",
        color: "#888888",
        stroke: "#000000",
        strokeThickness: 3,
        backgroundColor: "#151522",
        padding: { x: 10, y: 6 },
      })
      .setOrigin(0.5)
      .setDepth(20)
      .setInteractive({ useHandCursor: true });
    this.clearStageBtn.on("pointerover", () => {
      this.clearStageBtn.setColor(this.customStageKey ? "#ffaaaa" : "#bbbbbb");
    });
    this.clearStageBtn.on("pointerout", () => this.refreshStageTexts());
    this.clearStageBtn.on("pointerdown", () => {
      this.customStageKey = null;
      this.customStageLabel = null;
      this.syncStageCarouselIndex();
      this.refreshStageTexts();
    });

    this.add
      .text(STAGE_PANEL_X, panelTop + 372, "ARROWS CYCLE BUILT-INS AND SAVED PHOTO STAGES", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#777777",
        align: "center",
        wordWrap: { width: STAGE_PANEL_W - 44 },
        lineSpacing: 4,
      })
      .setOrigin(0.5, 0)
      .setDepth(20);

    this.fightBtn = this.add
      .text(STAGE_PANEL_X, STAGE_PANEL_BOTTOM - 24, "FIGHT!", {
        fontFamily: FONT,
        fontSize: "15px",
        color: "#555555",
        stroke: "#000000",
        strokeThickness: 5,
        backgroundColor: "#2a0808",
        padding: { x: 14, y: 9 },
      })
      .setOrigin(0.5)
      .setDepth(20);
    this.stageText.on("pointerover", () => this.stageText.setScale(1.03));
    this.stageText.on("pointerout", () => this.stageText.setScale(1));
    this.stageText.on("pointerdown", () => this.stepStageCarousel(1));
    this.updateFightButton();
    this.refreshStageTexts();
  }

  private drawStagePreviewFrame(cx: number, cy: number, width: number, height: number): void {
    this.stagePreviewFrame.clear();
    this.stagePreviewFrame.fillStyle(0x09111d, 0.96);
    this.stagePreviewFrame.fillRoundedRect(cx - width / 2, cy - height / 2, width, height, 10);
    this.stagePreviewFrame.lineStyle(2, 0x40527a, 0.9);
    this.stagePreviewFrame.strokeRoundedRect(cx - width / 2, cy - height / 2, width, height, 10);
  }

  private updateFightButton(): void {
    if (!this.fightBtn) return;
    const ready =
      this.p1Slot.photoHash !== null && this.p2Slot.photoHash !== null;
    this.fightBtn.setText(this.cpuVsCpu ? "WATCH MATCH" : "FIGHT!");
    this.fightBtn.setColor(ready ? ACCENT : "#333333");

    if (ready && !this.fightBtn.input?.enabled) {
      this.fightBtn.setInteractive({ useHandCursor: true });
      this.fightBtn.on("pointerover", () => this.fightBtn.setColor("#ff8888"));
      this.fightBtn.on("pointerout", () => this.fightBtn.setColor(ACCENT));
      this.fightBtn.on("pointerdown", () => this.startFight());
    }
  }

  private refreshStageTexts(): void {
    if (!this.stageText || !this.stageHintText || !this.clearStageBtn || !this.stageUploadBtn) return;

    this.stageCarouselOptions = this.buildStageCarouselOptions();
    this.syncStageCarouselIndex();
    const current = this.getCurrentStageOption();
    if (!current) return;

    this.stageText.setText(`STAGE: ${current.label}`);
    this.stageHintText.setText(current.blurb);
    this.stageCarouselCounterText.setText(`${this.stageCarouselIndex + 1} / ${this.stageCarouselOptions.length}`);

    if (current.kind === "photo") {
      this.stagePreviewMetaText.setText("FORGED PHOTO STAGE");
      this.stageUploadBtn.setText("RE-FORGE FROM PHOTO");
      this.clearStageBtn.setText("USE BUILT-IN / AUTO").setColor("#ff8888");
      this.stageDeleteBtn.setVisible(true);
    } else {
      const photoCount = this.cachedPhotoStages.length;
      this.stagePreviewMetaText.setText(
        photoCount > 0
          ? `${photoCount} SAVED PHOTO STAGE${photoCount === 1 ? "" : "S"} READY`
          : "FORGE A PHOTO TO ADD CUSTOM ARENAS",
      );
      this.stageUploadBtn.setText("FORGE STAGE FROM PHOTO");
      this.clearStageBtn.setText("USE BUILT-IN / AUTO").setColor("#888888");
      this.stageDeleteBtn.setVisible(false);
    }

    this.stagePrevBtn.setVisible(this.stageCarouselOptions.length > 1);
    this.stageNextBtn.setVisible(this.stageCarouselOptions.length > 1);
    void this.renderStagePreview(current);
  }

  private createStageFileInput(): void {
    this.stageFileInput = document.createElement("input");
    this.stageFileInput.type = "file";
    this.stageFileInput.accept = "image/png,image/jpeg,image/webp";
    this.stageFileInput.style.display = "none";
    document.body.appendChild(this.stageFileInput);

    this.stageFileInput.addEventListener("change", () => {
      const file = this.stageFileInput.files?.[0];
      this.stageFileInput.value = "";
      if (!file) return;
      void this.handleStageFile(file);
    });
  }

  private openStageFileDialog(): void {
    this.stageFileInput.click();
  }

  private async handleStageFile(file: File): Promise<void> {
    try {
      this.stageHintText?.setText("FORGING 2D STAGE FROM PHOTO...");
      const cached = await createPhotoStage(file, file.name);
      this.customStageKey = cached.stageKey;
      this.customStageLabel = cached.label ?? "PHOTO STAGE";
      await this.loadCachedPhotoStages();
      this.refreshStageTexts();
    } catch (err) {
      console.warn("[RosterScene] Failed to create photo stage:", err);
      this.stageHintText?.setText("AI STAGE FORGE FAILED. TRY ANOTHER IMAGE.");
    }
  }

  private async deleteCurrentPhotoStage(): Promise<void> {
    const current = this.getCurrentStageOption();
    const stageKey = current?.kind === "photo" ? current.customStageKey : null;
    if (!stageKey) return;

    try {
      await deleteCachedStageBackground(stageKey);
      if (this.customStageKey === stageKey) {
        this.customStageKey = null;
        this.customStageLabel = null;
        this.stageId = null;
      }
      await this.loadCachedPhotoStages();
      this.refreshStageTexts();
    } catch (err) {
      console.warn("[RosterScene] Failed to delete cached stage:", err);
      this.stagePreviewMetaText?.setText("FAILED TO DELETE STAGE");
    }
  }

  private async loadCachedPhotoStages(): Promise<void> {
    try {
      const allStages = await getAllCachedStageBackgrounds();
      this.cachedPhotoStages = allStages
        .filter((stage) => stage.kind === "photo")
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      this.cachedPhotoStages = [];
    }
    if (this.stageText) {
      this.refreshStageTexts();
    }
  }

  private buildStageCarouselOptions(): StageCarouselOption[] {
    const options: StageCarouselOption[] = [
      {
        key: "built-in:auto",
        kind: "built-in",
        label: getStageChoiceLabel(null),
        blurb: getStageChoiceBlurb(null),
        stageId: null,
      },
      ...STAGE_THEMES.map((stage) => ({
        key: `built-in:${stage.id}`,
        kind: "built-in" as const,
        label: stage.label,
        blurb: stage.blurb,
        stageId: stage.id,
      })),
      ...this.cachedPhotoStages.map((stage) => ({
        key: `photo:${stage.stageKey}`,
        kind: "photo" as const,
        label: (stage.label ?? "PHOTO STAGE").toUpperCase(),
        blurb: "Gemini-forged stage saved from your uploaded photo.",
        customStageKey: stage.stageKey,
        previewBlob: stage.pngBlob,
      })),
    ];
    return options;
  }

  private getCurrentStageOption(): StageCarouselOption | null {
    return this.stageCarouselOptions[this.stageCarouselIndex] ?? null;
  }

  private syncStageCarouselIndex(): void {
    if (this.stageCarouselOptions.length === 0) {
      this.stageCarouselIndex = 0;
      return;
    }

    const currentKey = this.customStageKey
      ? `photo:${this.customStageKey}`
      : `built-in:${this.stageId ?? "auto"}`;
    const idx = this.stageCarouselOptions.findIndex((option) => option.key === currentKey);
    this.stageCarouselIndex = idx >= 0 ? idx : 0;
  }

  private stepStageCarousel(delta: number): void {
    this.stageCarouselOptions = this.buildStageCarouselOptions();
    if (this.stageCarouselOptions.length === 0) return;

    this.syncStageCarouselIndex();
    const nextIndex = Phaser.Math.Wrap(
      this.stageCarouselIndex + delta,
      0,
      this.stageCarouselOptions.length,
    );
    this.stageCarouselIndex = nextIndex;
    this.applyStageCarouselSelection(this.stageCarouselOptions[nextIndex]);
    this.refreshStageTexts();
  }

  private applyStageCarouselSelection(option: StageCarouselOption): void {
    if (option.kind === "photo") {
      this.customStageKey = option.customStageKey ?? null;
      this.customStageLabel = option.label;
      this.stageId = null;
      return;
    }

    this.customStageKey = null;
    this.customStageLabel = null;
    this.stageId = option.stageId ?? null;
  }

  private async renderStagePreview(option: StageCarouselOption): Promise<void> {
    if (!this.stagePreviewFill) return;

    const previewW = STAGE_PANEL_W - 52;
    const previewH = Math.round(previewW * 9 / 16);
    const previewX = STAGE_PANEL_X;
    const previewY = STAGE_PANEL_TOP + 160;
    const loadId = ++this.stagePreviewLoadId;

    this.stagePreviewFill.clear();
    this.stagePreviewFill.fillStyle(option.kind === "photo" ? 0x0b1624 : 0x15203b, 0.96);
    this.stagePreviewFill.fillRoundedRect(previewX - previewW / 2 + 4, previewY - previewH / 2 + 4, previewW - 8, previewH - 8, 8);

    if (this.stagePreviewImage) {
      this.stagePreviewImage.destroy();
      this.stagePreviewImage = null;
    }
    if (this.stagePreviewTextureKey && this.textures.exists(this.stagePreviewTextureKey)) {
      this.textures.remove(this.stagePreviewTextureKey);
      this.stagePreviewTextureKey = undefined;
    }

    if (option.kind !== "photo" || !option.previewBlob) {
      this.drawBuiltInStagePreview(option, previewX, previewY, previewW, previewH);
      return;
    }

    try {
      const canvas = await this.buildStagePreviewCanvas(option.previewBlob, previewW - 8, previewH - 8);
      if (loadId !== this.stagePreviewLoadId) return;

      const texKey = `stage_preview_${option.customStageKey?.replace(/[^a-z0-9_-]/gi, "_") ?? loadId}`;
      if (this.textures.exists(texKey)) this.textures.remove(texKey);
      this.textures.addCanvas(texKey, canvas);
      this.stagePreviewTextureKey = texKey;
      this.stagePreviewImage = this.add.image(previewX, previewY, texKey).setDepth(21);
    } catch {
      if (loadId !== this.stagePreviewLoadId) return;
      this.drawBuiltInStagePreview(option, previewX, previewY, previewW, previewH);
    }
  }

  private drawBuiltInStagePreview(
    option: StageCarouselOption,
    cx: number,
    cy: number,
    width: number,
    height: number,
  ): void {
    this.stagePreviewFill.fillStyle(option.stageId ? 0x203055 : 0x1a2034, 0.94);
    this.stagePreviewFill.fillRoundedRect(cx - width / 2 + 4, cy - height / 2 + 4, width - 8, height - 8, 8);
    this.stagePreviewFill.fillStyle(0xffffff, 0.06);
    this.stagePreviewFill.fillCircle(cx + width * 0.22, cy - height * 0.18, 26);
    this.stagePreviewFill.fillStyle(0x000000, 0.18);
    this.stagePreviewFill.fillRect(cx - width / 2 + 4, cy + height * 0.15, width - 8, height * 0.35);
  }

  private async buildStagePreviewCanvas(blob: Blob, width: number, height: number): Promise<HTMLCanvasElement> {
    const img = await this.loadBlobImage(blob);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const scale = Math.max(width / img.width, height / img.height);
    const drawWidth = img.width * scale;
    const drawHeight = img.height * scale;
    ctx.drawImage(
      img,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    return canvas;
  }

  private loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const htmlImg = new Image();
      htmlImg.onload = () => {
        URL.revokeObjectURL(url);
        resolve(htmlImg);
      };
      htmlImg.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      };
      htmlImg.src = url;
    });
  }

  // ─── Roster Grid ────────────────────────────────────────────────────

  private async loadRoster(): Promise<void> {
    try {
      const all = await getAllCachedMetas();
      this.metas = all.filter(
        (m) => m.status === "ready" && m.version === CACHE_VERSION,
      );
    } catch {
      this.metas = [];
    }

    this.rosterContainer?.destroy();
    // this.rosterTitleText?.destroy();
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

    // this.rosterTitleText = this.add
    //   .text(
    //     viewportBounds.centerX,
    //     GRID_TOP - 18,
    //     "YOUR ROSTER (click to assign)",
    //     {
    //       fontFamily: FONT,
    //       fontSize: "10px",
    //       color: "#888888",
    //     },
    //   )
    //   .setOrigin(0.5)
    //   .setDepth(10);

    this.rosterHintText = this.add
      .text(viewportBounds.centerX, GRID_TOP - 6, "", {
        fontFamily: FONT,
        fontSize: "7px",
        color: "#666666",
      })
      .setOrigin(0.5)
      .setDepth(10);

    this.rosterMaskGfx = this.add.graphics().setVisible(false);
    this.rosterMaskGfx.fillStyle(0xffffff);
    this.rosterMaskGfx.fillRect(
      viewportBounds.x,
      viewportBounds.y,
      viewportBounds.width,
      viewportBounds.height,
    );
    this.rosterContainer.setMask(this.rosterMaskGfx.createGeometryMask());

    if (totalItems === 0) {
      this.rosterHintText.setText("CREATE A FIGHTER TO FILL THE ROSTER");
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
      g.fillRoundedRect(
        cx - thumbSize / 2,
        cy - thumbSize / 2,
        thumbSize,
        thumbSize + 20,
        5,
      );
      g.lineStyle(2, 0x333366);
      g.strokeRoundedRect(
        cx - thumbSize / 2,
        cy - thumbSize / 2,
        thumbSize,
        thumbSize + 20,
        5,
      );
      this.rosterContainer.add(g);

      if (meta.originalPhotoBlob) {
        this.loadThumbnail(meta, cx, cy, thumbSize, this.rosterContainer);
      }

      const nameLabel = this.add
        .text(
          cx,
          cy + thumbSize / 2 + 8,
          (meta.characterName || "Fighter").slice(0, 10).toUpperCase(),
          {
            fontFamily: FONT,
            fontSize: "7px",
            color: "#aaaaaa",
          },
        )
        .setOrigin(0.5)
        .setDepth(12);
      this.rosterContainer.add(nameLabel);

      const hitArea = this.add
        .rectangle(cx, cy, thumbSize, thumbSize + 20)
        .setInteractive({ useHandCursor: true })
        .setAlpha(0.001)
        .setDepth(15);
      hitArea.on("pointerdown", () => this.assignToSlot(meta));
      this.rosterContainer.add(hitArea);

      const delBtn = this.add
        .text(cx + thumbSize / 2 - 4, cy - thumbSize / 2 + 2, "X", {
          fontFamily: FONT,
          fontSize: "9px",
          color: "#ff4444",
          stroke: "#000000",
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(16)
        .setInteractive({ useHandCursor: true });
      delBtn.on("pointerover", () => delBtn.setColor("#ff8888").setScale(1.3));
      delBtn.on("pointerout", () => delBtn.setColor("#ff4444").setScale(1));
      delBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
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
    const right = STAGE_PANEL_X - STAGE_PANEL_W / 2 - 26;
    return new Phaser.Geom.Rectangle(
      left,
      GRID_TOP,
      right - left,
      GRID_BOTTOM - GRID_TOP,
    );
  }

  private handleRosterWheel(
    pointer: Phaser.Input.Pointer,
    _gameObjects: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ): void {
    const stageBounds = new Phaser.Geom.Rectangle(
      STAGE_PANEL_X - STAGE_PANEL_W / 2,
      STAGE_PANEL_TOP,
      STAGE_PANEL_W,
      STAGE_PANEL_BOTTOM - STAGE_PANEL_TOP,
    );
    if (Phaser.Geom.Rectangle.Contains(stageBounds, pointer.x, pointer.y)) {
      this.stepStageCarousel(deltaY > 0 ? 1 : -1);
      return;
    }

    const bounds = this.getRosterViewportBounds();
    if (this.rosterMaxScroll <= 0) return;
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
    this.rosterScrollY = Phaser.Math.Clamp(
      this.rosterScrollY + delta,
      0,
      this.rosterMaxScroll,
    );
    this.rosterContainer.y = -this.rosterScrollY;
    this.refreshRosterScrollHint();
  }

  private refreshRosterScrollHint(): void {
    if (!this.rosterHintText) return;
    if (this.metas.length === 0) {
      this.rosterHintText.setText("CREATE A FIGHTER TO FILL THE ROSTER");
      return;
    }
    if (this.rosterMaxScroll <= 0) {
      this.rosterHintText.setText(
        `${this.metas.length} FIGHTER${this.metas.length === 1 ? "" : "S"} READY`,
      );
      return;
    }

    if (this.rosterScrollY <= 0) {
      this.rosterHintText.setText("MOUSE WHEEL OR DOWN ARROW TO SEE MORE");
      return;
    }
    if (this.rosterScrollY >= this.rosterMaxScroll) {
      this.rosterHintText.setText("UP ARROW OR WHEEL UP TO GO BACK");
      return;
    }
    this.rosterHintText.setText(
      "MOUSE WHEEL OR ARROW KEYS TO SCROLL THE ROSTER",
    );
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
      const canvas = document.createElement("canvas");
      canvas.width = size - 8;
      canvas.height = size - 8;
      const ctx = canvas.getContext("2d")!;
      const scale = Math.min(
        canvas.width / htmlImg.width,
        canvas.height / htmlImg.height,
      );
      const dw = htmlImg.width * scale;
      const dh = htmlImg.height * scale;
      ctx.drawImage(
        htmlImg,
        (canvas.width - dw) / 2,
        (canvas.height - dh) / 2,
        dw,
        dh,
      );

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
    slot.characterName = meta.characterName || "Fighter";

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
    const cx = slotIdx === 0 ? SLOT_P1_X : SLOT_P2_X;
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
      const canvas = document.createElement("canvas");
      const size = 150;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
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
      this.p1NameText.setText("P1");
      if (this.p1Preview) {
        this.p1Preview.destroy();
        this.p1Preview = null;
      }
    }
    if (this.p2Slot.photoHash === photoHash) {
      this.p2Slot.photoHash = null;
      this.p2NameText.setText("P2");
      if (this.p2Preview) {
        this.p2Preview.destroy();
        this.p2Preview = null;
      }
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
      this.cameras.main.once("camerafadeoutcomplete", () => {
        this.scene.start("FightScene", {
          vsAI: this.vsAI,
          cpuVsCpu: this.cpuVsCpu,
          p1PhotoHash: this.p1Slot.photoHash,
          p2PhotoHash: this.p2Slot.photoHash,
          p1Name: this.p1Slot.characterName,
          p2Name: this.p2Slot.characterName,
          p1PersonalityId: this.p1Slot.personalityId,
          p2PersonalityId: this.p2Slot.personalityId,
          stageId: this.stageId ?? undefined,
          customStageKey: this.customStageKey ?? undefined,
          customStageLabel: this.customStageLabel ?? undefined,
        });
      });
    });
  }

  shutdown(): void {
    this.input.off("wheel", this.handleRosterWheel, this);
    this.input.keyboard?.off("keydown-UP", this.scrollRosterUp, this);
    this.input.keyboard?.off("keydown-DOWN", this.scrollRosterDown, this);
    this.stagePreviewImage?.destroy();
    this.stagePreviewImage = null;
    if (this.stagePreviewTextureKey && this.textures.exists(this.stagePreviewTextureKey)) {
      this.textures.remove(this.stagePreviewTextureKey);
      this.stagePreviewTextureKey = undefined;
    }
    this.stageFileInput?.remove();
  }

  destroy(): void {
    this.input.off("wheel", this.handleRosterWheel, this);
    this.input.keyboard?.off("keydown-UP", this.scrollRosterUp, this);
    this.input.keyboard?.off("keydown-DOWN", this.scrollRosterDown, this);
    this.stageFileInput?.remove();
  }
}
