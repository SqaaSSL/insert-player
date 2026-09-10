import Phaser from 'phaser';
import { Fighter } from '../fighters/Fighter.ts';
import { FighterView } from '../fighters/FighterView.ts';
import { FighterState, GAME_HEIGHT, GAME_WIDTH, GROUND_Y } from '../constants.ts';
import { EMPTY_INPUT } from '../sim/FighterInput.ts';
import { loadAiSprites } from '../sprites/AiSpriteLoader.ts';
import { SoundManager } from '../systems/SoundManager.ts';
import { getCachedStageBackground } from '../../services/SpriteCache.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';
import {
  DEFAULT_AURA_STAGE_ID,
  getStageTheme,
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
  type AuraNote,
  type AuraTurn,
  type AuraSlot,
} from '../aura/AuraChart.ts';
import {
  AURA_DEFAULT_LANE_KEYS,
  AURA_LOCAL_P1_LANE_KEYS,
  AURA_LOCAL_P2_LANE_KEYS,
  AURA_ROUNDS,
  getAuraDifficulty,
  type AuraLaneKeys,
  type AuraDifficultyId,
} from '../aura/AuraConfig.ts';
import { getAuraTrack, pickAuraTrackForMatch, type AuraTrack } from '../aura/AuraTracks.ts';
import {
  AURA_ROUTINE_ANIMATION_NAMES,
  AURA_PERFORMANCE_DEFINITIONS,
  auraPerformanceAtBeat,
  createAuraPerformanceRoutine,
  type AuraRoutineAnimationName,
} from '../aura/AuraPerformance.ts';
import { AuraPerformanceView } from '../aura/AuraPerformanceView.ts';
import { AuraComicFeedback } from '../aura/AuraComicFeedback.ts';
import { AuraScoreFeedback } from '../aura/AuraScoreFeedback.ts';
import { auraScoreCueAnchor } from '../aura/AuraScoreCue.ts';
import { auraHudLayout, auraHudState, drawAuraDuelMeter } from '../aura/AuraHud.ts';
import { createAuraLayout, auraPerformerTransform, auraComicAnchor } from '../aura/AuraLayout.ts';
import { auraCameraComposition, AURA_CAMERA_HANDOFF_MS, AURA_CAMERA_FINALE_MS } from '../aura/AuraCamera.ts';
import {
  AURA_PRESENTATION_EVENT, AURA_PRESENTATION_START_EVENT, AURA_PRESENTATION_TURN_EVENT,
  createAuraPresentationToken, type AuraPresentationDetail,
} from '../aura/AuraPresentationEvents.ts';
import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';
import { AuraMusicClock } from '../aura/AuraMusicClock.ts';
import { AuraStartup, AURA_STARTUP_EVENT, AURA_STARTUP_READY_EVENT, AURA_STARTUP_COUNTDOWN_MS, waitForAuraRenderedFrames } from '../aura/AuraStartup.ts';
import { AuraStartupView } from '../aura/AuraStartupView.ts';
import {
  AuraOnboarding, AURA_ONBOARDING_EVENT, AURA_ONBOARDING_SKIP_EVENT,
  canGuideAuraFirstBattle, type AuraOnboardingDetail,
} from '../aura/AuraOnboarding.ts';
import { createAuraChallengeRoutine, isValidAuraChallengeMatch } from '../aura/AuraChallenge.ts';
import { auraDemoPerformer } from '../aura/AuraDemoPerformers.ts';
import { prepareAuraChallengeMusic, createAuraChallengeMusicUrl, revokeAuraChallengeMusicUrl } from '../aura/AuraChallengeMedia.ts';
import { AuraRecorder } from '../aura/AuraRecording.ts';
import { AuraVideoRecorder } from '../aura/AuraVideoRecorder.ts';
import { AURA_CAPTURE_EVENT, type AuraCaptureDetail } from '../aura/AuraCapture.ts';
import { saveAuraRecording } from '../../services/AuraRecordingStore.ts';
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
import {
  CREAM,
  DANGER,
  HEAT,
  HEAT_DEEP,
  INK,
  PIXEL_FONT,
  SLOT_COLORS,
  SLOT_COLOR_CSS,
  STEEL,
  STEEL_DIM,
  fillChamfered,
  strokeChamfered,
} from '../ui/CabinetGraphics.ts';


/** Outer lanes read cream, inner lanes read heat: two tones, one glyph. */
const LANE_TONES = [CREAM, HEAT, HEAT, CREAM] as const;
const LANE_HALF_WIDTH = 30;
const RECEPTOR_WIDTH = 56;
const RECEPTOR_HEIGHT = 26;
const NOTE_WIDTH = 44;
const NOTE_HEIGHT = 14;
const HIGHWAY_FRAME_PAD_X = 12;
const HIGHWAY_FRAME_PAD_TOP = 30;
const CHAMFER = 6;
const CROWD_METER_SEGMENTS = 8;
const FIGHTER_X = [250, 774] as const;
const ONLINE_START_DELAY_MS = AURA_STARTUP_COUNTDOWN_MS;
const ONLINE_FINISH_GRACE_MS = 2_500;

/** The one note glyph: a chamfered bar with a dark split. Filled for notes and
 * flashes, outlined for the receptor slot. */
