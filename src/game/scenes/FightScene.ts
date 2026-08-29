import Phaser from "phaser";
import type { Fighter } from "../fighters/Fighter.ts";
import { FighterView } from "../fighters/FighterView.ts";
import { ProjectileViewPool } from "../fighters/ProjectileView.ts";
import { METER_MAX } from "../systems/Meter.ts";
import { InputManager } from "../systems/InputManager.ts";
import { SoundManager } from "../systems/SoundManager.ts";
import { HUD } from "../ui/HUD.ts";
import { ScreenEffects } from "../effects/ScreenEffects.ts";
import {
  MatchSimulation,
  RoundPhase,
  type MatchSimEvent,
} from "../sim/MatchSimulation.ts";
import { MatchRecorder, type MatchRecording } from "../sim/MatchReplay.ts";
import { RollbackSession } from "../net/RollbackSession.ts";
import {
  endActiveOnlineSession,
  getActiveOnlineSession,
  isOnlineControlMessage,
  type OnlineMatchSession,
} from "../net/onlineSession.ts";
import type { PeerTransportState } from "../net/PeerTransport.ts";
import {
  ensureStageBackground,
  getCachedStageBackgroundForRequest,
} from "../../services/StageBackgroundService.ts";
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  GROUND_Y,
  FIXED_TIMESTEP,
  ROUNDS_TO_WIN,
  MAX_HEALTH,
  FighterState,
} from "../constants.ts";
import { loadAiSprites } from "../sprites/AiSpriteLoader.ts";
import { getCachedIntro, getCachedStageBackground } from "../../services/SpriteCache.ts";
import {
  ANNOUNCE_EVENT,
  buildMatchSeed,
  getDefaultPersonalityId,
  getFighterPersonality,
  getMatchLabel,
  matchRestartFormat,
  resolveMatchRoundsToWin,
  shouldCaptureMatchIntroKeys,
  HUD_STATE_EVENT,
  INTRO_STATE_EVENT,
  MATCH_ACTION_EVENT,
  MATCH_ACTIONS_VISIBILITY_EVENT,
  MATCH_COMPLETE_EVENT,
  NET_STATE_EVENT,
  type AnnounceDetail,
  type NetStateDetail,
  type OnlineMatchInfo,
  type FighterPersonalityId,
  type HudStateDetail,
  type MatchAction,
  type MatchCompletionDetail,
  type MatchExperience,
  type MatchRestartFormat,
  type MatchSceneData,
} from "../match/MatchConfig.ts";
import {
  getStageTheme,
  pickStageThemeIdFromSeed,
  type StageThemeId,
} from "../match/StageConfig.ts";
import { debugInfo, debugWarn } from "../../services/DebugLog.ts";
import { resetVirtualInput } from "../systems/VirtualInput.ts";

/**
 * Upper bound on simulation ticks run in one render frame. A backgrounded tab
 * returns with a huge delta; instead of spiralling to catch up, the scene
 * drops the excess time.
 */
const MAX_TICKS_PER_FRAME = 5;

function getSignatureStageTextureKey(stageId: StageThemeId): string {
  return `stage_signature_${stageId}`;
}

export class FightScene extends Phaser.Scene {
  /**
   * The whole match state lives in the headless simulation; this scene only
   * samples inputs, steps it on a fixed 60 Hz tick, and renders its state
   * and events. Nothing here may mutate `sim` outside `sim.step()` /
   * `sim.requestIntroSkip()`, or two netplay peers would drift apart.
   */
  private sim!: MatchSimulation;
  /**
   * Every tick fed to the sim, plus periodic checksums. Exposed as
   * `window.__ASF_MATCH_RECORDING__()` so a match can be dumped and replayed
   * headlessly (`replayMatch`) — the desync harness for netplay.
   */
  private recorder!: MatchRecorder;
  /**
   * Online versus: the sim is driven through rollback netcode instead of
   * being stepped directly. `online` mirrors `MatchSceneData.online`.
   */
  private online: OnlineMatchInfo | null = null;
  private onlineSession: OnlineMatchSession | null = null;
  private rollback: RollbackSession | null = null;
  private onlineUnsubscribe: Array<() => void> = [];
  private lastNetState: NetStateDetail | null = null;
  private netStateFrame = 0;
  private opponentLeft = false;
  private opponentLeftAt = 0;
  private p1View!: FighterView;
  private p2View!: FighterView;
  private projectileViews!: ProjectileViewPool;
  private inputMgr!: InputManager;
  private hud!: HUD;
  private sound_mgr!: SoundManager;

  private accumulator = 0;
  private isVsAI = true;
  private cpuVsCpu = false;
  private experience: MatchExperience = "standard";
  private roundsToWin = ROUNDS_TO_WIN;
  private restartFormat: MatchRestartFormat = {};

  private hitSparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private stageGfx!: Phaser.GameObjects.Graphics;
  private stageBackdrop?: Phaser.GameObjects.Image;
  private stageBackdropTextureKey?: string;
  private stageVisualLayers: Phaser.GameObjects.Graphics[] = [];
  private ambientLayers: Phaser.GameObjects.Graphics[] = [];
  private stageLoadId = 0;

  private matchActionKeys: Phaser.Input.Keyboard.Key[] = [];
  private matchActionsVisible = false;
  private matchActionCommitted = false;
  private waitingForMatchInput = false;
  private p1PhotoHash: string | null = null;
  private p2PhotoHash: string | null = null;
  private p1CloudFighterId: string | null = null;
  private p2CloudFighterId: string | null = null;
  private p1Name = "Player 1";
  private p2Name = "CPU";
  private p1PersonalityId: FighterPersonalityId = getDefaultPersonalityId(0);
  private p2PersonalityId: FighterPersonalityId = getDefaultPersonalityId(1);
  private stageId: StageThemeId | null = null;
  private customStageKey: string | null = null;
  private customStageLabel: string | null = null;
  private resolvedStageId: StageThemeId = "insert-player-arena";
  private matchSeed = 1;
  private explicitSeed: number | undefined;
  private remix = 0;
  private p2Difficulty: number | null = null;
  private uiCam: Phaser.Cameras.Scene2D.Camera | null = null;
  private lastHudState: HudStateDetail | null = null;
  private uiObjects = new Set<Phaser.GameObjects.GameObject>();
  private stageFloorY = GROUND_Y;
  private fighterRenderScale = 1;
  private fighterRenderYOffset = 0;
  private ready = false;
  private matchLabel = "";
  private stageDisplayLabel = "";
  private p1DisplayTag = "";
  private p2DisplayTag = "";
  private cinematicIntroActive = false;
  /** The "FIGHT" cue already fired this intro; a late skip must not repeat it. */
  private fightCueFired = false;
  /** Sim is paused while the round-1 intro video/clip loading runs. */
  private introHold = false;
  private introRoundNumber = 1;
  private introEnterKey?: Phaser.Input.Keyboard.Key;
  private introSpaceKey?: Phaser.Input.Keyboard.Key;
  private introVideoSequenceActive = false;
  private introVideoSequenceToken = 0;
  private introVideoOverlayEl?: HTMLDivElement;
  private introVideoEl?: HTMLVideoElement;
  private introVideoUrl?: string;
  private matchStartedAt = 0;
  private matchReported = false;
  private sceneLifecycleEpoch = 0;
  private sceneLifecycleActive = false;

