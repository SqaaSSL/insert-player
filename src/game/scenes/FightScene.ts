import Phaser from "phaser";
import { Fighter } from "../fighters/Fighter.ts";
import { Projectile } from "../fighters/Projectile.ts";
import { CombatSystem, type HitEvent } from "../systems/CombatSystem.ts";
import { AIController } from "../systems/AIController.ts";
import { InputManager } from "../systems/InputManager.ts";
import { SoundManager } from "../systems/SoundManager.ts";
import { HUD } from "../ui/HUD.ts";
import { SeededRng } from "../utils/SeededRng.ts";
import { ScreenEffects } from "../effects/ScreenEffects.ts";
import {
  ensureStageBackground,
  getCachedStageBackgroundForRequest,
} from "../../services/StageBackgroundService.ts";
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  GROUND_Y,
  FIXED_TIMESTEP,
  ROUND_TIME,
  ROUNDS_TO_WIN,
  MAX_HEALTH,
  ATTACKS,
  FighterState,
} from "../constants.ts";
import { loadAiSprites } from "../sprites/AiSpriteLoader.ts";
import { getCachedMeta, getCachedStageBackground } from "../../services/SpriteCache.ts";
import {
  buildMatchSeed,
  getDefaultPersonalityId,
  getFighterPersonality,
  getMatchLabel,
  type FighterPersonalityId,
  type MatchSceneData,
} from "../match/MatchConfig.ts";
import {
  getStageTheme,
  pickStageThemeIdFromSeed,
  type StageThemeId,
} from "../match/StageConfig.ts";

enum RoundPhase {
  INTRO = 0,
  FIGHTING = 1,
  ROUND_END = 2,
  MATCH_END = 3,
}

export class FightScene extends Phaser.Scene {
  private p1!: Fighter;
  private p2!: Fighter;
  private combat!: CombatSystem;
  private inputMgr!: InputManager;
  private ai!: AIController;
  private ai2!: AIController;
  private hud!: HUD;
  private sound_mgr!: SoundManager;

  private accumulator = 0;
  private frameCount = 0;
  private roundTimer = ROUND_TIME;
  private phase = RoundPhase.INTRO;
  private phaseTimer = 0;
  private p1Wins = 0;
  private p2Wins = 0;
  private isVsAI = true;
  private cpuVsCpu = false;

  private hitSparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private stageGfx!: Phaser.GameObjects.Graphics;
  private stageBackdrop?: Phaser.GameObjects.Image;
  private stageBackdropTextureKey?: string;
  private stageVisualLayers: Phaser.GameObjects.Graphics[] = [];
  private ambientLayers: Phaser.GameObjects.Graphics[] = [];
  private stageLoadingText?: Phaser.GameObjects.Text;
  private stageLoadId = 0;

  private projectiles: Projectile[] = [];
  private matchOverUI?: Phaser.GameObjects.Text;
  private waitingForMatchInput = false;
  private p1PhotoHash: string | null = null;
  private p2PhotoHash: string | null = null;
  private p1Name = "Player 1";
  private p2Name = "CPU";
  private p1PersonalityId: FighterPersonalityId = getDefaultPersonalityId(0);
  private p2PersonalityId: FighterPersonalityId = getDefaultPersonalityId(1);
  private stageId: StageThemeId | null = null;
  private customStageKey: string | null = null;
  private customStageLabel: string | null = null;
  private resolvedStageId: StageThemeId = "dojo";
  private matchSeed = 1;
  private remix = 0;
  private stageFloorY = GROUND_Y;
  private fighterRenderScale = 1;
  private fighterRenderYOffset = 0;
  private bottomOverlayY = GAME_HEIGHT - 60;
  private ready = false;
  private matchLabel = "";
  private stageDisplayLabel = "";
  private p1DisplayTag = "";
  private p2DisplayTag = "";
  private introHasPlayed = false;
  private cinematicIntroActive = false;
  private introCanSkip = false;
  private introOverlay?: Phaser.GameObjects.Container;
  private introPortraitTextureKeys: string[] = [];
  private introEvents: Phaser.Time.TimerEvent[] = [];
  private introEnterKey?: Phaser.Input.Keyboard.Key;
  private introSpaceKey?: Phaser.Input.Keyboard.Key;

  constructor() {
    super({ key: "FightScene" });
  }

  init(data: MatchSceneData): void {
    this.cpuVsCpu = data.cpuVsCpu === true;
    this.isVsAI = data.vsAI !== false || this.cpuVsCpu;
    this.p1PhotoHash = data.p1PhotoHash ?? null;
    this.p2PhotoHash = data.p2PhotoHash ?? null;
    this.p1Name = data.p1Name ?? (this.cpuVsCpu ? "CPU 1" : "Player 1");
    this.p2Name = data.p2Name ?? (this.isVsAI ? "CPU" : "Player 2");
    this.p1PersonalityId = data.p1PersonalityId ?? getDefaultPersonalityId(0);
    this.p2PersonalityId = data.p2PersonalityId ?? getDefaultPersonalityId(1);
    this.stageId = data.stageId ?? null;
    this.customStageKey = data.customStageKey ?? null;
    this.customStageLabel = data.customStageLabel ?? null;
    this.remix = data.remix ?? 0;
    this.matchSeed = buildMatchSeed({
      ...data,
      vsAI: this.isVsAI,
      cpuVsCpu: this.cpuVsCpu,
      p1PhotoHash: this.p1PhotoHash ?? undefined,
      p2PhotoHash: this.p2PhotoHash ?? undefined,
      p1Name: this.p1Name,
      p2Name: this.p2Name,
      p1PersonalityId: this.p1PersonalityId,
      p2PersonalityId: this.p2PersonalityId,
      stageId: this.stageId ?? undefined,
      customStageKey: this.customStageKey ?? undefined,
      customStageLabel: this.customStageLabel ?? undefined,
      remix: this.remix,
    });
    this.p1Wins = 0;
    this.p2Wins = 0;
    this.accumulator = 0;
    this.waitingForMatchInput = false;
    this.ready = false;
    this.matchLabel = "";
    this.stageDisplayLabel = "";
    this.p1DisplayTag = "";
    this.p2DisplayTag = "";
    this.introHasPlayed = false;
    this.cinematicIntroActive = false;
    this.introCanSkip = false;
  }

  async create(): Promise<void> {
    if (this.customStageKey) {
      this.stageFloorY = GROUND_Y + 18;
      this.fighterRenderScale = 1.2;
      this.fighterRenderYOffset = this.stageFloorY - GROUND_Y;
      this.bottomOverlayY = GAME_HEIGHT - 28;
    } else {
      this.stageFloorY = GROUND_Y;
      this.fighterRenderScale = 1.03;
      this.fighterRenderYOffset = 0;
      this.bottomOverlayY = GAME_HEIGHT - 60;
    }

    const p1Personality = getFighterPersonality(this.p1PersonalityId);
    const p2Personality = getFighterPersonality(this.p2PersonalityId);
    const stageTheme = getStageTheme(
      this.stageId ?? pickStageThemeIdFromSeed(this.matchSeed),
    );
    this.resolvedStageId = stageTheme.id;
    const stageLabel = this.customStageKey
      ? (this.customStageLabel ?? "PHOTO STAGE").toUpperCase()
      : stageTheme.label;
    const matchLabel = this.isVsAI
      ? `${stageLabel} · ${getMatchLabel(this.remix)}`
      : stageLabel;
    this.stageDisplayLabel = stageLabel;
    this.matchLabel = matchLabel;
    this.p1DisplayTag = this.cpuVsCpu ? p1Personality.label : "";
    this.p2DisplayTag = this.isVsAI ? p2Personality.label : "";

    this.combat = new CombatSystem();
    this.inputMgr = new InputManager(this);
    this.sound_mgr = new SoundManager();
    this.introEnterKey = this.input.keyboard?.addKey(
      Phaser.Input.Keyboard.KeyCodes.ENTER,
    );
    this.introSpaceKey = this.input.keyboard?.addKey(
      Phaser.Input.Keyboard.KeyCodes.SPACE,
    );

    await this.loadAiSpritesIfNeeded();

    this.drawStage();
    if (this.customStageKey) {
      void this.loadCustomStageBackground();
    } else if (!this.stageId) {
      void this.loadAiStageBackground();
    }
    this.createFighters();

    this.hud = new HUD(this);
    this.hud.create(
      this.p1.name,
      this.p2.name,
      this.cpuVsCpu ? p1Personality.label : undefined,
      this.isVsAI ? p2Personality.label : undefined,
      matchLabel,
      this.p1PhotoHash,
      this.p2PhotoHash,
    );

    this.ai = new AIController(
      new SeededRng(this.mixSeed(0x6d2b79f5)),
      p2Personality,
    );
    this.ai2 = new AIController(
      new SeededRng(this.mixSeed(0x1b873593)),
      p1Personality,
    );

    this.createParticles();
    ScreenEffects.createCRTOverlay(this);
    this.startRound();
    this.ready = true;
  }

