import Phaser from 'phaser';
import { Fighter } from '../fighters/Fighter.ts';
import { FighterView } from '../fighters/FighterView.ts';
import { FighterState, GAME_HEIGHT, GAME_WIDTH, GROUND_Y } from '../constants.ts';
import { EMPTY_INPUT } from '../sim/FighterInput.ts';
import { loadAiSprites } from '../sprites/AiSpriteLoader.ts';
import { SoundManager } from '../systems/SoundManager.ts';
import { ScreenEffects } from '../effects/ScreenEffects.ts';
import { getCachedStageBackground } from '../../services/SpriteCache.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';
import {
  getFightStageCalibration,
  getStageTheme,
  pickStageThemeIdFromSeed,
  type StageThemeId,
} from '../match/StageConfig.ts';
import {
  AURA_BATTLE_COMPLETE_EVENT,
  AURA_INPUT_EVENT,
  MATCH_ACTION_EVENT,
  MATCH_ACTIONS_VISIBILITY_EVENT,
  NET_STATE_EVENT,
  ONLINE_REMATCH_STATE_EVENT,
  PAUSE_EVENT,
  RUNTIME_READY_EVENT,
  buildMatchSeed,
  type AuraBattleCompleteDetail,
  type MatchAction,
  type MatchSceneData,
  type OnlineMatchInfo,
} from '../match/MatchConfig.ts';
import {
  AuraBattle,
  auraRank,
  createAuraCpuPlan,
  type AuraCpuHit,
  type AuraGrade,
  type AuraJudgement,
  type AuraPlayerScore,
} from '../aura/AuraBattle.ts';
import {
  auraNoteTravelProgress,
  auraTurnAt,
  createAuraChart,
  type AuraLane,
  type AuraSlot,
} from '../aura/AuraChart.ts';
import {
  AURA_DEFAULT_LANE_KEYS,
  AURA_LOCAL_P1_LANE_KEYS,
  AURA_LOCAL_P2_LANE_KEYS,
  AURA_NOTE_TRAVEL_MS,
  AURA_ROUNDS,
  getAuraDifficulty,
  type AuraLaneKeys,
  type AuraDifficultyId,
} from '../aura/AuraConfig.ts';
import {
  AURA_ROUTINE_ANIMATION_NAMES,
  auraPerformanceAtBeat,
  createAuraPerformanceRoutine,
  type AuraRoutineAnimationName,
} from '../aura/AuraPerformance.ts';
import { AuraPerformanceView } from '../aura/AuraPerformanceView.ts';
import {
  destroyLoadedAuraAnimationPack,
  loadAuraAnimationPack,
  type LoadedAuraAnimationPack,
} from '../aura/AuraSpriteLoader.ts';
import {
  endActiveOnlineSession,
  getActiveOnlineSession,
  type OnlineMatchSession,
} from '../net/onlineSession.ts';
import type { PeerTransportState } from '../net/PeerTransport.ts';

const LANE_COLORS = [0x4fdcff, 0x8b4dff, 0xffce3a, 0xef4343] as const;
const LANE_HALF_WIDTH = 36;
const LANE_START_Y = 244;
const LANE_TARGET_Y = 497;
const RECEPTOR_WIDTH = 64;
const RECEPTOR_HEIGHT = 58;
const KEY_LABEL_Y = 542;
const HIGHWAY_FRAME_PAD_X = 14;
const HIGHWAY_FRAME_PAD_TOP = 44;
const HIGHWAY_FRAME_PAD_BOTTOM = 64;
const CROWD_METER_SEGMENTS = 8;
const INACTIVE_PERFORMER_STAGE_OFFSET = 260;
const ONLINE_START_DELAY_MS = 1_600;
const ONLINE_FINISH_GRACE_MS = 2_500;
const SHRUG_REACTION_MISTAKES = 2;
const SHRUG_REACTION_COOLDOWN_MS = 2_200;
const SHRUG_REACTION_DURATION_MS = 1_050;

type ResolvedAuraGrade = Exclude<AuraGrade, 'wrong_turn'>;

type AuraOnlineControl =
  | { t: 'aura_ready'; matchSerial: number }
  | { t: 'aura_start'; matchSerial: number; delayMs: number }
  | {
      t: 'aura_judgement';
      matchSerial: number;
      noteId: string;
      grade: Exclude<ResolvedAuraGrade, 'mash'>;
      offsetMs: number;
    }
  | { t: 'aura_finish'; matchSerial: number; score: AuraPlayerScore }
  | { t: 'quit' }
  | { t: 'rematch_ready'; previousMatchSerial: number }
  | { t: 'rematch_start'; previousMatchSerial: number; matchSerial: number; seed: number };

function isAuraScore(value: unknown): value is AuraPlayerScore {
  if (!value || typeof value !== 'object') return false;
  const score = value as Record<string, unknown>;
  return ['score', 'combo', 'bestCombo', 'perfect', 'great', 'good', 'misses', 'mashes']
    .every((key) => typeof score[key] === 'number' && Number.isFinite(score[key]));
}

function isAuraOnlineControl(value: unknown): value is AuraOnlineControl {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.t === 'quit') return true;
  if (message.t === 'aura_ready') {
    return Number.isSafeInteger(message.matchSerial) && (message.matchSerial as number) > 0;
  }
  if (message.t === 'aura_start') {
    return Number.isSafeInteger(message.matchSerial)
      && typeof message.delayMs === 'number'
      && message.delayMs >= 0
      && message.delayMs <= 5_000;
  }
  if (message.t === 'aura_judgement') {
    return Number.isSafeInteger(message.matchSerial)
      && typeof message.noteId === 'string'
      && ['perfect', 'great', 'good', 'miss'].includes(String(message.grade))
      && typeof message.offsetMs === 'number';
  }
  if (message.t === 'aura_finish') {
    return Number.isSafeInteger(message.matchSerial) && isAuraScore(message.score);
  }
  if (message.t === 'rematch_ready') {
    return Number.isSafeInteger(message.previousMatchSerial);
  }
  if (message.t === 'rematch_start') {
    return Number.isSafeInteger(message.previousMatchSerial)
      && Number.isSafeInteger(message.matchSerial)
      && Number.isSafeInteger(message.seed);
  }
  return false;
}

function stageTextureKey(stageId: StageThemeId): string {
  return `aura_stage_${stageId.replace(/[^a-z0-9_-]/gi, '_')}`;
}