  private get p1(): Fighter {
    return this.sim.p1;
  }

  private get p2(): Fighter {
    return this.sim.p2;
  }

  constructor() {
    super({ key: "FightScene" });
  }

  init(data: MatchSceneData): void {
    this.restartFormat = matchRestartFormat(data);
    this.experience = data.experience === "trial" ? "trial" : "standard";
    this.roundsToWin = resolveMatchRoundsToWin(
      data.roundsToWin,
      this.experience === "trial" ? 1 : ROUNDS_TO_WIN,
    );
    this.cpuVsCpu = data.cpuVsCpu === true;
    this.isVsAI = data.vsAI !== false || this.cpuVsCpu;
    this.p1PhotoHash = data.p1PhotoHash ?? null;
    this.p2PhotoHash = data.p2PhotoHash ?? null;
    this.p1CloudFighterId = data.p1CloudFighterId ?? null;
    this.p2CloudFighterId = data.p2CloudFighterId ?? null;
    this.p1Name = data.p1Name ?? (this.cpuVsCpu ? "CPU 1" : "Player 1");
    this.p2Name = data.p2Name ?? (this.isVsAI ? "CPU" : "Player 2");
    this.p1PersonalityId = data.p1PersonalityId ?? getDefaultPersonalityId(0);
    this.p2PersonalityId = data.p2PersonalityId ?? getDefaultPersonalityId(1);
    this.stageId = data.stageId ?? null;
    this.customStageKey = data.customStageKey ?? null;
    this.customStageLabel = data.customStageLabel ?? null;
    this.remix = data.remix ?? 0;
    this.p2Difficulty = data.p2Difficulty ?? null;
    this.explicitSeed = data.seed;
    this.online = data.online ?? null;
    this.opponentLeft = false;
    this.lastNetState = null;
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
      seed: this.explicitSeed,
    });
    this.accumulator = 0;
    this.waitingForMatchInput = false;
    this.matchActionCommitted = false;
    this.ready = false;
    this.matchLabel = "";
    this.stageDisplayLabel = "";
    this.p1DisplayTag = "";
    this.p2DisplayTag = "";
    this.cinematicIntroActive = false;
    this.introHold = false;
    this.matchStartedAt = Date.now();
    this.matchReported = false;
  }

  preload(): void {
    if (!this.stageId || this.customStageKey) return;
    const stageTheme = getStageTheme(this.stageId);
    if (!stageTheme.assetPath) return;

    const textureKey = getSignatureStageTextureKey(stageTheme.id);
    if (!this.textures.exists(textureKey)) {
      this.load.image(textureKey, stageTheme.assetPath);
    }
  }

  async create(): Promise<void> {
    const lifecycleEpoch = this.beginSceneLifecycle();
    window.removeEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.addEventListener(MATCH_ACTION_EVENT, this.onMatchAction);

    if (this.customStageKey) {
      this.stageFloorY = GROUND_Y + 18;
      this.fighterRenderScale = 1.2;
      this.fighterRenderYOffset = this.stageFloorY - GROUND_Y;
    } else {
      this.stageFloorY = GROUND_Y;
      this.fighterRenderScale = 1.03;
      this.fighterRenderYOffset = 0;
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

    this.inputMgr = new InputManager(this);
    this.sound_mgr = new SoundManager();
    const keyboard = this.input.keyboard;
    const introKeys = [
      Phaser.Input.Keyboard.KeyCodes.ENTER,
      Phaser.Input.Keyboard.KeyCodes.SPACE,
    ];
    const captureIntroKeys = shouldCaptureMatchIntroKeys(this.experience);
    this.introEnterKey = keyboard?.addKey(introKeys[0], captureIntroKeys);
    this.introSpaceKey = keyboard?.addKey(introKeys[1], captureIntroKeys);
    if (captureIntroKeys) keyboard?.addCapture(introKeys);
    else keyboard?.removeCapture(introKeys);

    await this.loadAiSpritesIfNeeded(lifecycleEpoch);
    if (!this.isCurrentSceneLifecycle(lifecycleEpoch)) return;

    this.drawStage();
    if (this.customStageKey) {
      void this.loadCustomStageBackground();
    } else if (!this.stageId) {
      void this.loadAiStageBackground();
    }
    const simConfig = {
      seed: this.matchSeed,
      vsAI: this.isVsAI,
      cpuVsCpu: this.cpuVsCpu,
      p1Name: this.p1Name,
      p2Name: this.p2Name,
      roundsToWin: this.roundsToWin,
      p1Personality,
      p2Personality,
      p2Difficulty: this.p2Difficulty ?? 1,
    };
    this.sim = new MatchSimulation(simConfig);
    this.recorder = new MatchRecorder(simConfig);
    this.installRecordingHook();
    if (this.online && !this.attachOnlineSession(this.online)) {
      // No live transport (hard reload at /fight, expired room): bail out.
      debugWarn("[FightScene] Online match has no live session; returning to menu");
      this.exitToMenu();
      return;
    }
    this.createFighters();

    this.hud = new HUD(this);

    this.createParticles();
    const crt = ScreenEffects.createCRTOverlay(this);

    // Split rendering into a world camera (zooms/shakes) and a UI camera
    // (HUD/overlays, never scales). Everything created up to this point is
    // world unless registered as UI; runtime spawns use markWorld/markUi.
    this.uiObjects.add(crt);
    this.hud.onRuntimeObject = (obj) => this.markUi(obj);
    this.uiCam = this.cameras.add(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.cameras.main.setBounds(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.cameras.main.ignore([...this.uiObjects]);
    this.uiCam.ignore(this.children.list.filter((obj) => !this.uiObjects.has(obj)));

    this.ready = true;
    this.handleSimEvents(this.sim.start());
    this.syncViews();
    this.emitHudState();
  }

  private async loadAiSpritesIfNeeded(lifecycleEpoch: number): Promise<void> {
    const loads: Promise<void>[] = [];
    const isCurrent = () => this.isCurrentSceneLifecycle(lifecycleEpoch);

    if (this.p1PhotoHash) {
      loads.push(
        loadAiSprites(this, "fighter_p1", this.p1PhotoHash, isCurrent).then((ok) => {
          if (!isCurrent()) return;
          if (ok) debugInfo("Loaded AI sprites for P1");
          else debugWarn("No AI sprites found for P1, using procedural");
        }),
      );
    }

    if (this.p2PhotoHash) {
      loads.push(
        loadAiSprites(this, "fighter_p2", this.p2PhotoHash, isCurrent).then((ok) => {
          if (!isCurrent()) return;
          if (ok) debugInfo("Loaded AI sprites for P2");
          else debugWarn("No AI sprites found for P2, using procedural");
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

    const stageTheme = getStageTheme(this.resolvedStageId);
    if (stageTheme.assetPath) {
      const textureKey = getSignatureStageTextureKey(stageTheme.id);
      if (this.textures.exists(textureKey)) {
        this.stageBackdrop = this.add
          .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, textureKey)
          .setDepth(-2)
          .setOrigin(0.5)
          .setDisplaySize(GAME_WIDTH, GAME_HEIGHT);
      } else {
        debugWarn(
          `[FightScene] Missing signature stage texture for ${stageTheme.id}, keeping neutral arena shell`,
        );
        this.drawVerticalGradient(this.stageGfx, 0x09111b, 0x162131);
        this.drawGround(this.stageGfx, 0x102030, 0x60758d);
      }
      return;
    }

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
        debugWarn(
          "[FightScene] Missing cached photo stage, keeping neutral arena shell",
        );
        return;
      }
      await this.applyStageBackground(cached.pngBlob, loadId);
    } catch (err: any) {
      if (!this.isActiveStageLoad(loadId)) return;
      debugWarn(
        "[FightScene] Photo stage failed to load, keeping neutral arena shell:",
        err?.message || err,
      );
    }
  }

  private async loadAiStageBackground(): Promise<void> {
    if (this.stageId) return;

    const loadId = ++this.stageLoadId;
    const cacheScope = "stage";

    try {
      const cached = await getCachedStageBackgroundForRequest({
        matchSeed: this.matchSeed,
        stageId: this.resolvedStageId,
        cacheScope,
      });
      if (!this.isActiveStageLoad(loadId)) return;

      if (cached) {
        const applied = await this.applyStageBackground(cached.pngBlob, loadId, true);
        if (!applied) {
          debugInfo("[FightScene] Cached AI arena will apply on the next match; preserving the active round");
        }
        return;
      }

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
      const applied = await this.applyStageBackground(generated.pngBlob, loadId, true);
      if (!applied) {
        debugInfo("[FightScene] AI arena cached for the next match; preserving the active round");
      }
    } catch (err: any) {
      if (!this.isActiveStageLoad(loadId)) return;
      debugWarn(
        "[FightScene] AI stage background failed, keeping procedural stage:",
        err?.message || err,
      );
    }
  }

  private isActiveStageLoad(loadId: number): boolean {
    return loadId === this.stageLoadId && this.scene.isActive();
  }

  private async applyStageBackground(
    blob: Blob,
    loadId: number,
    beforeFirstExchangeOnly = false,
  ): Promise<boolean> {
    const img = await this.loadBlobImage(blob);
    if (!this.isActiveStageLoad(loadId)) return false;
    if (
      beforeFirstExchangeOnly &&
      this.sim &&
      (this.sim.phase !== RoundPhase.INTRO || this.sim.fightTicks > 0)
    ) {
      return false;
    }

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
    });
    return true;
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
    this.p1View = new FighterView(this.sim.p1, "fighter_p1");
    this.p2View = new FighterView(this.sim.p2, "fighter_p2");
    this.p1View.createSprite(this);
    this.p2View.createSprite(this);
    this.p1View.setRenderPresentation(
      this.fighterRenderScale,
      this.fighterRenderYOffset,
    );
    this.p2View.setRenderPresentation(
      this.fighterRenderScale,
      this.fighterRenderYOffset,
    );
    this.p1View.sprite.setDepth(10);
    this.p2View.sprite.setDepth(10);
    this.projectileViews = new ProjectileViewPool(this, (sprite) => this.markWorld(sprite));
    this.projectileViews.setRenderYOffset(this.fighterRenderYOffset);
  }

  private syncViews(): void {
    this.p1View.syncSprite(this.p2.x);
    this.p2View.syncSprite(this.p1.x);
    this.projectileViews.sync(this.sim.projectiles);
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
    if (!this.introVideoSequenceActive && !this.sim.canSkipIntro) return false;
    return Boolean(
      (this.introEnterKey && Phaser.Input.Keyboard.JustDown(this.introEnterKey)) ||
      (this.introSpaceKey && Phaser.Input.Keyboard.JustDown(this.introSpaceKey)),
    );
  }

  /** Returns true when a sim intro skip was requested (a recorded action). */
  private skipIntro(): boolean {
    if (this.introVideoSequenceActive) {
      // Abort the clip sequence; playCachedIntroVideos falls through to the
      // cinematic card, which the player can skip again.
      this.introVideoSequenceActive = false;
      return false;
    }
    // Online: the skip travels inside the tick word so both peers apply it
    // on the same tick; the rollback session calls requestIntroSkip itself.
    if (this.rollback) return this.sim.canSkipIntro;
    return this.sim.requestIntroSkip();
  }

  // ---------------------------------------------------------------- online

  private attachOnlineSession(online: OnlineMatchInfo): boolean {
    const session = getActiveOnlineSession();
    if (!session || session.roomCode !== online.roomCode) return false;
    this.onlineSession = session;
    const transport = session.transport;
    this.rollback = new RollbackSession({
      sim: this.sim,
      localSlot: online.localSlot,
      inputDelay: online.inputDelay,
      send: (packet) => {
        transport.sendInput(packet);
      },
    });
    this.onlineUnsubscribe.push(
      transport.onInput((bytes) => {
        this.rollback?.receiveInputPacket(bytes);
      }),
      transport.onControl((payload) => {
        if (!isOnlineControlMessage(payload)) return;
        if (payload.t === "sync") {
          this.rollback?.receiveChecksumReport({ tick: payload.tick, checksum: payload.checksum });
        } else if (payload.t === "quit") {
          this.onOpponentLeft();
        }
      }),
      transport.onState((state) => this.onTransportState(state)),
    );
    this.installNetDebugHook();
    return true;
  }

  private installNetDebugHook(): void {
    const target = window as Window & { __ASF_NET_DEBUG__?: () => unknown };
    target.__ASF_NET_DEBUG__ = () => {
      const rollback = this.rollback;
      if (!rollback) return null;
      const stats = rollback.stats();
      const interval = rollback.checksumInterval;
      const checksums: Array<[number, number]> = [];
      for (let tick = interval; tick <= stats.confirmedTick; tick += interval) {
        const digest = rollback.localChecksumAt(tick);
        if (digest !== undefined) checksums.push([tick, digest]);
      }
      return {
        ...stats,
        phase: this.sim.phase,
        p1Health: this.p1.health,
        p2Health: this.p2.health,
        p1Wins: this.sim.p1Wins,
        p2Wins: this.sim.p2Wins,
        transport: this.onlineSession?.transport.getState() ?? null,
        checksums,
      };
    };
  }

  private detachOnlineSession(): void {
    delete (window as Window & { __ASF_NET_DEBUG__?: unknown }).__ASF_NET_DEBUG__;
    for (const unsubscribe of this.onlineUnsubscribe) unsubscribe();
    this.onlineUnsubscribe = [];
    this.rollback = null;
    this.onlineSession = null;
  }

  private flushNetChecksums(): void {
    if (!this.rollback || !this.onlineSession) return;
    for (const report of this.rollback.takeChecksumReports()) {
      this.onlineSession.transport.sendControl({ t: "sync", tick: report.tick, checksum: report.checksum });
    }
  }

  private onTransportState(state: PeerTransportState): void {
    if (!this.ready) return;
    if (!state.peerPresent && (state.phase === "waiting_peer" || state.phase === "closed" || state.phase === "error")) {
      this.onOpponentLeft();
    }
  }

  private onOpponentLeft(): void {
    if (this.opponentLeft) return;
    this.opponentLeft = true;
    this.opponentLeftAt = Date.now();
    debugWarn("[FightScene] Opponent left the online match");
    this.emitNetState(true);
    if (this.sim.phase !== RoundPhase.MATCH_OVER && !this.waitingForMatchInput) {
      this.showMatchOverUI();
    }
  }

  private emitNetState(force = false): void {
    if (!this.rollback || !this.onlineSession) return;
    this.netStateFrame++;
    if (!force && this.netStateFrame % 10 !== 0) return;
    const transport = this.onlineSession.transport.getState();
    const stats = this.rollback.stats();
    const detail: NetStateDetail = {
      connected: transport.phase === "connected",
      peerPresent: transport.peerPresent && !this.opponentLeft,
      path: transport.path,
      rttMs: transport.rttMs,
      rollbacks: stats.rollbacks,
      stalled: stats.localTick - stats.confirmedTick >= this.rollback.maxRollback,
      desynced: this.rollback.isDesynced,
      abandoned: this.opponentLeft,
    };
    const last = this.lastNetState;
    if (
      last &&
      last.connected === detail.connected &&
      last.peerPresent === detail.peerPresent &&
      last.path === detail.path &&
      last.rttMs === detail.rttMs &&
      last.rollbacks === detail.rollbacks &&
      last.stalled === detail.stalled &&
      last.desynced === detail.desynced &&
      last.abandoned === detail.abandoned
    ) {
      return;
    }
    this.lastNetState = detail;
    window.dispatchEvent(new CustomEvent(NET_STATE_EVENT, { detail }));
  }

  private exitToMenu(): void {
    const exitToMenu = (window as Window & { __ASF_EXIT_TO_MENU__?: () => void }).__ASF_EXIT_TO_MENU__;
    if (exitToMenu) {
      exitToMenu();
    } else {
      window.location.href = "/menu";
    }
  }

  private installRecordingHook(): void {
    const target = window as Window & { __ASF_MATCH_RECORDING__?: () => MatchRecording | null };
    target.__ASF_MATCH_RECORDING__ = () => (this.recorder ? this.recorder.toRecording() : null);
  }

  private removeRecordingHook(): void {
    const target = window as Window & { __ASF_MATCH_RECORDING__?: () => MatchRecording | null };
    delete target.__ASF_MATCH_RECORDING__;
  }

  private destroyIntroOverlay(): void {
    this.emitIntroState(false, this.introRoundNumber);
  }

  private getActiveIntroBlob(intro: Awaited<ReturnType<typeof getCachedIntro>>): Blob | null {
    if (!intro?.variants?.length) return null;
    const activeVariant =
      intro.variants.find((variant) => variant.id === intro.activeVariantId) ??
      intro.variants[0];
    return activeVariant?.videoBlob ?? null;
  }

  private async loadFightIntroClip(
    photoHash: string | null,
    title: string,
    subtitle: string,
  ): Promise<{ title: string; subtitle: string; blob: Blob } | null> {
    if (!photoHash) return null;
    const intro = await getCachedIntro(photoHash);
    const blob = this.getActiveIntroBlob(intro);
    if (!blob) return null;
    return { title, subtitle, blob };
  }

  private destroyIntroVideoOverlay(): void {
    if (this.introVideoEl) {
      this.introVideoEl.pause();
      this.introVideoEl.removeAttribute("src");
      this.introVideoEl.load();
      this.introVideoEl.remove();
      this.introVideoEl = undefined;
    }
    if (this.introVideoOverlayEl) {
      this.introVideoOverlayEl.remove();
      this.introVideoOverlayEl = undefined;
    }
    if (this.introVideoUrl) {
      URL.revokeObjectURL(this.introVideoUrl);
      this.introVideoUrl = undefined;
    }
  }

  private mountIntroVideoOverlay(
    clip: { title: string; subtitle: string; blob: Blob },
  ): HTMLVideoElement {
    this.destroyIntroVideoOverlay();

    const container =
      document.getElementById("game-container") ??
      this.game.canvas.parentElement ??
      this.game.canvas;

    const overlay = document.createElement("div");
    overlay.className = "intro-video-overlay";

    const header = document.createElement("div");
    header.textContent = "FIGHTER INTRO";
    header.className = "intro-video-kicker";
    overlay.appendChild(header);

    const videoShell = document.createElement("div");
    videoShell.className = "intro-video-shell";

    this.introVideoUrl = URL.createObjectURL(clip.blob);
    const video = document.createElement("video");
    video.src = this.introVideoUrl;
    video.autoplay = true;
    video.controls = false;
    video.loop = false;
    video.muted = false;
    video.volume = 1;
    video.playsInline = true;
    video.className = "intro-video-player";
    videoShell.appendChild(video);

    const topBadge = document.createElement("div");
    topBadge.textContent = clip.subtitle.toUpperCase();
    topBadge.className = "intro-video-badge";
    videoShell.appendChild(topBadge);

    const lowerThird = document.createElement("div");
    lowerThird.className = "intro-video-lower";

    const nameLine = document.createElement("div");
    nameLine.textContent = clip.title.toUpperCase();
    nameLine.className = "intro-video-title";
    lowerThird.appendChild(nameLine);

    const subtitleLine = document.createElement("div");
    subtitleLine.textContent = "READY TO FIGHT";
    subtitleLine.className = "intro-video-subtitle";
    lowerThird.appendChild(subtitleLine);

    videoShell.appendChild(lowerThird);
    overlay.appendChild(videoShell);

    const skip = document.createElement("div");
    skip.textContent = "ENTER / SPACE TO SKIP";
    skip.className = "intro-video-skip";
    overlay.appendChild(skip);

    container.appendChild(overlay);
    this.introVideoOverlayEl = overlay;
    this.introVideoEl = video;
    return video;
  }

  private async playIntroVideoClip(
    clip: { title: string; subtitle: string; blob: Blob },
    token: number,
  ): Promise<void> {
    const video = this.mountIntroVideoOverlay(clip);
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        video.removeEventListener("ended", onEnded);
        video.removeEventListener("error", onError);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Failed to play intro video for ${clip.title}`));
      };

      const onEnded = () => finish();
      const onError = () => fail();
      video.addEventListener("ended", onEnded);
      video.addEventListener("error", onError);

      const playVideo = async () => {
        try {
          await video.play();
        } catch {
          video.muted = true;
          try {
            await video.play();
          } catch {
            fail();
            return;
          }
        }
      };

      void playVideo();

      const pollAbort = () => {
        if (settled) return;
        if (token !== this.introVideoSequenceToken || !this.introVideoSequenceActive) {
          settled = true;
          cleanup();
          resolve();
          return;
        }
        window.setTimeout(pollAbort, 120);
      };
      pollAbort();
    });
    this.destroyIntroVideoOverlay();
  }

  private async playCachedIntroVideos(roundNum: number): Promise<void> {
    const token = ++this.introVideoSequenceToken;
    const clips = (await Promise.all([
      this.loadFightIntroClip(
        this.p1PhotoHash,
        this.p1Name,
        this.p1DisplayTag || "CHALLENGER",
      ),
      this.loadFightIntroClip(
        this.p2PhotoHash,
        this.p2Name,
        this.p2DisplayTag || (this.isVsAI ? "CPU" : "RIVAL"),
      ),
    ])).filter((clip): clip is { title: string; subtitle: string; blob: Blob } => !!clip);

    if (token !== this.introVideoSequenceToken || this.sim.phase !== RoundPhase.INTRO) {
      this.introHold = false;
      return;
    }

    if (clips.length === 0) {
      this.playMatchIntro(roundNum);
      return;
    }

    this.introVideoSequenceActive = true;
    this.syncViews();

    try {
      for (const clip of clips) {
        if (
          token !== this.introVideoSequenceToken ||
          this.sim.phase !== RoundPhase.INTRO ||
          !this.introVideoSequenceActive
        ) break;
        await this.playIntroVideoClip(clip, token);
      }
    } catch (err) {
      debugWarn("Fight intro video playback failed, falling back to cinematic intro.", err);
    } finally {
      this.destroyIntroVideoOverlay();
      if (token === this.introVideoSequenceToken) {
        this.introVideoSequenceActive = false;
      }
    }

    if (token !== this.introVideoSequenceToken || this.sim.phase !== RoundPhase.INTRO) {
      this.introHold = false;
      return;
    }
    this.playMatchIntro(roundNum);
  }

  private finishCinematicIntro(showFightAnnouncement: boolean): void {
    this.cinematicIntroActive = false;
    this.introHold = false;
    this.introVideoSequenceActive = false;
    this.destroyIntroOverlay();
    this.destroyIntroVideoOverlay();

    const cam = this.cameras.main;
    cam.stopFollow();
    cam.setZoom(1);
    cam.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);

    if (showFightAnnouncement && !this.fightCueFired) {
      this.dispatchAnnounce({ kind: 'fight' });
      this.sound_mgr.playAnnounce("fight");
    }
    this.fightCueFired = false;
  }

  /**
   * Round-1 versus card. Purely presentational: the sim's INTRO phase owns
   * the timing and emits `introCue`s; this just releases the hold so it
   * starts ticking.
   */
  private playMatchIntro(roundNum: number): void {
    this.cinematicIntroActive = true;
    this.introVideoSequenceActive = false;
    this.destroyIntroVideoOverlay();

    const cam = this.cameras.main;
    cam.stopFollow();
    cam.setZoom(1.03);
    cam.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);

    this.introRoundNumber = roundNum;
    this.emitIntroState(true, roundNum);

    this.tweens.add({
      targets: cam,
      zoom: 1,
      duration: 900,
      ease: "Sine.easeInOut",
    });

    this.introHold = false;
  }

  private onRoundStart(roundNumber: number, cinematic: boolean): void {
    this.cinematicIntroActive = false;
    this.fightCueFired = false;
    this.introVideoSequenceActive = false;
    this.destroyIntroOverlay();
    this.destroyIntroVideoOverlay();

    const cam = this.cameras.main;
    cam.stopFollow();
    cam.setZoom(1);
    cam.centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);

    if (cinematic && this.online) {
      // Intro clips live in the local cache only, so they would desync the
      // two intro durations; online goes straight to the versus card.
      this.playMatchIntro(roundNumber);
    } else if (cinematic) {
      // Hold the sim while cached intro clips load/play; the cinematic card
      // then runs on sim ticks.
      this.introHold = true;
      void this.playCachedIntroVideos(roundNumber);
    }
  }

  update(time: number, delta: number): void {
    if (!this.ready) return;

    this.inputMgr.poll();

    let skipRequested = false;
    if (this.sim.phase === RoundPhase.INTRO && this.shouldSkipIntro()) {
      skipRequested = this.skipIntro();
    }

    const holding = this.introHold || this.introVideoSequenceActive;
    if (!holding && this.sim.phase !== RoundPhase.MATCH_OVER) {
      // Fixed timestep accumulator: the sim only ever advances in whole
      // 60 Hz ticks, whatever the display refresh rate.
      this.accumulator = Math.min(
        this.accumulator + delta,
        FIXED_TIMESTEP * MAX_TICKS_PER_FRAME,
      );
      while (this.accumulator >= FIXED_TIMESTEP) {
        this.accumulator -= FIXED_TIMESTEP;
        if (this.rollback) {
          // Online: the local player always uses the Player 1 control set
          // (keyboard WASD, pad 0, touch), whichever fighter slot they own.
          // The input is stamped for a future tick and the session decides
          // how many ticks to run (or to stall).
          const localInput = this.inputMgr.readPlayer1();
          this.inputMgr.readPlayer2();
          const result = this.rollback.advanceFrame(localInput, skipRequested);
          skipRequested = false;
          this.handleSimEvents(result.events);
          if (!this.ready) return;
          this.flushNetChecksums();
          continue;
        }
        const p1Input = this.inputMgr.readPlayer1();
        const p2Input = this.inputMgr.readPlayer2();
        this.recorder.recordTick(p1Input, p2Input, skipRequested);
        skipRequested = false;
        this.handleSimEvents(this.sim.step(p1Input, p2Input));
        if (!this.ready) return;
        this.recorder.sampleChecksum(this.sim);
      }
    }
    if (this.rollback) this.emitNetState();

    const phase = this.sim.phase;
    if (phase === RoundPhase.FIGHTING) {
      this.updateClouds(time);
    }
    this.syncViews();
    if (phase !== RoundPhase.INTRO) {
      this.updateWorldCamera(delta);
    }
    this.emitHudState();
  }

  /** Route a runtime-created world object to the world camera only. */
  private markWorld<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.uiCam?.ignore(obj);
    return obj;
  }

  /** Route a runtime-created HUD/overlay object to the UI camera only. */
  private markUi<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.uiObjects.add(obj);
    this.cameras.main.ignore(obj);
    return obj;
  }

  /**
   * Continuous framing (Power-Clash style): the world camera eases toward the
   * fighters' midpoint and tightens as they close in. Purely visual, runs on
   * render delta; the HUD lives on its own camera and never scales.
   */
  private updateWorldCamera(delta: number): void {
    const cam = this.cameras.main;
    const dt = Math.min(delta, 100) / 1000;
    const mid = (this.p1.x + this.p2.x) / 2;
    const dist = Math.abs(this.p1.x - this.p2.x);
    const desiredZoom = Math.max(1, Math.min(1.14, 1.14 - Math.max(0, dist - 180) * 0.00032));
    cam.zoom += (desiredZoom - cam.zoom) * Math.min(1, dt * 3.5);
    const targetCenterX = 512 + (mid - 512) * 0.68;
    const desiredScrollX = targetCenterX - cam.width / 2;
    cam.scrollX += (desiredScrollX - cam.scrollX) * Math.min(1, dt * 3.2);
  }

  private dispatchAnnounce(detail: AnnounceDetail): void {
    window.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail }));
  }

  private emitHudState(): void {
    const detail: HudStateDetail = {
      visible: !this.cinematicIntroActive && !this.introVideoSequenceActive && !this.introHold,
      p1Health: Math.max(0, Math.round(this.p1.health)),
      p2Health: Math.max(0, Math.round(this.p2.health)),
      maxHealth: MAX_HEALTH,
      p1Meter: this.p1.meter,
      p2Meter: this.p2.meter,
      meterMax: METER_MAX,
      timer: this.sim.timerSeconds,
      p1Wins: this.sim.p1Wins,
      p2Wins: this.sim.p2Wins,
      roundsToWin: this.sim.roundsToWin,
      p1Name: this.p1.name,
      p2Name: this.p2.name,
      p1Tag: this.p1DisplayTag || null,
      p2Tag: this.p2DisplayTag || null,
      p1PhotoHash: this.p1PhotoHash,
      p2PhotoHash: this.p2PhotoHash,
      matchLabel: this.matchLabel,
    };
    const last = this.lastHudState;
    if (
      last &&
      last.visible === detail.visible &&
      last.p1Health === detail.p1Health &&
      last.p2Health === detail.p2Health &&
      last.p1Meter === detail.p1Meter &&
      last.p2Meter === detail.p2Meter &&
      last.timer === detail.timer &&
      last.p1Wins === detail.p1Wins &&
      last.p2Wins === detail.p2Wins &&
      last.roundsToWin === detail.roundsToWin &&
      last.p1Name === detail.p1Name &&
      last.p2Name === detail.p2Name
    ) {
      return;
    }
    this.lastHudState = detail;
    window.dispatchEvent(new CustomEvent(HUD_STATE_EVENT, { detail }));
  }

  private emitIntroState(visible: boolean, roundNumber: number): void {
    window.dispatchEvent(new CustomEvent(INTRO_STATE_EVENT, {
      detail: {
        visible,
        p1Name: this.p1.name,
        p2Name: this.p2.name,
        p1Tag: this.p1DisplayTag || "CHALLENGER",
        p2Tag: this.p2DisplayTag || (this.isVsAI ? "CPU" : "RIVAL"),
        p1PhotoHash: this.p1PhotoHash,
        p2PhotoHash: this.p2PhotoHash,
        stageLabel: this.stageDisplayLabel,
        matchLabel: this.matchLabel,
        roundNumber,
      },
    }));
  }

  // ------------------------------------------------------------ sim events

  /**
   * Presentation for everything the simulation reported this tick: sounds,
   * sparks, shakes, announcements, HUD, match reporting. The sim already
   * applied the state changes; nothing here feeds back into it.
   */
  private handleSimEvents(events: MatchSimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "roundStart":
          this.onRoundStart(event.roundNumber, event.cinematic);
          break;
        case "introCue":
          this.onIntroCue(event.cue, event.roundNumber);
          break;
        case "fightStart":
          if (this.cinematicIntroActive || this.introHold || this.introVideoSequenceActive) {
            this.finishCinematicIntro(event.skipped);
          }
          break;
        case "attackStart":
          this.emitAttackAudio(event.state);
          break;
        case "hit":
          this.onHit(event);
          break;
        case "projectileHit":
          this.onProjectileHit(event);
          break;
        case "reflect":
          this.hitSparks.emitParticleAt(event.x, event.y + this.fighterRenderYOffset, 8);
          this.sound_mgr.playBlock();
          break;
        case "clash":
          this.hitSparks.emitParticleAt(event.x, event.y + this.fighterRenderYOffset, 10);
          this.sound_mgr.playBlock();
          break;
        case "superFireball":
          this.onSuperFireball(event.playerIndex);
          break;
        case "roundEnd":
          this.onRoundEnd(event.outcome);
          break;
        case "matchEnd":
          this.reportMatchComplete(event.winner === 0 ? "p1" : "p2");
          debugInfo(
            `[FightScene] Match recorded: ${this.recorder.tickCount} ticks, seed ${this.matchSeed >>> 0}, checksum ${this.sim.checksum()}`,
          );
          break;
        case "winsCue": {
          const winner = event.winner === 0 ? this.p1 : this.p2;
          this.dispatchAnnounce({ kind: 'wins', winnerName: winner.name.toUpperCase() });
          this.sound_mgr.playAnnounce("wins");
          break;
        }
        case "matchOver":
          if (!this.waitingForMatchInput) {
            this.showMatchOverUI();
          }
          break;
      }
    }
  }

  private onIntroCue(cue: "skippable" | "round" | "fight" | "hide", roundNumber: number): void {
    switch (cue) {
      case "skippable":
        break;
      case "round":
        this.dispatchAnnounce({ kind: 'round', roundNumber });
        this.sound_mgr.playAnnounce("round");
        break;
      case "fight":
        this.fightCueFired = true;
        this.dispatchAnnounce({ kind: 'fight' });
        this.sound_mgr.playAnnounce("fight");
        break;
      case "hide":
        this.destroyIntroOverlay();
        break;
    }
  }

  private emitAttackAudio(next: FighterState): void {
    switch (next) {
      case FighterState.HIGH_PUNCH:
      case FighterState.LOW_PUNCH:
      case FighterState.HIGH_KICK:
      case FighterState.LOW_KICK:
        this.sound_mgr.playWhoosh();
        break;
      case FighterState.FIREBALL:
        this.sound_mgr.playFireball();
        break;
      case FighterState.UPPERCUT:
        this.sound_mgr.playUppercut();
        break;
    }
  }

  private fighterView(index: 0 | 1): FighterView {
    return index === 0 ? this.p1View : this.p2View;
  }

  private spawnFloatingText(
    x: number,
    y: number,
    text: string,
    color: string,
    fontSize: string,
    strokeThickness: number,
    rise: number,
    duration: number,
    depth: number,
  ): void {
    const label = this.markWorld(this.add
      .text(x, y, text, {
        fontFamily: '"Press Start 2P", monospace',
        fontSize,
        color,
        stroke: "#000000",
        strokeThickness,
      })
      .setOrigin(0.5)
      .setDepth(depth));
    this.tweens.add({
      targets: label,
      y: label.y - rise,
      alpha: 0,
      duration,
      ease: "Cubic.easeOut",
      onComplete: () => label.destroy(),
    });
  }

  private onSuperFireball(playerIndex: 0 | 1): void {
    const fighter = playerIndex === 0 ? this.p1 : this.p2;
    const view = this.fighterView(playerIndex);
    this.sound_mgr.playHit(true);
    this.spawnFloatingText(fighter.x, view.getRenderY() - 210, 'SUPER!', '#ffce3a', '16px', 4, 44, 800, 106);
  }

  private onProjectileHit(event: Extract<MatchSimEvent, { type: "projectileHit" }>): void {
    const defender = event.defender === 0 ? this.p1 : this.p2;
    const defenderView = this.fighterView(event.defender);

    this.hitSparks.emitParticleAt(
      defender.x + (defender.facingRight ? -20 : 20),
      defenderView.getRenderY() - 80,
      event.blocked ? 5 : 12,
    );

    this.spawnFloatingText(
      defender.x + (defender.facingRight ? -10 : 10),
      defenderView.getRenderY() - 100,
      event.damage.toString(),
      event.blocked ? "#999999" : "#ff8844",
      "12px",
      3,
      50,
      800,
      105,
    );
  }

  private onHit(event: Extract<MatchSimEvent, { type: "hit" }>): void {
    const defender = event.defender === 0 ? this.p1 : this.p2;
    const attacker = event.attacker === 0 ? this.p1 : this.p2;
    const defenderView = this.fighterView(event.defender);
    const attackerView = this.fighterView(event.attacker);

    // Sound
    if (event.blocked) {
      this.sound_mgr.playBlock();
    } else {
      this.sound_mgr.playHit(event.damage > 50);
    }

    // Impact: the sim already froze itself (hitstop); shake/flash here.
    if (event.blocked) {
      this.cameras.main.shake(50, 0.0015);
    } else if (event.damage > 50) {
      this.cameras.main.shake(120, 0.006);
      this.markUi(ScreenEffects.flashRed(this, 150));
    } else {
      this.cameras.main.shake(80, 0.003);
      this.markUi(ScreenEffects.flashWhite(this, 60));
    }

    if (event.counter && !event.blocked) {
      this.spawnFloatingText(defender.x, defenderView.getRenderY() - 190, 'COUNTER!', '#ffdd33', '14px', 4, 40, 700, 106);
    }

    // Sparks
    this.hitSparks.emitParticleAt(
      defender.x + (defender.facingRight ? -20 : 20),
      defenderView.getRenderY() - 80,
      event.blocked ? 5 : 12,
    );

    // Combo counter
    if (!event.blocked && event.comboCount >= 2) {
      this.hud.showCombo(
        attacker.x,
        attackerView.getRenderY(),
        event.comboCount,
        attacker.playerIndex,
      );
    }

    // Floating damage number
    this.spawnFloatingText(
      defender.x + (defender.facingRight ? -10 : 10),
      defenderView.getRenderY() - 100,
      event.damage.toString(),
      event.blocked ? "#999999" : "#ff4444",
      "12px",
      3,
      50,
      800,
      105,
    );
  }

  private onRoundEnd(outcome: "ko" | "double_ko" | "draw" | "decision"): void {
    switch (outcome) {
      case "double_ko":
        this.dispatchAnnounce({ kind: 'double_ko' });
        this.cameras.main.shake(250, 0.01);
        this.sound_mgr.playKO();
        this.sound_mgr.playAnnounce("ko");
        break;
      case "draw":
        this.dispatchAnnounce({ kind: 'draw' });
        break;
      case "ko":
        this.dispatchAnnounce({ kind: 'ko' });
        this.sound_mgr.playKO();
        this.sound_mgr.playAnnounce("ko");
        this.markUi(ScreenEffects.flashWhite(this, 200));
        // KO drama: the sim holds a long freeze; big shake and slow-motion
        // effects are presentation only.
        this.cameras.main.shake(250, 0.01);
        ScreenEffects.slowMotion(this, 700, 0.3);
        break;
      case "decision":
        break;
    }
    this.syncViews();
    this.emitHudState();
  }

  private reportMatchComplete(winnerSlot: "p1" | "p2"): void {
    if (this.matchReported) return;
    this.matchReported = true;

    const detail: MatchCompletionDetail = {
      experience: this.experience,
      winnerSlot,
      roundsP1: this.sim.p1Wins,
      roundsP2: this.sim.p2Wins,
      durationSeconds: Math.max(0, Math.round((Date.now() - this.matchStartedAt) / 1000)),
      vsAI: this.isVsAI,
      cpuVsCpu: this.cpuVsCpu,
      p1FighterId: this.p1CloudFighterId,
      p2FighterId: this.p2CloudFighterId,
      isRanked: false,
      ...(this.online ? { online: this.online } : {}),
    };
    window.dispatchEvent(new CustomEvent(MATCH_COMPLETE_EVENT, { detail }));
  }

  private showMatchOverUI(): void {
    this.waitingForMatchInput = true;
    this.setMatchActionsVisible(true);

    const escKey = this.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.ESC,
    );
    this.matchActionKeys = [escKey];

    if (this.experience !== "trial") {
      const enterKey = this.input.keyboard!.addKey(
        Phaser.Input.Keyboard.KeyCodes.ENTER,
      );
      const remixKey = this.input.keyboard!.addKey(
        Phaser.Input.Keyboard.KeyCodes.R,
      );
      this.matchActionKeys.push(enterKey, remixKey);
      enterKey.once("down", () => {
        this.performMatchAction("run_it_back");
      });
      remixKey.once("down", () => {
        this.performMatchAction("remix");
      });
    }

    escKey.once("down", () => {
      this.performMatchAction("menu");
    });
  }

  private readonly onMatchAction = (event: WindowEventMap[typeof MATCH_ACTION_EVENT]): void => {
    this.performMatchAction(event.detail.action);
  };

  private performMatchAction(action: MatchAction): void {
    if (!this.waitingForMatchInput || this.matchActionCommitted) return;
    this.matchActionCommitted = true;
    this.cleanupMatchOverUI();

    if (this.online) {
      // Re-running an online match needs a fresh room handshake; every
      // action returns to the lobby.
      this.onlineSession?.transport.sendControl({ t: "quit" });
    } else if (action === "run_it_back") {
      this.restartMatch(this.remix);
      return;
    } else if (action === "remix") {
      this.restartMatch(this.remix + 1);
      return;
    }

    this.cameras.main.fadeOut(500, 0, 0, 0);
    this.cameras.main.once("camerafadeoutcomplete", () => {
      const exitToMenu = (window as Window & { __ASF_EXIT_TO_MENU__?: () => void }).__ASF_EXIT_TO_MENU__;
      if (exitToMenu) {
        exitToMenu();
      } else {
        debugWarn("[FightScene] No __ASF_EXIT_TO_MENU__ handler registered; falling back to full reload");
        window.location.href = "/menu";
      }
    });
  }

  private restartMatch(remix: number): void {
    this.cleanupMatchOverUI();
    this.cameras.main.flash(200, 255, 255, 255);
    this.time.delayedCall(200, () => {
      this.scene.restart({
        ...this.restartFormat,
        vsAI: this.isVsAI,
        cpuVsCpu: this.cpuVsCpu,
        p1PhotoHash: this.p1PhotoHash ?? undefined,
        p2PhotoHash: this.p2PhotoHash ?? undefined,
        p1CloudFighterId: this.p1CloudFighterId,
        p2CloudFighterId: this.p2CloudFighterId,
        p1Name: this.p1Name,
        p2Name: this.p2Name,
        p1PersonalityId: this.p1PersonalityId,
        p2PersonalityId: this.p2PersonalityId,
        stageId: this.stageId ?? undefined,
        customStageKey: this.customStageKey ?? undefined,
        customStageLabel: this.customStageLabel ?? undefined,
        remix,
        p2Difficulty: this.p2Difficulty ?? undefined,
        seed: this.explicitSeed,
      });
    });
  }

  private cleanupMatchOverUI(): void {
    this.matchActionKeys.forEach((key) => key.removeAllListeners());
    this.matchActionKeys = [];
    this.setMatchActionsVisible(false);
  }

  private setMatchActionsVisible(visible: boolean): void {
    if (this.matchActionsVisible === visible) return;
    this.matchActionsVisible = visible;
    window.dispatchEvent(
      new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, {
        detail: { visible, online: Boolean(this.online) },
      }),
    );
  }

  private beginSceneLifecycle(): number {
    this.events.off(Phaser.Scenes.Events.SHUTDOWN, this.onSceneLifecycleEnd);
    this.events.off(Phaser.Scenes.Events.DESTROY, this.onSceneLifecycleEnd);
    this.sceneLifecycleActive = true;
    this.sceneLifecycleEpoch += 1;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onSceneLifecycleEnd);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.onSceneLifecycleEnd);
    return this.sceneLifecycleEpoch;
  }

  private isCurrentSceneLifecycle(epoch: number): boolean {
    return this.sceneLifecycleActive && this.sceneLifecycleEpoch === epoch;
  }

  private readonly onSceneLifecycleEnd = (): void => {
    if (!this.sceneLifecycleActive) return;
    this.sceneLifecycleActive = false;
    this.sceneLifecycleEpoch += 1;
    this.ready = false;
    this.stageLoadId += 1;
    this.events.off(Phaser.Scenes.Events.SHUTDOWN, this.onSceneLifecycleEnd);
    this.events.off(Phaser.Scenes.Events.DESTROY, this.onSceneLifecycleEnd);
    window.removeEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    this.removeRecordingHook();
    if (this.online) {
      this.detachOnlineSession();
      endActiveOnlineSession();
    }
    this.cleanupMatchOverUI();
    resetVirtualInput();
    this.inputMgr?.reset();
    this.introVideoSequenceActive = false;
    this.introHold = false;
    this.introVideoSequenceToken++;
    this.destroyIntroVideoOverlay();
    this.destroyIntroOverlay();
    this.stageBackdrop?.destroy();
    this.stageBackdrop = undefined;
    if (
      this.stageBackdropTextureKey &&
      this.textures.exists(this.stageBackdropTextureKey)
    ) {
      this.textures.remove(this.stageBackdropTextureKey);
    }
    this.stageBackdropTextureKey = undefined;
    this.projectileViews?.clear();
    this.sound_mgr?.destroy();
  };
}