  private mixSeed(salt: number): number {
    const mixed = Math.imul(this.matchSeed ^ salt, 0x45d9f3b);
    const normalized = mixed >>> 0;
    return normalized === 0 ? salt >>> 0 : normalized;
  }

  private async loadAiSpritesIfNeeded(): Promise<void> {
    const loads: Promise<void>[] = [];

    if (this.p1PhotoHash) {
      loads.push(
        loadAiSprites(this, "fighter_p1", this.p1PhotoHash).then((ok) => {
          if (ok) console.log("Loaded AI sprites for P1");
          else console.warn("No AI sprites found for P1, using procedural");
        }),
      );
    }

    if (this.p2PhotoHash) {
      loads.push(
        loadAiSprites(this, "fighter_p2", this.p2PhotoHash).then((ok) => {
          if (ok) console.log("Loaded AI sprites for P2");
          else console.warn("No AI sprites found for P2, using procedural");
        }),
      );
    }

    await Promise.all(loads);
  }

  private drawStage(): void {
    this.stageBackdrop?.destroy();
    this.stageBackdrop = undefined;
    if (
      this.stageBackdropTextureKey &&
      this.textures.exists(this.stageBackdropTextureKey)
    ) {
      this.textures.remove(this.stageBackdropTextureKey);
    }
    this.stageBackdropTextureKey = undefined;
    this.stageGfx = this.add.graphics().setDepth(0);
    this.stageVisualLayers = [];
    this.ambientLayers = [];

    const midGfx = this.add.graphics().setDepth(2);
    const frontGfx = this.add.graphics().setDepth(3);
    this.stageVisualLayers.push(this.stageGfx, midGfx, frontGfx);

    if (this.customStageKey) {
      this.drawVerticalGradient(this.stageGfx, 0x09111b, 0x162131);
      this.stageGfx.fillStyle(0x102030, 0.58);
      this.stageGfx.fillRect(
        0,
        this.stageFloorY - 14,
        GAME_WIDTH,
        GAME_HEIGHT - this.stageFloorY + 14,
      );
      this.stageGfx.lineStyle(3, 0xdce8f5, 0.24);
      this.stageGfx.lineBetween(
        0,
        this.stageFloorY,
        GAME_WIDTH,
        this.stageFloorY,
      );

      midGfx.fillStyle(0xffffff, 0.04);
      midGfx.fillRect(
        0,
        this.stageFloorY + 4,
        GAME_WIDTH,
        GAME_HEIGHT - this.stageFloorY - 4,
      );
      midGfx.lineStyle(1, 0xffffff, 0.08);
      for (let y = this.stageFloorY + 20; y < GAME_HEIGHT; y += 22) {
        midGfx.lineBetween(0, y, GAME_WIDTH, y);
      }
      midGfx.lineStyle(1, 0xffffff, 0.06);
      for (let x = -80; x <= GAME_WIDTH + 80; x += 72) {
        const targetX = GAME_WIDTH / 2 + (x - GAME_WIDTH / 2) * 1.45;
        midGfx.lineBetween(x, this.stageFloorY + 6, targetX, GAME_HEIGHT);
      }

      frontGfx.fillStyle(0x000000, 0.12);
      frontGfx.fillRect(0, GAME_HEIGHT - 18, GAME_WIDTH, 18);
      frontGfx.lineStyle(2, 0xffffff, 0.07);
      frontGfx.lineBetween(
        0,
        this.stageFloorY + 8,
        GAME_WIDTH,
        this.stageFloorY + 8,
      );
      return;
    }

    switch (this.resolvedStageId) {
      case "dojo":
        this.drawVerticalGradient(this.stageGfx, 0x14193c, 0x385a78);
        this.drawGround(this.stageGfx, 0x3a2a1a, 0x5a4a3a);
        this.stageGfx.fillStyle(0x4a3a2a);
        this.stageGfx.fillRect(30, GROUND_Y - 280, 40, 280);
        this.stageGfx.fillRect(GAME_WIDTH - 70, GROUND_Y - 280, 40, 280);
        this.stageGfx.fillStyle(0x8b0000);
        this.stageGfx.fillTriangle(
          0,
          GROUND_Y - 280,
          GAME_WIDTH / 2,
          GROUND_Y - 360,
          GAME_WIDTH,
          GROUND_Y - 280,
        );
        for (let i = 0; i < 5; i++) {
          const lx = 120 + i * 180;
          this.stageGfx.fillStyle(0xcc3333);
          this.stageGfx.fillRoundedRect(lx - 12, GROUND_Y - 300, 24, 36, 6);
        }

        midGfx.lineStyle(1, 0x5a4a3a, 0.4);
        for (let i = 0; i < 16; i++) {
          const plankX = i * 66;
          midGfx.lineBetween(plankX, GROUND_Y + 2, plankX, GAME_HEIGHT);
        }
        midGfx.lineStyle(1, 0x4a3a2a, 0.3);
        for (let y = GROUND_Y + 20; y < GAME_HEIGHT; y += 30) {
          midGfx.lineBetween(0, y, GAME_WIDTH, y);
        }

        frontGfx.fillStyle(0x111111, 0.5);
        for (const sx of [140, 360, 660, 870]) {
          const headY = GROUND_Y - 30;
          frontGfx.fillCircle(sx, headY, 8);
          frontGfx.fillRoundedRect(sx - 7, headY + 8, 14, 22, 3);
        }

        this.createCloudLayer(30, 0.008, 0xffffff, 0.06, [
          { x: 100, w: 120, h: 24 },
          { x: 500, w: 90, h: 18 },
          { x: 820, w: 110, h: 22 },
        ]);
        this.createCloudLayer(70, 0.015, 0xffffff, 0.06, [
          { x: 200, w: 80, h: 16 },
          { x: 650, w: 100, h: 20 },
          { x: 950, w: 70, h: 14 },
        ]);
        this.createLanternGlows(
          [120, 300, 480, 660, 840],
          GROUND_Y - 282,
          0xffaa00,
        );
        break;

      case "neon-rooftop":
        this.drawVerticalGradient(this.stageGfx, 0x070b1f, 0x5a1769);
        this.stageGfx.fillStyle(0xff55aa, 0.12);
        this.stageGfx.fillCircle(820, 120, 86);
        this.drawGround(this.stageGfx, 0x1c1f2c, 0x56617f);

        for (const building of [
          { x: 20, w: 90, h: 180, color: 0x121a30 },
          { x: 130, w: 120, h: 220, color: 0x18233a },
          { x: 280, w: 100, h: 190, color: 0x10182a },
          { x: 420, w: 160, h: 250, color: 0x172035 },
          { x: 620, w: 110, h: 205, color: 0x0f1730 },
          { x: 770, w: 130, h: 235, color: 0x17223f },
          { x: 930, w: 80, h: 170, color: 0x10192c },
        ]) {
          const topY = GROUND_Y - building.h;
          this.stageGfx.fillStyle(building.color);
          this.stageGfx.fillRect(building.x, topY, building.w, building.h);
          midGfx.fillStyle(0xffdd88, 0.35);
          for (let wy = topY + 18; wy < GROUND_Y - 18; wy += 22) {
            for (
              let wx = building.x + 12;
              wx < building.x + building.w - 12;
              wx += 18
            ) {
              if (((wx + wy) / 6) % 3 < 1) midGfx.fillRect(wx, wy, 8, 10);
            }
          }
        }

        midGfx.lineStyle(2, 0x7de8ff, 0.35);
        midGfx.lineBetween(0, GROUND_Y - 52, GAME_WIDTH, GROUND_Y - 52);
        midGfx.lineStyle(3, 0x67708e, 0.75);
        for (let x = 0; x < GAME_WIDTH; x += 48) {
          midGfx.lineBetween(x, GROUND_Y - 6, x + 20, GROUND_Y - 6);
        }

        frontGfx.lineStyle(2, 0x50607b, 0.9);
        frontGfx.lineBetween(0, GROUND_Y - 72, GAME_WIDTH, GROUND_Y - 72);
        for (let x = 0; x <= GAME_WIDTH; x += 42) {
          frontGfx.lineBetween(x, GROUND_Y - 72, x + 20, GROUND_Y - 102);
          frontGfx.lineBetween(x, GROUND_Y - 72, x - 20, GROUND_Y - 102);
        }

        this.createCloudLayer(88, 0.012, 0xff88ff, 0.05, [
          { x: 80, w: 180, h: 30 },
          { x: 520, w: 150, h: 24 },
          { x: 860, w: 170, h: 28 },
        ]);
        this.createNeonSigns([
          { x: 150, y: GROUND_Y - 190, w: 92, h: 30, color: 0xff44bb },
          { x: 488, y: GROUND_Y - 230, w: 110, h: 36, color: 0x44e5ff },
          { x: 812, y: GROUND_Y - 170, w: 82, h: 28, color: 0xffef66 },
        ]);
        break;

      case "sunset-pier":
        this.drawVerticalGradient(this.stageGfx, 0xff8f4b, 0xffd68b);
        this.stageGfx.fillStyle(0xfff3ba, 0.45);
        this.stageGfx.fillCircle(780, 122, 72);
        this.stageGfx.fillStyle(0x1e5f90);
        this.stageGfx.fillRect(0, GROUND_Y - 34, GAME_WIDTH, 92);
        this.drawGround(this.stageGfx, 0x7b4e2a, 0xc89552);

        midGfx.fillStyle(0x5e371d);
        for (let x = 0; x < GAME_WIDTH; x += 58) {
          midGfx.fillRect(x, GROUND_Y - 10, 8, GAME_HEIGHT - GROUND_Y + 10);
        }
        midGfx.lineStyle(2, 0xd9b07b, 0.45);
        for (let y = GROUND_Y + 14; y < GAME_HEIGHT; y += 24) {
          midGfx.lineBetween(0, y, GAME_WIDTH, y);
        }

        frontGfx.fillStyle(0x1f1f1f, 0.72);
        for (const palmX of [90, 910]) {
          frontGfx.fillRect(palmX - 5, GROUND_Y - 170, 10, 170);
          for (const dir of [-1, 1]) {
            frontGfx.fillTriangle(
              palmX,
              GROUND_Y - 170,
              palmX + dir * 70,
              GROUND_Y - 210,
              palmX + dir * 24,
              GROUND_Y - 132,
            );
            frontGfx.fillTriangle(
              palmX,
              GROUND_Y - 150,
              palmX + dir * 60,
              GROUND_Y - 140,
              palmX + dir * 18,
              GROUND_Y - 92,
            );
          }
        }

        this.createCloudLayer(54, 0.008, 0xffffff, 0.11, [
          { x: 130, w: 170, h: 32 },
          { x: 560, w: 200, h: 36 },
          { x: 900, w: 150, h: 28 },
        ]);
        this.createWaterShimmerLines(
          [GROUND_Y - 10, GROUND_Y + 8, GROUND_Y + 28],
          0xe8f5ff,
        );
        break;

      case "moonlit-garden":
        this.drawVerticalGradient(this.stageGfx, 0x081226, 0x17485b);
        this.stageGfx.fillStyle(0xe3f5ff, 0.2);
        this.stageGfx.fillCircle(820, 110, 78);
        this.drawGround(this.stageGfx, 0x24311d, 0x4f6344);

        midGfx.fillStyle(0x552e18);
        midGfx.fillRect(140, GROUND_Y - 190, 18, 190);
        midGfx.fillRect(318, GROUND_Y - 190, 18, 190);
        midGfx.fillRect(124, GROUND_Y - 190, 228, 14);
        midGfx.fillStyle(0x6f3f1d);
        midGfx.fillRect(180, GROUND_Y - 132, 120, 10);

        frontGfx.fillStyle(0x102012, 0.85);
        for (const bambooX of [640, 686, 730, 776, 828, 874]) {
          frontGfx.fillRect(bambooX, GROUND_Y - 220, 10, 220);
          for (let y = GROUND_Y - 198; y < GROUND_Y - 20; y += 36) {
            frontGfx.fillRect(bambooX - 2, y, 14, 4);
          }
        }

        this.createCloudLayer(
          84,
          0.006,
          0xb5ffff,
          0.05,
          [
            { x: 60, w: 220, h: 42 },
            { x: 410, w: 260, h: 46 },
            { x: 800, w: 210, h: 38 },
          ],
          1,
          "mist",
        );
        this.createFireflies([
          { x: 130, y: 170 },
          { x: 220, y: 130 },
          { x: 360, y: 210 },
          { x: 560, y: 140 },
          { x: 730, y: 190 },
          { x: 860, y: 152 },
          { x: 930, y: 220 },
        ]);
        break;

      case "subway-platform":
        this.drawVerticalGradient(this.stageGfx, 0x11161e, 0x2c3643);
        this.stageGfx.fillStyle(0x384655);
        this.stageGfx.fillRect(0, GROUND_Y - 230, GAME_WIDTH, 230);
        this.stageGfx.fillStyle(0x2f3946);
        this.stageGfx.fillRect(0, GROUND_Y, GAME_WIDTH, GAME_HEIGHT - GROUND_Y);
        this.stageGfx.fillStyle(0xc2a741);
        this.stageGfx.fillRect(0, GROUND_Y - 10, GAME_WIDTH, 10);
        this.stageGfx.lineStyle(2, 0x9c8936, 0.8);
        this.stageGfx.lineBetween(0, GROUND_Y - 10, GAME_WIDTH, GROUND_Y - 10);

        for (let y = GROUND_Y - 220; y < GROUND_Y - 30; y += 32) {
          midGfx.lineStyle(1, 0x607082, 0.5);
          midGfx.lineBetween(0, y, GAME_WIDTH, y);
        }
        for (let x = 0; x < GAME_WIDTH; x += 64) {
          midGfx.lineStyle(1, 0x607082, 0.35);
          midGfx.lineBetween(x, GROUND_Y - 230, x, GROUND_Y - 14);
        }
        midGfx.fillStyle(0x9aa8b2, 0.2);
        midGfx.fillRoundedRect(72, GROUND_Y - 182, 180, 42, 5);
        midGfx.fillRoundedRect(422, GROUND_Y - 162, 220, 36, 5);
        midGfx.fillRoundedRect(760, GROUND_Y - 192, 150, 38, 5);

        frontGfx.lineStyle(4, 0x1c1c1c, 0.9);
        frontGfx.lineBetween(0, GROUND_Y + 28, GAME_WIDTH, GROUND_Y + 28);
        frontGfx.lineBetween(0, GROUND_Y + 56, GAME_WIDTH, GROUND_Y + 56);
        for (let x = 18; x < GAME_WIDTH; x += 52) {
          frontGfx.lineBetween(x, GROUND_Y + 18, x + 16, GAME_HEIGHT);
        }

        this.createFluorescentLights([
          { x: 90, y: 60, w: 170 },
          { x: 410, y: 72, w: 210 },
          { x: 760, y: 58, w: 150 },
        ]);
        this.createDustMotes([
          { x: 120, y: 140, radius: 14 },
          { x: 340, y: 120, radius: 10 },
          { x: 560, y: 170, radius: 16 },
          { x: 760, y: 130, radius: 12 },
          { x: 930, y: 180, radius: 14 },
        ]);
        break;
    }
  }