function drawNoteGlyph(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  tone: number,
  filled: boolean,
  scale = 1,
): void {
  const w = NOTE_WIDTH * scale;
  const h = NOTE_HEIGHT * scale;
  const c = 3 * scale;
  if (filled) {
    fillChamfered(g, x - w / 2, y - h / 2, w, h, c, tone, 0.97);
    g.fillStyle(INK, 0.55);
    g.fillRect(x - 1, y - h / 2 + 2, 2, h - 4);
  } else {
    fillChamfered(g, x - w / 2, y - h / 2, w, h, c, INK, 0.85);
    strokeChamfered(g, x - w / 2, y - h / 2, w, h, c, 2, tone, 0.9);
  }
}

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
  private track!: AuraTrack;
  private battle!: AuraBattle;
  private actionRecorder: AuraRecorder | null = null;
  private videoRecorder: AuraVideoRecorder | null = null;
  private captureId = '';
  private captureErrorReported = false;
  private cpuPlans: [AuraCpuHit[], AuraCpuHit[]] = [[], []];
  private cpuPlanIndices: [number, number] = [0, 0];
  private fighters!: [Fighter, Fighter];
  private views!: [FighterView, FighterView];
  private auraAnimationPacks: [LoadedAuraAnimationPack | null, LoadedAuraAnimationPack | null] = [null, null];
  private auraPerformanceViews: [AuraPerformanceView | null, AuraPerformanceView | null] = [null, null];
  private comicFeedback: AuraComicFeedback | null = null;
  private scoreFeedback: AuraScoreFeedback | null = null;
  private fighterRenderScale = 1;
  private fighterRenderYOffset = 0;
  private layout = createAuraLayout();
  private cameraFocusSlot: AuraSlot = 0;
  private cameraFromSlot: AuraSlot = 0;
  private cameraTransitionMs = AURA_CAMERA_HANDOFF_MS;
  private finaleElapsedMs: number | null = null;
  private stageFrame: { width: number; height: number; x: number; y: number } | null = null;
  private performerContainers!: [Phaser.GameObjects.Container, Phaser.GameObjects.Container];
  private hudPanel!: Phaser.GameObjects.Graphics;
  private stageGrade!: Phaser.GameObjects.Graphics;
  private crtOverlay!: Phaser.GameObjects.Graphics;

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
  private noteObjects = new Map<string, Phaser.GameObjects.Container>();
  private p1ScoreText!: Phaser.GameObjects.Text;
  private p2ScoreText!: Phaser.GameObjects.Text;
  private p1NameText!: Phaser.GameObjects.Text;
  private p2NameText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private duelHeadingText!: Phaser.GameObjects.Text;
  private performerNameText!: Phaser.GameObjects.Text;
  private comboText!: Phaser.GameObjects.Text;
  private crowdLabelText!: Phaser.GameObjects.Text;
  private crowdMeterGraphics!: Phaser.GameObjects.Graphics;
  private laneKeyTexts: Phaser.GameObjects.Text[] = [];
  private duelMeterGraphics!: Phaser.GameObjects.Graphics;
  private feedbackObject: Phaser.GameObjects.Container | null = null;
  private beatGraphics!: Phaser.GameObjects.Graphics;
  private countInText!: Phaser.GameObjects.Text;
  private noteById = new Map<string, AuraNote>();
  private lastCountIn = -1;
  private lastMilestone: [number, number] = [0, 0];
  private playerTags!: [Phaser.GameObjects.Container, Phaser.GameObjects.Container];
  private currentTurnIndex = -2;

  private keysP1: Phaser.Input.Keyboard.Key[] = [];
  private keysP2: Phaser.Input.Keyboard.Key[] = [];
  private keyBindings: Array<{ key: Phaser.Input.Keyboard.Key; handler: () => void }> = [];
  private soundManager!: SoundManager;
  private crowdHeat: [number, number] = [0, 0];
  private activePerformerSlot: AuraSlot | null = null;
  private clockStartedAt: number | null = null;
  private musicClock = new AuraMusicClock();
  private challengeMediaAbort: AbortController | null = null;
  private challengeMusicUrl: string | null = null;
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
  private presentationReady = false;
  private presentationToken = 0;
  private presentationStarted = false;
  private onboarding: AuraOnboarding | null = null;
  private onboardingGraphics: Phaser.GameObjects.Graphics | null = null;
  private lastOnboardingState: string | null = null;
  private startup: AuraStartup | null = null;
  private startupView: AuraStartupView | null = null;
  private startupAbort: AbortController | null = null;
  private startupMediaUnlock: Promise<boolean> | null = null;
  private lastStartupState: string | null = null;
  private warmingPresentation = false;
  private awaitingStartInput = false;
  private onboardingRequested = false;
  private silentStartup = false;

  constructor() {
    super({ key: 'AuraScene' });
  }

  init(data: MatchSceneData): void {
    this.matchData = data;
    this.presentationReady = false;
    this.presentationStarted = false;
    this.onboarding = null;
    this.onboardingGraphics = null;
    this.lastOnboardingState = null;
    this.startup = null;
    this.startupView = null;
    this.startupAbort = null;
    this.startupMediaUnlock = null;
    this.lastStartupState = null;
    this.warmingPresentation = false;
    this.awaitingStartInput = false;
    this.onboardingRequested = false;
    this.silentStartup = false;
    this.captureErrorReported = false;
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
    this.auraAnimationPacks = [null, null];
    this.auraPerformanceViews = [null, null];
    this.crowdHeat = [0, 0];
    this.comicFeedback = null;
    this.scoreFeedback = null;
    this.activePerformerSlot = null;
    this.cameraFocusSlot = 0;
    this.cameraFromSlot = 0;
    this.cameraTransitionMs = AURA_CAMERA_HANDOFF_MS;
    this.finaleElapsedMs = null;
    this.stageFrame = null;
    this.currentTurnIndex = -2;
    this.clockStartedAt = null;
    this.musicClock.reset();
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
    this.feedbackObject = null;
    this.noteById.clear();
    this.lastCountIn = -1;
    this.lastMilestone = [0, 0];
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.presentationToken = createAuraPresentationToken();
    this.emitPresentation('loading');
  }

  preload(): void {
    const resolved = this.stageId ?? DEFAULT_AURA_STAGE_ID;
    const stage = getStageTheme(resolved);
    if (stage.assetPath && !this.textures.exists(stageTextureKey(stage.id))) {
      this.load.image(stageTextureKey(stage.id), stage.assetPath);
    }
  }

  async create(): Promise<void> {
    const epoch = this.beginLifecycle();
    this.startupAbort = new AbortController();
    if (this.matchData.auraChallenge) {
      if (!isValidAuraChallengeMatch(this.matchData)) {
        this.emitPresentation('error');
        return;
      }
      this.challengeMediaAbort = new AbortController();
      try {
        const music = await prepareAuraChallengeMusic(this.matchData.auraChallenge, this.challengeMediaAbort.signal);
        if (!this.isCurrentLifecycle(epoch)) return;
        this.challengeMusicUrl = createAuraChallengeMusicUrl(music);
      } catch (error) {
        if (this.isCurrentLifecycle(epoch)) {
          debugWarn('[AuraScene] Challenge media could not be verified', error);
          this.emitPresentation('error');
        }
        return;
      }
    }
    window.addEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.addEventListener(PAUSE_EVENT, this.onPause);
    window.addEventListener(AURA_INPUT_EVENT, this.onAuraInput);
    window.addEventListener(AURA_PRESENTATION_START_EVENT, this.onPresentationStart);
    window.addEventListener(AURA_STARTUP_READY_EVENT, this.onStartupReady);
    window.addEventListener(AURA_ONBOARDING_SKIP_EVENT, this.onOnboardingSkip);
    this.setMatchActionsVisible(false);

    this.resolvedStageId = this.stageId ?? DEFAULT_AURA_STAGE_ID;
    const stage = getStageTheme(this.resolvedStageId);
    this.stageLabel = this.customStageKey
      ? (this.customStageLabel ?? 'PHOTO STAGE').toUpperCase()
      : stage.label;
    // Keep the source calibration shared with Fight, but frame the stage using
    // measured body/root coordinates rather than Fight's background-specific zoom.
    this.fighterRenderScale = 1;
    this.fighterRenderYOffset = 0;
    this.layout = createAuraLayout(this.scale.width, this.scale.height);
    this.track = getAuraTrack(this.matchData.auraTrackId)
      ?? pickAuraTrackForMatch(this.matchSeed, this.customStageKey ? null : this.resolvedStageId);
    this.chart = createAuraChart(this.matchSeed, this.difficultyId, this.track);
    this.battle = new AuraBattle(this.chart, this.difficultyId);
    this.captureId = crypto.randomUUID();
    this.emitCapture({ id: this.captureId, state: 'preparing' });
    try {
      this.actionRecorder = new AuraRecorder({
        engineVersion: 'aura-presentation-v1', matchSeed: this.matchSeed,
        trackId: this.track.id, difficulty: this.difficultyId, stageId: this.resolvedStageId,
        p1Name: this.p1Name, p2Name: this.p2Name,
        p1CloudFighterId: this.p1CloudFighterId, p2CloudFighterId: this.p2CloudFighterId,
        chart: this.chart,
      });
    } catch (error) { debugWarn('[AuraScene] Action history unavailable', error); }
    for (const note of this.chart.notes) this.noteById.set(note.id, note);

    this.soundManager = new SoundManager();
    this.soundManager.prepareAuraCrowd();
    const musicReady = this.soundManager.prepareBattleMusic(this.challengeMusicUrl ?? this.track.url, this.startupAbort.signal);
    try {
      const [, audioReady] = await Promise.all([this.loadFighters(epoch), musicReady]);
      if (!audioReady) throw new Error('Aura music is not ready to play');
    } catch (error) {
      if (this.isCurrentLifecycle(epoch)) {
        debugWarn('[AuraScene] Performer assets failed to load', error);
        this.emitPresentation('error');
      }
      return;
    }
    if (!this.isCurrentLifecycle(epoch)) return;
    // Orientation can change while assets load, before our resize listener exists.
    this.layout = createAuraLayout(this.scale.width, this.scale.height);

    try {
      if (!this.textures.exists(stageTextureKey(stage.id))) throw new Error('Aura stage is unavailable');
      this.worldLayer = this.add.container(0, 0);
      this.createStage(stageTextureKey(stage.id));
      if (this.customStageKey) await this.loadCustomStage(epoch);
      if (typeof document !== 'undefined' && document.fonts) await document.fonts.load(`12px ${PIXEL_FONT}`);
      if (!this.isCurrentLifecycle(epoch)) return;
      this.createFighters();
      this.createWorldEffects();
      this.createUi();
      this.createCameras();
      this.applyLayout();
      this.scale.on(Phaser.Scale.Events.RESIZE, this.onLayoutResize);
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

      this.updateScoreUi();
      this.updateTurnPresentation(-1);
      if (!await this.warmPresentation(epoch)) return;
    } catch (error) {
      if (this.isCurrentLifecycle(epoch)) {
        debugWarn('[AuraScene] Presentation could not be prepared', error);
        this.emitPresentation('error');
      }
      return;
    }
    if (!this.isCurrentLifecycle(epoch)) return;
    this.presentationReady = true;
    this.emitPresentation('ready');
    window.dispatchEvent(new CustomEvent(RUNTIME_READY_EVENT, {
      detail: { sceneKey: 'AuraScene', matchSeed: this.matchSeed },
    }));
  }

  private emitPresentation(phase: AuraPresentationDetail['phase']): void {
    window.dispatchEvent(new CustomEvent(AURA_PRESENTATION_EVENT, {
      detail: { phase, token: this.presentationToken, seed: this.matchSeed,
        ...((this.online || this.isVsAI) && !this.cpuVsCpu ? { localControlledSlot: this.localControlledSlot() } : {}),
      },
    }));
  }

  private async waitForPresentationFrames(frames = 2): Promise<boolean> {
    return this.startupAbort
      ? waitForAuraRenderedFrames(this.game.events, this.startupAbort.signal, frames)
      : false;
  }

  private async warmPresentation(epoch: number): Promise<boolean> {
    if (!this.isCurrentLifecycle(epoch)) return false;
    this.warmingPresentation = true;
    this.applyPerformerLayout();
    // Each source frame's opaque bounds are measured lazily by the view. Warm
    // that cache and submit every texture while loading, yielding between moves
    // so this work cannot steal the first played notes or recorded frames.
    for (const slot of [0, 1] as const) {
      const view = this.auraPerformanceViews[slot];
      const pack = this.auraAnimationPacks[slot];
      if (!view || !pack) continue;
      for (const [name, animation] of pack.animations) {
        view.play(name);
        const step = AURA_PERFORMANCE_DEFINITIONS[name].durationMs / animation.frameCount;
        for (let frame = 0; frame < animation.frameCount; frame += 1) {
          view.update(frame === 0 ? 0.001 : step, this.views[slot]);
          view.getVisibleTopCenter();
        }
        if (!await this.waitForPresentationFrames(1) || !this.isCurrentLifecycle(epoch)) return false;
      }
      this.restPerformer(slot);
    }
    this.warmingPresentation = false;
    this.applyLayout();
    return this.waitForPresentationFrames();
  }

  private emitStartup(): void {
    if (!this.startup) return;
    const state = this.startup.snapshot;
    // Per-frame remaining time is for canvas only; React needs phase/count.
    const identity = `${state.phase}:${state.count}`;
    if (identity === this.lastStartupState) return;
    this.lastStartupState = identity;
    window.dispatchEvent(new CustomEvent(AURA_STARTUP_EVENT, {
      detail: { token: this.presentationToken, seed: this.matchSeed, ...state },
    }));
  }

  private async prepareStartup(): Promise<void> {
    if (this.startup || !this.lifecycleActive || !this.presentationStarted) return;
    const epoch = this.lifecycleEpoch;
    this.startup = new AuraStartup(Boolean(this.online));
    this.turnText.setText('AURA DUEL · GET READY');
    this.fitHudText();
    this.emitStartup();
    this.startupView?.render(this.layout, this.startup.snapshot);
    this.applyPerformerLayout();
    if (this.cpuVsCpu) {
      this.silentStartup = !await this.soundManager.unlockPreparedMedia(this.startupAbort?.signal);
      if (!this.isCurrentLifecycle(epoch)) return;
    }
    if (!await this.waitForPresentationFrames() || !this.isCurrentLifecycle(epoch)) return;
    this.videoRecorder = new AuraVideoRecorder();
    const audioTracks = this.silentStartup ? [] : this.soundManager.getRecordingAudioTracks();
    const capture = this.videoRecorder.start(this.game.canvas, audioTracks, audioTracks.length > 0);
    if (this.paused) this.videoRecorder.pause();
    const recordingStarted = capture.ok && await this.videoRecorder.whenStarted();
    if (!this.isCurrentLifecycle(epoch)) return;
    this.captureErrorReported = !recordingStarted;
    this.emitCapture(recordingStarted
      ? { id: this.captureId, state: 'recording' }
      : { id: this.captureId, state: 'unavailable', reason: this.videoRecorder.error ?? capture.reason ?? 'recording-start-failed' });
    // Encoder support never decides whether a player can play the real duel.
    this.startup.begin();
    this.emitStartup();
    this.startupView?.render(this.layout, this.startup.snapshot);
  }

  private updateStartup(delta: number): void {
    const alreadyPlaying = this.startup?.snapshot.phase === 'playing';
    if (!this.startup || alreadyPlaying) return;
    if (this.online && this.scheduledClockStart !== null) {
      this.startup.countdown(Math.max(0, this.scheduledClockStart - performance.now()));
    } else this.startup.advance(delta);
    this.applyPerformerLayout();
    this.startupView?.render(this.layout, this.startup.snapshot, this.startup.readyForOnline);
    this.emitStartup();
    if (this.startup.readyForOnline && !this.localOnlineReady) {
      this.localOnlineReady = true;
      this.announceOnlineReady();
    } else if (!this.online && this.startup.snapshot.phase === 'playing') this.beginClock(0);
  }

  private readonly onPresentationStart = (event: WindowEventMap[typeof AURA_PRESENTATION_START_EVENT]): void => {
    const detail = event.detail;
    if (!this.lifecycleActive || !this.presentationReady || this.presentationStarted
      || detail?.token !== this.presentationToken || detail?.seed !== this.matchSeed) return;
    this.presentationStarted = true;
    this.onboardingRequested = detail.onboarding === true && canGuideAuraFirstBattle(this.matchData);
    if (this.cpuVsCpu) {
      // Attract/canary playback remains unattended; music unlock keeps its
      // ordinary next-input fallback if the browser disallows autoplay.
      void this.prepareStartup();
    } else this.awaitStartupGesture();
  };

  private awaitStartupGesture(): void {
    this.awaitingStartInput = true;
    window.dispatchEvent(new CustomEvent(AURA_STARTUP_EVENT, {
      detail: { token: this.presentationToken, seed: this.matchSeed,
        phase: 'awaiting-input', remainingMs: 0, count: null },
    }));
  }

  private readonly onStartupReady = (event: WindowEventMap[typeof AURA_STARTUP_READY_EVENT]): void => {
    if (!this.lifecycleActive || !this.presentationReady || !this.presentationStarted || !this.awaitingStartInput
      || this.paused || event.detail?.token !== this.presentationToken || event.detail?.seed !== this.matchSeed) return;
    this.awaitingStartInput = false;
    const epoch = this.lifecycleEpoch;
    window.dispatchEvent(new CustomEvent(AURA_STARTUP_EVENT, {
      detail: { token: this.presentationToken, seed: this.matchSeed,
        phase: 'preparing', remainingMs: 0, count: null },
    }));
    // This event, unlike the curtain acknowledgement, comes from the Ready button.
    this.startupMediaUnlock = this.soundManager.unlockPreparedMedia(this.startupAbort?.signal);
    void this.startupMediaUnlock.then(unlocked => {
      if (!this.isCurrentLifecycle(epoch)) return;
      if (!unlocked) { this.awaitStartupGesture(); return; }
      if (this.onboardingRequested) this.startOnboarding();
      else void this.prepareStartup();
    });
  };

  private startOnboarding(): void {
    this.startupView?.render(this.layout, null);
    this.onboarding = new AuraOnboarding();
    this.onboardingGraphics = this.add.graphics();
    this.uiLayer.add(this.onboardingGraphics);
    this.focusPerformer(0);
    this.drawLanes(0);
    this.drawOnboardingPractice();
    this.emitOnboarding();
  }

  private emitOnboarding(): void {
    if (!this.onboarding) return;
    const detail: AuraOnboardingDetail = {
      token: this.presentationToken, seed: this.matchSeed,
      ...this.onboarding.snapshot, laneKeys: this.primaryLaneKeys(),
    };
    const state = JSON.stringify(detail);
    if (state === this.lastOnboardingState) return;
    this.lastOnboardingState = state;
    window.dispatchEvent(new CustomEvent(AURA_ONBOARDING_EVENT, { detail }));
  }

  private drawOnboardingPractice(): void {
    const guide = this.onboarding;
    const graphics = this.onboardingGraphics;
    if (!guide || !graphics) return;
    const { phase, practiceLane, completedLanes } = guide.snapshot;
    graphics.clear();
    if (phase !== 'practice' || practiceLane === null) return;
    const lane = this.laneLayout(0, practiceLane);
    const tone = LANE_TONES[practiceLane];
    const progress = guide.practiceProgress;
    graphics.fillStyle(tone, 0.12);
    graphics.fillRect(lane.startX - LANE_HALF_WIDTH, lane.startY,
      LANE_HALF_WIDTH * 2, lane.targetY - lane.startY);
    strokeChamfered(graphics, lane.targetX - RECEPTOR_WIDTH / 2 - 3,
      lane.targetY - RECEPTOR_HEIGHT / 2 - 3, RECEPTOR_WIDTH + 6, RECEPTOR_HEIGHT + 6,
      5, progress === 1 ? 3 : 1, HEAT, progress === 1 ? 1 : 0.6);
    drawNoteGlyph(graphics, lane.startX,
      Phaser.Math.Linear(lane.startY, lane.targetY, progress), tone, true);
    const key = this.primaryLaneKeys()[practiceLane];
    this.turnText.setText(`PRACTICE · ${completedLanes + 1}/4 · NO SCORE YET`);
    this.highwayTitleText.setText(progress === 1 ? `HIT ${key} NOW` : `FOLLOW LANE ${practiceLane + 1}`).setVisible(true);
    this.highwayMetaText.setText(`PRESS ${key} · OR TAP LANE ${practiceLane + 1}`).setVisible(true);
  }

  private handlePracticeInput(slot: AuraSlot, lane: AuraLane): void {
    if (!this.onboarding || slot !== 0 || !Number.isInteger(lane) || lane < 0 || lane > 3) return;
    const outcome = this.onboarding.practiceInput(lane);
    if (outcome === 'hit' || outcome === 'start-battle') {
      this.flashLaneInput(0, lane);
      // A real, owned Aura move demonstrates what the rhythm controls. This
      // feedback never touches the battle, crowd score or action recording.
      const move = (['aura_six_seven', 'aura_mog_check', 'aura_glide', 'aura_one_leg'] as const)[lane];
      const performance = this.auraPerformanceViews[0];
      if (performance?.play(move)) {
        this.fighters[0].forceState(FighterState.IDLE);
        performance.update(0, this.views[0]);
        this.comicFeedback?.move(0, move);
      }
    }
    this.drawOnboardingPractice();
    this.emitOnboarding();
    if (outcome === 'start-battle') this.startBattleAfterPractice();
  }

  private startBattleAfterPractice(): void {
    this.onboardingGraphics?.clear();
    this.updateTurnPresentation(-1);
    void this.prepareStartup();
  }

  private readonly onOnboardingSkip = (event: WindowEventMap[typeof AURA_ONBOARDING_SKIP_EVENT]): void => {
    if (!this.lifecycleActive || !this.presentationReady || !this.presentationStarted || this.paused || !this.onboarding
      || event.detail?.token !== this.presentationToken || event.detail?.seed !== this.matchSeed) return;
    const phase = this.onboarding.snapshot.phase;
    if (phase === 'complete' || phase === 'skipped') return;
    this.onboarding.skip();
    this.onboardingGraphics?.clear();
    this.emitOnboarding();
    if (phase === 'practice') this.startBattleAfterPractice();
  };

  private emitPresentationTurn(playerIndex: AuraSlot): void {
    window.dispatchEvent(new CustomEvent(AURA_PRESENTATION_TURN_EVENT, {
      detail: { token: this.presentationToken, seed: this.matchSeed, playerIndex },
    }));
  }

  update(_time: number, delta: number): void {
    if (!this.lifecycleActive) return;
    // Limits are wall-clock based, so surface encoder failures even in pause.
    if (this.videoRecorder?.error && !this.captureErrorReported) {
      this.captureErrorReported = true;
      this.emitCapture({ id: this.captureId, state: 'unavailable', reason: this.videoRecorder.error });
    }
    // Phaser does not await async create(). During a rematch, old view fields
    // still exist while their textures are being replaced by loadFighters().
    if (!this.presentationReady || this.paused) return;
    this.soundManager.updateAuraCrowd(delta);
    this.advanceCameraPresentation(Math.min(delta, 100));
    this.advanceFighterPresentation(Math.min(delta, 50) / 1_000);
    this.updateStartup(delta);
    if (this.onboarding) {
      this.onboarding.advance(Math.min(delta, 100));
      if (this.onboarding.snapshot.phase === 'practice') this.drawOnboardingPractice();
      this.emitOnboarding();
    }
    if (this.matchFinished || this.clockStartedAt === null) return;

    const nowMs = this.clockMs();
    if (nowMs < 0) return;
    this.updateTurn(nowMs);
    this.fitHudText();
    if (!this.finalizing) {
      this.playCpuPlans(nowMs);
      this.collectHumanMisses(nowMs);
      this.updateNotes(nowMs);
    }
    this.updateBeatPresentation(nowMs);

    if (nowMs >= this.chart.durationMs && !this.finalizing) {
      this.beginFinalization();
    }
    if (this.finalizing) this.maybeCompleteFinalization();
  }

  /** Beat feedback stays on the instrument; only turn changes move the camera. */
  private updateBeatPresentation(nowMs: number): void {
    const beatPos = (nowMs - this.chart.beatOffsetMs) / this.chart.beatMs;
    const beatIndex = Math.floor(beatPos);
    const phase = Phaser.Math.Clamp(beatPos - beatIndex, 0, 1);
    const turn = this.finalizing ? null : auraTurnAt(this.chart, nowMs);
    const pulse = Math.pow(1 - phase, 3);

    this.beatGraphics.clear();
    if (turn) {
      const grow = pulse * 3;
      for (let lane = 0; lane < 4; lane += 1) {
        const layout = this.laneLayout(turn.slot, lane as AuraLane);
        strokeChamfered(
          this.beatGraphics,
          layout.targetX - RECEPTOR_WIDTH / 2 - 3 - grow,
          layout.targetY - RECEPTOR_HEIGHT / 2 - 3 - grow,
          RECEPTOR_WIDTH + 6 + grow * 2,
          RECEPTOR_HEIGHT + 6 + grow * 2,
          5,
          2,
          LANE_TONES[lane],
          0.06 + pulse * 0.42,
        );
      }
      const combo = this.battle.scoreFor(turn.slot).combo;
      this.comboText.setScale(combo > 0 ? 1 + 0.08 * pulse : 1);
    } else {
      this.comboText.setScale(1);
    }

    this.updateCountIn(turn, nowMs);
  }

  private updateCountIn(turn: AuraTurn | null, nowMs: number): void {
    const remaining = turn ? turn.firstNoteMs - nowMs : 0;
    if (!turn || remaining <= 0) {
      if (this.lastCountIn !== -1) {
        this.lastCountIn = -1;
        this.tweens.killTweensOf(this.countInText);
        this.countInText.setVisible(false);
      }
      return;
    }
    const count = Math.max(1, Math.ceil(remaining / this.chart.beatMs));
    if (count === this.lastCountIn) return;
    this.lastCountIn = count;
    this.countInText.setText(String(count)).setVisible(true).setAlpha(1).setScale(1);
    if (this.reduceMotion) return;
    this.tweens.killTweensOf(this.countInText);
    this.countInText.setScale(1.6);
    this.tweens.add({
      targets: this.countInText,
      scale: 1,
      alpha: 0.55,
      duration: Math.min(320, this.chart.beatMs * 0.8),
      ease: 'Quart.easeOut',
    });
  }

  private async loadFighters(epoch: number): Promise<void> {
    const isCurrent = () => this.isCurrentLifecycle(epoch);
    const loadSlot = async (slot: AuraSlot, spriteKey: string, photoHash: string | null) => {
      const [, auraPack] = await Promise.all([
        photoHash ? loadAiSprites(this, spriteKey, photoHash, isCurrent) : Promise.resolve(false),
        loadAuraAnimationPack(this, spriteKey, photoHash, isCurrent, auraDemoPerformer(this.matchData, slot)),
      ]);
      if (isCurrent()) {
        this.auraAnimationPacks[slot] = auraPack;
      }
    };
    await Promise.all([
      loadSlot(0, 'fighter_p1', this.p1PhotoHash),
      loadSlot(1, 'fighter_p2', this.p2PhotoHash),
    ]);
    if (!isCurrent()) return;
    // Cache/manifest readiness is only a selection hint. Both actual decoded
    // packs must contain the six required performances before any entry path
    // can start a duel; the optional shrug reaction is not part of this check.
    const unavailableSlot = this.auraAnimationPacks.findIndex((pack) => !pack?.complete);
    if (unavailableSlot !== -1) {
      throw new Error(`P${unavailableSlot + 1} needs all six Aura performances to start this duel`);
    }
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

    // Neutral cabinet grade: darken, never recolour the stage art.
    this.stageGrade = this.add.graphics().setDepth(-18);
    this.worldLayer.add(this.stageGrade);

    this.stageTint = this.add.graphics().setDepth(-17);
    this.stageLights = this.add.graphics().setDepth(-16).setBlendMode(Phaser.BlendModes.ADD);
    this.worldLayer.add([this.stageTint, this.stageLights]);
    this.drawStageLighting(null, 0);
  }

  private drawStageLighting(slot: AuraSlot | null, heat: number): void {
    if (!this.stageTint || !this.stageLights) return;
    this.stageTint.clear();
    this.stageLights.clear();

    // No colour washes or beat-driven lights over the source character.
    this.stageTint.fillStyle(INK, 0.16);
    this.stageTint.fillRect(0, this.layout.hudHeight, this.layout.width, this.layout.height - this.layout.hudHeight);
    if (slot === null) return;
    const placement = this.cameraComposition().performers[slot];
    this.stageLights.fillStyle(SLOT_COLORS[slot], 0.06);
    this.stageLights.fillEllipse(placement.x, placement.footY, 180, 28);
  }



  private async loadCustomStage(epoch: number): Promise<void> {
    if (!this.customStageKey) return;
    try {
      const cached = await getCachedStageBackground(this.customStageKey);
      if (!this.isCurrentLifecycle(epoch)) return;
      if (!cached) throw new Error('Custom Aura stage is unavailable');
      const image = await this.blobImage(cached.pngBlob);
      if (!this.isCurrentLifecycle(epoch)) return;
      const key = `aura_custom_${this.customStageKey.replace(/[^a-z0-9_-]/gi, '_')}`;
      if (this.textures.exists(key)) this.textures.remove(key);
      this.textures.addImage(key, image);
      this.customStageTextureKey = key;
      this.stageBackdrop.setTexture(key);
      this.layoutStage();
    } catch (error) {
      debugWarn('[AuraScene] Custom stage could not be loaded:', error instanceof Error ? error.message : error);
      throw error;
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
    const p1 = new Fighter(0, this.p1Name, FIGHTER_X[0], true);
    const p2 = new Fighter(1, this.p2Name, FIGHTER_X[1], false);
    p1.y = GROUND_Y;
    p2.y = GROUND_Y;
    this.fighters = [p1, p2];
    this.views = [new FighterView(p1, 'fighter_p1'), new FighterView(p2, 'fighter_p2')];
    this.performerContainers = [this.add.container(0, 0), this.add.container(0, 0)];
    this.worldLayer.add(this.performerContainers);
    for (const [slot, view] of this.views.entries()) {
      view.createSprite(this);
      view.setRenderPresentation(this.fighterRenderScale, this.fighterRenderYOffset);
      this.performerContainers[slot].add([view.shadowSprite!, view.sprite]);
    }
    this.auraPerformanceViews = [0, 1].map((slot) => {
      const pack = this.auraAnimationPacks[slot as AuraSlot];
      if (!pack) return null;
      const performanceView = new AuraPerformanceView(this, pack);
      this.performerContainers[slot].add(performanceView.gameObjects());
      performanceView.playResting();
      return performanceView;
    }) as [AuraPerformanceView | null, AuraPerformanceView | null];
  }

  private createWorldEffects(): void {
    this.activeGlow = this.add.graphics();
    this.activeGlow.lineStyle(2, HEAT, 0.8);
    this.activeGlow.strokeEllipse(0, 0, 180, 28);
    // Container children are painted in list order, not child depth order.
    // Insert before every performer so even the rear arc stays under their feet.
    this.worldLayer.addAt(this.activeGlow, this.worldLayer.getIndex(this.performerContainers[0]));

    this.playerTags = [
      this.createPlayerTag(this.cpuVsCpu ? 'CPU 1' : this.isCpuSlot(0) ? 'CPU' : 'P1', SLOT_COLORS[0]),
      this.createPlayerTag(
        this.cpuVsCpu ? 'CPU 2' : this.isCpuSlot(1) ? 'CPU' : 'P2',
        SLOT_COLORS[1],
      ),
    ];
  }

  private createPlayerTag(label: string, color: number): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0).setDepth(30);
    const text = this.add.text(0, 0, label, {
      fontFamily: PIXEL_FONT,
      fontSize: '9px',
      color: `#${color.toString(16).padStart(6, '0')}`,
    }).setOrigin(0.5);
    const width = Math.max(44, text.width + 18);
    const plate = this.add.graphics();
    fillChamfered(plate, -width / 2, -11, width, 22, 4, INK, 0.9);
    strokeChamfered(plate, -width / 2, -11, width, 22, 4, 1, color, 1);
    // A thin tick instead of a speech-bubble tail.
    plate.fillStyle(color, 1);
    plate.fillRect(-1, 11, 2, 9);
    container.add([plate, text]);
    this.worldLayer.add(container);
    return container;
  }

  private createUi(): void {
    this.uiLayer = this.add.container(0, 0).setDepth(500);
    this.comicFeedback = new AuraComicFeedback(this, this.uiLayer, this.reduceMotion,
      (name) => this.soundManager.playAuraMove(name));
    this.scoreFeedback = new AuraScoreFeedback(this, this.uiLayer, this.reduceMotion);
    this.hudPanel = this.add.graphics();
    this.uiLayer.add(this.hudPanel);

    this.duelMeterGraphics = this.add.graphics();
    this.uiLayer.add(this.duelMeterGraphics);

    this.p1NameText = this.add.text(0, 0, `P1 · ${this.p1Name.toUpperCase()}`, {
      fontFamily: PIXEL_FONT, fontSize: '11px', color: SLOT_COLOR_CSS[0],
    });
    this.p2NameText = this.add.text(0, 0, `P2 · ${this.p2Name.toUpperCase()}`, {
      fontFamily: PIXEL_FONT, fontSize: '11px', color: SLOT_COLOR_CSS[1], align: 'right',
    }).setOrigin(1, 0);
    this.p1ScoreText = this.add.text(0, 0, '0 AURA', {
      fontFamily: PIXEL_FONT, fontSize: '17px', color: '#fff4d6',
    });
    this.p2ScoreText = this.add.text(0, 0, '0 AURA', {
      fontFamily: PIXEL_FONT, fontSize: '17px', color: '#fff4d6', align: 'right',
    }).setOrigin(1, 0);
    this.turnText = this.add.text(0, 0, 'AURA CHECK', {
      fontFamily: PIXEL_FONT, fontSize: '12px', color: '#ffce3a', align: 'center',
    }).setOrigin(0.5);
    this.phaseText = this.add.text(0, 0, 'TIED', {
      fontFamily: PIXEL_FONT, fontSize: '9px', color: '#fff4d6', align: 'center',
    }).setOrigin(0.5);
    this.duelHeadingText = this.add.text(0, 0, 'AURA DUEL', {
      fontFamily: PIXEL_FONT, fontSize: '10px', color: '#9aa1b4', align: 'center',
    }).setOrigin(0.5);
    this.performerNameText = this.add.text(0, 0, '', {
      fontFamily: PIXEL_FONT, fontSize: '12px', color: '#fff4d6', align: 'center',
      stroke: '#050507', strokeThickness: 4,
    }).setOrigin(0.5);
    this.comboText = this.add.text(0, 0, 'x0 FLOW', {
      fontFamily: PIXEL_FONT, fontSize: '18px', color: '#ffce3a',
      stroke: '#050507', strokeThickness: 6,
    });
    this.crowdLabelText = this.add.text(0, 0, 'CROWD · WATCHING', {
      fontFamily: PIXEL_FONT,
      fontSize: '8px',
      color: '#fff4d6',
      stroke: '#050507',
      strokeThickness: 4,
    }).setVisible(false);
    this.crowdMeterGraphics = this.add.graphics().setVisible(false);
    this.highwayTitleText = this.add.text(0, 0, 'ON CAM', {
      fontFamily: PIXEL_FONT,
      fontSize: '8px',
      color: '#fff4d6',
    }).setVisible(false);
    this.highwayMetaText = this.add.text(0, 0, '', {
      fontFamily: PIXEL_FONT,
      fontSize: '10px',
      color: '#fff4d6',
      backgroundColor: '#050507',
      padding: { x: 8, y: 7 },
      stroke: '#050507', strokeThickness: 2,
    }).setOrigin(0.5).setVisible(false);
    this.laneKeyTexts = Array.from({ length: 4 }, () => this.add.text(0, this.layout.keyLabelY, '', {
      fontFamily: PIXEL_FONT, fontSize: '16px', color: '#fff4d6', align: 'center',
      stroke: '#050507', strokeThickness: 2,
    }).setOrigin(0.5).setVisible(false));
    this.uiLayer.add([
      this.p1NameText,
      this.p2NameText,
      this.p1ScoreText,
      this.p2ScoreText,
      this.turnText,
      this.phaseText,
      this.duelHeadingText,
      this.performerNameText,
      this.comboText,
      this.crowdLabelText,
      ...this.laneKeyTexts,
    ]);

    this.laneGraphics = this.add.graphics();
    this.targetGraphics = this.add.graphics();
    this.beatGraphics = this.add.graphics().setBlendMode(Phaser.BlendModes.ADD);
    this.countInText = this.add.text(this.layout.highwayX, this.layout.laneStartY + 96, '4', {
      fontFamily: PIXEL_FONT,
      fontSize: '34px',
      color: '#ffce3a',
      stroke: '#050507',
      strokeThickness: 8,
    }).setOrigin(0.5).setVisible(false);
    this.inputFlashGraphics = Array.from({ length: 4 }, () => (
      this.add.graphics().setAlpha(0).setBlendMode(Phaser.BlendModes.ADD)
    ));
    this.inputPulseGraphics = Array.from({ length: 4 }, () => (
      this.add.graphics().setAlpha(0).setBlendMode(Phaser.BlendModes.ADD)
    ));
    this.uiLayer.add([
      this.laneGraphics,
      this.targetGraphics,
      this.beatGraphics,
      ...this.inputFlashGraphics,
      ...this.inputPulseGraphics,
      this.countInText,
    ]);
    this.uiLayer.add([
      this.crowdMeterGraphics,
      this.highwayTitleText,
      this.highwayMetaText,
    ]);
    for (const text of this.laneKeyTexts) this.uiLayer.bringToTop(text);
    this.uiLayer.bringToTop(this.comboText);
    this.uiLayer.bringToTop(this.crowdLabelText);
    this.crtOverlay = this.add.graphics();
    this.uiLayer.add(this.crtOverlay);
    this.startupView = new AuraStartupView(this, this.uiLayer, [this.p1Name, this.p2Name]);
    this.startupView.render(this.layout, { phase: 'preparing', count: null });
  }

  private createCameras(): void {
    this.uiCamera = this.cameras.add(0, 0, this.layout.width, this.layout.height);
    this.cameras.main.ignore(this.uiLayer);
    this.uiCamera.ignore(this.worldLayer);
  }

  private readonly onLayoutResize = (): void => {
    if (!this.lifecycleActive || !this.presentationReady) return;
    this.layout = createAuraLayout(this.scale.width, this.scale.height);
    this.comicFeedback?.beginTurn();
    this.applyLayout();
    this.startupView?.render(this.layout, this.onboarding?.snapshot.phase === 'practice' ? null
      : this.startup?.snapshot ?? { phase: 'preparing', count: null }, this.startup?.readyForOnline);
    if (this.onboarding?.snapshot.phase === 'practice') this.drawOnboardingPractice();
    if (this.clockStartedAt !== null && !this.matchFinished && !this.finalizing) {
      // Reproject at the already sampled/frozen instant, even while paused.
      // Reflow must not judge notes, advance time, or start a new recording.
      this.updateNotes(this.musicClock.timeMs);
    }
  };

  private layoutStage(): void {
    const { stage, active } = this.layout;
    const sourceWidth = this.stageBackdrop.frame.realWidth;
    const sourceHeight = this.stageBackdrop.frame.realHeight;
    const floorRatio = this.customStageTextureKey ? undefined : getStageTheme(this.resolvedStageId).auraFloorRatio;
    const scale = floorRatio === undefined
      ? Math.max(stage.width / sourceWidth, stage.height / sourceHeight)
      : Math.max(
        stage.width / sourceWidth,
        (active.footY - stage.y) / (sourceHeight * floorRatio),
        (stage.y + stage.height - active.footY) / (sourceHeight * (1 - floorRatio)),
      );
    const backdropY = floorRatio === undefined
      ? active.footY + 60 - sourceHeight * scale / 2
      : active.footY + sourceHeight * scale * (0.5 - floorRatio);
    this.stageBackdrop.setDisplaySize(sourceWidth * scale, sourceHeight * scale)
      .setPosition(stage.width / 2, backdropY);
    this.stageFrame = { width: sourceWidth * scale, height: sourceHeight * scale, x: stage.width / 2, y: backdropY };
    this.stageGrade.clear().fillStyle(INK, 0.22)
      .fillRect(0, 0, this.layout.width, this.layout.height);
    if (this.layout.portrait) {
      this.stageGrade.fillStyle(INK, 0.94)
        .fillRect(0, stage.y + stage.height, this.layout.width, this.layout.height - stage.y - stage.height);
    }
  }

  private applyLayout(): void {
    this.scoreFeedback?.clear();
    const { width, height, hudHeight, instrument } = this.layout;
    const hud = auraHudLayout(this.layout);
    for (const camera of [this.cameras.main, this.uiCamera]) {
      camera.setViewport(0, 0, width, height).setZoom(1).setScroll(0, 0);
    }
    this.layoutStage();
    this.hudPanel.clear().fillStyle(INK, 0.96).fillRect(0, 0, width, hudHeight);
    this.hudPanel.lineStyle(1, SLOT_COLORS[0], 0.9).lineBetween(0, hudHeight, width / 2, hudHeight);
    this.hudPanel.lineStyle(1, SLOT_COLORS[1], 0.9).lineBetween(width / 2, hudHeight, width, hudHeight);
    this.p1NameText.setPosition(24, hud.nameY).setFontSize(hud.nameSize);
    this.p2NameText.setPosition(width - 24, hud.nameY).setFontSize(hud.nameSize);
    this.p1ScoreText.setPosition(24, hud.scoreY).setFontSize(hud.scoreSize);
    this.p2ScoreText.setPosition(width - 24, hud.scoreY).setFontSize(hud.scoreSize);
    this.turnText.setPosition(width / 2, hud.statusY).setFontSize(hud.statusSize);
    this.phaseText.setPosition(width / 2, hud.leadY).setFontSize(hud.leadSize);
    this.duelHeadingText.setPosition(width / 2, hud.headingY).setFontSize(hud.headingSize).setVisible(hud.headingVisible);
    this.performerNameText.setPosition(this.layout.performerLabel.x, this.layout.performerLabel.y);
    this.countInText.setPosition(this.layout.highwayX, this.layout.laneStartY + 96);
    this.beatGraphics.clear();
    this.comboText.setPosition(instrument.comboX, instrument.comboY).setOrigin(1, 0).setFontSize(11);
    this.crtOverlay.clear().fillStyle(0x000000, 0.035);
    for (let y = 0; y < height; y += 4) this.crtOverlay.fillRect(0, y, width, 1);
    if (this.feedbackObject) {
      this.tweens.killTweensOf(this.feedbackObject);
      this.feedbackObject.destroy();
      this.feedbackObject = null;
    }
    this.applyPerformerLayout();
    this.updateScoreUi();
    this.updateCrowdUi(this.activePerformerSlot);
    if (!this.matchFinished && !this.finalizing) {
      this.drawLanes(this.activePerformerSlot ?? this.chart.turns[0]?.slot ?? 0);
    }
  }

  private applyPerformerLayout(): void {
    const composition = this.cameraComposition();
    for (const slot of [0, 1] as const) {
      const placement = composition.performers[slot];
      const transform = auraPerformerTransform(this.views[slot].getIdleBodyReference(), placement);
      this.performerContainers[slot].setPosition(transform.x, transform.y)
        .setScale(transform.scale).setVisible(placement.visible).setAlpha(placement.alpha);
      this.playerTags[slot].setVisible(false);
      this.comicFeedback?.setAnchor(slot, auraComicAnchor(this.layout, slot));
      this.comicFeedback?.setSlotVisible(slot, this.activePerformerSlot === slot);
    }
    const labelSlot = this.activePerformerSlot ?? this.chart.turns[0]?.slot ?? 0;
    this.performerNameText.setText(`P${labelSlot + 1} · ${(labelSlot === 0 ? this.p1Name : this.p2Name).toUpperCase()}`)
      .setColor(SLOT_COLOR_CSS[labelSlot]).setVisible(!this.matchFinished && !this.finalizing && !composition.transitioning);
    this.performerNameText.setScale(Math.min(1, 256 / Math.max(1, this.performerNameText.width)));
    const placement = composition.performers[this.activePerformerSlot ?? 0];
    this.activeGlow.setPosition(placement.x, placement.footY).setAlpha(this.activePerformerSlot === null ? 0 : 1);
    this.applyBackdropComposition();
    this.drawStageLighting(this.activePerformerSlot, 0);
    this.advanceFighterPresentation(0);
  }

  private cameraComposition() {
    const startup = this.startup?.snapshot;
    const introFaceoff = this.warmingPresentation ? 1 : startup && startup.phase !== 'playing'
      ? startup.phase === 'countdown'
        ? Math.max(0, (startup.remainingMs - (AURA_STARTUP_COUNTDOWN_MS - AURA_CAMERA_HANDOFF_MS)) / AURA_CAMERA_HANDOFF_MS)
        : 1
      : null;
    return auraCameraComposition(this.layout, {
      activeSlot: this.cameraFocusSlot ?? this.activePerformerSlot ?? 0,
      fromSlot: this.cameraFromSlot ?? this.cameraFocusSlot ?? this.activePerformerSlot ?? 0,
      transitionProgress: (this.cameraTransitionMs ?? AURA_CAMERA_HANDOFF_MS) / AURA_CAMERA_HANDOFF_MS,
      ...(this.finaleElapsedMs != null ? { finaleProgress: this.finaleElapsedMs / AURA_CAMERA_FINALE_MS } : {}),
      ...(introFaceoff !== null ? { finaleProgress: introFaceoff } : {}),
      reducedMotion: this.reduceMotion,
    });
  }

  private applyBackdropComposition(): void {
    if (!this.stageFrame || !this.stageBackdrop) return;
    const { backdropOffsetX, backdropScale } = this.cameraComposition();
    const base = this.stageFrame;
    this.stageBackdrop.setDisplaySize(base.width * backdropScale, base.height * backdropScale)
      .setPosition(base.x + backdropOffsetX,
        this.layout.active.footY + (base.y - this.layout.active.footY) * backdropScale);
  }

  private advanceCameraPresentation(deltaMs: number): void {
    const finalizing = this.finaleElapsedMs != null;
    const before = finalizing ? this.finaleElapsedMs! : this.cameraTransitionMs ?? AURA_CAMERA_HANDOFF_MS;
    const duration = finalizing ? AURA_CAMERA_FINALE_MS : AURA_CAMERA_HANDOFF_MS;
    const next = this.reduceMotion ? duration : Math.min(duration, before + Math.max(0, deltaMs));
    if (finalizing) this.finaleElapsedMs = next;
    else this.cameraTransitionMs = next;
    if (next !== before) this.applyPerformerLayout();
  }

  private fitHudText(): void {
    const hud = auraHudLayout(this.layout);
    for (const text of [this.p1NameText, this.p2NameText, this.p1ScoreText, this.p2ScoreText]) {
      text.setScale(Math.min(1, hud.seatWidth / Math.max(1, text.width)));
    }
    this.phaseText.setScale(Math.min(1, hud.centerWidth / Math.max(1, this.phaseText.width)));
    this.turnText.setScale(Math.min(1, (this.layout.width - 48) / Math.max(1, this.turnText.width)));
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
    if (this.matchData.auraChallenge) {
      this.bindKeySet(this.keysP1, this.matchData.auraChallenge.slot);
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

  private laneLayout(_slot: AuraSlot, lane: AuraLane): LaneLayout {
    // Straight 4K rails in one fixed instrument area for every performer.
    const x = this.layout.highwayX + this.layout.laneOffsets[lane];
    return {
      startX: x,
      targetX: x,
      startY: this.layout.laneStartY,
      targetY: this.layout.laneTargetY,
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
    const difficulty = getAuraDifficulty(this.difficultyId);
    for (let lane = 0; lane < 4; lane += 1) {
      const typedLane = lane as AuraLane;
      const layout = this.laneLayout(slot, typedLane);
      const tone = LANE_TONES[lane];
      const left = layout.startX - LANE_HALF_WIDTH;
      const height = layout.targetY - layout.startY;
      this.laneGraphics.fillStyle(INK, 0.5);
      this.laneGraphics.fillRect(left, layout.startY, LANE_HALF_WIDTH * 2, height);
      this.laneGraphics.lineStyle(1, STEEL_DIM, 1);
      this.laneGraphics.lineBetween(left, layout.startY, left, layout.targetY);
      this.laneGraphics.lineBetween(left + LANE_HALF_WIDTH * 2, layout.startY, left + LANE_HALF_WIDTH * 2, layout.targetY);
      this.laneGraphics.fillStyle(tone, 0.7);
      this.laneGraphics.fillRect(layout.startX - 12, layout.startY - 2, 24, 2);

      // Timing bands: the good window as a faint field, the perfect window
      // as a brighter core, so the player can see what "on time" means.
      const pxPerMs = height / this.chart.noteTravelMs;
      const goodHalf = difficulty.goodWindowMs * pxPerMs;
      const perfectHalf = difficulty.perfectWindowMs * pxPerMs;
      this.laneGraphics.fillStyle(tone, 0.06);
      this.laneGraphics.fillRect(left + 1, layout.targetY - goodHalf, LANE_HALF_WIDTH * 2 - 2, goodHalf * 2);
      this.laneGraphics.fillStyle(tone, 0.12);
      this.laneGraphics.fillRect(left + 1, layout.targetY - perfectHalf, LANE_HALF_WIDTH * 2 - 2, perfectHalf * 2);

      // Receptor: a metal slot with the glyph outline inside it.
      const rx = layout.targetX - RECEPTOR_WIDTH / 2;
      const ry = layout.targetY - RECEPTOR_HEIGHT / 2;
      fillChamfered(this.targetGraphics, rx, ry, RECEPTOR_WIDTH, RECEPTOR_HEIGHT, 4, 0x0b0c14, 0.96);
      strokeChamfered(this.targetGraphics, rx, ry, RECEPTOR_WIDTH, RECEPTOR_HEIGHT, 4, 1, STEEL, 0.75);
      drawNoteGlyph(this.targetGraphics, layout.targetX, layout.targetY, tone, false);

      // Persistent keycaps teach the mapping before the player's next turn.
      // Watch mode uses lane numbers, with an explicit AUTO status below.
      fillChamfered(this.targetGraphics, layout.targetX - 22, this.layout.keyLabelY - 17, 44, 34, 4, INK, 1);
      strokeChamfered(this.targetGraphics, layout.targetX - 22, this.layout.keyLabelY - 17, 44, 34, 4, 1, STEEL, 1);
    }
    this.drawBeatGrid(slot);
    this.drawLaneControlHints(slot);
    const frameLeft = this.layout.highwayX + this.layout.laneOffsets[0] - LANE_HALF_WIDTH - HIGHWAY_FRAME_PAD_X;
    const frameTop = this.layout.laneStartY - HIGHWAY_FRAME_PAD_TOP;
    this.highwayTitleText
      .setText(this.isCpuSlot(slot) ? 'AUTO RHYTHM' : 'HIT THE LINE')
      .setColor('#fff4d6')
      .setOrigin(0, 0)
      .setPosition(frameLeft + 10, frameTop + 9)
      .setFontSize(9)
      .setVisible(true)
      .setScale(1);
  }

  private drawLaneControlHints(slot: AuraSlot, beforeStart = false): void {
    // Online always advertises this device's controls, including rival turns.
    const keys = this.laneKeysForSlot(this.online ? this.localControlledSlot() : slot);
    this.laneKeyTexts.forEach((text, lane) => {
      const layout = this.laneLayout(slot, lane as AuraLane);
      text.setText(this.cpuVsCpu ? String(lane + 1) : keys[lane])
        .setPosition(layout.targetX, this.layout.keyLabelY).setColor('#fff4d6').setScale(1).setVisible(true);
    });
    const locallyPlayable = !this.isCpuSlot(slot)
      && (!this.online || slot === this.online.localSlot);
    const hint = this.cpuVsCpu
      ? `AUTO · CPU ${slot + 1} TURN`
      : beforeStart
        ? `GET READY · ${keys.join(' ')}`
        : !locallyPlayable
          ? `${this.isCpuSlot(slot) ? 'CPU' : 'RIVAL'} TURN · GET READY`
          : !this.online && !this.isVsAI
            ? `P${slot + 1} TURN · ${keys.join(' ')}`
            : 'YOUR TURN · HIT THE SHAPES';
    this.highwayMetaText.setText(hint).setPosition(this.layout.highwayX, this.layout.keyLabelY + 47)
      .setOrigin(0.5).setVisible(true);
  }

  private drawHighwayFrame(slot: AuraSlot): void {
    const frameLeft = this.layout.highwayX + this.layout.laneOffsets[0] - LANE_HALF_WIDTH - HIGHWAY_FRAME_PAD_X;
    const frameRight = this.layout.highwayX + this.layout.laneOffsets[3] + LANE_HALF_WIDTH + HIGHWAY_FRAME_PAD_X;
    const frameTop = this.layout.laneStartY - HIGHWAY_FRAME_PAD_TOP;
    const frameBottom = this.layout.instrument.bottom;
    const width = frameRight - frameLeft;
    const height = frameBottom - frameTop;

    fillChamfered(this.laneGraphics, frameLeft, frameTop, width, height, CHAMFER + 4, INK, 0.84);
    strokeChamfered(this.laneGraphics, frameLeft, frameTop, width, height, CHAMFER + 4, 1, STEEL, 0.45);

    // A full thin border identifies the active seat without favouring an edge.
    const accent = SLOT_COLORS[slot];
    strokeChamfered(this.laneGraphics, frameLeft, frameTop, width, height, CHAMFER + 4, 1, accent, 0.8);
    this.laneGraphics.lineStyle(2, CREAM, 0.85);
    this.laneGraphics.lineBetween(frameLeft + 12, this.layout.laneTargetY, frameRight - 12, this.layout.laneTargetY);

    // Round heat: a gold hairline that grows along the bottom rail.
    const roundProgress = this.currentRoundProgress();
    this.laneGraphics.lineStyle(2, STEEL_DIM, 1);
    this.laneGraphics.lineBetween(frameLeft + CHAMFER + 4, frameBottom - 1, frameRight - CHAMFER - 4, frameBottom - 1);
    if (roundProgress > 0) {
      const railWidth = width - (CHAMFER + 4) * 2;
      this.laneGraphics.lineStyle(2, HEAT, 0.9);
      this.laneGraphics.lineBetween(
        frameLeft + CHAMFER + 4,
        frameBottom - 1,
        frameLeft + CHAMFER + 4 + railWidth * roundProgress,
        frameBottom - 1,
      );
    }
  }

  private drawBeatGrid(slot: AuraSlot): void {
    const left = this.laneLayout(slot, 0);
    const right = this.laneLayout(slot, 3);
    for (const progress of [0.25, 0.5, 0.75]) {
      const y = Phaser.Math.Linear(left.startY, left.targetY, progress);
      this.laneGraphics.lineStyle(1, STEEL, progress === 0.5 ? 0.28 : 0.14);
      this.laneGraphics.lineBetween(left.startX - LANE_HALF_WIDTH, y, right.startX + LANE_HALF_WIDTH, y);
    }
  }



  private createNote(noteId: string, lane: AuraLane): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0).setDepth(520);
    const marker = this.add.graphics();
    drawNoteGlyph(marker, 0, 0, LANE_TONES[lane], true);
    container.add(marker);
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
      if (until > this.chart.noteTravelMs || until < -getAuraDifficulty(this.difficultyId).goodWindowMs) continue;
      activeIds.add(note.id);
      const object = this.noteObjects.get(note.id) ?? this.createNote(note.id, note.lane);
      const layout = this.laneLayout(turn.slot, note.lane);
      const progress = auraNoteTravelProgress(note.atMs, nowMs, this.chart.noteTravelMs);
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
        this.turnText.setText(beats > 4 ? 'SAME ROUTINE · MOST AURA WINS' : `GET READY · ${beats}`);
      } else if (!this.finalizing) {
        this.turnText.setText('THE ROOM HAS DECIDED');
      }
      return;
    }

    const countIn = turn.firstNoteMs - nowMs;
    const remaining = Math.max(0, Math.ceil((turn.endMs - nowMs) / 1_000));
    this.turnText.setText(`ROUND ${turn.round + 1}/${AURA_ROUNDS} · P${turn.slot + 1} ${countIn > 0 ? 'GET READY' : 'ON CAM'} · ${remaining}S`);
    const activeScore = this.battle.scoreFor(turn.slot);
    this.comboText.setText(`x${activeScore.combo} FLOW`);
  }

  private updateTurnPresentation(turnIndex: number): void {
    this.currentTurnIndex = turnIndex;
    this.clearNotes();
    this.comicFeedback?.beginTurn();
    this.scoreFeedback?.clear();
    if (turnIndex < 0) {
      this.updateCrowdUi(null);
      this.focusBoth();
      const firstSlot = this.chart.turns[0]?.slot ?? this.localControlledSlot();
      this.drawLanes(firstSlot);
      this.highwayTitleText.setVisible(false);
      this.drawLaneControlHints(firstSlot, true);
      return;
    }
    if (turnIndex >= this.chart.turns.length) {
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
    if (this.onboarding) {
      this.onboarding.turn(turn.slot);
      this.emitOnboarding();
    }
    this.drawLanes(turn.slot);
    this.updateCrowdUi(turn.slot);
    // Inactive turns change the status, never hide the controls to learn next.
    this.focusPerformer(turn.slot);
  }

  private focusPerformer(slot: AuraSlot): void {
    const previous = this.cameraFocusSlot ?? this.activePerformerSlot ?? slot;
    this.cameraFromSlot = previous;
    this.cameraFocusSlot = slot;
    this.cameraTransitionMs = previous === slot || this.reduceMotion ? AURA_CAMERA_HANDOFF_MS : 0;
    this.activePerformerSlot = slot;
    const inactive = (1 - slot) as AuraSlot;
    this.restPerformer(slot);
    this.restPerformer(inactive);
    // Both bodies keep their stage marks while the camera glides to the next
    // performer. Count-in provides the handoff time; the instrument stays fixed.
    this.views[slot].sprite.setAlpha(1);
    this.views[slot].shadowSprite?.setAlpha(0.2);
    this.views[inactive].sprite.setAlpha(1);
    this.views[inactive].shadowSprite?.setAlpha(0.12);
    for (const view of this.views) view.setRenderPresentation(this.fighterRenderScale, this.fighterRenderYOffset);
    this.applyPerformerLayout();
    this.syncCrowdMix(slot);
    this.emitPresentationTurn(slot);
  }

  private focusBoth(): void {
    if (!this.views) return;
    this.activePerformerSlot = null;
    this.highwayTitleText?.setVisible(false);
    this.highwayMetaText?.setVisible(false);
    this.updateCrowdUi(null);
    for (const [slot, view] of this.views.entries()) {
      view.sprite.setAlpha(1);
      view.shadowSprite?.setAlpha(0.16);
      view.setRenderPresentation(this.fighterRenderScale, this.fighterRenderYOffset);
      this.restPerformer(slot as AuraSlot);
    }
    this.applyPerformerLayout();
    const roomHeat = Math.max(this.crowdHeat[0], this.crowdHeat[1]);
    this.soundManager?.setAuraCrowdMix(roomHeat, this.finalizing ? 1 : 0);
    this.activeGlow?.setAlpha(0);
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
    const anchorX = this.layout.instrument.crowdX;
    this.crowdLabelText
      .setText(`CROWD · ${status}`)
      .setOrigin(1, 0)
      .setPosition(anchorX, this.layout.instrument.crowdY)
      .setVisible(true);

    const segmentWidth = this.layout.instrument.crowdSegmentWidth;
    const gap = 4;
    const trackWidth = CROWD_METER_SEGMENTS * segmentWidth + (CROWD_METER_SEGMENTS - 1) * gap;
    const trackLeft = anchorX - trackWidth;
    const filled = Math.ceil(heat * CROWD_METER_SEGMENTS);
    const segmentColors = [STEEL, STEEL, STEEL, CREAM, CREAM, HEAT, HEAT_DEEP, DANGER];
    this.crowdMeterGraphics.clear().setVisible(true);
    const meterY = this.layout.instrument.crowdMeterY;
    fillChamfered(this.crowdMeterGraphics, trackLeft - 4, meterY, trackWidth + 8, 10, 3, INK, 0.85);
    for (let index = 0; index < CROWD_METER_SEGMENTS; index += 1) {
      const x = trackLeft + index * (segmentWidth + gap);
      const lit = index < filled;
      this.crowdMeterGraphics.fillStyle(lit ? segmentColors[index] : STEEL_DIM, lit ? 0.95 : 0.8);
      this.crowdMeterGraphics.fillRect(x, meterY + 2, segmentWidth, 6);
    }
  }

  private flashLaneInput(slot: AuraSlot, lane: AuraLane): void {
    const flash = this.inputFlashGraphics[lane];
    const pulse = this.inputPulseGraphics[lane];
    const keyText = this.laneKeyTexts[lane];
    if (!flash || !pulse || !keyText) return;

    const layout = this.laneLayout(slot, lane);
    const tone = LANE_TONES[lane];
    this.tweens.killTweensOf(flash);
    this.tweens.killTweensOf(pulse);
    this.tweens.killTweensOf(keyText);
    flash.clear();
    flash.fillStyle(tone, 0.07);
    flash.fillRect(layout.targetX - LANE_HALF_WIDTH, layout.startY, LANE_HALF_WIDTH * 2, layout.targetY - layout.startY);
    flash.fillStyle(tone, 0.16);
    flash.fillRect(layout.targetX - LANE_HALF_WIDTH, layout.targetY - 70, LANE_HALF_WIDTH * 2, 70);
    const rx = layout.targetX - RECEPTOR_WIDTH / 2;
    const ry = layout.targetY - RECEPTOR_HEIGHT / 2;
    fillChamfered(flash, rx, ry, RECEPTOR_WIDTH, RECEPTOR_HEIGHT, 4, tone, 0.95);
    strokeChamfered(flash, rx, ry, RECEPTOR_WIDTH, RECEPTOR_HEIGHT, 4, 2, 0xffffff, 1);
    drawNoteGlyph(flash, layout.targetX, layout.targetY, 0xffffff, true);
    flash.setAlpha(1);

    pulse.clear();
    strokeChamfered(pulse, -RECEPTOR_WIDTH / 2, -RECEPTOR_HEIGHT / 2, RECEPTOR_WIDTH, RECEPTOR_HEIGHT, 4, 3, tone, 0.9);
    pulse.setPosition(layout.targetX, layout.targetY).setScale(0.94).setAlpha(1);

    keyText.setColor('#ffffff').setPosition(layout.targetX, this.layout.keyLabelY).setScale(1.18);

    if (this.reduceMotion) {
      this.time.delayedCall(120, () => {
        flash.setAlpha(0);
        pulse.setAlpha(0);
        keyText.setColor('#fff4d6').setPosition(this.laneLayout(slot, lane).targetX, this.layout.keyLabelY).setScale(1);
      });
      return;
    }
    this.tweens.add({ targets: flash, alpha: 0, duration: 200, ease: 'Quart.easeOut' });
    this.tweens.add({
      targets: pulse,
      scaleX: 1.3,
      scaleY: 1.5,
      alpha: 0,
      duration: 200,
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
    if (this.onboarding?.snapshot.phase === 'practice') {
      if (this.lifecycleActive && this.presentationReady && this.presentationStarted && !this.paused
        && !this.matchFinished && !this.finalizing) this.handlePracticeInput(slot, lane);
      return;
    }
    if (nowMs < 0 || this.paused || this.matchFinished || this.finalizing || this.isCpuSlot(slot)) return;
    if (this.online && this.online.localSlot !== slot) return;
    if (auraTurnAt(this.chart, nowMs)?.slot === slot) this.flashLaneInput(slot, lane);
    const judgement = this.battle.judgeInput(slot, lane, nowMs);
    if (judgement.grade === 'wrong_turn') {
      this.recordJudgement(judgement, nowMs);
      if (nowMs - this.lastWrongTurnFeedbackAt > 650) {
        this.lastWrongTurnFeedbackAt = nowMs;
        this.showFeedback(judgement);
      }
      return;
    }
    this.applyJudgement(judgement, true, nowMs);
  }

  private playCpuPlans(nowMs: number): void {
    for (const slot of [0, 1] as const) {
      if (!this.isCpuSlot(slot)) continue;
      const plan = this.cpuPlans[slot];
      while (this.cpuPlanIndices[slot] < plan.length && plan[this.cpuPlanIndices[slot]].atMs <= nowMs) {
        const hit = plan[this.cpuPlanIndices[slot]++];
        const judgement = this.battle.judgeNote(hit.noteId, hit.grade, hit.offsetMs);
        if (judgement) this.applyJudgement(judgement, false, nowMs);
      }
    }
  }

  private collectHumanMisses(nowMs: number): void {
    let slots: AuraSlot[];
    if (this.online) slots = [this.online.localSlot];
    else slots = ([0, 1] as AuraSlot[]).filter((slot) => !this.isCpuSlot(slot));
    for (const judgement of this.battle.collectMisses(nowMs, slots)) {
      this.applyJudgement(judgement, true, nowMs);
    }
  }

  private recordJudgement(judgement: AuraJudgement, atMs: number): void {
    try { this.actionRecorder?.record(atMs, judgement); }
    catch (error) {
      // An incomplete history must never be labelled as a complete replay.
      this.actionRecorder = null;
      debugWarn('[AuraScene] Action history stopped', error);
    }
  }

  private applyJudgement(judgement: AuraJudgement, broadcast: boolean, atMs = this.clockMs()): void {
    if (this.onboarding) {
      this.onboarding.judgement(judgement, this.activePerformerSlot);
      this.emitOnboarding();
    }
    this.recordJudgement(judgement, atMs);
    const noteObject = judgement.noteId ? this.noteObjects.get(judgement.noteId) : null;
    if (noteObject) {
      this.noteObjects.delete(judgement.noteId!);
      if (
        (judgement.grade === 'perfect' || judgement.grade === 'great' || judgement.grade === 'good')
        && !this.reduceMotion
      ) {
        const hitScale = judgement.grade === 'perfect' ? 1.5 : judgement.grade === 'great' ? 1.32 : 1.18;
        this.tweens.add({
          targets: noteObject,
          scaleX: hitScale,
          scaleY: hitScale * 0.6,
          alpha: 0,
          duration: 110,
          ease: 'Quart.easeOut',
          onComplete: () => noteObject.destroy(),
        });
      } else {
        noteObject.destroy();
      }
    }
    this.animateFighterForJudgement(judgement);
    this.showFeedback(judgement);
    this.updateScoreUi();
    this.trackMilestone(judgement);
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

  private trackMilestone(judgement: AuraJudgement): void {
    if (judgement.grade === 'wrong_turn') return;
    const slot = judgement.slot;
    if (judgement.grade === 'miss' || judgement.grade === 'mash') {
      this.lastMilestone[slot] = 0;
      return;
    }
    const combo = this.battle.scoreFor(slot).combo;
    if (combo < 10 || combo % 10 !== 0 || this.lastMilestone[slot] === combo) return;
    this.lastMilestone[slot] = combo;
    this.playMilestone(slot, combo);
  }

  /** Every ten clean notes celebrate on the visible performance, not its hidden base sprite. */
  private playMilestone(slot: AuraSlot, combo: number): void {
    if (this.activePerformerSlot !== slot) return;
    this.comicFeedback?.milestone(slot, combo);
  }

  private reactCrowd(judgement: AuraJudgement): void {
    if (judgement.grade === 'wrong_turn') return;
    const slot = judgement.slot;
    if (judgement.grade === 'miss' || judgement.grade === 'mash') {
      const heatBeforeFailure = this.crowdHeat[slot];
      this.crowdHeat[slot] = Math.max(0, judgement.grade === 'miss'
        ? heatBeforeFailure * 0.55 - 0.08
        : heatBeforeFailure * 0.75 - 0.04);
      this.refreshCrowdPresentation(slot);
      this.syncCrowdMix(
        slot,
        heatBeforeFailure * (judgement.grade === 'miss' ? 0.8 : 0.4),
      );
      return;
    }

    const gain = judgement.grade === 'perfect' ? 0.025 : judgement.grade === 'great' ? 0.018 : 0.012;
    const comboHeat = Math.min(1, judgement.combo / 40);
    this.crowdHeat[slot] = Math.min(1, Math.max(comboHeat, this.crowdHeat[slot] + gain));
    this.refreshCrowdPresentation(slot);
    this.syncCrowdMix(slot);
  }



  private refreshCrowdPresentation(slot: AuraSlot): void {
    if (this.activePerformerSlot !== slot) return;
    this.updateCrowdUi(slot);
  }

  private currentRoundProgress(): number {
    const round = this.chart.turns[this.currentTurnIndex]?.round ?? 0;
    return Phaser.Math.Clamp(round / Math.max(1, AURA_ROUNDS - 1), 0, 1);
  }

  private syncCrowdMix(slot: AuraSlot, negativePunch = 0): void {
    // Late online judgements still update that seat's heat, but must not
    // replace the current performer's crowd mix or replay an old failure.
    if (this.activePerformerSlot !== slot) return;
    this.soundManager.setAuraCrowdMix(this.crowdHeat[slot], this.currentRoundProgress(), negativePunch);
  }

  private animateFighterForJudgement(judgement: AuraJudgement): void {
    // Network results may arrive after a handoff. Score them, but never wake
    // the waiting performer or replace the current performer's visual phrase.
    if (judgement.grade === 'wrong_turn' || this.activePerformerSlot !== judgement.slot) return;
    const fighter = this.fighters[judgement.slot];
    const performanceView = this.auraPerformanceViews[judgement.slot];
    const note = judgement.noteId ? this.noteById.get(judgement.noteId) ?? null : null;
    const routine = note ? createAuraPerformanceRoutine(this.matchSeed, this.chart.turns[note.turnIndex].round) : null;
    const requested = this.canaryPerformanceOverride
      ?? (note && routine ? auraPerformanceAtBeat(routine, note.beat) : null);
    let played: AuraAnimationName | null = requested && performanceView?.play(requested) ? requested : null;
    if (!played && performanceView) {
      const fallback = performanceView.firstRoutineAnimation();
      if (fallback && performanceView.play(fallback)) played = fallback;
    }
    if (performanceView) {
      fighter.forceState(FighterState.IDLE);
      performanceView.update(0, this.views[judgement.slot]);
    } else {
      fighter.forceState(this.choreographyFor(judgement));
    }
    // Context belongs to the move actually rendered, not an unavailable pack.
    if (played) this.comicFeedback?.move(judgement.slot, played);
    this.comicFeedback?.judgement(judgement.slot, judgement.grade === 'miss' || judgement.grade === 'mash');
  }

  /** Lane picks the fallback move family, the beat picks the flavour. */
  private choreographyFor(judgement: AuraJudgement): FighterState {
    const big = [
      FighterState.HIGH_PUNCH,
      FighterState.LOW_KICK,
      FighterState.HIGH_KICK,
      FighterState.UPPERCUT,
    ] as const;
    const quick = [
      FighterState.LOW_PUNCH,
      FighterState.CROUCH,
      FighterState.HIGH_PUNCH,
      FighterState.LOW_KICK,
    ] as const;
    const note = judgement.noteId ? this.noteById.get(judgement.noteId) : undefined;
    if (!note) return quick[judgement.lane];
    const clean = judgement.grade === 'perfect' || judgement.grade === 'great';
    if (clean && Number.isInteger(note.beat) && note.beat % 8 === 7) return FighterState.VICTORY;
    if (!Number.isInteger(note.beat)) return quick[judgement.lane];
    return big[judgement.lane];
  }



  private showFeedback(judgement: AuraJudgement): void {
    // A delayed rival packet can change the score, but not the current body's
    // feedback. Keep the delta next to its score, clear of the performance.
    if (judgement.slot !== this.activePerformerSlot && judgement.grade !== 'wrong_turn') return;
    if (judgement.grade !== 'wrong_turn') {
      this.scoreFeedback?.show(judgement.scoreDelta, auraScoreCueAnchor(this.layout, judgement.slot));
    }
    const primary = judgement.grade === 'perfect'
      ? 'PERFECT'
      : judgement.grade === 'great'
        ? 'CLEAN'
        : judgement.grade === 'good'
          ? 'GOOD'
          : judgement.grade === 'miss'
            ? 'MISS'
            : judgement.grade === 'mash'
              ? 'TOO FAST'
              : 'WAIT YOUR TURN';
    const color = judgement.grade === 'perfect'
      ? '#ffce3a'
      : judgement.grade === 'great'
        ? '#fff4d6'
        : judgement.grade === 'good'
          ? '#9aa1b4'
          : '#9aa1b4';
    // One call-out at a time in the reserved feedback area, clear of the body.
    if (this.feedbackObject) {
      this.tweens.killTweensOf(this.feedbackObject);
      this.feedbackObject.destroy();
      this.feedbackObject = null;
    }
    const container = this.add.container(this.layout.feedback.x, this.layout.feedback.y).setDepth(700);
    const title = this.add.text(0, 0, primary, {
      fontFamily: PIXEL_FONT,
      fontSize: '13px',
      color,
      align: 'center',
      stroke: '#050507',
      strokeThickness: 4,
    }).setOrigin(0.5, 0);
    container.add(title);
    const timed = judgement.noteId !== null && judgement.grade !== 'miss';
    if (timed) {
      // Early/late readout: a small meter with a tick, plus the offset in ms.
      const window = getAuraDifficulty(this.difficultyId).goodWindowMs;
      const ratio = Phaser.Math.Clamp(judgement.offsetMs / window, -1, 1);
      const meterY = title.height + 10;
      const meter = this.add.graphics();
      meter.fillStyle(INK, 0.85);
      meter.fillRect(-44, meterY, 88, 6);
      meter.fillStyle(STEEL, 0.5);
      meter.fillRect(-42, meterY + 2, 84, 2);
      meter.fillStyle(CREAM, 0.9);
      meter.fillRect(-1, meterY - 1, 2, 8);
      meter.fillStyle(judgement.grade === 'perfect' ? HEAT : CREAM, 1);
      meter.fillRect(Math.round(ratio * 40) - 2, meterY - 2, 4, 10);
      container.add(meter);
      if (Math.abs(judgement.offsetMs) >= 12) {
        const early = judgement.offsetMs < 0;
        const readout = this.add.text(
          early ? -52 : 52,
          meterY - 1,
          `${early ? 'EARLY' : 'LATE'} ${Math.round(Math.abs(judgement.offsetMs))}MS`,
          { fontFamily: PIXEL_FONT, fontSize: '7px', color: '#9aa1b4', stroke: '#050507', strokeThickness: 3 },
        ).setOrigin(early ? 1 : 0, 0);
        container.add(readout);
      }
    }
    this.uiLayer.add(container);
    this.feedbackObject = container;
    const release = () => {
      if (this.feedbackObject === container) this.feedbackObject = null;
      container.destroy();
    };
    if (this.reduceMotion) {
      this.time.delayedCall(360, release);
      return;
    }
    container.setAlpha(1);
    this.tweens.add({
      targets: container,
      alpha: 0,
      delay: 280,
      duration: 140,
      ease: 'Quad.easeIn',
      onComplete: release,
    });
  }

  private updateScoreUi(): void {
    const p1 = this.battle.scoreFor(0);
    const p2 = this.battle.scoreFor(1);
    this.renderDuelScoreUi(p1.score, p2.score);
  }

  private renderDuelScoreUi(p1: number, p2: number): void {
    this.p1ScoreText.setText(`${formatAura(p1)} AURA`);
    this.p2ScoreText.setText(`${formatAura(p2)} AURA`);
    const duel = auraHudState([p1, p2]);
    this.duelMeterGraphics.clear();
    drawAuraDuelMeter(this.duelMeterGraphics, this.layout, duel);
    this.phaseText.setText(duel.leadLabel).setColor(duel.leader === null ? '#fff4d6' : '#ffce3a');
    this.fitHudText();
  }

  private restPerformer(slot: AuraSlot): void {
    this.fighters[slot].forceState(FighterState.IDLE);
    this.views[slot].syncSprite(this.fighters[(1 - slot) as AuraSlot].x);
    const performance = this.auraPerformanceViews[slot];
    if (performance && !performance.playResting()) performance.interrupt(this.views[slot]);
    performance?.update(0, this.views[slot]);
  }

  private advanceFighterPresentation(dt: number): void {
    if (!this.fighters || !this.views) return;
    for (const slot of [0, 1] as const) {
      const opponent = (1 - slot) as AuraSlot;
      const performing = this.activePerformerSlot === slot;
      // Fighter.update(0) still advances stateFrame, so skip it entirely at rest.
      if (dt > 0 && (performing || this.matchFinished)) this.fighters[slot].update(dt, EMPTY_INPUT, this.fighters[opponent].x);
      this.views[slot].syncSprite(this.fighters[opponent].x);
      this.auraPerformanceViews[slot]?.update(performing || this.matchFinished ? dt * 1_000 : 0, this.views[slot]);
      const rig = this.performerContainers?.[slot];
      if (rig) {
        const body = this.views[slot].getIdleBodyReference();
        const placement = this.cameraComposition().performers[slot];
        // Combat fallbacks (notably uppercut) also move Fighter.y in the Fight
        // simulation. Aura owns the stage root: cancel that world translation,
        // not the authored pose offsets, and never resize an individual frame.
        rig.setPosition(placement.x - body.rootX * rig.scaleX, placement.footY - body.rootY * rig.scaleY);
      }
      const top = this.getPerformerTopCenter(slot);
      this.playerTags[slot]?.setPosition(top.x, Math.max(this.layout.hudHeight + 22, top.y - 24));
    }
  }

  private getPerformerTopCenter(slot: AuraSlot): { x: number; y: number } {
    const top = this.auraPerformanceViews[slot]?.getVisibleTopCenter()
      ?? this.views[slot].getVisibleTopCenter();
    const container = this.performerContainers?.[slot];
    return container ? { x: container.x + top.x * container.scaleX, y: container.y + top.y * container.scaleY } : top;
  }

  private isCpuSlot(slot: AuraSlot): boolean {
    if (this.online) return false;
    if (this.matchData.auraChallenge) return slot !== this.matchData.auraChallenge.slot;
    return this.cpuVsCpu || (this.isVsAI && slot === 1);
  }

  private localControlledSlot(): AuraSlot {
    return this.online?.localSlot ?? this.matchData.auraChallenge?.slot ?? 0;
  }

  private beginClock(delayMs: number): void {
    if (!this.lifecycleActive || !this.presentationReady || !this.presentationStarted
      || this.onboarding?.snapshot.phase === 'practice') return;
    if (this.online && !this.localOnlineReady) return;
    if (this.scheduledClockStart !== null || this.clockStartedAt !== null) return;
    this.scheduledClockStart = performance.now() + delayMs;
    if (this.online) {
      this.startup?.countdown(delayMs);
      this.emitStartup();
    }
    this.soundManager.stopBattleMusic();
    const epoch = this.lifecycleEpoch;
    const start = () => {
      if (!this.isCurrentLifecycle(epoch) || this.clockStartedAt !== null || this.paused) return;
      this.clockStartedAt = performance.now();
      this.scheduledClockStart = null;
      this.pausedDuration = 0;
      this.startup?.play();
      this.startupView?.render(this.layout, this.startup?.snapshot ?? null);
      this.emitStartup();
      if (!this.silentStartup) {
        this.soundManager.startBattleMusic(this.challengeMusicUrl ?? this.track.url);
        this.soundManager.startAuraCrowd();
      }
      this.emitPresentationTurn(this.chart.turns[0]?.slot ?? 0);
      debugInfo('[AuraScene] Beat clock started', { seed: this.matchSeed, difficulty: this.difficultyId });
    };
    if (delayMs === 0) start();
    else this.time.delayedCall(delayMs, start);
  }

  /** Sample on render and input, so judgements follow actual media playback,
   * not the age of the previous render or a wall-clock drift threshold. */
  private syncClockToMusic(): void {
    if (this.clockStartedAt === null || this.paused) return;
    this.musicClock.update(
      Math.max(0, performance.now() - this.clockStartedAt - this.pausedDuration),
      this.silentStartup ? { status: 'unavailable' } : this.soundManager.getBattleMusicClockSample(),
    );
  }

  private clockMs(): number {
    if (this.clockStartedAt === null) return -1;
    this.syncClockToMusic();
    return this.musicClock.timeMs;
  }

  private beginFinalization(): void {
    this.onboarding?.complete();
    this.emitOnboarding();
    this.finalizing = true;
    this.finalizingStartedAt = performance.now();
    this.clearNotes();
    this.laneGraphics.clear();
    this.targetGraphics.clear();
    this.laneKeyTexts.forEach((text) => text.setVisible(false));
    this.turnText.setText(this.online ? 'CHECKING FINAL SCORES' : 'THE ROOM HAS DECIDED');
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
    this.activePerformerSlot = winner === 'draw' ? null : winner === 'p2' ? 1 : 0;
    this.finaleElapsedMs = this.reduceMotion ? AURA_CAMERA_FINALE_MS : 0;
    this.comicFeedback?.beginTurn();
    this.scoreFeedback?.clear();
    this.comboText.setVisible(false);
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
    for (const slot of [0, 1] as const) {
      const performance = this.auraPerformanceViews[slot];
      const won = winner === 'draw' || winner === (slot === 0 ? 'p1' : 'p2');
      if (performance && !performance.playFinale(won)) performance.interrupt(this.views[slot]);
    }
    this.applyPerformerLayout();
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
      ...(!this.customStageKey ? {
        challengeRoutine: createAuraChallengeRoutine(this.matchSeed, this.difficultyId, this.track.id, this.resolvedStageId) ?? undefined,
        challengeShareSlots: this.matchData.auraChallenge ? [this.matchData.auraChallenge.slot] : this.online ? [this.online.localSlot]
          : this.cpuVsCpu ? [] : this.isVsAI ? [0] : [0, 1],
      } : {}),
      ...(this.matchData.auraChallenge ? { challenge: this.matchData.auraChallenge } : {}),
      ...(this.online ? { online: this.online } : {}),
    };
    this.turnText.setText(winner === 'draw' ? 'MUTUAL MAIN CHARACTERS' : `${winner === 'p1' ? this.p1Name : this.p2Name} OWNS THE ROOM`);
    this.renderDuelScoreUi(p1Score.score, p2Score.score);
    this.fitHudText();
    this.soundManager.playAnnounce('wins');
    this.soundManager.peakAuraCrowd();
    window.dispatchEvent(new CustomEvent(AURA_BATTLE_COMPLETE_EVENT, { detail: summary }));
    try {
      this.actionRecorder?.finish(summary);
      const recording = this.actionRecorder?.toRecording();
      if (recording?.status === 'complete') void saveAuraRecording(this.captureId, recording).then(saved => {
        if (!saved) debugWarn('[AuraScene] Local action history could not be saved');
      });
    } catch (error) { debugWarn('[AuraScene] Action history incomplete', error); }
    const epoch = this.lifecycleEpoch;
    // Include the winner reveal in the actual canvas recording, then stop game
    // music so it cannot double up with the result screen's video playback.
    if (this.videoRecorder?.status === 'recording') this.emitCapture({ id: this.captureId, state: 'processing' });
    this.time.delayedCall(2_800, () => { void this.finishVideoCapture(epoch); });
    this.time.delayedCall(this.reduceMotion ? 1_800 : 3_000, () => this.setMatchActionsVisible(true));
  }

  private emitCapture(detail: AuraCaptureDetail): void {
    window.dispatchEvent(new CustomEvent(AURA_CAPTURE_EVENT, { detail }));
  }

  private async finishVideoCapture(epoch: number): Promise<void> {
    if (!this.isCurrentLifecycle(epoch)) return;
    const recorder = this.videoRecorder;
    const video = await recorder?.stop();
    if (!this.isCurrentLifecycle(epoch)) return;
    this.soundManager.pauseBattleMusic();
    this.emitCapture(video
      ? { id: this.captureId, state: 'ready', video }
      : { id: this.captureId, state: 'unavailable', reason: recorder?.error ?? 'recording-unavailable' });
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
    if (this.online || this.matchFinished) return;
    const next = event.detail.paused;
    if (next === this.paused) return;
    if (next) {
      this.paused = true;
      this.pausedAt = performance.now();
      this.soundManager?.pauseBattleMusic();
      this.videoRecorder?.pause();
    } else {
      this.pausedDuration += performance.now() - this.pausedAt;
      this.paused = false;
      if (this.clockStartedAt !== null) this.soundManager?.resumeBattleMusic();
      this.videoRecorder?.resume();
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
    const retryChallenge = action === 'run_it_back' ? this.matchData.auraChallenge : undefined;
    const remixedPlayer = action === 'remix' && this.matchData.auraChallenge?.slot === 1 ? {
      p1Name: this.matchData.p2Name, p2Name: this.matchData.p1Name,
      p1PhotoHash: this.matchData.p2PhotoHash, p2PhotoHash: this.matchData.p1PhotoHash,
      p1CloudFighterId: this.matchData.p2CloudFighterId, p2CloudFighterId: this.matchData.p1CloudFighterId,
      p1PersonalityId: this.matchData.p2PersonalityId, p2PersonalityId: this.matchData.p1PersonalityId,
    } : {};
    this.scene.restart({
      ...this.matchData,
      ...remixedPlayer,
      gameMode: 'aura',
      auraDifficulty: this.difficultyId,
      remix: this.remix + 1,
      seed: retryChallenge?.seed ?? (nextSeed || 0x41555241),
      auraTrackId: retryChallenge?.trackId ?? (action === 'remix' ? undefined : this.track.id),
      auraChallenge: retryChallenge,
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
    this.startupAbort?.abort();
    this.startupAbort = null;
    this.startupView?.destroy();
    this.startupView = null;
    this.startup = null;
    this.startupMediaUnlock = null;
    this.challengeMediaAbort?.abort();
    this.challengeMediaAbort = null;
    if (this.challengeMusicUrl) revokeAuraChallengeMusicUrl(this.challengeMusicUrl);
    this.challengeMusicUrl = null;
    this.presentationReady = false;
    this.presentationStarted = false;
    this.scale?.off(Phaser.Scale.Events.RESIZE, this.onLayoutResize);
    this.lifecycleEpoch += 1;
    window.removeEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.removeEventListener(PAUSE_EVENT, this.onPause);
    window.removeEventListener(AURA_INPUT_EVENT, this.onAuraInput);
    window.removeEventListener(AURA_PRESENTATION_START_EVENT, this.onPresentationStart);
    window.removeEventListener(AURA_STARTUP_READY_EVENT, this.onStartupReady);
    window.removeEventListener(AURA_ONBOARDING_SKIP_EVENT, this.onOnboardingSkip);
    this.onboardingGraphics?.destroy();
    this.onboardingGraphics = null;
    this.onboarding = null;
    for (const { key, handler } of this.keyBindings) key.off('down', handler);
    this.keyBindings = [];
    this.clearNotes();
    this.comicFeedback?.destroy();
    this.comicFeedback = null;
    this.scoreFeedback?.clear();
    this.scoreFeedback = null;
    for (const view of this.auraPerformanceViews) view?.destroy();
    this.auraPerformanceViews = [null, null];
    for (const pack of this.auraAnimationPacks) destroyLoadedAuraAnimationPack(this, pack);
    this.auraAnimationPacks = [null, null];
    this.videoRecorder?.destroy();
    this.videoRecorder = null;
    this.actionRecorder = null;
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