function formatAura(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

function scoreCopy(score: AuraPlayerScore): AuraPlayerScore {
  return { ...score };
}

interface LaneLayout {
  startX: number;
  targetX: number;
  startY: number;
  targetY: number;
}

export class AuraScene extends Phaser.Scene {
  private matchData!: MatchSceneData;
  private difficultyId: AuraDifficultyId = 'viral';
  private matchSeed = 0;
  private remix = 0;
  private isVsAI = true;
  private cpuVsCpu = false;
  private canaryPerformanceOverride: AuraRoutineAnimationName | null = null;
  private p1Name = 'Player 1';
  private p2Name = 'CPU';
  private p1PhotoHash: string | null = null;
  private p2PhotoHash: string | null = null;
  private p1CloudFighterId: string | null = null;
  private p2CloudFighterId: string | null = null;
  private stageId: StageThemeId | null = null;
  private resolvedStageId!: StageThemeId;
  private stageLabel = '';
  private customStageKey: string | null = null;
  private customStageLabel: string | null = null;
  private online: OnlineMatchInfo | null = null;

  private chart!: ReturnType<typeof createAuraChart>;
  private battle!: AuraBattle;
  private cpuPlans: [AuraCpuHit[], AuraCpuHit[]] = [[], []];
  private cpuPlanIndices: [number, number] = [0, 0];
  private fighters!: [Fighter, Fighter];
  private views!: [FighterView, FighterView];
  private fightSpritePacksLoaded: [boolean, boolean] = [false, false];
  private auraAnimationPacks: [LoadedAuraAnimationPack | null, LoadedAuraAnimationPack | null] = [null, null];
  private auraPerformanceViews: [AuraPerformanceView | null, AuraPerformanceView | null] = [null, null];
  private fighterRenderScale = 1;
  private fighterRenderYOffset = 0;

  private worldLayer!: Phaser.GameObjects.Container;
  private uiLayer!: Phaser.GameObjects.Container;
  private uiCamera!: Phaser.Cameras.Scene2D.Camera;
  private stageBackdrop!: Phaser.GameObjects.Image;
  private stageTint!: Phaser.GameObjects.Graphics;
  private stageLights!: Phaser.GameObjects.Graphics;
  private customStageTextureKey: string | null = null;
  private laneGraphics!: Phaser.GameObjects.Graphics;
  private targetGraphics!: Phaser.GameObjects.Graphics;
  private highwayTitleText!: Phaser.GameObjects.Text;
  private highwayMetaText!: Phaser.GameObjects.Text;
  private inputFlashGraphics: Phaser.GameObjects.Graphics[] = [];
  private inputPulseGraphics: Phaser.GameObjects.Graphics[] = [];
  private activeGlow!: Phaser.GameObjects.Graphics;
  private burstRing!: Phaser.GameObjects.Graphics;
  private noteObjects = new Map<string, Phaser.GameObjects.Container>();
  private p1ScoreText!: Phaser.GameObjects.Text;
  private p2ScoreText!: Phaser.GameObjects.Text;
  private p1NameText!: Phaser.GameObjects.Text;
  private p2NameText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private comboText!: Phaser.GameObjects.Text;
  private crowdLabelText!: Phaser.GameObjects.Text;
  private crowdMeterGraphics!: Phaser.GameObjects.Graphics;
  private laneKeyTexts: Phaser.GameObjects.Text[] = [];
  private p1Balance!: Phaser.GameObjects.Rectangle;
  private p2Balance!: Phaser.GameObjects.Rectangle;
  private balanceCrown!: Phaser.GameObjects.Text;
  private playerTags!: [Phaser.GameObjects.Container, Phaser.GameObjects.Container];
  private currentTurnIndex = -2;

  private keysP1: Phaser.Input.Keyboard.Key[] = [];
  private keysP2: Phaser.Input.Keyboard.Key[] = [];
  private keyBindings: Array<{ key: Phaser.Input.Keyboard.Key; handler: () => void }> = [];
  private soundManager!: SoundManager;
  private crowdHeat: [number, number] = [0, 0];
  private mistakeStreak: [number, number] = [0, 0];
  private lastShrugReactionAt: [number, number] = [-Infinity, -Infinity];
  private shrugReactionEpoch: [number, number] = [0, 0];
  private activePerformerSlot: AuraSlot | null = null;
  private clockStartedAt: number | null = null;
  private scheduledClockStart: number | null = null;
  private paused = false;
  private pausedAt = 0;
  private pausedDuration = 0;
  private matchFinished = false;
  private finalizing = false;
  private finalizingStartedAt = 0;
  private matchActionsVisible = false;
  private lastWrongTurnFeedbackAt = -Infinity;
  private reduceMotion = false;

  private onlineSession: OnlineMatchSession | null = null;
  private onlineUnsubscribe: Array<() => void> = [];
  private localOnlineReady = false;
  private remoteOnlineReady = false;
  private onlineClockAnnounced = false;
  private remoteFinalScore: AuraPlayerScore | null = null;
  private localFinishSent = false;
  private opponentLeft = false;
  private preserveOnlineSessionOnRestart = false;
  private localRematchReady = false;
  private remoteRematchReady = false;
  private onlineRematchStarting = false;
  private actionCommitted = false;

  private lifecycleEpoch = 0;
  private lifecycleActive = false;

  constructor() {
    super({ key: 'AuraScene' });
  }

  init(data: MatchSceneData): void {
    this.matchData = data;
    this.difficultyId = getAuraDifficulty(data.auraDifficulty).id;
    this.remix = data.remix ?? 0;
    this.isVsAI = data.vsAI !== false || data.cpuVsCpu === true;
    this.cpuVsCpu = data.cpuVsCpu === true;
    const requestedCanaryPerformance = import.meta.env.DEV
      ? new URLSearchParams(window.location.search).get('auraCanaryMove')
      : null;
    this.canaryPerformanceOverride = AURA_ROUTINE_ANIMATION_NAMES.find(
      (name) => name === requestedCanaryPerformance,
    ) ?? null;
    this.p1Name = data.p1Name ?? (this.cpuVsCpu ? 'CPU 1' : 'Player 1');
    this.p2Name = data.p2Name ?? (this.isVsAI ? 'CPU' : 'Player 2');
    this.p1PhotoHash = data.p1PhotoHash ?? null;
    this.p2PhotoHash = data.p2PhotoHash ?? null;
    this.p1CloudFighterId = data.p1CloudFighterId ?? null;
    this.p2CloudFighterId = data.p2CloudFighterId ?? null;
    this.stageId = data.stageId ?? null;
    this.customStageKey = data.customStageKey ?? null;
    this.customStageLabel = data.customStageLabel ?? null;
    this.online = data.online ?? null;
    this.matchSeed = buildMatchSeed({ ...data, gameMode: 'aura' });
    this.cpuPlans = [[], []];
    this.cpuPlanIndices = [0, 0];
    this.noteObjects.clear();
    this.fightSpritePacksLoaded = [false, false];
    this.auraAnimationPacks = [null, null];
    this.auraPerformanceViews = [null, null];
    this.crowdHeat = [0, 0];
    this.mistakeStreak = [0, 0];
    this.lastShrugReactionAt = [-Infinity, -Infinity];
    this.shrugReactionEpoch = [0, 0];
    this.activePerformerSlot = null;
    this.currentTurnIndex = -2;
    this.clockStartedAt = null;
    this.scheduledClockStart = null;
    this.paused = false;
    this.pausedDuration = 0;
    this.matchFinished = false;
    this.finalizing = false;
    this.matchActionsVisible = false;
    this.onlineSession = null;
    this.onlineUnsubscribe = [];
    this.localOnlineReady = false;
    this.remoteOnlineReady = false;
    this.onlineClockAnnounced = false;
    this.remoteFinalScore = null;
    this.localFinishSent = false;
    this.opponentLeft = false;
    this.preserveOnlineSessionOnRestart = false;
    this.localRematchReady = false;
    this.remoteRematchReady = false;
    this.onlineRematchStarting = false;
    this.actionCommitted = false;
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  preload(): void {
    const resolved = this.stageId ?? pickStageThemeIdFromSeed(this.matchSeed);
    const stage = getStageTheme(resolved);
    if (stage.assetPath && !this.textures.exists(stageTextureKey(stage.id))) {
      this.load.image(stageTextureKey(stage.id), stage.assetPath);
    }
  }

  async create(): Promise<void> {
    const epoch = this.beginLifecycle();
    window.addEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.addEventListener(PAUSE_EVENT, this.onPause);
    window.addEventListener(AURA_INPUT_EVENT, this.onAuraInput);
    this.setMatchActionsVisible(false);

    this.resolvedStageId = this.stageId ?? pickStageThemeIdFromSeed(this.matchSeed);
    const stage = getStageTheme(this.resolvedStageId);
    this.stageLabel = this.customStageKey
      ? (this.customStageLabel ?? 'PHOTO STAGE').toUpperCase()
      : stage.label;
    const calibration = getFightStageCalibration(this.resolvedStageId, Boolean(this.customStageKey));
    this.fighterRenderScale = calibration.fighterScale * 1.02;
    this.fighterRenderYOffset = calibration.fighterYOffset;
    this.chart = createAuraChart(this.matchSeed, this.difficultyId);
    this.battle = new AuraBattle(this.chart, this.difficultyId);

    this.soundManager = new SoundManager();
    this.soundManager.prepareAuraCrowd();
    await this.loadFighters(epoch);
    if (!this.isCurrentLifecycle(epoch)) return;

    this.worldLayer = this.add.container(0, 0);
    this.createStage(stageTextureKey(stage.id));
    if (this.customStageKey) void this.loadCustomStage(epoch);
    this.createFighters();
    this.createWorldEffects();
    this.createUi();
    this.createCameras();
    this.createInput();
    this.cpuPlans = [
      this.isCpuSlot(0) ? createAuraCpuPlan(this.chart, 0, this.difficultyId) : [],
      this.isCpuSlot(1) ? createAuraCpuPlan(this.chart, 1, this.difficultyId) : [],
    ];

    if (this.online && !this.attachOnlineSession(this.online)) {
      debugWarn('[AuraScene] Online match has no live session; returning to menu');
      this.exitToMenu();
      return;
    }

    if (this.online) {
      this.localOnlineReady = true;
      this.announceOnlineReady();
    } else {
      this.beginClock(0);
    }

    this.updateScoreUi();
    this.updateTurnPresentation(-1);
    window.dispatchEvent(new CustomEvent(RUNTIME_READY_EVENT, {
      detail: { sceneKey: 'AuraScene', matchSeed: this.matchSeed },
    }));
  }

  update(_time: number, delta: number): void {
    if (!this.lifecycleActive || this.paused) return;
    this.soundManager.updateAuraCrowd(delta);
    this.advanceFighterPresentation(Math.min(delta, 50) / 1_000);
    if (this.matchFinished || this.clockStartedAt === null) return;

    const nowMs = this.clockMs();
    if (nowMs < 0) return;
    this.updateTurn(nowMs);
    if (!this.finalizing) {
      this.playCpuPlans(nowMs);
      this.collectHumanMisses(nowMs);
      this.updateNotes(nowMs);
    }

    if (nowMs >= this.chart.durationMs && !this.finalizing) {
      this.beginFinalization();
    }
    if (this.finalizing) this.maybeCompleteFinalization();
  }

  private async loadFighters(epoch: number): Promise<void> {
    const isCurrent = () => this.isCurrentLifecycle(epoch);
    const loadSlot = async (slot: AuraSlot, spriteKey: string, photoHash: string | null) => {
      const [fightPackLoaded, auraPack] = await Promise.all([
        photoHash ? loadAiSprites(this, spriteKey, photoHash, isCurrent) : Promise.resolve(false),
        loadAuraAnimationPack(this, spriteKey, photoHash, isCurrent),
      ]);
      if (isCurrent()) {
        this.fightSpritePacksLoaded[slot] = fightPackLoaded;
        this.auraAnimationPacks[slot] = auraPack;
      }
    };
    await Promise.all([
      loadSlot(0, 'fighter_p1', this.p1PhotoHash),
      loadSlot(1, 'fighter_p2', this.p2PhotoHash),
    ]);
  }

  private createStage(textureKey: string): void {
    const hasTexture = this.textures.exists(textureKey);
    if (hasTexture) {
      this.stageBackdrop = this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 4, textureKey)
        .setDisplaySize(GAME_WIDTH * 1.08, GAME_HEIGHT * 1.08)
        .setDepth(-20);
    } else {
      const fallbackKey = 'aura-stage-fallback';
      const canvas = document.createElement('canvas');
      canvas.width = GAME_WIDTH;
      canvas.height = GAME_HEIGHT;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#070812';
      context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
      context.strokeStyle = '#242238';
      for (let x = 0; x < GAME_WIDTH; x += 64) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, GAME_HEIGHT);
        context.stroke();
      }
      this.textures.addCanvas(fallbackKey, canvas);
      this.stageBackdrop = this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, fallbackKey).setDepth(-20);
    }
    this.worldLayer.add(this.stageBackdrop);

    const grade = this.add.graphics().setDepth(-18);
    grade.fillStyle(0x050507, 0.24);
    grade.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    grade.fillStyle(0x09091a, 0.38);
    grade.fillRect(0, 0, GAME_WIDTH, 102);
    grade.fillStyle(0x020205, 0.2);
    grade.fillRect(0, 390, GAME_WIDTH, 186);
    this.worldLayer.add(grade);

    this.stageTint = this.add.graphics().setDepth(-17);
    this.stageLights = this.add.graphics().setDepth(-16).setBlendMode(Phaser.BlendModes.ADD);
    this.worldLayer.add([this.stageTint, this.stageLights]);
    this.drawStageLighting(null, 0);

    const floor = this.add.graphics().setDepth(-8);
    floor.lineStyle(2, 0xffce3a, 0.42);
    floor.strokeEllipse(GAME_WIDTH / 2, GROUND_Y + this.fighterRenderYOffset + 5, 470, 94);
    floor.lineStyle(1, 0x4fdcff, 0.18);
    floor.strokeEllipse(GAME_WIDTH / 2, GROUND_Y + this.fighterRenderYOffset + 5, 392, 72);
    this.worldLayer.add(floor);
  }

  private drawStageLighting(slot: AuraSlot | null, heat: number): void {
    if (!this.stageTint || !this.stageLights) return;
    this.stageTint.clear();
    this.stageLights.clear();

    const leftTop = slot === 1 ? 0x24082f : 0x062a3d;
    const rightTop = slot === 0 ? 0x28072e : 0x081c3f;
    const leftBottom = slot === 1 ? 0x16061f : 0x06445a;
    const rightBottom = slot === 0 ? 0x3a0a3f : 0x0a3450;
    this.stageTint.fillGradientStyle(
      leftTop,
      rightTop,
      leftBottom,
      rightBottom,
      0.28,
      0.28,
      0.38,
      0.38,
    );
    this.stageTint.fillRect(0, 92, GAME_WIDTH, GAME_HEIGHT - 92);
    this.stageTint.fillStyle(0x03030c, 0.18);
    this.stageTint.fillRect(0, 92, GAME_WIDTH, 54);

    if (slot === null) {
      this.drawRadialStageGlow(326, 360, 0x4fdcff, 0.12);
      this.drawRadialStageGlow(698, 360, 0xff3dc6, 0.1);
      return;
    }

    const performerX = this.fighters?.[slot]?.x ?? (slot === 0 ? 326 : 698);
    const color = slot === 0 ? 0x4fdcff : 0xff3dc6;
    const strength = 0.14 + heat * 0.12;
    this.stageLights.fillStyle(color, 0.035 + heat * 0.025);
    this.stageLights.fillTriangle(
      performerX - 38,
      90,
      performerX + 38,
      90,
      performerX + (slot === 0 ? 190 : -190),
      GROUND_Y + 40,
    );
    this.stageLights.fillTriangle(
      performerX - 18,
      90,
      performerX + 18,
      90,
      performerX + (slot === 0 ? -170 : 170),
      GROUND_Y + 25,
    );
    this.drawRadialStageGlow(performerX, 360, color, strength);
  }

  private drawRadialStageGlow(x: number, y: number, color: number, strength: number): void {
    for (let ring = 0; ring < 6; ring += 1) {
      const scale = 1 - ring * 0.13;
      this.stageLights.fillStyle(color, strength * (0.12 + ring * 0.035));
      this.stageLights.fillEllipse(x, y, 430 * scale, 390 * scale);
    }
  }

  private async loadCustomStage(epoch: number): Promise<void> {
    if (!this.customStageKey) return;
    try {
      const cached = await getCachedStageBackground(this.customStageKey);
      if (!cached || !this.isCurrentLifecycle(epoch)) return;
      const image = await this.blobImage(cached.pngBlob);
      if (!this.isCurrentLifecycle(epoch)) return;
      const key = `aura_custom_${this.customStageKey.replace(/[^a-z0-9_-]/gi, '_')}`;
      if (this.textures.exists(key)) this.textures.remove(key);
      this.textures.addImage(key, image);
      this.customStageTextureKey = key;
      this.stageBackdrop.setTexture(key).setDisplaySize(GAME_WIDTH * 1.08, GAME_HEIGHT * 1.12);
    } catch (error) {
      debugWarn('[AuraScene] Custom stage could not be loaded:', error instanceof Error ? error.message : error);
    }
  }

  private blobImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      };
      image.src = url;
    });
  }

  private createFighters(): void {
    const p1 = new Fighter(0, this.p1Name, 326, true);
    const p2 = new Fighter(1, this.p2Name, 698, false);
    p1.y = GROUND_Y;
    p2.y = GROUND_Y;
    this.fighters = [p1, p2];
    this.views = [new FighterView(p1, 'fighter_p1'), new FighterView(p2, 'fighter_p2')];
    for (const view of this.views) {
      view.createSprite(this);
      view.setRenderPresentation(this.fighterRenderScale, this.fighterRenderYOffset);
      this.worldLayer.add([view.shadowSprite!, view.sprite]);
    }
    this.auraPerformanceViews = [0, 1].map((slot) => {
      const pack = this.auraAnimationPacks[slot as AuraSlot];
      if (!pack) return null;
      const performanceView = new AuraPerformanceView(this, pack);
      this.worldLayer.add(performanceView.gameObjects());
      if (performanceView.has('aura_unbothered')) performanceView.play('aura_unbothered');
      return performanceView;
    }) as [AuraPerformanceView | null, AuraPerformanceView | null];
  }

  private createWorldEffects(): void {
    this.activeGlow = this.add.graphics().setDepth(7).setBlendMode(Phaser.BlendModes.ADD);
    this.activeGlow.fillStyle(0x4fdcff, 0.1);
    this.activeGlow.fillEllipse(0, 0, 260, 78);
    this.activeGlow.lineStyle(3, 0xffce3a, 0.72);
    this.activeGlow.strokeEllipse(0, 0, 238, 66);
    this.worldLayer.add(this.activeGlow);

    this.burstRing = this.add.graphics().setDepth(13).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.burstRing.lineStyle(7, 0x4fdcff, 0.94);
    this.burstRing.strokeCircle(0, 0, 58);
    this.worldLayer.add(this.burstRing);

    this.playerTags = [
      this.createPlayerTag(this.cpuVsCpu ? 'CPU 1' : 'P1', this.cpuVsCpu ? 0x68f59b : 0x4fdcff),
      this.createPlayerTag(
        this.cpuVsCpu ? 'CPU 2' : this.isCpuSlot(1) ? 'CPU' : 'P2',
        this.isCpuSlot(1) ? 0x68f59b : 0x8b4dff,
      ),
    ];
  }

  private createPlayerTag(label: string, color: number): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0).setDepth(30);
    const text = this.add.text(0, 0, label, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '11px',
      color: '#fff4d6',
    }).setOrigin(0.5);
    const width = Math.max(58, text.width + 24);
    const background = this.add.graphics();
    background.fillStyle(0x050507, 0.92);
    background.fillRoundedRect(-width / 2, -17, width, 34, 4);
    background.lineStyle(2, color, 1);
    background.strokeRoundedRect(-width / 2, -17, width, 34, 4);
    background.fillStyle(color, 1);
    background.fillTriangle(-6, 17, 6, 17, 0, 25);
    container.add([background, text]);
    this.worldLayer.add(container);
    return container;
  }

  private createUi(): void {
    this.uiLayer = this.add.container(0, 0).setDepth(500);
    const panel = this.add.graphics();
    panel.fillGradientStyle(0x050513, 0x12061c, 0x070719, 0x0d0718, 0.97);
    panel.fillRect(0, 0, GAME_WIDTH, 92);
    panel.fillStyle(0x4fdcff, 0.055);
    panel.fillRect(0, 0, GAME_WIDTH / 2, 92);
    panel.fillStyle(0xff3dc6, 0.045);
    panel.fillRect(GAME_WIDTH / 2, 0, GAME_WIDTH / 2, 92);
    panel.fillStyle(0x05050f, 0.94);
    panel.fillRoundedRect(326, 31, 372, 54, 8);
    panel.lineStyle(1, 0x6e5cba, 0.6);
    panel.strokeRoundedRect(326, 31, 372, 54, 8);
    panel.lineStyle(2, 0x4fdcff, 0.7);
    panel.lineBetween(0, 91, GAME_WIDTH / 2, 91);
    panel.lineStyle(2, 0xff3dc6, 0.62);
    panel.lineBetween(GAME_WIDTH / 2, 91, GAME_WIDTH, 91);
    this.uiLayer.add(panel);

    const balanceTrack = this.add.rectangle(512, 18, 620, 12, 0x09091c)
      .setStrokeStyle(2, 0x51458a, 0.9);
    this.p1Balance = this.add.rectangle(202, 19, 310, 8, 0x4fdcff).setOrigin(0, 0.5);
    this.p2Balance = this.add.rectangle(822, 19, 310, 8, 0xff3dc6).setOrigin(1, 0.5);
    this.balanceCrown = this.add.text(512, 18, '♛', {
      fontFamily: 'Georgia, serif', fontSize: '28px', color: '#ffce3a',
    }).setOrigin(0.5);
    this.uiLayer.add([balanceTrack, this.p1Balance, this.p2Balance, this.balanceCrown]);

    this.p1NameText = this.add.text(26, 36, this.p1Name.toUpperCase(), {
      fontFamily: '"Press Start 2P", monospace', fontSize: '11px', color: '#4fdcff',
    });
    this.p2NameText = this.add.text(998, 36, this.p2Name.toUpperCase(), {
      fontFamily: '"Press Start 2P", monospace', fontSize: '11px', color: '#ff65d0', align: 'right',
    }).setOrigin(1, 0);
    this.p1ScoreText = this.add.text(26, 59, '0 AURA', {
      fontFamily: '"Press Start 2P", monospace', fontSize: '17px', color: '#fff4d6',
    });
    this.p2ScoreText = this.add.text(998, 59, '0 AURA', {
      fontFamily: '"Press Start 2P", monospace', fontSize: '17px', color: '#fff4d6', align: 'right',
    }).setOrigin(1, 0);
    this.turnText = this.add.text(512, 45, 'AURA CHECK', {
      fontFamily: '"Press Start 2P", monospace', fontSize: '12px', color: '#ffce3a', align: 'center',
    }).setOrigin(0.5);
    this.phaseText = this.add.text(512, 70, 'FARM RESPONSIBLY', {
      fontFamily: '"Space Grotesk", sans-serif', fontSize: '13px', fontStyle: 'bold', color: '#fff4d6',
    }).setOrigin(0.5);
    this.comboText = this.add.text(26, 510, 'x0 FLOW', {
      fontFamily: '"Press Start 2P", monospace', fontSize: '18px', color: '#ffce3a',
      stroke: '#050507', strokeThickness: 6,
    });
    this.crowdLabelText = this.add.text(26, 536, 'CROWD · WATCHING', {
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: '10px',
      fontStyle: 'bold',
      color: '#fff4d6',
      stroke: '#050507',
      strokeThickness: 4,
    }).setVisible(false);
    this.crowdMeterGraphics = this.add.graphics().setVisible(false);
    this.highwayTitleText = this.add.text(0, 0, 'YOUR INPUT', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '9px',
      color: '#fff4d6',
      stroke: '#050507',
      strokeThickness: 4,
    }).setVisible(false);
    this.highwayMetaText = this.add.text(0, 0, '4K // LIVE', {
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: '9px',
      fontStyle: 'bold',
      color: '#4fdcff',
      stroke: '#050507',
      strokeThickness: 3,
    }).setOrigin(1, 0).setVisible(false);
    this.laneKeyTexts = Array.from({ length: 4 }, () => this.add.text(0, 542, '', {
      fontFamily: '"Space Grotesk", sans-serif', fontSize: '11px', fontStyle: 'bold', color: '#fff4d6', align: 'center',
      stroke: '#050507', strokeThickness: 4,
    }).setOrigin(0.5).setVisible(false));
    this.uiLayer.add([
      this.p1NameText,
      this.p2NameText,
      this.p1ScoreText,
      this.p2ScoreText,
      this.turnText,
      this.phaseText,
      this.comboText,
      this.crowdLabelText,
      ...this.laneKeyTexts,
    ]);

    this.laneGraphics = this.add.graphics();
    this.targetGraphics = this.add.graphics();
    this.inputFlashGraphics = Array.from({ length: 4 }, () => (
      this.add.graphics().setAlpha(0).setBlendMode(Phaser.BlendModes.ADD)
    ));
    this.inputPulseGraphics = Array.from({ length: 4 }, () => (
      this.add.graphics().setAlpha(0).setBlendMode(Phaser.BlendModes.ADD)
    ));
    this.uiLayer.add([
      this.laneGraphics,
      this.targetGraphics,
      ...this.inputFlashGraphics,
      ...this.inputPulseGraphics,
    ]);
    this.uiLayer.add([
      this.crowdMeterGraphics,
      this.highwayTitleText,
      this.highwayMetaText,
    ]);
    for (const text of this.laneKeyTexts) this.uiLayer.bringToTop(text);
    this.uiLayer.add(ScreenEffects.createCRTOverlay(this));
  }

  private createCameras(): void {
    this.uiCamera = this.cameras.add(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.cameras.main.setBounds(-80, -30, GAME_WIDTH + 160, GAME_HEIGHT + 60);
    this.cameras.main.ignore(this.uiLayer);
    this.uiCamera.ignore(this.worldLayer);
  }

  private createInput(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) return;
    const primaryKeys = this.primaryLaneKeys();
    this.keysP1 = primaryKeys.map((key) => keyboard.addKey(key, true));
    this.keysP2 = AURA_LOCAL_P2_LANE_KEYS.map((key) => keyboard.addKey(key, true));
    keyboard.addCapture([...new Set([...primaryKeys, ...AURA_LOCAL_P2_LANE_KEYS])]);
    this.keyBindings = [];
    if (this.cpuVsCpu) return;
    if (this.online) {
      this.bindKeySet(this.keysP1, this.online.localSlot);
      return;
    }
    if (!this.isCpuSlot(0)) this.bindKeySet(this.keysP1, 0);
    if (!this.isCpuSlot(1)) this.bindKeySet(this.keysP2, 1);
  }

  private bindKeySet(keys: Phaser.Input.Keyboard.Key[], slot: AuraSlot): void {
    keys.forEach((key, lane) => {
      const handler = () => this.handleInput(slot, lane as AuraLane);
      key.on('down', handler);
      this.keyBindings.push({ key, handler });
    });
  }

  private laneLayout(slot: AuraSlot, lane: AuraLane): LaneLayout {
    // The highway always occupies the side opposite the active performer.
    const center = slot === 0 ? 720 : 304;
    // Straight 4K rails keep screen-space velocity and note size fully honest.
    // The wider middle seam mirrors the physical gap between the player's hands.
    const offsets = [-150, -66, 66, 150] as const;
    const x = center + offsets[lane];
    return {
      startX: x,
      targetX: x,
      startY: LANE_START_Y,
      targetY: LANE_TARGET_Y,
    };
  }

  private primaryLaneKeys(): AuraLaneKeys {
    return this.online || this.isVsAI ? AURA_DEFAULT_LANE_KEYS : AURA_LOCAL_P1_LANE_KEYS;
  }

  private laneKeysForSlot(slot: AuraSlot): AuraLaneKeys {
    if (!this.online && !this.isVsAI && slot === 1) return AURA_LOCAL_P2_LANE_KEYS;
    return this.primaryLaneKeys();
  }

  private drawLanes(slot: AuraSlot): void {
    this.laneGraphics.clear();
    this.targetGraphics.clear();
    for (const graphics of [...this.inputFlashGraphics, ...this.inputPulseGraphics]) {
      this.tweens.killTweensOf(graphics);
      graphics.clear().setAlpha(0).setScale(1);
    }
    this.drawHighwayFrame(slot);
    for (let lane = 0; lane < 4; lane += 1) {
      const typedLane = lane as AuraLane;
      const layout = this.laneLayout(slot, typedLane);
      const color = LANE_COLORS[lane];
      this.laneGraphics.fillGradientStyle(0x11112b, 0x11112b, 0x05050d, 0x05050d, 0.6);
      this.laneGraphics.fillRect(
        layout.startX - LANE_HALF_WIDTH + 2,
        layout.startY,
        LANE_HALF_WIDTH * 2 - 4,
        layout.targetY - layout.startY,
      );
      this.laneGraphics.fillStyle(color, 0.035);
      this.laneGraphics.fillRect(
        layout.startX - LANE_HALF_WIDTH + 3,
        layout.startY,
        LANE_HALF_WIDTH * 2 - 6,
        layout.targetY - layout.startY,
      );
      this.laneGraphics.lineStyle(12, color, 0.065);
      this.laneGraphics.lineBetween(
        layout.startX - LANE_HALF_WIDTH,
        layout.startY,
        layout.targetX - LANE_HALF_WIDTH,
        layout.targetY,
      );
      this.laneGraphics.lineBetween(
        layout.startX + LANE_HALF_WIDTH,
        layout.startY,
        layout.targetX + LANE_HALF_WIDTH,
        layout.targetY,
      );
      this.laneGraphics.lineStyle(2, color, 0.88);
      this.laneGraphics.lineBetween(
        layout.startX - LANE_HALF_WIDTH,
        layout.startY,
        layout.targetX - LANE_HALF_WIDTH,
        layout.targetY,
      );
      this.laneGraphics.lineBetween(
        layout.startX + LANE_HALF_WIDTH,
        layout.startY,
        layout.targetX + LANE_HALF_WIDTH,
        layout.targetY,
      );
      this.laneGraphics.lineStyle(1, color, 0.18);
      this.laneGraphics.lineBetween(layout.startX, layout.startY, layout.targetX, layout.targetY);
      this.laneGraphics.fillStyle(color, 0.82);
      this.laneGraphics.fillRoundedRect(layout.startX - 14, layout.startY - 3, 28, 5, 2);
      this.targetGraphics.lineStyle(16, color, 0.075);
      this.targetGraphics.strokeRoundedRect(
        layout.targetX - RECEPTOR_WIDTH / 2,
        layout.targetY - RECEPTOR_HEIGHT / 2,
        RECEPTOR_WIDTH,
        RECEPTOR_HEIGHT,
        8,
      );
      this.targetGraphics.fillGradientStyle(0x11112b, 0x11112b, 0x05050c, 0x05050c, 0.78);
      this.targetGraphics.fillRoundedRect(
        layout.targetX - RECEPTOR_WIDTH / 2,
        layout.targetY - RECEPTOR_HEIGHT / 2,
        RECEPTOR_WIDTH,
        RECEPTOR_HEIGHT,
        8,
      );
      this.targetGraphics.lineStyle(3, color, 1);
      this.targetGraphics.strokeRoundedRect(
        layout.targetX - RECEPTOR_WIDTH / 2,
        layout.targetY - RECEPTOR_HEIGHT / 2,
        RECEPTOR_WIDTH,
        RECEPTOR_HEIGHT,
        8,
      );
      this.drawMarker(this.targetGraphics, layout.targetX, layout.targetY, typedLane, color, 19, false);
    }
    this.drawBeatGrid(slot);
    const keys = this.laneKeysForSlot(slot);
    this.laneKeyTexts.forEach((text, lane) => {
      const layout = this.laneLayout(slot, lane as AuraLane);
      text.setText(keys[lane]).setPosition(layout.targetX, KEY_LABEL_Y).setVisible(true);
    });
    // The match header and the four key labels already explain the interaction.
    // Leaving the highway header clean keeps the visual treatment close to the
    // reference without copying its redundant button legend.
    this.highwayTitleText.setVisible(false);
    this.highwayMetaText.setVisible(false);
  }

  private drawHighwayFrame(slot: AuraSlot): void {
    const left = this.laneLayout(slot, 0);
    const right = this.laneLayout(slot, 3);
    const frameLeft = left.startX - LANE_HALF_WIDTH - HIGHWAY_FRAME_PAD_X;
    const frameRight = right.startX + LANE_HALF_WIDTH + HIGHWAY_FRAME_PAD_X;
    const frameTop = LANE_START_Y - HIGHWAY_FRAME_PAD_TOP;
    const frameBottom = LANE_TARGET_Y + HIGHWAY_FRAME_PAD_BOTTOM;
    const corner = 14;
    const panel = [
      new Phaser.Geom.Point(frameLeft + corner, frameTop),
      new Phaser.Geom.Point(frameRight - corner, frameTop),
      new Phaser.Geom.Point(frameRight, frameTop + corner),
      new Phaser.Geom.Point(frameRight, frameBottom - corner),
      new Phaser.Geom.Point(frameRight - corner, frameBottom),
      new Phaser.Geom.Point(frameLeft + corner, frameBottom),
      new Phaser.Geom.Point(frameLeft, frameBottom - corner),
      new Phaser.Geom.Point(frameLeft, frameTop + corner),
    ];
    const shadow = panel.map((point) => new Phaser.Geom.Point(point.x + 8, point.y + 10));

    this.laneGraphics.fillStyle(0x000000, 0.42);
    this.laneGraphics.fillPoints(shadow, true);
    this.laneGraphics.fillGradientStyle(0x10102a, 0x1b0a2a, 0x04040c, 0x08040f, 0.5);
    this.laneGraphics.fillPoints(panel, true);
    this.laneGraphics.lineStyle(14, 0x765dff, 0.045);
    this.laneGraphics.strokePoints(panel, true);
    const roundProgress = this.currentRoundProgress();
    if (roundProgress > 0) {
      this.laneGraphics.lineStyle(10, 0xffce3a, 0.025 + roundProgress * 0.065);
      this.laneGraphics.strokePoints(panel, true);
    }
    this.laneGraphics.lineStyle(1, 0xfff4d6, 0.28);
    this.laneGraphics.strokePoints(panel, true);

    const seamX = (this.laneLayout(slot, 1).startX + this.laneLayout(slot, 2).startX) / 2;
    this.laneGraphics.lineStyle(3, 0x4fdcff, 0.92);
    this.laneGraphics.lineBetween(frameLeft + corner, frameTop, seamX - 24, frameTop);
    this.laneGraphics.lineBetween(frameLeft, frameTop + corner, frameLeft, frameBottom - corner);
    this.laneGraphics.lineStyle(3, 0xff3dc6, 0.86);
    this.laneGraphics.lineBetween(seamX + 24, frameTop, frameRight - corner, frameTop);
    this.laneGraphics.lineBetween(frameRight, frameTop + corner, frameRight, frameBottom - corner);
    this.laneGraphics.lineStyle(2, 0xffce3a, 0.72);
    this.laneGraphics.lineBetween(frameLeft + corner, frameBottom, frameRight - corner, frameBottom);

    this.laneGraphics.fillStyle(0x02020b, 0.42);
    this.laneGraphics.fillRect(seamX - 18, frameTop + 40, 36, LANE_TARGET_Y + RECEPTOR_HEIGHT / 2 - frameTop - 40);
    this.laneGraphics.lineStyle(1, 0xffce3a, 0.18);
    this.laneGraphics.lineBetween(seamX - 18, frameTop + 40, seamX - 18, LANE_TARGET_Y + RECEPTOR_HEIGHT / 2);
    this.laneGraphics.lineBetween(seamX + 18, frameTop + 40, seamX + 18, LANE_TARGET_Y + RECEPTOR_HEIGHT / 2);

    const crownY = frameTop + 20;
    this.laneGraphics.fillStyle(0xffce3a, 0.12 + roundProgress * 0.1);
    this.laneGraphics.fillCircle(seamX, crownY, 17);
    this.laneGraphics.fillStyle(0xffce3a, 0.94);
    this.laneGraphics.fillPoints([
      new Phaser.Geom.Point(seamX - 12, crownY + 5),
      new Phaser.Geom.Point(seamX - 10, crownY - 7),
      new Phaser.Geom.Point(seamX - 3, crownY - 1),
      new Phaser.Geom.Point(seamX, crownY - 12),
      new Phaser.Geom.Point(seamX + 4, crownY - 1),
      new Phaser.Geom.Point(seamX + 11, crownY - 8),
      new Phaser.Geom.Point(seamX + 12, crownY + 5),
    ], true);
    this.laneGraphics.fillRect(seamX - 12, crownY + 5, 24, 4);
  }

  private drawBeatGrid(slot: AuraSlot): void {
    const left = this.laneLayout(slot, 0);
    const leftInner = this.laneLayout(slot, 1);
    const rightInner = this.laneLayout(slot, 2);
    const right = this.laneLayout(slot, 3);
    for (const progress of [0.25, 0.5, 0.75]) {
      const y = Phaser.Math.Linear(left.startY, left.targetY, progress);
      this.laneGraphics.lineStyle(
        progress === 0.5 ? 2 : 1,
        0xfff4d6,
        progress === 0.5 ? 0.22 : 0.12,
      );
      this.laneGraphics.lineBetween(
        left.startX - LANE_HALF_WIDTH,
        y,
        leftInner.startX + LANE_HALF_WIDTH,
        y,
      );
      this.laneGraphics.lineBetween(
        rightInner.startX - LANE_HALF_WIDTH,
        y,
        right.startX + LANE_HALF_WIDTH,
        y,
      );
      for (const lane of [0, 1, 2, 3] as const) {
        const x = this.laneLayout(slot, lane).startX;
        this.laneGraphics.lineStyle(2, LANE_COLORS[lane], 0.3);
        this.laneGraphics.lineBetween(x - 5, y - 2, x, y + 2);
        this.laneGraphics.lineBetween(x, y + 2, x + 5, y - 2);
      }
    }
  }

  private drawMarker(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    lane: AuraLane,
    color: number,
    size: number,
    filled: boolean,
  ): void {
    graphics.lineStyle(filled ? 4 : 3, color, 1);
    graphics.fillStyle(filled ? color : 0x050507, filled ? 0.78 : 0.88);
    if (lane === 0) {
      const points = [
        new Phaser.Geom.Point(x, y - size * 0.64),
        new Phaser.Geom.Point(x + size * 0.72, y),
        new Phaser.Geom.Point(x, y + size * 0.64),
        new Phaser.Geom.Point(x - size * 0.72, y),
      ];
      if (filled) graphics.fillPoints(points, true);
      graphics.strokePoints(points, true);
    } else if (lane === 1) {
      if (filled) graphics.fillCircle(x, y, size * 0.6);
      graphics.strokeCircle(x, y, size * 0.6);
    } else if (lane === 2) {
      const points = Array.from({ length: 10 }, (_, index) => {
        const radius = index % 2 === 0 ? size * 0.72 : size * 0.32;
        const angle = -Math.PI / 2 + index * Math.PI / 5;
        return new Phaser.Geom.Point(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
      });
      if (filled) graphics.fillPoints(points, true);
      graphics.strokePoints(points, true);
    } else {
      const points = [
        new Phaser.Geom.Point(x - size * 0.72, y - size * 0.52),
        new Phaser.Geom.Point(x + size * 0.72, y - size * 0.52),
        new Phaser.Geom.Point(x, y + size * 0.7),
      ];
      if (filled) graphics.fillPoints(points, true);
      graphics.strokePoints(points, true);
    }
  }

  private createNote(noteId: string, lane: AuraLane): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0).setDepth(520);
    const glow = this.add.graphics().setBlendMode(Phaser.BlendModes.ADD);
    glow.fillStyle(LANE_COLORS[lane], 0.08);
    glow.fillCircle(0, 0, 25);
    glow.lineStyle(7, LANE_COLORS[lane], 0.08);
    this.drawMarker(glow, 0, 1, lane, LANE_COLORS[lane], 19, false);
    const marker = this.add.graphics();
    this.drawMarker(marker, 0, 1, lane, LANE_COLORS[lane], 17, true);
    container.add([glow, marker]);
    this.uiLayer.add(container);
    this.noteObjects.set(noteId, container);
    return container;
  }

  private updateNotes(nowMs: number): void {
    const turn = auraTurnAt(this.chart, nowMs);
    if (!turn || this.finalizing) {
      this.clearNotes();
      return;
    }
    const activeIds = new Set<string>();
    for (const note of turn.notes) {
      if (this.battle.isJudged(note.id)) continue;
      const until = note.atMs - nowMs;
      if (until > AURA_NOTE_TRAVEL_MS || until < -getAuraDifficulty(this.difficultyId).goodWindowMs) continue;
      activeIds.add(note.id);
      const object = this.noteObjects.get(note.id) ?? this.createNote(note.id, note.lane);
      const layout = this.laneLayout(turn.slot, note.lane);
      const progress = auraNoteTravelProgress(note.atMs, nowMs);
      object.setPosition(
        Phaser.Math.Linear(layout.startX, layout.targetX, progress),
        Phaser.Math.Linear(layout.startY, layout.targetY, progress),
      );
      object.setScale(1);
      object.setAlpha(until < 0 ? Math.max(0.22, 1 + until / 240) : 1);
    }
    for (const [id, object] of this.noteObjects) {
      if (activeIds.has(id)) continue;
      object.destroy();
      this.noteObjects.delete(id);
    }
  }

  private clearNotes(): void {
    for (const object of this.noteObjects.values()) object.destroy();
    this.noteObjects.clear();
  }

  private updateTurn(nowMs: number): void {
    const turn = auraTurnAt(this.chart, nowMs);
    const turnIndex = turn?.index ?? (nowMs < this.chart.firstTurnMs ? -1 : this.chart.turns.length);
    if (turnIndex !== this.currentTurnIndex) this.updateTurnPresentation(turnIndex);

    if (!turn) {
      if (nowMs < this.chart.firstTurnMs) {
        const beats = Math.max(1, Math.ceil((this.chart.firstTurnMs - nowMs) / this.chart.beatMs));
        this.turnText.setText('AURA CHECK');
        this.phaseText.setText(beats > 4 ? 'THE ROOM IS WATCHING' : `STARTS IN ${beats}`);
      } else if (!this.finalizing) {
        this.turnText.setText('FINAL AURA CHECK');
        this.phaseText.setText('POSE LIKE THE RENT IS DUE');
      }
      return;
    }

    const countIn = turn.firstNoteMs - nowMs;
    const performerLabel = this.cpuVsCpu
      ? `CPU ${turn.slot + 1}`
      : turn.slot === 0 ? 'P1' : this.isCpuSlot(1) ? 'CPU' : 'P2';
    this.turnText.setText(turn.round === AURA_ROUNDS - 1
      ? `${performerLabel} PERFORMANCE · FINAL ROUND`
      : `${performerLabel} PERFORMANCE · ROUND ${turn.round + 1}`);
    this.phaseText.setText(countIn > 0
      ? `AURA IN ${Math.max(1, Math.ceil(countIn / this.chart.beatMs))}`
      : this.cpuVsCpu
        ? 'WATCH THE AURA ECONOMY'
        : this.isCpuSlot(turn.slot)
          ? 'CPU IS FARMING'
          : this.online && turn.slot !== this.localControlledSlot()
            ? 'RIVAL IS FARMING'
            : 'HIT THE SHAPES · DO NOT PANIC');
    const activeScore = this.battle.scoreFor(turn.slot);
    this.comboText.setText(`x${activeScore.combo} FLOW`);
  }

  private updateTurnPresentation(turnIndex: number): void {
    this.currentTurnIndex = turnIndex;
    this.clearNotes();
    if (turnIndex < 0 || turnIndex >= this.chart.turns.length) {
      this.laneGraphics.clear();
      this.targetGraphics.clear();
      this.laneKeyTexts.forEach((text) => text.setVisible(false));
      this.highwayTitleText.setVisible(false);
      this.highwayMetaText.setVisible(false);
      this.updateCrowdUi(null);
      this.focusBoth();
      return;
    }
    const turn = this.chart.turns[turnIndex];
    this.mistakeStreak[turn.slot] = 0;
    this.drawLanes(turn.slot);
    this.comboText
      .setOrigin(turn.slot === 0 ? 0 : 1, 0)
      .setX(turn.slot === 0 ? 26 : 998);
    this.updateCrowdUi(turn.slot);
    const locallyPlayable = !this.isCpuSlot(turn.slot)
      && (!this.online || turn.slot === this.online.localSlot);
    this.laneKeyTexts.forEach((text) => text.setVisible(locallyPlayable));
    this.focusPerformer(turn.slot);
  }

  private focusPerformer(slot: AuraSlot): void {
    this.activePerformerSlot = slot;
    const activeX = this.fighters[slot].x;
    const inactive = (1 - slot) as AuraSlot;
    this.shrugReactionEpoch[slot] += 1;
    const activePerformanceView = this.auraPerformanceViews[slot];
    if (activePerformanceView?.has('aura_unbothered')) {
      activePerformanceView.play('aura_unbothered');
    } else {
      activePerformanceView?.interrupt(this.views[slot]);
    }
    this.activeGlow.setPosition(activeX, GROUND_Y + this.fighterRenderYOffset + 5);
    this.views[slot].sprite.setAlpha(1);
    this.views[slot].shadowSprite?.setAlpha(0.2);
    this.views[inactive].sprite.setAlpha(0.52);
    this.views[inactive].shadowSprite?.setAlpha(0.09);
    this.views[slot].setRenderPresentation(this.fighterRenderScale * 1.28, this.fighterRenderYOffset);
    this.views[inactive].setRenderPresentation(this.fighterRenderScale * 0.7, this.fighterRenderYOffset);
    this.drawStageLighting(slot, this.stageEnergyForSlot(slot));
    this.syncCrowdMix(slot);
    const camera = this.cameras.main;
    const targetScrollX = slot === 0 ? 46 : -46;
    if (this.reduceMotion) {
      camera.setZoom(1.12).setScroll(targetScrollX, 4);
    } else {
      this.tweens.killTweensOf(camera);
      this.tweens.add({
        targets: camera,
        zoom: 1.12,
        scrollX: targetScrollX,
        scrollY: 4,
        duration: 520,
        ease: 'Quart.easeOut',
      });
    }
  }

  private focusBoth(): void {
    if (!this.views) return;
    this.activePerformerSlot = null;
    this.highwayTitleText?.setVisible(false);
    this.highwayMetaText?.setVisible(false);
    this.updateCrowdUi(null);
    for (const [slot, view] of this.views.entries()) {
      this.shrugReactionEpoch[slot as AuraSlot] += 1;
      view.sprite.setAlpha(0.9);
      view.shadowSprite?.setAlpha(0.16);
      view.setRenderPresentation(this.fighterRenderScale, this.fighterRenderYOffset);
      const performanceView = this.auraPerformanceViews[slot as AuraSlot];
      if (performanceView?.has('aura_unbothered')) performanceView.play('aura_unbothered');
      else performanceView?.interrupt(view);
    }
    this.drawStageLighting(null, 0);
    const roomHeat = Math.max(this.crowdHeat[0], this.crowdHeat[1]);
    this.soundManager?.setAuraCrowdMix(roomHeat, this.finalizing ? 1 : 0);
    this.activeGlow?.setPosition(GAME_WIDTH / 2, GROUND_Y + this.fighterRenderYOffset + 5).setAlpha(0.5);
    const camera = this.cameras.main;
    if (this.reduceMotion) camera.setZoom(1).setScroll(0, 0);
    else {
      this.tweens.killTweensOf(camera);
      this.tweens.add({ targets: camera, zoom: 1, scrollX: 0, scrollY: 0, duration: 420, ease: 'Quart.easeOut' });
    }
  }

  private updateCrowdUi(slot: AuraSlot | null): void {
    if (slot === null) {
      this.crowdLabelText?.setVisible(false);
      this.crowdMeterGraphics?.clear().setVisible(false);
      return;
    }

    const heat = this.crowdHeat[slot];
    const status = heat >= 0.92
      ? 'UNHINGED'
      : heat >= 0.68
        ? 'FERAL'
        : heat >= 0.4
          ? 'LOUD'
          : heat >= 0.18
            ? 'WARMING UP'
            : 'WATCHING';
    const rightAligned = slot === 1;
    const anchorX = rightAligned ? 998 : 26;
    this.crowdLabelText
      .setText(`CROWD · ${status}`)
      .setOrigin(rightAligned ? 1 : 0, 0)
      .setPosition(anchorX, 535)
      .setVisible(true);

    const segmentWidth = 22;
    const gap = 5;
    const trackWidth = CROWD_METER_SEGMENTS * segmentWidth + (CROWD_METER_SEGMENTS - 1) * gap;
    const trackLeft = rightAligned ? anchorX - trackWidth : anchorX;
    const filled = Math.ceil(heat * CROWD_METER_SEGMENTS);
    this.crowdMeterGraphics.clear().setVisible(true);
    this.crowdMeterGraphics.fillStyle(0x05050f, 0.82);
    this.crowdMeterGraphics.fillRoundedRect(trackLeft - 4, 551 - 4, trackWidth + 8, 14, 4);
    for (let index = 0; index < CROWD_METER_SEGMENTS; index += 1) {
      const x = trackLeft + index * (segmentWidth + gap);
      const color = index < 4 ? 0x4fdcff : index < 6 ? 0xa976ff : index === 6 ? 0xff3dc6 : 0xffce3a;
      this.crowdMeterGraphics.fillStyle(index < filled ? color : 0x29263e, index < filled ? 0.95 : 0.72);
      this.crowdMeterGraphics.fillRoundedRect(x, 551, segmentWidth, 6, 2);
    }
  }

  private flashLaneInput(slot: AuraSlot, lane: AuraLane): void {
    const flash = this.inputFlashGraphics[lane];
    const pulse = this.inputPulseGraphics[lane];
    const keyText = this.laneKeyTexts[lane];
    if (!flash || !pulse || !keyText) return;

    const layout = this.laneLayout(slot, lane);
    const color = LANE_COLORS[lane];
    this.tweens.killTweensOf(flash);
    this.tweens.killTweensOf(pulse);
    this.tweens.killTweensOf(keyText);
    flash.clear();
    flash.fillStyle(color, 0.08);
    flash.fillRect(
      layout.targetX - LANE_HALF_WIDTH,
      layout.startY,
      LANE_HALF_WIDTH * 2,
      layout.targetY - layout.startY,
    );
    flash.fillStyle(color, 0.18);
    flash.fillRect(
      layout.targetX - LANE_HALF_WIDTH,
      layout.targetY - 82,
      LANE_HALF_WIDTH * 2,
      82,
    );
    flash.fillStyle(color, 0.98);
    flash.fillRoundedRect(
      layout.targetX - RECEPTOR_WIDTH / 2,
      layout.targetY - RECEPTOR_HEIGHT / 2,
      RECEPTOR_WIDTH,
      RECEPTOR_HEIGHT,
      8,
    );
    flash.lineStyle(4, 0xffffff, 1);
    flash.strokeRoundedRect(
      layout.targetX - RECEPTOR_WIDTH / 2,
      layout.targetY - RECEPTOR_HEIGHT / 2,
      RECEPTOR_WIDTH,
      RECEPTOR_HEIGHT,
      8,
    );
    this.drawMarker(flash, layout.targetX, layout.targetY, lane, 0xffffff, 20, true);
    flash.setAlpha(1);

    pulse.clear();
    pulse.lineStyle(6, color, 0.9);
    pulse.strokeRoundedRect(
      -RECEPTOR_WIDTH / 2,
      -RECEPTOR_HEIGHT / 2,
      RECEPTOR_WIDTH,
      RECEPTOR_HEIGHT,
      8,
    );
    pulse.setPosition(layout.targetX, layout.targetY).setScale(0.9).setAlpha(1);

    keyText.setColor('#ffffff').setPosition(layout.targetX, KEY_LABEL_Y).setScale(1.18);

    if (this.reduceMotion) {
      this.time.delayedCall(120, () => {
        flash.setAlpha(0);
        pulse.setAlpha(0);
        keyText.setColor('#fff4d6').setPosition(layout.targetX, KEY_LABEL_Y).setScale(1);
      });
      return;
    }
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 230,
      ease: 'Quart.easeOut',
    });
    this.tweens.add({
      targets: pulse,
      scaleX: 1.32,
      scaleY: 1.32,
      alpha: 0,
      duration: 230,
      ease: 'Quart.easeOut',
    });
    this.tweens.add({
      targets: keyText,
      scaleX: 1,
      scaleY: 1,
      duration: 190,
      ease: 'Quart.easeOut',
      onComplete: () => keyText.setColor('#fff4d6'),
    });
  }

  private handleInput(slot: AuraSlot, lane: AuraLane, nowMs = this.clockMs()): void {
    if (this.matchFinished || this.finalizing || this.isCpuSlot(slot)) return;
    if (this.online && this.online.localSlot !== slot) return;
    if (auraTurnAt(this.chart, nowMs)?.slot === slot) this.flashLaneInput(slot, lane);
    const judgement = this.battle.judgeInput(slot, lane, nowMs);
    if (judgement.grade === 'wrong_turn') {
      if (nowMs - this.lastWrongTurnFeedbackAt > 650) {
        this.lastWrongTurnFeedbackAt = nowMs;
        this.showFeedback(judgement);
      }
      return;
    }
    this.applyJudgement(judgement, true);
  }

  private playCpuPlans(nowMs: number): void {
    for (const slot of [0, 1] as const) {
      if (!this.isCpuSlot(slot)) continue;
      const plan = this.cpuPlans[slot];
      while (this.cpuPlanIndices[slot] < plan.length && plan[this.cpuPlanIndices[slot]].atMs <= nowMs) {
        const hit = plan[this.cpuPlanIndices[slot]++];
        const judgement = this.battle.judgeNote(hit.noteId, hit.grade, hit.offsetMs);
        if (judgement) this.applyJudgement(judgement, false);
      }
    }
  }

  private collectHumanMisses(nowMs: number): void {
    let slots: AuraSlot[];
    if (this.online) slots = [this.online.localSlot];
    else slots = ([0, 1] as AuraSlot[]).filter((slot) => !this.isCpuSlot(slot));
    for (const judgement of this.battle.collectMisses(nowMs, slots)) {
      this.applyJudgement(judgement, true);
    }
  }

  private applyJudgement(judgement: AuraJudgement, broadcast: boolean): void {
    const noteObject = judgement.noteId ? this.noteObjects.get(judgement.noteId) : null;
    if (noteObject) {
      this.noteObjects.delete(judgement.noteId!);
      if (
        (judgement.grade === 'perfect' || judgement.grade === 'great' || judgement.grade === 'good')
        && !this.reduceMotion
      ) {
        const hitScale = judgement.grade === 'perfect' ? 1.7 : judgement.grade === 'great' ? 1.45 : 1.25;
        this.tweens.add({
          targets: noteObject,
          scale: hitScale,
          alpha: 0,
          duration: 180,
          ease: 'Quart.easeOut',
          onComplete: () => noteObject.destroy(),
        });
      } else {
        noteObject.destroy();
      }
    }
    this.animateFighterForJudgement(judgement);
    this.updateOpponentReaction(judgement);
    this.showFeedback(judgement);
    this.updateScoreUi();
    if (judgement.grade !== 'wrong_turn') this.reactCrowd(judgement);

    if (
      broadcast
      && this.onlineSession
      && this.online
      && judgement.noteId
      && judgement.grade !== 'mash'
      && judgement.grade !== 'wrong_turn'
    ) {
      this.onlineSession.transport.sendControl({
        t: 'aura_judgement',
        matchSerial: this.online.matchSerial,
        noteId: judgement.noteId,
        grade: judgement.grade,
        offsetMs: judgement.offsetMs,
      } satisfies AuraOnlineControl);
    }
  }

  private reactCrowd(judgement: AuraJudgement): void {
    const slot = judgement.slot;
    if (judgement.grade === 'miss' || judgement.grade === 'mash') {
      const heatBeforeFailure = this.crowdHeat[slot];
      this.crowdHeat[slot] = Math.max(0, heatBeforeFailure - (judgement.grade === 'miss' ? 0.55 : 0.28));
      this.refreshCrowdPresentation(slot);
      this.syncCrowdMix(
        slot,
        judgement.grade === 'miss' ? 0.58 + heatBeforeFailure * 0.42 : 0.42 + heatBeforeFailure * 0.24,
      );
      return;
    }

    const gain = judgement.grade === 'perfect' ? 0.16 : judgement.grade === 'great' ? 0.11 : 0.07;
    const comboHeat = Math.min(1, judgement.combo / 14);
    this.crowdHeat[slot] = Math.min(1, Math.max(comboHeat, this.crowdHeat[slot] + gain));
    this.refreshCrowdPresentation(slot);
    this.syncCrowdMix(slot);
  }

  private updateOpponentReaction(judgement: AuraJudgement): void {
    if (judgement.grade === 'wrong_turn') return;
    const failingSlot = judgement.slot;
    if (judgement.grade !== 'miss' && judgement.grade !== 'mash') {
      this.mistakeStreak[failingSlot] = 0;
      return;
    }

    this.mistakeStreak[failingSlot] += 1;
    if (
      this.activePerformerSlot !== failingSlot
      || this.mistakeStreak[failingSlot] < SHRUG_REACTION_MISTAKES
    ) return;

    const now = this.time.now;
    if (now - this.lastShrugReactionAt[failingSlot] < SHRUG_REACTION_COOLDOWN_MS) return;
    const reactingSlot = (1 - failingSlot) as AuraSlot;
    const reactionView = this.auraPerformanceViews[reactingSlot];
    if (!reactionView?.play('aura_shrug')) return;

    this.mistakeStreak[failingSlot] = 0;
    this.lastShrugReactionAt[failingSlot] = now;
    this.views[reactingSlot].sprite.setAlpha(0.82);
    const reactionEpoch = ++this.shrugReactionEpoch[reactingSlot];
    this.time.delayedCall(SHRUG_REACTION_DURATION_MS, () => {
      if (
        !this.lifecycleActive
        || this.shrugReactionEpoch[reactingSlot] !== reactionEpoch
        || this.activePerformerSlot === reactingSlot
      ) return;
      const currentReactionView = this.auraPerformanceViews[reactingSlot];
      if (currentReactionView?.has('aura_unbothered')) {
        currentReactionView.play('aura_unbothered');
      } else {
        currentReactionView?.interrupt(this.views[reactingSlot]);
      }
      this.views[reactingSlot].sprite.setAlpha(0.52);
    });
  }

  private refreshCrowdPresentation(slot: AuraSlot): void {
    if (this.activePerformerSlot !== slot) return;
    this.updateCrowdUi(slot);
    this.drawStageLighting(slot, this.stageEnergyForSlot(slot));
  }

  private currentRoundProgress(): number {
    const round = this.chart.turns[this.currentTurnIndex]?.round ?? 0;
    return Phaser.Math.Clamp(round / Math.max(1, AURA_ROUNDS - 1), 0, 1);
  }

  private stageEnergyForSlot(slot: AuraSlot): number {
    return Phaser.Math.Clamp(this.crowdHeat[slot] + this.currentRoundProgress() * 0.16, 0, 1);
  }

  private syncCrowdMix(slot: AuraSlot, negativePunch = 0): void {
    this.soundManager.setAuraCrowdMix(this.crowdHeat[slot], this.currentRoundProgress(), negativePunch);
  }

  private animateFighterForJudgement(judgement: AuraJudgement): void {
    const fighter = this.fighters[judgement.slot];
    const performanceView = this.auraPerformanceViews[judgement.slot];
    if (judgement.grade === 'miss' || judgement.grade === 'mash') {
      performanceView?.interrupt(
        this.views[judgement.slot],
        !this.fightSpritePacksLoaded[judgement.slot],
      );
      fighter.forceState(FighterState.HIT_STUN);
      fighter.stunFrames = judgement.grade === 'miss' ? 12 : 7;
      return;
    }
    if (judgement.grade === 'wrong_turn') return;
    const note = judgement.noteId
      ? this.chart.notes.find((entry) => entry.id === judgement.noteId) ?? null
      : null;
    const routine = note ? createAuraPerformanceRoutine(this.matchSeed, this.chart.turns[note.turnIndex].round) : null;
    const requestedPerformance = this.canaryPerformanceOverride
      ?? (note && routine ? auraPerformanceAtBeat(routine, note.beat) : null);
    let customPerformancePlayed = requestedPerformance
      ? performanceView?.play(requestedPerformance) ?? false
      : false;
    // A partial local pack is useful for reviewing a paid canary before the
    // remaining five animations exist. It is never considered publishable,
    // but the one available performance can still be exercised in-game.
    if (!customPerformancePlayed && performanceView && !this.auraAnimationPacks[judgement.slot]?.complete) {
      const canary = performanceView.firstRoutineAnimation();
      customPerformancePlayed = canary ? performanceView.play(canary) : false;
    }
    if (customPerformancePlayed) {
      fighter.forceState(FighterState.IDLE);
    } else {
      const states = [
        FighterState.HIGH_PUNCH,
        FighterState.LOW_KICK,
        FighterState.HIGH_KICK,
        FighterState.UPPERCUT,
      ] as const;
      fighter.forceState(states[judgement.lane]);
    }
    if (judgement.grade === 'perfect' || judgement.grade === 'great') {
      this.spawnPerformanceSparks(judgement);
    }
    if (judgement.grade === 'perfect') this.playAuraBurst(judgement.slot, judgement.lane);
  }

  private spawnPerformanceSparks(judgement: AuraJudgement): void {
    if (this.reduceMotion) return;
    const top = this.getPerformerTopCenter(judgement.slot);
    const count = judgement.grade === 'perfect' ? (judgement.combo >= 8 ? 12 : 8) : 5;
    const color = LANE_COLORS[judgement.lane];
    for (let index = 0; index < count; index += 1) {
      const direction = index % 2 === 0 ? -1 : 1;
      const spark = this.add.rectangle(
        top.x + direction * (8 + (index % 3) * 7),
        top.y + 94 + (index % 4) * 9,
        3 + (index % 2) * 2,
        9 + (index % 3) * 3,
        color,
        0.9,
      ).setDepth(18).setBlendMode(Phaser.BlendModes.ADD).setAngle(index * 29);
      this.worldLayer.add(spark);
      this.tweens.add({
        targets: spark,
        x: spark.x + direction * (38 + index * 7),
        y: spark.y - 42 - (index % 4) * 17,
        angle: spark.angle + direction * 100,
        alpha: 0,
        duration: 340 + index * 22,
        ease: 'Quart.easeOut',
        onComplete: () => spark.destroy(),
      });
    }
  }

  private playAuraBurst(slot: AuraSlot, lane: AuraLane): void {
    const top = this.getPerformerTopCenter(slot);
    this.burstRing.clear();
    this.burstRing.lineStyle(7, LANE_COLORS[lane], 0.94);
    this.burstRing.strokeCircle(0, 0, 58);
    this.burstRing
      .setPosition(top.x, top.y + 96)
      .setScale(0.45)
      .setAlpha(0.95);
    if (this.reduceMotion) {
      this.burstRing.setAlpha(0);
      return;
    }
    this.tweens.killTweensOf(this.burstRing);
    this.tweens.add({
      targets: this.burstRing,
      scaleX: 2.1,
      scaleY: 2.1,
      alpha: 0,
      duration: 330,
      ease: 'Quart.easeOut',
    });
    this.cameras.main.shake(70, 0.0022);
  }

  private showFeedback(judgement: AuraJudgement): void {
    const score = this.battle.scoreFor(judgement.slot);
    const primary = judgement.grade === 'perfect'
      ? score.combo >= 12 ? 'MAIN CHARACTER' : 'PERFECT'
      : judgement.grade === 'great'
        ? 'CLEAN'
        : judgement.grade === 'good'
          ? 'STILL COUNTS'
          : judgement.grade === 'miss'
            ? 'AURA LOST'
            : judgement.grade === 'mash'
              ? 'DESPERATE INPUT'
              : 'WAIT YOUR TURN';
    const secondary = judgement.grade === 'wrong_turn'
      ? 'THE CAMERA IS NOT ON YOU'
      : judgement.scoreDelta > 0
        ? `+${formatAura(judgement.scoreDelta)} AURA`
        : `-${formatAura(Math.abs(judgement.scoreDelta))} AURA`;
    const color = judgement.grade === 'perfect'
      ? '#4fdcff'
      : judgement.grade === 'great'
        ? '#a976ff'
        : judgement.grade === 'good'
          ? '#ffce3a'
          : '#ef4343';
    const x = judgement.slot === 0 ? 536 : 488;
    const align = judgement.slot === 0 ? 'left' : 'right';
    const container = this.add.container(x, 130).setDepth(700);
    const title = this.add.text(0, 0, primary, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: judgement.grade === 'perfect' ? '26px' : '18px',
      color,
      align,
      stroke: '#050507',
      strokeThickness: 8,
    }).setOrigin(judgement.slot === 0 ? 0 : 1, 0);
    const delta = this.add.text(0, title.height + 8, secondary, {
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: '14px',
      fontStyle: 'bold',
      color: '#fff4d6',
      align,
      stroke: '#050507',
      strokeThickness: 5,
    }).setOrigin(judgement.slot === 0 ? 0 : 1, 0);
    container.add([title, delta]);
    this.uiLayer.add(container);
    if (this.reduceMotion) {
      this.time.delayedCall(360, () => container.destroy());
      return;
    }
    container.setScale(0.82).setAlpha(0);
    this.tweens.add({ targets: container, scale: 1, alpha: 1, duration: 130, ease: 'Quart.easeOut' });
    this.tweens.add({
      targets: container,
      y: 114,
      alpha: 0,
      delay: 520,
      duration: 210,
      ease: 'Quad.easeIn',
      onComplete: () => container.destroy(),
    });
  }

  private updateScoreUi(): void {
    const p1 = this.battle.scoreFor(0);
    const p2 = this.battle.scoreFor(1);
    this.p1ScoreText.setText(`${formatAura(p1.score)} AURA`);
    this.p2ScoreText.setText(`${formatAura(p2.score)} AURA`);
    const total = p1.score + p2.score;
    const ratio = total <= 0 ? 0.5 : Phaser.Math.Clamp(p1.score / total, 0.08, 0.92);
    this.p1Balance.setDisplaySize(620 * ratio, 8);
    this.p2Balance.setDisplaySize(620 * (1 - ratio), 8);
    this.balanceCrown.setX(202 + 620 * ratio);
  }

  private advanceFighterPresentation(dt: number): void {
    if (!this.fighters || !this.views) return;
    this.fighters[0].update(dt, EMPTY_INPUT, this.fighters[1].x);
    this.fighters[1].update(dt, EMPTY_INPUT, this.fighters[0].x);
    this.views[0].syncSprite(this.fighters[1].x);
    this.views[1].syncSprite(this.fighters[0].x);
    if (this.activePerformerSlot !== null) {
      const inactive = (1 - this.activePerformerSlot) as AuraSlot;
      const offset = this.activePerformerSlot === 0
        ? INACTIVE_PERFORMER_STAGE_OFFSET
        : -INACTIVE_PERFORMER_STAGE_OFFSET;
      this.views[inactive].sprite.setX(this.views[inactive].sprite.x + offset);
      this.views[inactive].shadowSprite?.setX(this.views[inactive].shadowSprite.x + offset);
    }
    for (const slot of [0, 1] as const) {
      this.auraPerformanceViews[slot]?.update(dt * 1_000, this.views[slot]);
      const top = this.getPerformerTopCenter(slot);
      this.playerTags[slot]?.setPosition(top.x, Math.max(130, top.y - 25));
    }
  }

  private getPerformerTopCenter(slot: AuraSlot): { x: number; y: number } {
    return this.auraPerformanceViews[slot]?.getVisibleTopCenter()
      ?? this.views[slot].getVisibleTopCenter();
  }

  private isCpuSlot(slot: AuraSlot): boolean {
    if (this.online) return false;
    return this.cpuVsCpu || (this.isVsAI && slot === 1);
  }

  private localControlledSlot(): AuraSlot {
    return this.online?.localSlot ?? 0;
  }

  private beginClock(delayMs: number): void {
    if (this.scheduledClockStart !== null || this.clockStartedAt !== null) return;
    this.scheduledClockStart = performance.now() + delayMs;
    this.soundManager.stopBattleMusic();
    this.time.delayedCall(delayMs, () => {
      if (!this.lifecycleActive || this.clockStartedAt !== null) return;
      this.clockStartedAt = performance.now();
      this.scheduledClockStart = null;
      this.pausedDuration = 0;
      this.soundManager.startBattleMusic();
      this.soundManager.startAuraCrowd();
      debugInfo('[AuraScene] Beat clock started', { seed: this.matchSeed, difficulty: this.difficultyId });
    });
  }

  private clockMs(): number {
    if (this.clockStartedAt === null) return -1;
    const now = this.paused ? this.pausedAt : performance.now();
    return Math.max(0, now - this.clockStartedAt - this.pausedDuration);
  }

  private beginFinalization(): void {
    this.finalizing = true;
    this.finalizingStartedAt = performance.now();
    this.clearNotes();
    this.laneGraphics.clear();
    this.targetGraphics.clear();
    this.laneKeyTexts.forEach((text) => text.setVisible(false));
    this.turnText.setText('FINAL AURA CHECK');
    this.phaseText.setText(this.online ? 'VERIFYING THE VIBES' : 'THE ROOM HAS DECIDED');
    this.focusBoth();
    if (this.online && this.onlineSession && !this.localFinishSent) {
      this.localFinishSent = true;
      this.onlineSession.transport.sendControl({
        t: 'aura_finish',
        matchSerial: this.online.matchSerial,
        score: this.battle.scoreFor(this.online.localSlot),
      } satisfies AuraOnlineControl);
    }
  }

  private maybeCompleteFinalization(): void {
    if (this.matchFinished) return;
    if (
      this.online
      && !this.remoteFinalScore
      && !this.opponentLeft
      && performance.now() - this.finalizingStartedAt < ONLINE_FINISH_GRACE_MS
    ) return;
    this.completeMatch();
  }

  private completeMatch(): void {
    if (this.matchFinished) return;
    this.matchFinished = true;
    const p1Score = this.online?.localSlot === 1 && this.remoteFinalScore
      ? scoreCopy(this.remoteFinalScore)
      : this.battle.scoreFor(0);
    const p2Score = this.online?.localSlot === 0 && this.remoteFinalScore
      ? scoreCopy(this.remoteFinalScore)
      : this.battle.scoreFor(1);
    const winner: AuraBattleCompleteDetail['winnerSlot'] = p1Score.score === p2Score.score
      ? 'draw'
      : p1Score.score > p2Score.score ? 'p1' : 'p2';
    if (winner === 'p1') {
      this.fighters[0].forceState(FighterState.VICTORY);
      this.fighters[1].forceState(FighterState.DEFEAT);
    } else if (winner === 'p2') {
      this.fighters[1].forceState(FighterState.VICTORY);
      this.fighters[0].forceState(FighterState.DEFEAT);
    } else {
      this.fighters[0].forceState(FighterState.VICTORY);
      this.fighters[1].forceState(FighterState.VICTORY);
    }
    const summary: AuraBattleCompleteDetail = {
      winnerSlot: winner,
      p1Name: this.p1Name,
      p2Name: this.p2Name,
      p1Score,
      p2Score,
      p1Rank: auraRank(p1Score),
      p2Rank: auraRank(p2Score),
      durationSeconds: Math.round(this.chart.durationMs / 100) / 10,
      difficulty: this.difficultyId,
      stageId: this.resolvedStageId,
      stageLabel: this.stageLabel,
      ...(this.online ? { online: this.online } : {}),
    };
    this.turnText.setText(winner === 'draw' ? 'MUTUAL MAIN CHARACTERS' : `${winner === 'p1' ? this.p1Name : this.p2Name} OWNS THE ROOM`);
    this.phaseText.setText(winner === 'draw' ? 'IMPOSSIBLE AURA EQUILIBRIUM' : '+∞ AURA · RECEIPTS ATTACHED');
    this.soundManager.playAnnounce('wins');
    this.soundManager.peakAuraCrowd();
    window.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: summary }));
    this.time.delayedCall(this.reduceMotion ? 80 : 620, () => this.setMatchActionsVisible(true));
  }

  private attachOnlineSession(online: OnlineMatchInfo): boolean {
    const session = getActiveOnlineSession();
    if (!session || session.roomCode !== online.roomCode) return false;
    this.onlineSession = session;
    this.onlineUnsubscribe.push(
      session.transport.onControl((value) => this.onOnlineControl(value)),
      session.transport.onState((state) => this.onTransportState(state)),
    );
    this.emitOnlineRematchState('idle');
    return true;
  }

  private announceOnlineReady(): void {
    if (!this.online || !this.onlineSession || !this.localOnlineReady) return;
    const sent = this.onlineSession.transport.sendControl({
      t: 'aura_ready', matchSerial: this.online.matchSerial,
    } satisfies AuraOnlineControl);
    if (sent) this.maybeAnnounceOnlineClock();
  }

  private maybeAnnounceOnlineClock(): void {
    if (
      !this.online
      || !this.onlineSession
      || this.onlineSession.seat !== 'host'
      || !this.localOnlineReady
      || !this.remoteOnlineReady
      || this.onlineClockAnnounced
    ) return;
    this.onlineClockAnnounced = true;
    this.onlineSession.transport.sendControl({
      t: 'aura_start', matchSerial: this.online.matchSerial, delayMs: ONLINE_START_DELAY_MS,
    } satisfies AuraOnlineControl);
    this.beginClock(ONLINE_START_DELAY_MS);
  }

  private onOnlineControl(value: unknown): void {
    if (!isAuraOnlineControl(value) || !this.online) return;
    if ('matchSerial' in value && value.matchSerial !== this.online.matchSerial) return;
    if (value.t === 'aura_ready') {
      this.remoteOnlineReady = true;
      this.announceOnlineReady();
      this.maybeAnnounceOnlineClock();
    } else if (value.t === 'aura_start') {
      if (this.onlineSession?.seat === 'guest') {
        const halfRtt = (this.onlineSession.transport.getState().rttMs ?? 0) / 2;
        this.beginClock(Math.max(0, value.delayMs - halfRtt));
      }
    } else if (value.t === 'aura_judgement') {
      const judgement = this.battle.judgeNote(value.noteId, value.grade, value.offsetMs);
      if (judgement) this.applyJudgement(judgement, false);
    } else if (value.t === 'aura_finish') {
      this.remoteFinalScore = scoreCopy(value.score);
    } else if (value.t === 'quit') {
      this.opponentLeft = true;
      if (!this.finalizing) this.beginFinalization();
    } else if (value.t === 'rematch_ready' && value.previousMatchSerial === this.online.matchSerial) {
      this.remoteRematchReady = true;
      if (!this.localRematchReady) this.emitOnlineRematchState('rival_ready', 'Your rival is ready to farm again.');
      void this.maybeStartOnlineRematch();
    } else if (
      value.t === 'rematch_start'
      && value.previousMatchSerial === this.online.matchSerial
      && this.onlineSession?.seat === 'guest'
    ) {
      this.restartOnlineMatch(value.matchSerial, value.seed);
    }
  }

  private onTransportState(state: PeerTransportState): void {
    if (state.phase === 'connected') this.announceOnlineReady();
    if (!state.peerPresent && (state.phase === 'closed' || state.phase === 'error' || state.phase === 'waiting_peer')) {
      this.opponentLeft = true;
    }
    window.dispatchEvent(new CustomEvent(NET_STATE_EVENT, {
      detail: {
        connected: state.phase === 'connected',
        peerPresent: state.peerPresent,
        path: state.path,
        rttMs: state.rttMs,
        rollbacks: 0,
        stalled: this.clockStartedAt === null,
        desynced: false,
        abandoned: this.opponentLeft,
      },
    }));
  }

  private requestOnlineRematch(): void {
    if (!this.online || !this.onlineSession || this.localRematchReady || this.onlineRematchStarting || this.opponentLeft) return;
    this.localRematchReady = true;
    this.emitOnlineRematchState('waiting', this.remoteRematchReady ? 'Both players ready. Starting…' : 'Waiting for your rival…');
    const sent = this.onlineSession.transport.sendControl({
      t: 'rematch_ready', previousMatchSerial: this.online.matchSerial,
    } satisfies AuraOnlineControl);
    if (!sent) {
      this.localRematchReady = false;
      this.emitOnlineRematchState('error', 'Could not reach your rival. Try again.');
      return;
    }
    void this.maybeStartOnlineRematch();
  }

  private async maybeStartOnlineRematch(): Promise<void> {
    const session = this.onlineSession;
    const previous = this.online?.matchSerial;
    if (!session || previous === undefined || session.seat !== 'host' || !this.localRematchReady || !this.remoteRematchReady || this.onlineRematchStarting) return;
    if (!session.allocateNextMatchSerial) {
      this.emitOnlineRematchState('error', 'Could not reserve the rematch.');
      return;
    }
    this.onlineRematchStarting = true;
    this.emitOnlineRematchState('starting', 'Both players ready. Farming again…');
    try {
      const matchSerial = await session.allocateNextMatchSerial();
      const words = new Uint32Array(1);
      crypto.getRandomValues(words);
      const seed = words[0] || 0x41555241;
      const sent = session.transport.sendControl({
        t: 'rematch_start', previousMatchSerial: previous, matchSerial, seed,
      } satisfies AuraOnlineControl);
      if (!sent) throw new Error('Rival disconnected');
      this.restartOnlineMatch(matchSerial, seed);
    } catch (error) {
      this.onlineRematchStarting = false;
      this.localRematchReady = false;
      debugWarn('[AuraScene] Online rematch failed:', error instanceof Error ? error.message : error);
      this.emitOnlineRematchState('error', 'Could not start the rematch. Try again.');
    }
  }

  private restartOnlineMatch(matchSerial: number, seed: number): void {
    if (!this.online || !this.onlineSession || this.actionCommitted) return;
    this.actionCommitted = true;
    this.preserveOnlineSessionOnRestart = true;
    this.setMatchActionsVisible(false);
    this.scene.restart({
      gameMode: 'aura',
      vsAI: false,
      cpuVsCpu: false,
      p1PhotoHash: this.p1PhotoHash ?? undefined,
      p2PhotoHash: this.p2PhotoHash ?? undefined,
      p1CloudFighterId: this.p1CloudFighterId,
      p2CloudFighterId: this.p2CloudFighterId,
      p1Name: this.p1Name,
      p2Name: this.p2Name,
      stageId: this.stageId ?? undefined,
      customStageKey: this.customStageKey ?? undefined,
      customStageLabel: this.customStageLabel ?? undefined,
      auraDifficulty: this.difficultyId,
      seed,
      online: { ...this.online, matchSerial },
    } satisfies MatchSceneData);
  }

  private emitOnlineRematchState(
    state: WindowEventMap[typeof ONLINE_REMATCH_STATE_EVENT]['detail']['state'],
    message?: string,
  ): void {
    window.dispatchEvent(new CustomEvent(ONLINE_REMATCH_STATE_EVENT, { detail: { state, message } }));
  }

  private readonly onAuraInput = (event: WindowEventMap[typeof AURA_INPUT_EVENT]): void => {
    this.handleInput(event.detail.playerIndex, event.detail.lane);
  };

  private readonly onPause = (event: WindowEventMap[typeof PAUSE_EVENT]): void => {
    if (this.online) return;
    const next = event.detail.paused;
    if (next === this.paused) return;
    if (next) {
      this.paused = true;
      this.pausedAt = performance.now();
      this.soundManager?.pauseBattleMusic();
    } else {
      this.pausedDuration += performance.now() - this.pausedAt;
      this.paused = false;
      this.soundManager?.resumeBattleMusic();
    }
  };

  private readonly onMatchAction = (event: WindowEventMap[typeof MATCH_ACTION_EVENT]): void => {
    this.performAction(event.detail.action);
  };

  private performAction(action: MatchAction): void {
    if (this.actionCommitted) return;
    if (this.online && action === 'run_it_back') {
      this.requestOnlineRematch();
      return;
    }
    this.actionCommitted = true;
    this.setMatchActionsVisible(false);
    if (this.online) {
      this.onlineSession?.transport.sendControl({ t: 'quit' } satisfies AuraOnlineControl);
      endActiveOnlineSession();
      this.exitToMenu();
      return;
    }
    if (action === 'menu') {
      this.exitToMenu();
      return;
    }
    const nextSeed = (this.matchSeed + (action === 'remix' ? 0x9e3779b9 : 0x41555241)) >>> 0;
    this.scene.restart({
      ...this.matchData,
      gameMode: 'aura',
      auraDifficulty: this.difficultyId,
      remix: this.remix + 1,
      seed: nextSeed || 0x41555241,
    } satisfies MatchSceneData);
  }

  private exitToMenu(): void {
    const exit = (window as Window & { __ASF_EXIT_TO_MENU__?: () => void }).__ASF_EXIT_TO_MENU__;
    if (exit) exit();
    else window.location.href = '/menu';
  }

  private setMatchActionsVisible(visible: boolean): void {
    this.matchActionsVisible = visible;
    window.dispatchEvent(new CustomEvent(MATCH_ACTIONS_VISIBILITY_EVENT, {
      detail: { visible, online: Boolean(this.online) },
    }));
  }

  private beginLifecycle(): number {
    this.lifecycleActive = true;
    this.lifecycleEpoch += 1;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onLifecycleEnd);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.onLifecycleEnd);
    return this.lifecycleEpoch;
  }

  private isCurrentLifecycle(epoch: number): boolean {
    return this.lifecycleActive && this.lifecycleEpoch === epoch;
  }

  private readonly onLifecycleEnd = (): void => {
    if (!this.lifecycleActive) return;
    this.lifecycleActive = false;
    this.lifecycleEpoch += 1;
    window.removeEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.removeEventListener(PAUSE_EVENT, this.onPause);
    window.removeEventListener(AURA_INPUT_EVENT, this.onAuraInput);
    for (const { key, handler } of this.keyBindings) key.off('down', handler);
    this.keyBindings = [];
    this.clearNotes();
    for (const view of this.auraPerformanceViews) view?.destroy();
    this.auraPerformanceViews = [null, null];
    for (const pack of this.auraAnimationPacks) destroyLoadedAuraAnimationPack(this, pack);
    this.fightSpritePacksLoaded = [false, false];
    this.auraAnimationPacks = [null, null];
    this.soundManager?.destroy();
    for (const unsubscribe of this.onlineUnsubscribe) unsubscribe();
    this.onlineUnsubscribe = [];
    if (this.online && !this.preserveOnlineSessionOnRestart) endActiveOnlineSession();
    if (this.customStageTextureKey && this.textures.exists(this.customStageTextureKey)) {
      this.textures.remove(this.customStageTextureKey);
    }
    this.customStageTextureKey = null;
  };
}