  private updateClouds(time: number): void {
    for (let i = 0; i < this.ambientLayers.length; i++) {
      const gfx = this.ambientLayers[i];
      const type = gfx.getData("ambientType") as string;
      gfx.clear();

      if (type === "clouds" || type === "mist") {
        const layer = gfx.getData("ambientLayer") as {
          y: number;
          speed: number;
          shapes: { x: number; w: number; h: number }[];
          color: number;
          alpha: number;
        };
        gfx.fillStyle(layer.color, layer.alpha);
        for (const shape of layer.shapes) {
          const offsetX = (time * layer.speed) % (GAME_WIDTH + shape.w);
          const drawX =
            ((shape.x + offsetX) % (GAME_WIDTH + shape.w)) - shape.w;
          gfx.fillEllipse(drawX + shape.w / 2, layer.y, shape.w, shape.h);
        }
        continue;
      }

      if (type === "lantern") {
        const points = gfx.getData("points") as { x: number; y: number }[];
        const color = gfx.getData("color") as number;
        for (let p = 0; p < points.length; p++) {
          const point = points[p];
          const pulse = 0.15 + Math.sin(time * 0.003 + p * 1.2) * 0.1;
          gfx.fillStyle(color, pulse);
          gfx.fillCircle(point.x, point.y, 28);
          gfx.fillStyle(0xffcc44, pulse * 0.5);
          gfx.fillCircle(point.x, point.y, 42);
        }
        continue;
      }

      if (type === "water") {
        const rows = gfx.getData("rows") as number[];
        const color = gfx.getData("color") as number;
        for (let r = 0; r < rows.length; r++) {
          const y = rows[r];
          const alpha = 0.12 + Math.sin(time * 0.0025 + r) * 0.05;
          gfx.lineStyle(2, color, alpha);
          for (let x = 0; x < GAME_WIDTH; x += 24) {
            const wave = Math.sin(time * 0.004 + x * 0.025 + r) * 3;
            gfx.lineBetween(x, y + wave, x + 18, y + wave + 1);
          }
        }
        continue;
      }

      if (type === "neon") {
        const signs = gfx.getData("signs") as {
          x: number;
          y: number;
          w: number;
          h: number;
          color: number;
        }[];
        for (let s = 0; s < signs.length; s++) {
          const sign = signs[s];
          const pulse = 0.35 + Math.sin(time * 0.006 + s * 1.5) * 0.18;
          gfx.fillStyle(sign.color, pulse * 0.22);
          gfx.fillRoundedRect(
            sign.x - 8,
            sign.y - 8,
            sign.w + 16,
            sign.h + 16,
            8,
          );
          gfx.lineStyle(3, sign.color, 0.8);
          gfx.strokeRoundedRect(sign.x, sign.y, sign.w, sign.h, 6);
          gfx.fillStyle(sign.color, 0.25 + pulse * 0.12);
          gfx.fillRoundedRect(
            sign.x + 5,
            sign.y + 5,
            sign.w - 10,
            sign.h - 10,
            4,
          );
        }
        continue;
      }

      if (type === "fireflies") {
        const points = gfx.getData("points") as { x: number; y: number }[];
        for (let p = 0; p < points.length; p++) {
          const point = points[p];
          const driftX = Math.sin(time * 0.0016 + p * 1.7) * 16;
          const driftY = Math.cos(time * 0.0012 + p * 2.4) * 10;
          const alpha = 0.28 + Math.sin(time * 0.006 + p * 2.1) * 0.14;
          gfx.fillStyle(0xfff8a8, alpha);
          gfx.fillCircle(point.x + driftX, point.y + driftY, 3);
          gfx.fillStyle(0xf0ffcc, alpha * 0.4);
          gfx.fillCircle(point.x + driftX, point.y + driftY, 8);
        }
        continue;
      }

      if (type === "fluorescent") {
        const lights = gfx.getData("lights") as {
          x: number;
          y: number;
          w: number;
        }[];
        for (let l = 0; l < lights.length; l++) {
          const light = lights[l];
          const flicker =
            0.2 +
            Math.sin(time * 0.012 + l * 0.9) * 0.08 +
            Math.sin(time * 0.027 + l * 2.1) * 0.04;
          gfx.fillStyle(0xd7fff6, flicker);
          gfx.fillRoundedRect(light.x, light.y, light.w, 12, 5);
          gfx.fillStyle(0xb7ffff, flicker * 0.35);
          gfx.fillRoundedRect(light.x - 16, light.y + 4, light.w + 32, 28, 8);
        }
        continue;
      }

      if (type === "dust") {
        const motes = gfx.getData("motes") as {
          x: number;
          y: number;
          radius: number;
        }[];
        for (let m = 0; m < motes.length; m++) {
          const mote = motes[m];
          const offsetX = Math.sin(time * 0.0015 + m) * 14;
          const offsetY = Math.cos(time * 0.0011 + m * 1.8) * 6;
          gfx.fillStyle(0xdde8ef, 0.06);
          gfx.fillCircle(mote.x + offsetX, mote.y + offsetY, mote.radius);
        }
      }
    }
  }

  private drawVerticalGradient(
    gfx: Phaser.GameObjects.Graphics,
    topColor: number,
    bottomColor: number,
  ): void {
    const top = Phaser.Display.Color.IntegerToRGB(topColor);
    const bottom = Phaser.Display.Color.IntegerToRGB(bottomColor);
    for (let y = 0; y < GROUND_Y; y++) {
      const t = y / GROUND_Y;
      const r = Math.floor(Phaser.Math.Linear(top.r, bottom.r, t));
      const g = Math.floor(Phaser.Math.Linear(top.g, bottom.g, t));
      const b = Math.floor(Phaser.Math.Linear(top.b, bottom.b, t));
      gfx.fillStyle(Phaser.Display.Color.GetColor(r, g, b));
      gfx.fillRect(0, y, GAME_WIDTH, 1);
    }
  }

  private drawGround(
    gfx: Phaser.GameObjects.Graphics,
    groundColor: number,
    lineColor: number,
  ): void {
    gfx.fillStyle(groundColor);
    gfx.fillRect(0, GROUND_Y, GAME_WIDTH, GAME_HEIGHT - GROUND_Y);
    gfx.lineStyle(3, lineColor);
    gfx.lineBetween(0, GROUND_Y, GAME_WIDTH, GROUND_Y);
  }

  private createCloudLayer(
    y: number,
    speed: number,
    color: number,
    alpha: number,
    shapes: { x: number; w: number; h: number }[],
    depth = 1,
    type: "clouds" | "mist" = "clouds",
  ): void {
    const gfx = this.add.graphics().setDepth(depth);
    gfx.setData("ambientType", type);
    gfx.setData("ambientLayer", { y, speed, shapes, color, alpha });
    this.ambientLayers.push(gfx);
  }

  private createLanternGlows(xs: number[], y: number, color: number): void {
    const gfx = this.add.graphics().setDepth(1);
    gfx.setData("ambientType", "lantern");
    gfx.setData(
      "points",
      xs.map((x) => ({ x, y })),
    );
    gfx.setData("color", color);
    this.ambientLayers.push(gfx);
  }

  private createWaterShimmerLines(rows: number[], color: number): void {
    const gfx = this.add.graphics().setDepth(1);
    gfx.setData("ambientType", "water");
    gfx.setData("rows", rows);
    gfx.setData("color", color);
    this.ambientLayers.push(gfx);
  }

  private createNeonSigns(
    signs: { x: number; y: number; w: number; h: number; color: number }[],
  ): void {
    const gfx = this.add.graphics().setDepth(1);
    gfx.setData("ambientType", "neon");
    gfx.setData("signs", signs);
    this.ambientLayers.push(gfx);
  }

  private createFireflies(points: { x: number; y: number }[]): void {
    const gfx = this.add.graphics().setDepth(1);
    gfx.setData("ambientType", "fireflies");
    gfx.setData("points", points);
    this.ambientLayers.push(gfx);
  }

  private createFluorescentLights(
    lights: { x: number; y: number; w: number }[],
  ): void {
    const gfx = this.add.graphics().setDepth(1);
    gfx.setData("ambientType", "fluorescent");
    gfx.setData("lights", lights);
    this.ambientLayers.push(gfx);
  }

  private createDustMotes(
    motes: { x: number; y: number; radius: number }[],
  ): void {
    const gfx = this.add.graphics().setDepth(1);
    gfx.setData("ambientType", "dust");
    gfx.setData("motes", motes);
    this.ambientLayers.push(gfx);
  }

  private async loadCustomStageBackground(): Promise<void> {
    if (!this.customStageKey) return;

    const loadId = ++this.stageLoadId;
    try {
      const cached = await getCachedStageBackground(this.customStageKey);
      if (!this.isActiveStageLoad(loadId)) return;
      if (!cached) {
        console.warn(
          "[FightScene] Missing cached photo stage, keeping neutral arena shell",
        );
        return;
      }
      await this.applyStageBackground(cached.pngBlob, loadId);
    } catch (err: any) {
      if (!this.isActiveStageLoad(loadId)) return;
      console.warn(
        "[FightScene] Photo stage failed to load, keeping neutral arena shell:",
        err?.message || err,
      );
    }
  }

  private async loadAiStageBackground(): Promise<void> {
    if (this.stageId) return;

    const loadId = ++this.stageLoadId;
    const cacheScope = this.stageId ? "stage" : "matchup";

    try {
      const cached = await getCachedStageBackgroundForRequest({
        matchSeed: this.matchSeed,
        stageId: this.resolvedStageId,
        cacheScope,
      });
      if (!this.isActiveStageLoad(loadId)) return;

      if (cached) {
        await this.applyStageBackground(cached.pngBlob, loadId);
        return;
      }

      this.setStageLoadingText("SUMMONING ARENA...");
      const generated = await ensureStageBackground({
        matchSeed: this.matchSeed,
        stageId: this.resolvedStageId,
        cacheScope,
        fighterOneName: this.p1Name,
        fighterTwoName: this.p2Name,
        fighterOnePersonalityId: this.p1PersonalityId,
        fighterTwoPersonalityId: this.p2PersonalityId,
        fighterOnePhotoHash: this.p1PhotoHash,
        fighterTwoPhotoHash: this.p2PhotoHash,
      });

      if (!this.isActiveStageLoad(loadId)) return;
      await this.applyStageBackground(generated.pngBlob, loadId);
      this.setStageLoadingText("ARENA READY", 900);
    } catch (err: any) {
      if (!this.isActiveStageLoad(loadId)) return;
      console.warn(
        "[FightScene] AI stage background failed, keeping procedural stage:",
        err?.message || err,
      );
      this.clearStageLoadingText();
    }
  }

  private isActiveStageLoad(loadId: number): boolean {
    return loadId === this.stageLoadId && this.scene.isActive();
  }

  private async applyStageBackground(
    blob: Blob,
    loadId: number,
  ): Promise<void> {
    const img = await this.loadBlobImage(blob);
    if (!this.isActiveStageLoad(loadId)) return;

    const texKey = this.customStageKey
      ? `stage_bg_custom_${this.customStageKey.replace(/[^a-z0-9_-]/gi, "_")}`
      : `stage_bg_${this.resolvedStageId}_${(this.matchSeed >>> 0).toString(16)}`;
    if (
      this.stageBackdropTextureKey &&
      this.stageBackdropTextureKey !== texKey &&
      this.textures.exists(this.stageBackdropTextureKey)
    ) {
      this.textures.remove(this.stageBackdropTextureKey);
    }
    if (this.textures.exists(texKey)) {
      this.textures.remove(texKey);
    }
    this.textures.addImage(texKey, img);
    this.stageBackdropTextureKey = texKey;

    if (!this.stageBackdrop) {
      this.stageBackdrop = this.add
        .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, texKey)
        .setDepth(-2)
        .setOrigin(0.5);
    } else {
      this.stageBackdrop.setTexture(texKey);
    }

    const backdropHeight = this.customStageKey ? GAME_HEIGHT + 40 : GAME_HEIGHT;
    const backdropY = this.customStageKey
      ? GAME_HEIGHT / 2 - 20
      : GAME_HEIGHT / 2;
    this.stageBackdrop
      .setPosition(GAME_WIDTH / 2, backdropY)
      .setDisplaySize(GAME_WIDTH, backdropHeight);

    this.stageBackdrop.setAlpha(0);

    const visualAlphas = this.customStageKey
      ? [0.03, 0.16, 0.1]
      : [0.04, 0.12, 0.2];
    for (let i = 0; i < this.stageVisualLayers.length; i++) {
      const layer = this.stageVisualLayers[i];
      const targetAlpha = visualAlphas[i] ?? 0.75;
      this.tweens.add({
        targets: layer,
        alpha: targetAlpha,
        duration: 700,
        ease: "Sine.easeOut",
      });
    }

    for (const layer of this.ambientLayers) {
      this.tweens.add({
        targets: layer,
        alpha: this.customStageKey ? 0.2 : 0.5,
        duration: 700,
        ease: "Sine.easeOut",
      });
    }

    this.tweens.add({
      targets: this.stageBackdrop,
      alpha: 1,
      duration: 700,
      ease: "Sine.easeOut",
      onComplete: () => this.clearStageLoadingText(),
    });
  }

  private setStageLoadingText(text: string, autoHideMs = 0): void {
    if (!this.stageLoadingText) {
      this.stageLoadingText = this.add
        .text(GAME_WIDTH / 2, this.bottomOverlayY - 14, "", {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: "8px",
          color: "#88ddff",
          stroke: "#000000",
          strokeThickness: 2,
        })
        .setOrigin(0.5)
        .setDepth(120);
    }

    this.tweens.killTweensOf(this.stageLoadingText);
    this.stageLoadingText.setText(text).setAlpha(1);

    if (autoHideMs > 0) {
      this.time.delayedCall(autoHideMs, () => {
        if (this.stageLoadingText?.text === text) {
          this.clearStageLoadingText();
        }
      });
    }
  }

  private clearStageLoadingText(immediate = false): void {
    if (!this.stageLoadingText) return;
    this.tweens.killTweensOf(this.stageLoadingText);
    if (immediate) {
      this.stageLoadingText.destroy();
      this.stageLoadingText = undefined;
      return;
    }
    this.tweens.add({
      targets: this.stageLoadingText,
      alpha: 0,
      duration: 220,
      onComplete: () => {
        this.stageLoadingText?.destroy();
        this.stageLoadingText = undefined;
      },
    });
  }

  private loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      };
      img.src = url;
    });
  }

  private createFighters(): void {
    this.p1 = new Fighter(0, this.p1Name, "fighter_p1", 250, true);
    this.p2 = new Fighter(
      1,
      this.p2Name,
      "fighter_p2",
      GAME_WIDTH - 250,
      false,
    );

    this.p1.createSprite(this);
    this.p2.createSprite(this);
    this.p1.setRenderPresentation(
      this.fighterRenderScale,
      this.fighterRenderYOffset,
    );
    this.p2.setRenderPresentation(
      this.fighterRenderScale,
      this.fighterRenderYOffset,
    );
    this.p1.sprite.setDepth(10);
    this.p2.sprite.setDepth(10);
  }

  private createParticles(): void {
    this.hitSparks = this.add.particles(0, 0, "spark", {
      speed: { min: 100, max: 300 },
      angle: { min: 0, max: 360 },
      scale: { start: 1, end: 0 },
      lifespan: 300,
      gravityY: 200,
      emitting: false,
    });
    this.hitSparks.setDepth(50);
  }

  private shouldSkipIntro(): boolean {
    if (!this.introCanSkip) return false;
    return Boolean(
      (this.introEnterKey && Phaser.Input.Keyboard.JustDown(this.introEnterKey)) ||
      (this.introSpaceKey && Phaser.Input.Keyboard.JustDown(this.introSpaceKey)),
    );
  }

  private clearIntroEvents(): void {
    for (const event of this.introEvents) {
      event.remove(false);
    }
    this.introEvents = [];
  }

  private scheduleIntroEvent(delayMs: number, callback: () => void): void {
    const event = this.time.delayedCall(delayMs, callback);
    this.introEvents.push(event);
  }

  private destroyIntroOverlay(immediate = true): void {
    if (immediate) {
      this.clearIntroEvents();
      this.introCanSkip = false;
    }
    if (!this.introOverlay) {
      for (const texKey of this.introPortraitTextureKeys) {
        if (this.textures.exists(texKey)) this.textures.remove(texKey);
      }
      this.introPortraitTextureKeys = [];
      return;
    }

    const overlay = this.introOverlay;
    this.introOverlay = undefined;

    const cleanup = () => {
      overlay.destroy(true);
      for (const texKey of this.introPortraitTextureKeys) {
        if (this.textures.exists(texKey)) this.textures.remove(texKey);
      }
      this.introPortraitTextureKeys = [];
    };

    if (immediate) {
      cleanup();
      return;
    }

    this.tweens.add({
      targets: overlay,
      alpha: 0,
      duration: 220,
      ease: "Sine.easeInOut",
      onComplete: cleanup,
    });
  }

  private async renderIntroPortrait(blob: Blob, size: number): Promise<HTMLCanvasElement> {
    const img = await this.loadBlobImage(blob);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#081018";
    ctx.fillRect(0, 0, size, size);
    const inset = 8;
    const innerSize = size - inset * 2;
    const scale = Math.max(innerSize / img.width, innerSize / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const dx = Math.round((size - drawW) / 2);
    const dy = Math.round((size - drawH) / 2);
    ctx.drawImage(img, dx, dy, drawW, drawH);
    return canvas;
  }

  private async attachIntroPortrait(
    parent: Phaser.GameObjects.Container,
    photoHash: string | null,
    x: number,
    y: number,
    size: number,
  ): Promise<void> {
    if (!photoHash) return;
    const meta = await getCachedMeta(photoHash);
    if (!meta?.originalPhotoBlob || !this.introOverlay) return;
    const canvas = await this.renderIntroPortrait(meta.originalPhotoBlob, size);
    if (!this.introOverlay || parent.parentContainer !== this.introOverlay) return;

    const texKey = `fight_intro_portrait_${photoHash.slice(0, 12)}_${Date.now()}`;
    if (this.textures.exists(texKey)) this.textures.remove(texKey);
    this.textures.addCanvas(texKey, canvas);
    this.introPortraitTextureKeys.push(texKey);

    const image = this.add.image(x, y, texKey).setDepth(162);
    parent.add(image);
  }

  private createIntroCard(
    x: number,
    y: number,
    width: number,
    height: number,
    align: "left" | "right",
    name: string,
    tag: string,
    accent: string,
  ): Phaser.GameObjects.Container {
    const card = this.add.container(x, y).setDepth(161);
    const bg = this.add.graphics();
    bg.fillStyle(0x050811, 0.88);
    bg.fillRoundedRect(-width / 2, -height / 2, width, height, 12);
    bg.lineStyle(3, Phaser.Display.Color.HexStringToColor(accent).color, 0.85);
    bg.strokeRoundedRect(-width / 2, -height / 2, width, height, 12);
    bg.fillStyle(0xffffff, 0.08);
    bg.fillRect(-width / 2, -height / 2, width, 34);
    card.add(bg);

    const portraitOffset = align === "left" ? -width / 2 + 62 : width / 2 - 62;
    const portraitFrame = this.add.graphics();
    portraitFrame.fillStyle(0x0b1020, 0.95);
    portraitFrame.fillRoundedRect(portraitOffset - 46, -46, 92, 92, 10);
    portraitFrame.lineStyle(2, 0xffffff, 0.4);
    portraitFrame.strokeRoundedRect(portraitOffset - 46, -46, 92, 92, 10);
    card.add(portraitFrame);

    const textX = align === "left" ? -20 : 20;
    const originX = align === "left" ? 0 : 1;
    const nameText = this.add.text(textX, -34, name.toUpperCase(), {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: "13px",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
      align,
      wordWrap: { width: 160 },
    }).setOrigin(originX, 0.5);
    const tagText = this.add.text(textX, 8, tag, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: "8px",
      color: accent,
      stroke: "#000000",
      strokeThickness: 3,
      align,
      wordWrap: { width: 170 },
    }).setOrigin(originX, 0.5);
    card.add([nameText, tagText]);

    return card;
  }

  private finishCinematicIntro(showFightAnnouncement: boolean): void {
    this.cinematicIntroActive = false;
    this.introCanSkip = false;
    this.clearIntroEvents();
    this.destroyIntroOverlay(true);

    const cam = this.cameras.main;
    cam.stopFollow();
    cam.setZoom(1);
    cam.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);

    this.p1.x = 250;
    this.p2.x = GAME_WIDTH - 250;
    this.p1.forceState(FighterState.IDLE);
    this.p2.forceState(FighterState.IDLE);
    this.p1.syncSprite(this.p2.x);
    this.p2.syncSprite(this.p1.x);

    if (showFightAnnouncement) {
      this.hud.showAnnouncement("FIGHT!", 800);
      this.sound_mgr.playAnnounce("fight");
    }

    this.phaseTimer = 0;
    this.phase = RoundPhase.FIGHTING;
  }

  private playMatchIntro(roundNum: number): void {
    this.cinematicIntroActive = true;
    this.introCanSkip = false;
    this.destroyIntroOverlay(true);
    this.phaseTimer = 150;

    const cam = this.cameras.main;
    cam.stopFollow();
    cam.setZoom(1.03);
    cam.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);

    this.p1.x = 250;
    this.p2.x = GAME_WIDTH - 250;
    this.p1.forceState(FighterState.IDLE);
    this.p2.forceState(FighterState.IDLE);

    const overlay = this.add.container(0, 0).setDepth(160).setAlpha(1);
    this.introOverlay = overlay;

    const dimmer = this.add.rectangle(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      GAME_WIDTH,
      GAME_HEIGHT,
      0x000000,
      0.28,
    ).setDepth(160);
    overlay.add(dimmer);

    const stageText = this.add.text(GAME_WIDTH / 2, 76, this.stageDisplayLabel, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: "12px",
      color: "#ffdd66",
      stroke: "#000000",
      strokeThickness: 4,
      align: "center",
    }).setOrigin(0.5).setDepth(161);
    const matchText = this.add.text(GAME_WIDTH / 2, 102, this.matchLabel, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: "7px",
      color: "#b9d8ff",
      stroke: "#000000",
      strokeThickness: 3,
      align: "center",
    }).setOrigin(0.5).setDepth(161);
    const vsText = this.add.text(GAME_WIDTH / 2, 314, "VS", {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: "30px",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 5,
    }).setOrigin(0.5).setDepth(162);
    const skipText = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 34, "ENTER / SPACE: SKIP", {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: "7px",
      color: "#9ad6ff",
      stroke: "#000000",
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(161);
    overlay.add([stageText, matchText, vsText, skipText]);

    const leftCard = this.createIntroCard(
      -170,
      320,
      260,
      126,
      "left",
      this.p1Name,
      this.p1DisplayTag || "CHALLENGER",
      "#ff6b6b",
    );
    const rightCard = this.createIntroCard(
      GAME_WIDTH + 170,
      320,
      260,
      126,
      "right",
      this.p2Name,
      this.p2DisplayTag || (this.isVsAI ? "CPU" : "RIVAL"),
      "#66ccff",
    );
    overlay.add([leftCard, rightCard]);

    void this.attachIntroPortrait(leftCard, this.p1PhotoHash, -68, 0, 84);
    void this.attachIntroPortrait(rightCard, this.p2PhotoHash, 68, 0, 84);

    this.tweens.add({
      targets: leftCard,
      x: 188,
      duration: 500,
      ease: "Cubic.easeOut",
    });
    this.tweens.add({
      targets: rightCard,
      x: GAME_WIDTH - 188,
      duration: 500,
      ease: "Cubic.easeOut",
    });
    this.tweens.add({
      targets: [stageText, matchText, vsText],
      alpha: { from: 0, to: 1 },
      y: "-=10",
      duration: 360,
      ease: "Sine.easeOut",
    });
    this.tweens.add({
      targets: cam,
      zoom: 1,
      duration: 900,
      ease: "Sine.easeInOut",
    });

    this.scheduleIntroEvent(420, () => {
      this.introCanSkip = true;
    });
    this.scheduleIntroEvent(760, () => {
      if (this.phase !== RoundPhase.INTRO) return;
      this.hud.showAnnouncement(`ROUND ${roundNum}`, 1200);
      this.sound_mgr.playAnnounce("round");
    });
    this.scheduleIntroEvent(1750, () => {
      if (this.phase !== RoundPhase.INTRO) return;
      this.hud.showAnnouncement("FIGHT!", 800);
      this.sound_mgr.playAnnounce("fight");
    });
    this.scheduleIntroEvent(1900, () => {
      if (this.phase !== RoundPhase.INTRO) return;
      this.destroyIntroOverlay(false);
    });
  }

  private skipCinematicIntro(): void {
    if (!this.cinematicIntroActive) return;
    this.finishCinematicIntro(true);
  }

  private startRound(): void {
    this.phase = RoundPhase.INTRO;
    this.phaseTimer = 120;
    this.roundTimer = ROUND_TIME;
    this.frameCount = 0;
    this.cinematicIntroActive = false;
    this.introCanSkip = false;
    this.destroyIntroOverlay(true);

    const cam = this.cameras.main;
    cam.stopFollow();
    cam.setZoom(1);
    cam.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);

    for (const proj of this.projectiles) proj.destroy();
    this.projectiles = [];

    this.p1.health = MAX_HEALTH;
    this.p2.health = MAX_HEALTH;
    this.p1.x = 250;
    this.p2.x = GAME_WIDTH - 250;
    this.p1.y = GROUND_Y;
    this.p2.y = GROUND_Y;
    this.p1.vx = 0;
    this.p2.vx = 0;
    this.p1.vy = 0;
    this.p2.vy = 0;
    this.p1.forceState(FighterState.IDLE);
    this.p2.forceState(FighterState.IDLE);
    this.p1.stunFrames = 0;
    this.p2.stunFrames = 0;
    this.p1.comboCount = 0;
    this.p2.comboCount = 0;

    const roundNum = this.p1Wins + this.p2Wins + 1;
    if (!this.introHasPlayed && roundNum === 1) {
      this.introHasPlayed = true;
      this.playMatchIntro(roundNum);
      return;
    }

    this.hud.showAnnouncement(`ROUND ${roundNum}`, 1200);
    this.sound_mgr.playAnnounce("round");
    this.time.delayedCall(1300, () => {
      if (this.phase === RoundPhase.INTRO) {
        this.hud.showAnnouncement("FIGHT!", 800);
        this.sound_mgr.playAnnounce("fight");
      }
    });
  }

  update(time: number, delta: number): void {
    if (!this.ready) return;

    if (this.phase === RoundPhase.INTRO) {
      if (this.cinematicIntroActive && this.shouldSkipIntro()) {
        this.skipCinematicIntro();
      }
      this.phaseTimer--;
      if (this.phaseTimer <= 0) {
        if (this.cinematicIntroActive) {
          this.finishCinematicIntro(false);
        } else {
          this.phase = RoundPhase.FIGHTING;
        }
      }
      this.p1.syncSprite(this.p2.x);
      this.p2.syncSprite(this.p1.x);
      return;
    }

    if (
      this.phase === RoundPhase.ROUND_END ||
      this.phase === RoundPhase.MATCH_END
    ) {
      this.phaseTimer--;
      this.updateRoundEndPresentation(delta);
      this.p1.syncSprite(this.p2.x);
      this.p2.syncSprite(this.p1.x);

      if (this.phaseTimer <= 0) {
        if (this.phase === RoundPhase.MATCH_END) {
          if (!this.waitingForMatchInput) {
            this.showMatchOverUI();
          }
          return;
        }
        this.startRound();
      }
      return;
    }

    // Fixed timestep accumulator for determinism
    this.accumulator += delta;
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.fixedUpdate();
      this.accumulator -= FIXED_TIMESTEP;
    }

    this.updateClouds(time);

    this.p1.syncSprite(this.p2.x);
    this.p2.syncSprite(this.p1.x);
    this.hud.update(this.p1.health, this.p2.health, this.roundTimer);
  }

  private updateRoundEndPresentation(delta: number): void {
    const dt = Math.min(delta, FIXED_TIMESTEP * 2) / 1000;
    this.advanceFighterPresentation(this.p1, this.p2.x, dt);
    this.advanceFighterPresentation(this.p2, this.p1.x, dt);
  }

  private advanceFighterPresentation(
    fighter: Fighter,
    opponentX: number,
    dt: number,
  ): void {
    if (Math.abs(opponentX - fighter.x) > 4) {
      fighter.facingRight = opponentX > fighter.x;
    }

    fighter.stateFrame++;

    if (fighter.state === FighterState.KNOCKDOWN) {
      fighter.applyPhysics(dt);
      if (
        fighter.health <= 0 &&
        fighter.isGrounded() &&
        fighter.stateFrame >= 30
      ) {
        fighter.forceState(FighterState.DEFEAT);
      }
    }
  }

  private fixedUpdate(): void {
    this.frameCount++;
    const dt = FIXED_TIMESTEP / 1000;

    // Timer
    this.roundTimer -= dt;
    if (this.roundTimer <= 0) {
      this.roundTimer = 0;
      this.endRound();
      return;
    }

    // Read inputs
    const p1Input = this.cpuVsCpu
      ? this.ai2.getInput(this.p1, this.p2)
      : this.inputMgr.readPlayer1();
    const p2Input = this.isVsAI
      ? this.ai.getInput(this.p2, this.p1)
      : this.inputMgr.readPlayer2();

    // Update fighters
    this.p1.update(dt, p1Input, this.p2.x);
    this.p2.update(dt, p2Input, this.p1.x);

    // Spawn fireballs at release frame
    this.checkFireballSpawn(this.p1);
    this.checkFireballSpawn(this.p2);

    // Update projectiles
    this.updateProjectiles(dt);

    // Resolve combat
    const events = this.combat.resolve(this.p1, this.p2);
    for (const evt of events) {
      this.onHit(evt);
    }

    // Check KO
    if (this.p1.health <= 0 || this.p2.health <= 0) {
      this.endRound();
    }
  }

  private checkFireballSpawn(fighter: Fighter): void {
    if (fighter.state !== FighterState.FIREBALL) return;
    const startup = ATTACKS[FighterState.FIREBALL].startup;
    if (fighter.stateFrame !== startup) return;

    const spawnX =
      fighter.x +
      (fighter.facingRight ? fighter.getBodyWidth() : -fighter.getBodyWidth());
    const spawnY = fighter.getRenderY() - fighter.getBodyHeight() * 0.56;
    const proj = new Projectile(
      this,
      spawnX,
      spawnY,
      fighter.facingRight,
      fighter.playerIndex,
      false,
    );
    this.projectiles.push(proj);
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      proj.update(dt);

      if (!proj.active) {
        this.projectiles.splice(i, 1);
        continue;
      }

      const defender = proj.ownerIndex === 0 ? this.p2 : this.p1;
      const hurtbox = defender.getHurtbox();
      const pHitbox = proj.getHitbox();

      if (this.aabbOverlap(pHitbox, hurtbox)) {
        const isBlocking =
          (defender.state === FighterState.WALK_BACKWARD ||
            defender.state === FighterState.CROUCH ||
            defender.state === FighterState.BLOCK) &&
          defender.isGrounded();

        const fakeAtk = {
          damage: proj.damage,
          hitStunFrames: 20,
          blockStunFrames: 10,
          pushback: 120,
          startup: 0,
          active: 0,
          recovery: 0,
          hitbox: { x: 0, y: 0, width: 0, height: 0 },
        };

        defender.takeDamage(fakeAtk, isBlocking);

        this.hitSparks.emitParticleAt(
          defender.x + (defender.facingRight ? -20 : 20),
          defender.getRenderY() - 80,
          isBlocking ? 5 : 12,
        );

        const dmgColor = isBlocking ? "#999999" : "#ff8844";
        const actualDmg = isBlocking
          ? Math.floor(proj.damage * 0.1)
          : proj.damage;
        const dmgText = this.add
          .text(
            defender.x + (defender.facingRight ? -10 : 10),
            defender.getRenderY() - 100,
            actualDmg.toString(),
            {
              fontFamily: '"Press Start 2P", monospace',
              fontSize: "12px",
              color: dmgColor,
              stroke: "#000000",
              strokeThickness: 3,
            },
          )
          .setOrigin(0.5)
          .setDepth(105);

        this.tweens.add({
          targets: dmgText,
          y: dmgText.y - 50,
          alpha: 0,
          duration: 800,
          ease: "Cubic.easeOut",
          onComplete: () => dmgText.destroy(),
        });

        proj.destroy();
        this.projectiles.splice(i, 1);

        if (defender.health <= 0) {
          this.endRound();
          return;
        }
      }
    }
  }

  private aabbOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  private onHit(event: HitEvent): void {
    const defender = event.defender === 0 ? this.p1 : this.p2;
    const attacker = event.attacker === 0 ? this.p1 : this.p2;

    // Sound
    if (event.blocked) {
      this.sound_mgr.playBlock();
    } else {
      this.sound_mgr.playHit(event.damage > 50);
    }

    // Hit freeze + screen effects for unblocked hits
    if (!event.blocked) {
      const freezeDuration = event.damage > 50 ? 100 : 60;
      ScreenEffects.slowMotion(this, freezeDuration, 0.05);

      if (event.damage > 50) {
        ScreenEffects.flashRed(this, 150);
      } else {
        ScreenEffects.flashWhite(this, 60);
      }
    }

    // Sparks
    this.hitSparks.emitParticleAt(
      defender.x + (defender.facingRight ? -20 : 20),
      defender.getRenderY() - 80,
      event.blocked ? 5 : 12,
    );

    // Combo counter
    if (!event.blocked && defender.comboCount >= 2) {
      this.hud.showCombo(
        attacker.x,
        attacker.getRenderY(),
        defender.comboCount,
        attacker.playerIndex,
      );
    }

    // Floating damage number
    const dmgColor = event.blocked ? "#999999" : "#ff4444";
    const dmgText = this.add
      .text(
        defender.x + (defender.facingRight ? -10 : 10),
        defender.getRenderY() - 100,
        event.damage.toString(),
        {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: "12px",
          color: dmgColor,
          stroke: "#000000",
          strokeThickness: 3,
        },
      )
      .setOrigin(0.5)
      .setDepth(105);

    this.tweens.add({
      targets: dmgText,
      y: dmgText.y - 50,
      alpha: 0,
      duration: 800,
      ease: "Cubic.easeOut",
      onComplete: () => dmgText.destroy(),
    });
  }

  private endRound(): void {
    if (this.phase !== RoundPhase.FIGHTING) return;

    this.phase = RoundPhase.ROUND_END;
    this.phaseTimer = 180; // 3 seconds
    this.accumulator = 0;

    let winner: Fighter;
    if (this.p1.health <= 0 && this.p2.health <= 0) {
      this.hud.showAnnouncement("DOUBLE K.O.!", 2500);
      this.sound_mgr.playKO();
      this.sound_mgr.playAnnounce("ko");
      this.p1.syncSprite(this.p2.x);
      this.p2.syncSprite(this.p1.x);
      return;
    } else if (this.p1.health > this.p2.health) {
      winner = this.p1;
      this.p1Wins++;
    } else {
      winner = this.p2;
      this.p2Wins++;
    }

    const loser = winner === this.p1 ? this.p2 : this.p1;

    winner.forceState(FighterState.VICTORY);
    if (loser.health <= 0) {
      if (loser.state !== FighterState.KNOCKDOWN) {
        loser.forceState(FighterState.KNOCKDOWN);
      }
      this.hud.showAnnouncement("K.O.!", 2000);
      this.sound_mgr.playKO();
      this.sound_mgr.playAnnounce("ko");
      ScreenEffects.flashWhite(this, 200);
    } else {
      loser.forceState(FighterState.DEFEAT);
    }

    this.hud.updateRoundWins(this.p1Wins, this.p2Wins);

    if (this.p1Wins >= ROUNDS_TO_WIN || this.p2Wins >= ROUNDS_TO_WIN) {
      this.phase = RoundPhase.MATCH_END;
      this.phaseTimer = 300; // 5 seconds
      this.time.delayedCall(2200, () => {
        this.hud.showAnnouncement(`${winner.name.toUpperCase()} WINS!`, 0);
        this.sound_mgr.playAnnounce("wins");
      });
    }
  }

  private showMatchOverUI(): void {
    this.waitingForMatchInput = true;

    this.matchOverUI = this.add
      .text(
        GAME_WIDTH / 2,
        this.bottomOverlayY,
        "ENTER: RUN IT BACK  /  R: REMIX  /  ESC: MENU",
        {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: "11px",
          color: "#ffcc00",
          stroke: "#000000",
          strokeThickness: 3,
        },
      )
      .setOrigin(0.5)
      .setDepth(200);

    this.tweens.add({
      targets: this.matchOverUI,
      alpha: { from: 1, to: 0.3 },
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    const enterKey = this.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.ENTER,
    );
    const escKey = this.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.ESC,
    );
    const remixKey = this.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.R,
    );

    enterKey.once("down", () => {
      remixKey.removeAllListeners();
      escKey.removeAllListeners();
      this.restartMatch(this.remix);
    });

    remixKey.once("down", () => {
      enterKey.removeAllListeners();
      escKey.removeAllListeners();
      this.restartMatch(this.remix + 1);
    });

    escKey.once("down", () => {
      enterKey.removeAllListeners();
      remixKey.removeAllListeners();
      this.cleanupMatchOverUI();
      this.cameras.main.fadeOut(500, 0, 0, 0);
      this.cameras.main.once("camerafadeoutcomplete", () => {
        this.scene.start("TitleScene");
      });
    });
  }

  private restartMatch(remix: number): void {
    this.cleanupMatchOverUI();
    this.cameras.main.flash(200, 255, 255, 255);
    this.time.delayedCall(200, () => {
      this.scene.restart({
        vsAI: this.isVsAI,
        cpuVsCpu: this.cpuVsCpu,
        p1PhotoHash: this.p1PhotoHash ?? undefined,
        p2PhotoHash: this.p2PhotoHash ?? undefined,
        p1Name: this.p1Name,
        p2Name: this.p2Name,
        p1PersonalityId: this.p1PersonalityId,
        p2PersonalityId: this.p2PersonalityId,
        stageId: this.stageId ?? undefined,
        customStageKey: this.customStageKey ?? undefined,
        customStageLabel: this.customStageLabel ?? undefined,
        remix,
      });
    });
  }

  private cleanupMatchOverUI(): void {
    if (this.matchOverUI) {
      this.tweens.killTweensOf(this.matchOverUI);
      this.matchOverUI.destroy();
      this.matchOverUI = undefined;
    }
  }

  shutdown(): void {
    this.clearStageLoadingText(true);
    this.stageBackdrop?.destroy();
    this.stageBackdrop = undefined;
    if (
      this.stageBackdropTextureKey &&
      this.textures.exists(this.stageBackdropTextureKey)
    ) {
      this.textures.remove(this.stageBackdropTextureKey);
      this.stageBackdropTextureKey = undefined;
    }
  }

  destroy(): void {
    this.shutdown();
  }
}
