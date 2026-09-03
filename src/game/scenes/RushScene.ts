import Phaser from 'phaser';
import { Fighter } from '../fighters/Fighter.ts';
import { FighterView } from '../fighters/FighterView.ts';
import { FighterState, FIXED_TIMESTEP, GAME_HEIGHT, GAME_WIDTH } from '../constants.ts';
import { InputManager } from '../systems/InputManager.ts';
import { SoundManager } from '../systems/SoundManager.ts';
import { resetVirtualInput } from '../systems/VirtualInput.ts';
import { loadAiSprites } from '../sprites/AiSpriteLoader.ts';
import {
  MATCH_ACTION_EVENT,
  PAUSE_EVENT,
  RUNTIME_READY_EVENT,
  RUSH_COMPANION_ORDER_EVENT,
  RUSH_RUN_COMPLETE_EVENT,
  type MatchAction,
  type MatchSceneData,
  type RushRunCompleteDetail,
} from '../match/MatchConfig.ts';
import {
  getDefaultStageThemeIdForMode,
  getStageTheme,
  stageSupportsMode,
  type StageThemeId,
} from '../match/StageConfig.ts';
import { getCachedStageBackground } from '../../services/SpriteCache.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';
import {
  BrawlSimulation,
  type BrawlActor,
  type BrawlObstacle,
  type BrawlProjectile,
  type BrawlSimEvent,
} from '../brawl/BrawlSimulation.ts';
import { RUSH_ROUTE_MAP, type BrawlMapDefinition, type BrawlObstacleSkin } from '../brawl/BrawlMap.ts';
import { getBrawlCompanionInput } from '../brawl/BrawlCompanionAI.ts';
import {
  buildRushRouteMap,
  getRushStageProfile,
  type RushStageProfile,
} from '../brawl/RushStageProfile.ts';
import { scoreRushRun } from '../brawl/RushRunScore.ts';
import {
  RUSH_COMPANION_ORDERS,
  getRushDifficulty,
  type RushCompanionOrder,
  type RushDifficultyId,
} from '../brawl/RushConfig.ts';

const MAX_TICKS_PER_FRAME = 5;
const DEFAULT_STAGE_ID: StageThemeId = getDefaultStageThemeIdForMode('rush');
const PLAYER_TAG_POINTER_REACH = 22;
const PLAYER_TAG_CLEARANCE = 6;

const SIDE_STREET_ASSETS = {
  barricadeIntact: ['rush_side_street_barricade_intact', '/assets/rush/side-street/barricade-intact.png'],
  barricadeDamaged: ['rush_side_street_barricade_damaged', '/assets/rush/side-street/barricade-damaged.png'],
  barricadeBroken: ['rush_side_street_barricade_broken', '/assets/rush/side-street/barricade-broken.png'],
  fuelCellIntact: ['rush_side_street_fuel_cell_intact', '/assets/rush/side-street/fuel-cell-intact.png'],
  fuelCellDamaged: ['rush_side_street_fuel_cell_damaged', '/assets/rush/side-street/fuel-cell-damaged.png'],
  fuelCellBroken: ['rush_side_street_fuel_cell_broken', '/assets/rush/side-street/fuel-cell-broken.png'],
  steamVentIdle: ['rush_side_street_steam_vent_idle', '/assets/rush/side-street/steam-vent-idle.png'],
  steamVentActive: ['rush_side_street_steam_vent_active', '/assets/rush/side-street/steam-vent-active.png'],
  entryDoor: ['rush_side_street_entry_door', '/assets/rush/side-street/entry-door.png'],
  entryManhole: ['rush_side_street_entry_manhole', '/assets/rush/side-street/entry-manhole.png'],
  entryDropRig: ['rush_side_street_entry_drop_rig', '/assets/rush/side-street/entry-drop-rig.png'],
} as const;

interface ActorPresentation {
  fighter: Fighter;
  view: FighterView;
  tag: Phaser.GameObjects.Container | null;
  health: Phaser.GameObjects.Graphics | null;
}

interface ObstaclePresentation {
  graphics: Phaser.GameObjects.Graphics;
  sprite: Phaser.GameObjects.Image | null;
}

interface ObstaclePalette {
  body: number;
  top: number;
  accent: number;
  dark: number;
}

interface RushRunStats {
  enemiesDefeated: number;
  obstaclesDestroyed: number;
  checkpointsCleared: number;
  revives: number;
  damageTaken: number;
}

function emptyRunStats(): RushRunStats {
  return {
    enemiesDefeated: 0,
    obstaclesDestroyed: 0,
    checkpointsCleared: 0,
    revives: 0,
    damageTaken: 0,
  };
}

const OBSTACLE_PALETTES: Record<BrawlObstacleSkin, ObstaclePalette> = {
  arena: { body: 0x27212f, top: 0x51425f, accent: 0xffce3a, dark: 0x09070a },
  executive: { body: 0x26384c, top: 0x56789b, accent: 0xe7f2ff, dark: 0x08111d },
  mars: { body: 0x5b2c24, top: 0x9c4d32, accent: 0xffa24d, dark: 0x160806 },
  tablao: { body: 0x521729, top: 0x8a2f43, accent: 0xffce3a, dark: 0x15050a },
  jaula: { body: 0x244635, top: 0x477a59, accent: 0xffe066, dark: 0x06110b },
  'side-street': { body: 0x334155, top: 0x687386, accent: 0xffcf33, dark: 0x080a12 },
  custom: { body: 0x293348, top: 0x52647d, accent: 0xffce3a, dark: 0x07090f },
};

declare global {
  interface Window {
    __ASF_RUSH_STATE__?: () => ReturnType<BrawlSimulation['snapshot']>;
  }
}

export class RushScene extends Phaser.Scene {
  private matchData!: MatchSceneData;
  private sim!: BrawlSimulation;
  private inputManager!: InputManager;
  private soundManager: SoundManager | null = null;
  private companionCpu = false;
  private companionOrder: RushCompanionOrder = 'follow';
  private rushDifficulty: RushDifficultyId = 'arcade';
  private ready = false;
  private accumulator = 0;
  private stageId: StageThemeId = DEFAULT_STAGE_ID;
  private customStageKey: string | null = null;
  private stageTextureKey: string | null = null;
  private routeMap: Readonly<BrawlMapDefinition> = RUSH_ROUTE_MAP;
  private stageProfile!: RushStageProfile;
  private lifecycle = 0;
  private presentations = new Map<string, ActorPresentation>();
  private projectileSprites = new Map<number, Phaser.GameObjects.Sprite>();
  private obstaclePresentations = new Map<string, ObstaclePresentation>();
  private stageEntrySprites: Phaser.GameObjects.Image[] = [];
  private stageEntryKeys = new Set<string>();
  private entranceCueGraphics!: Phaser.GameObjects.Graphics;
  private hudGraphics!: Phaser.GameObjects.Graphics;
  private hudP1!: Phaser.GameObjects.Text;
  private hudP2!: Phaser.GameObjects.Text;
  private hudObjective!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;
  private escapeKey?: Phaser.Input.Keyboard.Key;
  private jumpKey?: Phaser.Input.Keyboard.Key;
  private jumpQueued = false;
  private paused = false;
  private waitingForRunAction = false;
  private runActionCommitted = false;
  private runSummaryReported = false;
  private runStats: RushRunStats = emptyRunStats();

  private readonly onPauseEvent = (event: WindowEventMap[typeof PAUSE_EVENT]): void => {
    this.paused = event.detail.paused;
    if (this.paused) {
      this.accumulator = 0;
      this.inputManager?.reset();
    }
  };

  private readonly onMatchAction = (event: WindowEventMap[typeof MATCH_ACTION_EVENT]): void => {
    this.performRunAction(event.detail.action);
  };

  private readonly onCompanionOrder = (event: WindowEventMap[typeof RUSH_COMPANION_ORDER_EVENT]): void => {
    this.companionOrder = event.detail.order;
    this.matchData.rushCompanionOrder = event.detail.order;
    const label = RUSH_COMPANION_ORDERS.find((order) => order.id === event.detail.order)?.label
      ?? event.detail.order.toUpperCase();
    this.showBanner(`CPU: ${label}`, 0xb8ffcd);
  };

  constructor() {
    super({ key: 'RushScene' });
  }

  init(data: MatchSceneData): void {
    this.matchData = data;
    const requestedStageId = data.stageId ?? DEFAULT_STAGE_ID;
    this.stageId = stageSupportsMode(requestedStageId, 'rush')
      ? requestedStageId
      : DEFAULT_STAGE_ID;
    // Fight photos and legacy Fight plates do not have authored traversal
    // geometry. Rush intentionally falls back to its hybrid Level 1 kit.
    this.customStageKey = null;
    this.stageTextureKey = null;
    this.stageProfile = getRushStageProfile(this.stageId, Boolean(this.customStageKey));
    this.routeMap = buildRushRouteMap(this.stageProfile);
    this.companionCpu = data.vsAI === true;
    this.companionOrder = data.rushCompanionOrder ?? 'follow';
    this.rushDifficulty = getRushDifficulty(data.rushDifficulty).id;
    this.accumulator = 0;
    this.ready = false;
    this.presentations.clear();
    this.projectileSprites.clear();
    this.obstaclePresentations.clear();
    this.stageEntrySprites = [];
    this.stageEntryKeys.clear();
    this.jumpQueued = false;
    this.paused = false;
    this.waitingForRunAction = false;
    this.runActionCommitted = false;
    this.runSummaryReported = false;
    this.runStats = emptyRunStats();
  }

  preload(): void {
    const stage = getStageTheme(this.stageId);
    if (stage.rushAssetPath) {
      this.stageTextureKey = `rush_stage_route_${stage.id}`;
      if (!this.textures.exists(this.stageTextureKey)) {
        this.load.image(this.stageTextureKey, stage.rushAssetPath);
      }
    }
    if (stage.id === 'side-street' || stage.id === 'la-jaula-304') {
      for (const [textureKey, assetPath] of Object.values(SIDE_STREET_ASSETS)) {
        if (!this.textures.exists(textureKey)) this.load.image(textureKey, assetPath);
      }
    }
  }

  async create(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    window.removeEventListener(PAUSE_EVENT, this.onPauseEvent);
    window.addEventListener(PAUSE_EVENT, this.onPauseEvent);
    window.removeEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.addEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.removeEventListener(RUSH_COMPANION_ORDER_EVENT, this.onCompanionOrder);
    window.addEventListener(RUSH_COMPANION_ORDER_EVENT, this.onCompanionOrder);
    this.escapeKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.escapeKey?.on('down', this.exitToMenu, this);
    this.jumpKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.jumpKey?.on('down', this.queueJump, this);
    this.soundManager = new SoundManager();

    await this.loadPlayerSprites(lifecycle);
    if (!this.isCurrent(lifecycle)) return;
    await this.createStageBackdrop(lifecycle);
    if (!this.isCurrent(lifecycle)) return;

    this.drawRouteGeometry();
    this.sim = new BrawlSimulation([
      this.matchData.p1Name ?? 'Player 1',
      this.matchData.p2Name ?? 'Player 2',
    ], this.routeMap, { difficulty: this.rushDifficulty });
    this.inputManager = new InputManager(this);
    this.createHud();
    this.handleEvents(this.sim.start());
    this.syncPresentations();
    this.syncProjectilePresentations();
    this.syncObstaclePresentations();
    this.updateHud();

    this.cameras.main
      .setBounds(0, 0, this.routeMap.worldWidth, this.routeMap.worldHeight)
      .setScroll(0, 0);
    window.__ASF_RUSH_STATE__ = () => this.sim.snapshot();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);
    this.ready = true;
    this.soundManager.startBattleMusic();
    window.dispatchEvent(new CustomEvent(RUNTIME_READY_EVENT, {
      detail: { sceneKey: 'RushScene', matchSeed: this.matchData.seed },
    }));
    debugInfo('[RushScene] Co-op route ready', {
      stageId: this.stageId,
      rushProfile: this.stageProfile.id,
      customStage: Boolean(this.customStageKey),
      companionCpu: this.companionCpu,
      p1: this.matchData.p1Name ?? 'Player 1',
      p2: this.matchData.p2Name ?? 'Player 2',
    });
  }

  update(_time: number, delta: number): void {
    if (!this.ready || this.paused || this.waitingForRunAction) return;
    this.inputManager.poll();
    this.accumulator += Math.min(delta, FIXED_TIMESTEP * MAX_TICKS_PER_FRAME);
    let ticks = 0;
    while (this.accumulator >= FIXED_TIMESTEP && ticks < MAX_TICKS_PER_FRAME) {
      const p1Input = this.inputManager.readPlayer1();
      const localP2Input = this.inputManager.readPlayer2();
      const events = this.sim.step(
        { ...p1Input, jump: this.consumeQueuedJump() || p1Input.uppercut },
        this.companionCpu ? getBrawlCompanionInput(this.sim, 1, this.companionOrder) : localP2Input,
      );
      this.handleEvents(events);
      this.accumulator -= FIXED_TIMESTEP;
      ticks += 1;
    }
    this.syncPresentations();
    this.syncProjectilePresentations();
    this.syncObstaclePresentations();
    this.updateHud();
    this.updateCamera(delta);
  }

  private async loadPlayerSprites(lifecycle: number): Promise<void> {
    const isCurrent = () => this.isCurrent(lifecycle);
    const loads: Promise<boolean>[] = [];
    if (this.matchData.p1PhotoHash) {
      loads.push(loadAiSprites(this, 'fighter_p1', this.matchData.p1PhotoHash, isCurrent));
    }
    if (this.matchData.p2PhotoHash) {
      loads.push(loadAiSprites(this, 'fighter_p2', this.matchData.p2PhotoHash, isCurrent));
    }
    if (loads.length === 0) return;
    try {
      await Promise.all(loads);
    } catch (error) {
      debugWarn('[RushScene] Player sprite load failed; keeping procedural fighters:', error);
    }
  }

  private async createStageBackdrop(lifecycle: number): Promise<void> {
    if (this.customStageKey) {
      const cached = await getCachedStageBackground(this.customStageKey);
      if (!this.isCurrent(lifecycle)) return;
      if (cached) {
        const image = await this.loadBlobImage(cached.pngBlob);
        if (!this.isCurrent(lifecycle)) return;
        this.stageTextureKey = `rush_custom_${this.customStageKey.replace(/[^a-z0-9_-]/gi, '_')}`;
        if (this.textures.exists(this.stageTextureKey)) this.textures.remove(this.stageTextureKey);
        this.textures.addImage(this.stageTextureKey, image);
      }
    }

    const textureKey = this.stageTextureKey && this.textures.exists(this.stageTextureKey)
      ? this.stageTextureKey
      : null;
    const segmentCount = Math.ceil(this.routeMap.worldWidth / GAME_WIDTH);
    const hasAuthoredRoute = Boolean(textureKey && getStageTheme(this.stageId).rushAssetPath);
    if (textureKey && hasAuthoredRoute) {
      this.add.image(
        this.routeMap.worldWidth / 2,
        GAME_HEIGHT / 2,
        textureKey,
      )
        .setDisplaySize(this.routeMap.worldWidth, GAME_HEIGHT)
        .setDepth(-20);
    } else if (textureKey) {
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const zoom = 1 + (segment % 3) * 0.025;
        this.add.image(
          segment * GAME_WIDTH + GAME_WIDTH / 2,
          GAME_HEIGHT / 2 + (segment % 2 === 0 ? 0 : 5),
          textureKey,
        )
          .setDisplaySize((GAME_WIDTH + 28) * zoom, GAME_HEIGHT * zoom)
          .setDepth(-20);
        this.add.rectangle(
          segment * GAME_WIDTH + GAME_WIDTH / 2,
          GAME_HEIGHT / 2,
          GAME_WIDTH + 2,
          GAME_HEIGHT,
          this.stageProfile.backdropVeil,
          this.stageProfile.backdropVeilAlpha + (segment % 2) * 0.025,
        ).setDepth(-19);
      }
    } else {
      const fallback = this.add.graphics().setDepth(-20);
      fallback.fillGradientStyle(0x16132f, 0x16132f, 0x050507, 0x050507, 1);
      fallback.fillRect(0, 0, this.routeMap.worldWidth, GAME_HEIGHT);
    }

    this.add.rectangle(
      this.routeMap.worldWidth / 2,
      GAME_HEIGHT / 2,
      this.routeMap.worldWidth,
      GAME_HEIGHT,
      this.stageProfile.shadow,
      hasAuthoredRoute ? 0.018 : 0.055,
    )
      .setDepth(-18.8);

    if (!hasAuthoredRoute) {
      const accentCss = `#${this.stageProfile.accent.toString(16).padStart(6, '0')}`;
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const label = this.stageProfile.segmentLabels[segment]
          ?? `ZONE ${segment + 1}`;
        this.add.text(segment * GAME_WIDTH + 52, 114, `${segment + 1}  ${label}`, {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: '9px',
          color: accentCss,
          stroke: '#050507',
          strokeThickness: 4,
        }).setAlpha(0.58).setDepth(-17);
      }

      const joins = this.add.graphics().setDepth(-17);
      for (let x = GAME_WIDTH; x < this.routeMap.worldWidth; x += GAME_WIDTH) {
        joins.fillStyle(0x050507, 0.42);
        joins.fillRect(x - 15, 92, 30, 250);
        joins.lineStyle(3, this.stageProfile.accent, 0.26);
        joins.lineBetween(x - 13, 102, x + 13, 130);
        joins.lineBetween(x + 13, 130, x - 13, 158);
        joins.lineBetween(x - 13, 158, x + 13, 186);
        joins.lineBetween(x + 13, 186, x - 13, 214);
        joins.lineBetween(x - 13, 214, x + 13, 242);
        joins.lineBetween(x + 13, 242, x - 13, 270);
        joins.lineBetween(x - 13, 270, x + 13, 298);
        joins.lineBetween(x + 13, 298, x - 13, 326);
      }
    }
  }

  private drawRouteGeometry(): void {
    const { walkArea } = this.routeMap;
    const hasAuthoredRoute = Boolean(getStageTheme(this.stageId).rushAssetPath);
    const lines = this.add.graphics().setDepth(-5);
    if (!hasAuthoredRoute) {
      lines.fillStyle(0x050507, 0.12);
      lines.fillRect(
        0,
        walkArea.back - 8,
        this.routeMap.worldWidth,
        walkArea.front - walkArea.back + 28,
      );
      lines.lineStyle(1, this.stageProfile.accent, 0.16);
      for (let lane = walkArea.back; lane <= walkArea.front; lane += 44) {
        lines.lineBetween(walkArea.left, lane, walkArea.right, lane);
      }
      for (let x = walkArea.left; x <= walkArea.right; x += 120) {
        lines.lineBetween(x - 46, walkArea.back, x, walkArea.front + 12);
      }
      lines.lineStyle(2, this.stageProfile.accent, 0.28);
      lines.strokeRoundedRect(
        walkArea.left,
        walkArea.back - 8,
        walkArea.right - walkArea.left,
        walkArea.front - walkArea.back + 28,
        8,
      );

      for (const [index, encounter] of this.routeMap.encounters.entries()) {
        lines.fillStyle(this.stageProfile.accent, 0.1);
        lines.fillRect(encounter.triggerX - 6, walkArea.back - 8, 12, walkArea.front - walkArea.back + 28);
        lines.lineStyle(2, this.stageProfile.accent, 0.42);
        lines.lineBetween(encounter.triggerX, walkArea.back - 8, encounter.triggerX, walkArea.front + 20);
        this.add.text(encounter.triggerX, walkArea.back - 18, `0${index + 1}`, {
          fontFamily: '"Press Start 2P", monospace',
          fontSize: '10px',
          color: `#${this.stageProfile.accent.toString(16).padStart(6, '0')}`,
          stroke: '#050507',
          strokeThickness: 3,
        }).setOrigin(0.5, 1).setAlpha(0.7).setDepth(-4);
      }
    }

    const accessPoints = this.add.graphics().setDepth(Math.round(walkArea.back) - 12);
    for (const encounter of this.routeMap.encounters) {
      for (const spawn of encounter.enemies) {
        const entrance = spawn.entrance;
        if (!entrance) continue;
        const sourceX = entrance.sourceX ?? spawn.x;
        if (this.createAuthoredEntrance(entrance.kind, sourceX)) continue;
        if (entrance.kind === 'door') {
          accessPoints.fillStyle(0x030307, 0.92);
          accessPoints.fillRoundedRect(sourceX - 30, walkArea.back - 116, 60, 118, 5);
          accessPoints.lineStyle(3, this.stageProfile.accent, 0.55);
          accessPoints.strokeRoundedRect(sourceX - 30, walkArea.back - 116, 60, 118, 5);
          accessPoints.fillStyle(this.stageProfile.accent, 0.8);
          accessPoints.fillCircle(sourceX + 18, walkArea.back - 54, 3);
          accessPoints.lineStyle(2, this.stageProfile.accent, 0.24);
          accessPoints.lineBetween(sourceX - 18, walkArea.back - 88, sourceX + 18, walkArea.back - 88);
        } else if (entrance.kind === 'background') {
          accessPoints.fillStyle(0x050507, 0.78);
          accessPoints.fillPoints([
            new Phaser.Geom.Point(sourceX - 42, walkArea.back + 2),
            new Phaser.Geom.Point(sourceX + 42, walkArea.back + 2),
            new Phaser.Geom.Point(sourceX + 27, walkArea.back + 30),
            new Phaser.Geom.Point(sourceX - 27, walkArea.back + 30),
          ], true);
          accessPoints.lineStyle(2, this.stageProfile.accent, 0.45);
          for (let rung = 0; rung < 4; rung += 1) {
            const y = walkArea.back + 7 + rung * 6;
            accessPoints.lineBetween(sourceX - 25 + rung * 2, y, sourceX + 25 - rung * 2, y);
          }
        } else if (entrance.kind === 'drop') {
          accessPoints.lineStyle(4, 0x050507, 0.72);
          accessPoints.lineBetween(sourceX - 48, walkArea.back - 178, sourceX + 48, walkArea.back - 178);
          accessPoints.lineStyle(3, this.stageProfile.accent, 0.5);
          accessPoints.lineBetween(sourceX - 34, walkArea.back - 171, sourceX + 34, walkArea.back - 171);
          accessPoints.lineStyle(2, this.stageProfile.accent, 0.24);
          accessPoints.lineBetween(sourceX, walkArea.back - 168, sourceX, spawn.lane - 12);
          accessPoints.fillStyle(this.stageProfile.accent, 0.16);
          accessPoints.fillEllipse(spawn.x, spawn.lane + 2, 78, 34);
          accessPoints.lineStyle(2, this.stageProfile.accent, 0.52);
          accessPoints.strokeEllipse(spawn.x, spawn.lane + 2, 78, 34);
        } else {
          const gateLane = entrance.sourceLane ?? spawn.lane;
          accessPoints.fillStyle(0x050507, 0.82);
          accessPoints.fillRoundedRect(sourceX - 12, gateLane - 82, 24, 90, 4);
          accessPoints.lineStyle(3, this.stageProfile.accent, 0.5);
          accessPoints.strokeRoundedRect(sourceX - 12, gateLane - 82, 24, 90, 4);
          accessPoints.fillStyle(this.stageProfile.accent, 0.78);
          accessPoints.fillTriangle(sourceX - 30, gateLane - 48, sourceX - 16, gateLane - 58, sourceX - 16, gateLane - 38);
        }
      }
    }

    this.entranceCueGraphics = this.add.graphics().setDepth(Math.round(walkArea.back) - 2);

    if (!hasAuthoredRoute) {
      lines.fillStyle(this.stageProfile.accent, 0.22);
      lines.fillRect(this.routeMap.exitX - 8, walkArea.back - 8, 16, walkArea.front - walkArea.back + 28);
    }
    this.add.text(this.routeMap.exitX, walkArea.back - 18, 'EXIT →', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '10px',
      color: `#${this.stageProfile.accent.toString(16).padStart(6, '0')}`,
      stroke: '#050507',
      strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(-4);
  }

  private createAuthoredEntrance(
    kind: 'right' | 'door' | 'background' | 'drop',
    sourceX: number,
  ): boolean {
    // La Jaula's four route plates already contain gates, tunnels and cage
    // openings. A second procedural door on top reads like a collision prop.
    if (this.stageId === 'la-jaula-304') return true;
    if (this.stageId !== 'side-street') return false;
    // Edge arrivals already read against the authored gates and should not get
    // a permanent debug-looking post. Their live landing cue is drawn below.
    if (kind === 'right') return true;
    const entryKey = `${kind}:${Math.round(sourceX)}`;
    if (this.stageEntryKeys.has(entryKey)) return true;

    const asset = kind === 'door'
      ? SIDE_STREET_ASSETS.entryDoor
      : kind === 'background'
        ? SIDE_STREET_ASSETS.entryManhole
        : SIDE_STREET_ASSETS.entryDropRig;
    const [textureKey] = asset;
    if (!this.textures.exists(textureKey)) return false;

    const sprite = this.add.image(sourceX, this.routeMap.walkArea.back + 2, textureKey)
      .setOrigin(0.5, 1)
      .setDepth(Math.round(this.routeMap.walkArea.back) - 10);
    const targetWidth = kind === 'door' ? 118 : kind === 'background' ? 104 : 154;
    const scale = targetWidth / sprite.width;
    sprite.setScale(scale);
    if (kind === 'background') {
      sprite
        .setOrigin(0.5)
        .setPosition(sourceX, this.routeMap.walkArea.back + 27)
        .setDepth(Math.round(this.routeMap.walkArea.back) - 4);
    }

    this.stageEntryKeys.add(entryKey);
    this.stageEntrySprites.push(sprite);
    return true;
  }

  private createHud(): void {
    this.hudGraphics = this.add.graphics().setDepth(3000).setScrollFactor(0);
    const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '11px',
      color: '#fff4d6',
      stroke: '#050507',
      strokeThickness: 4,
    };
    this.hudP1 = this.add.text(34, 30, '', textStyle).setDepth(3001).setScrollFactor(0);
    this.hudP2 = this.add.text(GAME_WIDTH - 34, 30, '', textStyle)
      .setOrigin(1, 0)
      .setDepth(3001)
      .setScrollFactor(0);
    this.hudObjective = this.add.text(GAME_WIDTH / 2, 26, '', {
      ...textStyle,
      fontSize: '12px',
      color: '#ffce3a',
      align: 'center',
    }).setOrigin(0.5, 0).setDepth(3001).setScrollFactor(0);
    this.banner = this.add.text(GAME_WIDTH / 2, 124, '', {
      ...textStyle,
      fontSize: '22px',
      color: '#fff4d6',
      align: 'center',
    }).setOrigin(0.5).setDepth(3002).setScrollFactor(0).setAlpha(0);

    const controlsCopy = this.companionCpu
      ? 'P1  WASD MOVE · U/J ATTACK · I FIREBALL · K/SPACE JUMP · G GUARD    CPU PARTNER'
      : 'P1  WASD · U/J · I FIREBALL · K/SPACE JUMP    P2  ARROWS · NUM4/1 · NUM5 FIREBALL · NUM2 JUMP';
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 20, controlsCopy, {
        fontFamily: '"Space Grotesk", system-ui, sans-serif',
        fontSize: '11px',
        color: '#fff4d6',
        stroke: '#050507',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(3001)
      .setScrollFactor(0);
  }

  private syncPresentations(): void {
    const actors = [...this.sim.players, ...this.sim.enemies];
    for (const actor of actors) {
      let presentation = this.presentations.get(actor.id);
      if (!presentation) {
        presentation = this.createActorPresentation(actor);
        this.presentations.set(actor.id, presentation);
      }
      this.syncActorPresentation(actor, presentation);
    }
    this.syncEnemyEntranceCues();
  }

  private syncEnemyEntranceCues(): void {
    this.entranceCueGraphics.clear();
    for (const enemy of this.sim.enemies) {
      if (enemy.combatReady || enemy.health <= 0) continue;
      const pulse = 0.48 + Math.sin((this.sim.tick + enemy.id.length * 7) * 0.18) * 0.18;
      const targetX = enemy.entryTargetX;
      const targetLane = enemy.entryTargetLane;
      this.entranceCueGraphics.fillStyle(this.stageProfile.accent, pulse * 0.22);
      this.entranceCueGraphics.fillEllipse(targetX, targetLane + 3, 92, 38);
      this.entranceCueGraphics.lineStyle(3, this.stageProfile.accent, pulse);
      this.entranceCueGraphics.strokeEllipse(targetX, targetLane + 3, 92, 38);
      if (enemy.entranceDelayTicks > 0) {
        this.entranceCueGraphics.lineStyle(2, 0xff2a2a, pulse);
        this.entranceCueGraphics.strokeCircle(targetX, targetLane - 7, 14 + (this.sim.tick % 20) * 0.6);
      } else if (enemy.entranceKind !== 'drop') {
        this.entranceCueGraphics.lineStyle(2, this.stageProfile.accent, 0.34);
        this.entranceCueGraphics.lineBetween(enemy.x, enemy.lane, targetX, targetLane);
      }
    }
  }

  private syncProjectilePresentations(): void {
    const live = new Set<number>();
    for (const projectile of this.sim.projectiles) {
      live.add(projectile.id);
      let sprite = this.projectileSprites.get(projectile.id);
      if (!sprite) {
        sprite = this.add.sprite(projectile.x, projectile.lane - projectile.height, 'fireball_projectile')
          .setOrigin(0.5)
          .setBlendMode(Phaser.BlendModes.ADD);
        this.projectileSprites.set(projectile.id, sprite);
      }
      this.syncProjectilePresentation(projectile, sprite);
    }
    for (const [id, sprite] of this.projectileSprites) {
      if (live.has(id)) continue;
      sprite.destroy();
      this.projectileSprites.delete(id);
    }
  }

  private syncProjectilePresentation(
    projectile: BrawlProjectile,
    sprite: Phaser.GameObjects.Sprite,
  ): void {
    const pulse = 1 + Math.sin(projectile.age * 0.55) * 0.08;
    sprite
      .setPosition(projectile.x, projectile.lane - projectile.height)
      .setFlipX(projectile.vx < 0)
      .setScale((projectile.isSuper ? 1.65 : 1.08) * pulse)
      .setDepth(Math.round(projectile.lane) + 8)
      .setAlpha(0.92);
    if (projectile.ownerKind === 'enemy') {
      sprite.setTint(projectile.isSuper ? 0xff6b3d : 0xd56bff);
    } else if (projectile.isSuper) {
      sprite.setTint(0x78ddff);
    } else {
      sprite.clearTint();
    }
  }

  private syncObstaclePresentations(): void {
    for (const obstacle of this.sim.obstacles) {
      let presentation = this.obstaclePresentations.get(obstacle.id);
      if (!presentation) {
        presentation = { graphics: this.add.graphics(), sprite: null };
        this.obstaclePresentations.set(obstacle.id, presentation);
      }
      this.drawObstacle(obstacle, presentation);
    }
  }

  private drawObstacle(obstacle: BrawlObstacle, presentation: ObstaclePresentation): void {
    if (this.drawAuthoredObstacle(obstacle, presentation)) return;
    presentation.sprite?.setVisible(false);
    const { graphics } = presentation;
    const x = obstacle.x;
    const y = obstacle.lane;
    const palette = OBSTACLE_PALETTES[obstacle.skin];
    graphics.clear().setDepth(Math.round(y));
    if (obstacle.type === 'steam-vent') {
      const hazardWidth = obstacle.hazardWidth;
      const hazardDepth = obstacle.hazardLaneDepth;
      graphics.fillStyle(0x050507, 0.72);
      graphics.fillEllipse(x, y + 2, obstacle.width + 18, obstacle.laneDepth + 10);
      graphics.fillStyle(obstacle.active ? 0x9ee7ff : obstacle.telegraphing ? 0xffce3a : 0x2e3440, obstacle.active ? 0.82 : 0.78);
      graphics.fillEllipse(x, y, obstacle.width, obstacle.laneDepth);
      graphics.lineStyle(3, obstacle.active ? 0xe8fbff : 0x111827, 0.9);
      graphics.strokeEllipse(x, y, obstacle.width, obstacle.laneDepth);
      graphics.lineStyle(2, 0x050507, 0.7);
      for (let offset = -0.3; offset <= 0.3; offset += 0.2) {
        graphics.lineBetween(
          x - obstacle.width * 0.34,
          y + obstacle.laneDepth * offset,
          x + obstacle.width * 0.34,
          y + obstacle.laneDepth * offset,
        );
      }
      if (obstacle.telegraphing) {
        graphics.lineStyle(3, palette.accent, 0.84);
        graphics.strokeEllipse(x, y, hazardWidth, hazardDepth);
      }
      if (obstacle.active) {
        graphics.fillStyle(0xffce3a, 0.14);
        graphics.fillEllipse(x, y, hazardWidth, hazardDepth);
        graphics.lineStyle(3, 0xffce3a, 0.92);
        graphics.strokeEllipse(x, y, hazardWidth, hazardDepth);
        const lift = (this.sim.tick * 2 + obstacle.cycleOffset) % 34;
        graphics.fillStyle(0xe8fbff, 0.42);
        graphics.fillCircle(x - 22, y - 30 - lift * 0.45, 16);
        graphics.fillCircle(x + 8, y - 50 - lift * 0.7, 22);
        graphics.fillCircle(x + 28, y - 82 - lift * 0.35, 14);
        graphics.fillStyle(0x9ee7ff, 0.22);
        graphics.fillRoundedRect(x - obstacle.width * 0.38, y - 98, obstacle.width * 0.76, 104, 22);
      }
      return;
    }

    if (obstacle.type === 'explosive-barrel') {
      graphics.fillStyle(0x050507, 0.4);
      graphics.fillEllipse(x, y + 6, obstacle.width + 20, obstacle.laneDepth * 0.72);
      if (obstacle.health <= 0) {
        graphics.fillStyle(palette.dark, 0.92);
        graphics.fillEllipse(x, y - 2, obstacle.width + 8, 18);
        graphics.lineStyle(5, palette.body, 0.7);
        graphics.strokeEllipse(x - 12, y - 8, obstacle.width * 0.48, 16);
        graphics.strokeEllipse(x + 14, y - 3, obstacle.width * 0.44, 14);
        graphics.fillStyle(0xff6b3d, 0.32);
        graphics.fillCircle(x + 4, y - 9, 6);
        return;
      }

      const visualHeight = 62;
      graphics.fillGradientStyle(palette.top, palette.body, palette.dark, palette.body, 1);
      graphics.fillRoundedRect(x - obstacle.width / 2, y - visualHeight, obstacle.width, visualHeight, 9);
      graphics.fillStyle(palette.top, 1);
      graphics.fillEllipse(x, y - visualHeight, obstacle.width, 17);
      graphics.lineStyle(4, palette.dark, 0.95);
      graphics.strokeRoundedRect(x - obstacle.width / 2, y - visualHeight, obstacle.width, visualHeight, 9);
      graphics.strokeEllipse(x, y - visualHeight, obstacle.width, 17);
      graphics.fillStyle(palette.accent, 0.95);
      graphics.fillRect(x - obstacle.width / 2 + 3, y - 46, obstacle.width - 6, 8);
      graphics.fillRect(x - obstacle.width / 2 + 3, y - 20, obstacle.width - 6, 8);
      graphics.fillStyle(palette.dark, 0.92);
      graphics.fillPoints([
        new Phaser.Geom.Point(x, y - 45),
        new Phaser.Geom.Point(x + 13, y - 34),
        new Phaser.Geom.Point(x, y - 23),
        new Phaser.Geom.Point(x - 13, y - 34),
      ], true);
      graphics.lineStyle(3, palette.accent, 1);
      graphics.lineBetween(x - 2, y - 41, x + 3, y - 34);
      graphics.lineBetween(x + 3, y - 34, x - 3, y - 28);
      const ratio = obstacle.health / obstacle.maxHealth;
      if (ratio < 0.55) {
        const sparkY = y - visualHeight - 12 - (this.sim.tick % 12);
        graphics.fillStyle(0xffce3a, 0.78);
        graphics.fillCircle(x + 10, sparkY, 3);
        graphics.lineStyle(2, 0xff6b3d, 0.7);
        graphics.lineBetween(x + 10, sparkY, x + 18, sparkY - 7);
      }
      return;
    }

    graphics.fillStyle(0x050507, 0.35);
    graphics.fillEllipse(x, y + 7, obstacle.width + 26, obstacle.laneDepth * 0.72);
    if (obstacle.health <= 0) {
      graphics.fillStyle(palette.body, 0.9);
      graphics.fillRect(x - obstacle.width / 2, y - 8, obstacle.width * 0.42, 11);
      graphics.fillRect(x + obstacle.width * 0.04, y - 3, obstacle.width * 0.46, 9);
      graphics.fillStyle(palette.accent, 0.48);
      graphics.fillRect(x - 18, y - 11, 32, 6);
      return;
    }

    const visualHeight = 52;
    graphics.fillGradientStyle(palette.top, palette.body, palette.dark, palette.body, 1);
    graphics.fillRoundedRect(x - obstacle.width / 2, y - visualHeight, obstacle.width, visualHeight, 5);
    graphics.fillStyle(palette.top, 1);
    graphics.fillPoints([
      new Phaser.Geom.Point(x - obstacle.width / 2, y - visualHeight),
      new Phaser.Geom.Point(x - obstacle.width * 0.37, y - visualHeight - 14),
      new Phaser.Geom.Point(x + obstacle.width * 0.48, y - visualHeight - 14),
      new Phaser.Geom.Point(x + obstacle.width / 2, y - visualHeight),
    ], true);
    graphics.lineStyle(3, palette.dark, 0.92);
    graphics.strokeRoundedRect(x - obstacle.width / 2, y - visualHeight, obstacle.width, visualHeight, 5);
    graphics.lineBetween(x, y - visualHeight, x, y);
    graphics.lineBetween(x - obstacle.width / 2, y - 26, x + obstacle.width / 2, y - 26);
    const stripeWidth = Math.max(12, obstacle.width / 6);
    for (let stripe = -2; stripe <= 2; stripe += 1) {
      graphics.fillStyle(stripe % 2 === 0 ? palette.accent : palette.dark, 0.92);
      graphics.fillRect(x + stripe * stripeWidth - stripeWidth / 2, y - 19, stripeWidth, 12);
    }
    const ratio = obstacle.health / obstacle.maxHealth;
    if (ratio < 1) {
      graphics.fillStyle(0x050507, 0.9);
      graphics.fillRoundedRect(x - obstacle.width / 2, y - visualHeight - 27, obstacle.width, 7, 2);
      graphics.fillStyle(ratio > 0.35 ? palette.accent : 0xff2a2a, 1);
      graphics.fillRoundedRect(x - obstacle.width / 2 + 2, y - visualHeight - 25, (obstacle.width - 4) * ratio, 3, 1);
    }
  }

  private drawAuthoredObstacle(
    obstacle: BrawlObstacle,
    presentation: ObstaclePresentation,
  ): boolean {
    if (obstacle.skin !== 'side-street' && obstacle.skin !== 'jaula') return false;

    const ratio = obstacle.maxHealth > 0 ? obstacle.health / obstacle.maxHealth : 1;
    let asset: readonly [string, string];
    let widthScale: number;
    if (obstacle.type === 'steam-vent') {
      asset = obstacle.active
        ? SIDE_STREET_ASSETS.steamVentActive
        : SIDE_STREET_ASSETS.steamVentIdle;
      widthScale = 1.42;
    } else if (obstacle.type === 'explosive-barrel') {
      asset = ratio <= 0
        ? SIDE_STREET_ASSETS.fuelCellBroken
        : ratio < 0.58
          ? SIDE_STREET_ASSETS.fuelCellDamaged
          : SIDE_STREET_ASSETS.fuelCellIntact;
      widthScale = 1.62;
    } else {
      asset = ratio <= 0
        ? SIDE_STREET_ASSETS.barricadeBroken
        : ratio < 0.58
          ? SIDE_STREET_ASSETS.barricadeDamaged
          : SIDE_STREET_ASSETS.barricadeIntact;
      widthScale = 1.76;
    }

    const [textureKey] = asset;
    if (!this.textures.exists(textureKey)) return false;

    const sprite = presentation.sprite ?? this.add.image(obstacle.x, obstacle.lane, textureKey)
      .setOrigin(0.5, 1);
    presentation.sprite = sprite;
    sprite
      .setVisible(true)
      .setTexture(textureKey)
      .setPosition(obstacle.x, obstacle.lane + 3)
      .setDepth(Math.round(obstacle.lane));
    const targetWidth = obstacle.width * widthScale;
    sprite.setScale(targetWidth / sprite.width);

    const graphics = presentation.graphics;
    graphics.clear().setDepth(Math.round(obstacle.lane) - 1);
    const shadowWidth = obstacle.type === 'steam-vent'
      ? obstacle.width * 1.18
      : obstacle.width * 1.42;
    graphics.fillStyle(0x050507, obstacle.health <= 0 ? 0.22 : 0.42);
    graphics.fillEllipse(
      obstacle.x,
      obstacle.lane + 6,
      shadowWidth,
      Math.max(18, obstacle.laneDepth * 0.58),
    );

    if (obstacle.type === 'steam-vent') {
      const hazardWidth = obstacle.hazardWidth;
      const hazardDepth = obstacle.hazardLaneDepth;
      if (obstacle.telegraphing) {
        const pulse = 0.6 + Math.sin(this.sim.tick * 0.34) * 0.2;
        graphics.lineStyle(3, this.stageProfile.accent, pulse);
        graphics.strokeEllipse(
          obstacle.x,
          obstacle.lane,
          hazardWidth,
          hazardDepth,
        );
      }
      if (obstacle.active) {
        graphics.fillStyle(0xffcf33, 0.18);
        graphics.fillEllipse(
          obstacle.x,
          obstacle.lane,
          hazardWidth,
          hazardDepth,
        );
        graphics.lineStyle(3, 0xffcf33, 0.96);
        graphics.strokeEllipse(obstacle.x, obstacle.lane, hazardWidth, hazardDepth);
      }
      return true;
    }

    if (ratio > 0 && ratio < 1) {
      const healthWidth = Math.max(52, targetWidth * 0.72);
      const barY = obstacle.lane - sprite.displayHeight - 9;
      graphics.fillStyle(0x050507, 0.88);
      graphics.fillRoundedRect(obstacle.x - healthWidth / 2 - 2, barY - 2, healthWidth + 4, 7, 2);
      graphics.fillStyle(ratio > 0.35 ? this.stageProfile.accent : 0xf04e3e, 1);
      graphics.fillRoundedRect(obstacle.x - healthWidth / 2, barY, healthWidth * ratio, 3, 1);
    }
    return true;
  }

  private createActorPresentation(actor: BrawlActor): ActorPresentation {
    const playerIndex = actor.slot ?? this.presentations.size + 2;
    const fighter = new Fighter(playerIndex, actor.name, actor.x, actor.facingRight);
    const spriteKey = actor.slot === 0
      ? 'fighter_p1'
      : actor.slot === 1
        ? 'fighter_p2'
        : `rush_enemy_${actor.archetype ?? 'grunt'}`;
    const view = new FighterView(fighter, spriteKey);
    view.createSprite(this);
    const scale = actor.archetype === 'captain'
      ? 1.02
      : actor.archetype === 'bruiser'
        ? 0.9
        : actor.archetype === 'shooter'
          ? 0.76
        : actor.kind === 'enemy'
          ? 0.78
          : 0.86;
    view.setRenderPresentation(scale);

    let tag: Phaser.GameObjects.Container | null = null;
    if (actor.slot !== null) tag = this.createPlayerTag(actor.slot);
    const health = actor.kind === 'enemy' ? this.add.graphics() : null;
    return { fighter, view, tag, health };
  }

  private createPlayerTag(slot: 0 | 1): Phaser.GameObjects.Container {
    const color = slot === 0 ? 0x4fb3ff : 0x30e07a;
    const shape = this.add.graphics();
    shape.fillStyle(0x050507, 0.92);
    shape.fillRoundedRect(-27, -14, 54, 28, 4);
    shape.lineStyle(2, color, 1);
    shape.strokeRoundedRect(-27, -14, 54, 28, 4);
    shape.fillStyle(color, 1);
    shape.fillTriangle(-6, 14, 6, 14, 0, 22);
    const tagLabel = this.companionCpu && slot === 1 ? 'CPU' : `P${slot + 1}`;
    const label = this.add.text(0, 0, tagLabel, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '11px',
      color: slot === 0 ? '#4fb3ff' : '#30e07a',
      stroke: '#050507',
      strokeThickness: 3,
    }).setOrigin(0.5);
    return this.add.container(0, 0, [shape, label]).setDepth(2900);
  }

  private syncActorPresentation(actor: BrawlActor, presentation: ActorPresentation): void {
    const nearestOpponentX = actor.kind === 'player'
      ? this.nearestLivingEnemyX(actor.x)
      : this.nearestLivingPlayerX(actor.x);
    presentation.fighter.x = actor.x;
    presentation.fighter.y = actor.lane;
    presentation.fighter.facingRight = actor.facingRight;
    presentation.fighter.state = this.fighterStateFor(actor);
    presentation.fighter.stateFrame = actor.stateTick;
    presentation.view.syncSprite(nearestOpponentX);
    presentation.view.sprite.setY(presentation.view.sprite.y - actor.height);
    const depth = Math.round(actor.lane) + (actor.kind === 'player' ? 1 : 0);
    presentation.view.shadowSprite?.setDepth(depth - 2);
    presentation.view.sprite.setDepth(depth);
    const waitingToEnter = actor.kind === 'enemy' && !actor.combatReady && actor.entranceDelayTicks > 0;
    presentation.view.sprite.setAlpha(waitingToEnter ? 0 : actor.combatReady ? 1 : 0.88);
    presentation.view.shadowSprite?.setAlpha(waitingToEnter ? 0 : actor.combatReady ? 0.14 : 0.09);
    presentation.view.sprite.clearTint();

    if (presentation.tag) {
      const spriteTop = presentation.view.getVisibleTopCenter();
      presentation.tag.setPosition(
        Math.round(spriteTop.x),
        Math.round(spriteTop.y - PLAYER_TAG_POINTER_REACH - PLAYER_TAG_CLEARANCE),
      );
      presentation.tag.setAlpha(actor.health <= 0 ? 0.58 : 1);
    }

    if (presentation.health) {
      presentation.health.clear();
      if (actor.health > 0 && actor.combatReady) {
        const width = actor.archetype === 'captain' ? 84 : actor.archetype === 'bruiser' ? 68 : 58;
        const visibleTop = presentation.view.getVisibleTopCenter();
        const y = visibleTop.y - 15;
        presentation.health.fillStyle(0x050507, 0.9);
        presentation.health.fillRoundedRect(actor.x - width / 2 - 2, y - 2, width + 4, 8, 2);
        presentation.health.fillStyle(
          actor.archetype === 'captain'
            ? 0xffce3a
            : actor.archetype === 'shooter'
              ? 0x4fdcff
              : 0xff2a2a,
          1,
        );
        presentation.health.fillRoundedRect(
          actor.x - width / 2,
          y,
          width * (actor.health / actor.maxHealth),
          4,
          1,
        );
        presentation.health.setDepth(depth + 2);
      }
    }
  }

  private fighterStateFor(actor: BrawlActor): FighterState {
    if (actor.guarding) return FighterState.BLOCK;
    switch (actor.state) {
      case 'walk': return FighterState.WALK_FORWARD;
      case 'entering': return FighterState.WALK_FORWARD;
      case 'jump': return FighterState.JUMP;
      case 'attack': return actor.attackKind === 'heavy' ? FighterState.HIGH_KICK : FighterState.HIGH_PUNCH;
      case 'fireball': return FighterState.FIREBALL;
      case 'hit': return FighterState.HIT_STUN;
      case 'down': return FighterState.KNOCKDOWN;
      case 'victory': return FighterState.VICTORY;
      default: return FighterState.IDLE;
    }
  }

  private nearestLivingEnemyX(x: number): number {
    const living = this.sim.enemies.filter((enemy) => enemy.health > 0 && enemy.combatReady);
    if (living.length === 0) return x + 1;
    living.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
    return living[0].x;
  }

  private nearestLivingPlayerX(x: number): number {
    const living = this.sim.players.filter((player) => player.health > 0);
    if (living.length === 0) return x - 1;
    living.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
    return living[0].x;
  }

  private updateHud(): void {
    const [p1, p2] = this.sim.players;
    this.hudGraphics.clear();
    this.drawPlayerHealth(28, 56, 288, p1.health / p1.maxHealth, 0x4fb3ff);
    this.drawPlayerHealth(GAME_WIDTH - 316, 56, 288, p2.health / p2.maxHealth, 0x30e07a);
    this.hudP1.setText(`P1  ${p1.name.toUpperCase()}`);
    this.hudP2.setText(`${p2.name.toUpperCase()}  ${this.companionCpu ? 'CPU' : 'P2'}`);
    const livingEnemies = this.sim.enemies.filter((enemy) => enemy.health > 0).length;
    const encounterCount = this.routeMap.encounters.length;
    if (this.sim.activeEncounterIndex >= 0) {
      const encounter = this.routeMap.encounters[this.sim.activeEncounterIndex];
      const threat = encounter?.threat ?? Math.min(3, this.sim.activeEncounterIndex + 1);
      this.hudObjective.setText(
        `${encounter?.mode === 'rolling' ? 'MOVING WAVE' : 'ROADBLOCK'} ${this.sim.activeEncounterIndex + 1}/${encounterCount} · ${getRushDifficulty(this.rushDifficulty).label}\n${livingEnemies} HOSTILE${livingEnemies === 1 ? '' : 'S'}`,
      );
    } else {
      const finalCheckpointCleared = this.sim.encounterIndex >= encounterCount - 1;
      const startX = Math.min(...this.routeMap.playerSpawns.map((spawn) => spawn.x));
      const routeRatio = Phaser.Math.Clamp(
        (this.sim.progressX - startX) / (this.routeMap.exitX - startX),
        0,
        1,
      );
      const segmentIndex = Phaser.Math.Clamp(
        Math.floor(this.sim.progressX / GAME_WIDTH),
        0,
        this.stageProfile.segmentLabels.length - 1,
      );
      this.hudObjective.setText(
        `${finalCheckpointCleared ? 'EXIT →' : 'ADVANCE →'}\n${this.stageProfile.segmentLabels[segmentIndex]} · ${Math.round(routeRatio * 100)}%`,
      );
    }
    this.drawRouteProgress();
  }

  private drawRouteProgress(): void {
    const startX = Math.min(...this.routeMap.playerSpawns.map((spawn) => spawn.x));
    const railX = GAME_WIDTH / 2 - 145;
    const railY = 82;
    const railWidth = 290;
    const ratioFor = (worldX: number) => Phaser.Math.Clamp(
      (worldX - startX) / (this.routeMap.exitX - startX),
      0,
      1,
    );
    const progressRatio = ratioFor(this.sim.progressX);

    this.hudGraphics.fillStyle(0x050507, 0.9);
    this.hudGraphics.fillRoundedRect(railX - 4, railY - 4, railWidth + 8, 12, 3);
    this.hudGraphics.fillStyle(0x4a3e35, 1);
    this.hudGraphics.fillRect(railX, railY, railWidth, 4);
    this.hudGraphics.fillStyle(this.stageProfile.accent, 1);
    this.hudGraphics.fillRect(railX, railY, railWidth * progressRatio, 4);

    for (const [index, encounter] of this.routeMap.encounters.entries()) {
      const x = railX + railWidth * ratioFor(encounter.triggerX);
      const reached = index <= this.sim.encounterIndex;
      this.hudGraphics.fillStyle(reached ? this.stageProfile.accent : 0x050507, 1);
      this.hudGraphics.fillCircle(x, railY + 2, 5);
      this.hudGraphics.lineStyle(2, this.stageProfile.accent, reached ? 1 : 0.62);
      this.hudGraphics.strokeCircle(x, railY + 2, 5);
    }

    this.hudGraphics.fillStyle(this.sim.progressX >= this.routeMap.exitX ? this.stageProfile.accent : 0x050507, 1);
    this.hudGraphics.fillTriangle(
      railX + railWidth - 2,
      railY - 5,
      railX + railWidth + 7,
      railY + 2,
      railX + railWidth - 2,
      railY + 9,
    );
  }

  private updateCamera(delta: number): void {
    const activeEncounter = this.routeMap.encounters[this.sim.activeEncounterIndex];
    const livingCombatants = [...this.sim.players, ...this.sim.enemies]
      .filter((actor) => actor.health > 0);
    const combatFocusX = livingCombatants.length > 0
      ? (
          Math.min(...livingCombatants.map((actor) => actor.x))
          + Math.max(...livingCombatants.map((actor) => actor.x))
        ) / 2
      : this.sim.progressX;
    const desiredScrollX = activeEncounter
      ? combatFocusX - GAME_WIDTH / 2
      : this.sim.progressX - GAME_WIDTH * 0.3;
    const targetScrollX = Phaser.Math.Clamp(
      desiredScrollX,
      0,
      this.routeMap.worldWidth - GAME_WIDTH,
    );
    const blend = 1 - Math.pow(0.001, Math.min(delta, 100) / 1000);
    this.cameras.main.scrollX = Phaser.Math.Linear(
      this.cameras.main.scrollX,
      targetScrollX,
      blend,
    );
  }

  private drawPlayerHealth(x: number, y: number, width: number, ratio: number, accent: number): void {
    this.hudGraphics.fillStyle(0x050507, 0.9);
    this.hudGraphics.fillRoundedRect(x - 3, y - 3, width + 6, 18, 3);
    this.hudGraphics.lineStyle(2, 0xffce3a, 0.72);
    this.hudGraphics.strokeRoundedRect(x - 3, y - 3, width + 6, 18, 3);
    this.hudGraphics.fillStyle(0x281626, 1);
    this.hudGraphics.fillRect(x, y, width, 12);
    this.hudGraphics.fillStyle(accent, 1);
    this.hudGraphics.fillRect(x, y, Math.max(0, width * ratio), 12);
  }

  private handleEvents(events: BrawlSimEvent[]): void {
    for (const event of events) {
      if (event.type === 'runStart') {
        this.soundManager?.playAnnounce('fight');
        this.showBanner('MOVE RIGHT\nJUMP THE ROUTE');
      } else if (event.type === 'encounterStart') {
        this.soundManager?.playAnnounce('round');
        const encounter = this.routeMap.encounters[event.encounterIndex];
        this.showBanner(`${encounter?.mode === 'rolling' ? 'KEEP MOVING' : 'ROADBLOCK'} ${event.encounterIndex + 1}\n${event.label}`);
      } else if (event.type === 'encounterCleared') {
        this.runStats.checkpointsCleared += 1;
        this.showBanner('PATH CLEAR\nMOVE →');
      } else if (event.type === 'attack') {
        if (event.attackKind === 'heavy') this.soundManager?.playUppercut();
        else this.soundManager?.playWhoosh();
      } else if (event.type === 'checkpointRecovery') {
        const actor = this.sim.players.find((player) => player.id === event.actorId);
        if (actor) this.createFloatingText(actor.x, actor.lane - 190, `+${event.amount} HP`, '#30e07a');
      } else if (event.type === 'obstacleRecovery') {
        const actor = this.sim.players.find((player) => player.id === event.actorId);
        if (actor) this.createFloatingText(actor.x, actor.lane - 178, `TEAM +${event.amount} HP`, '#30e07a');
      } else if (event.type === 'hit') {
        if (this.sim.players.some((player) => player.id === event.targetId)) {
          this.runStats.damageTaken += event.damage;
        }
        this.soundManager?.playHit(event.damage >= 40);
        const target = [...this.sim.players, ...this.sim.enemies].find((actor) => actor.id === event.targetId);
        if (target) this.createHitEffect(target.x, target.lane - 92, event.damage);
      } else if (event.type === 'guarded') {
        this.runStats.damageTaken += event.damage;
        this.soundManager?.playWhoosh();
        const target = this.sim.players.find((actor) => actor.id === event.targetId);
        if (target) this.createFloatingText(target.x, target.lane - 150, 'BLOCK', '#8ac5ff');
      } else if (event.type === 'fireball') {
        this.soundManager?.playFireball();
        const actor = [...this.sim.players, ...this.sim.enemies].find((candidate) => candidate.id === event.actorId);
        if (actor) {
          this.createCastEffect(
            actor.x + (actor.facingRight ? 52 : -52),
            actor.lane - 72,
            event.isSuper,
            actor.kind === 'enemy',
          );
        }
      } else if (event.type === 'obstacleHit') {
        this.soundManager?.playHit(event.damage >= 40);
        const obstacle = this.sim.obstacles.find((candidate) => candidate.id === event.obstacleId);
        if (obstacle) this.createHitEffect(obstacle.x, obstacle.lane - 34, event.damage);
      } else if (event.type === 'obstacleDestroyed') {
        this.runStats.obstaclesDestroyed += 1;
        const obstacle = this.sim.obstacles.find((candidate) => candidate.id === event.obstacleId);
        if (obstacle && obstacle.type !== 'explosive-barrel') {
          this.createFloatingText(obstacle.x, obstacle.lane - 78, 'SMASH!', '#ffce3a');
        }
      } else if (event.type === 'obstacleExploded') {
        this.soundManager?.playKO();
        const obstacle = this.sim.obstacles.find((candidate) => candidate.id === event.obstacleId);
        if (obstacle) this.createExplosionEffect(obstacle.x, obstacle.lane - 28);
      } else if (event.type === 'hazardBurst') {
        this.soundManager?.playWhoosh();
        const obstacle = this.sim.obstacles.find((candidate) => candidate.id === event.obstacleId);
        if (obstacle) this.createVentBurst(obstacle.x, obstacle.lane);
      } else if (event.type === 'actorDown') {
        const actor = [...this.sim.players, ...this.sim.enemies]
          .find((candidate) => candidate.id === event.actorId);
        if (actor?.kind === 'enemy') this.runStats.enemiesDefeated += 1;
        if (actor?.kind === 'player' || actor?.archetype === 'captain') {
          this.soundManager?.playKO();
        }
      } else if (event.type === 'revived') {
        this.runStats.revives += 1;
        const actor = this.sim.players.find((player) => player.id === event.actorId);
        if (actor) this.createFloatingText(actor.x, actor.lane - 180, 'BACK IN!', '#30e07a');
      } else if (event.type === 'missionComplete') {
        this.soundManager?.stopBattleMusic();
        this.soundManager?.playAnnounce('wins');
        this.showBanner('ROUTE CLEARED');
        this.finishRun('won');
      } else if (event.type === 'missionFailed') {
        this.soundManager?.stopBattleMusic();
        this.soundManager?.playAnnounce('ko');
        this.showBanner('TEAM DOWN');
        this.finishRun('lost');
      }
    }
  }

  private showBanner(text: string, color = 0xfff4d6): void {
    this.banner
      .setText(text)
      .setColor(`#${color.toString(16).padStart(6, '0')}`)
      .setAlpha(1)
      .setScale(0.92);
    this.tweens.killTweensOf(this.banner);
    this.tweens.add({
      targets: this.banner,
      alpha: 0,
      scale: 1.04,
      delay: 850,
      duration: 650,
      ease: 'Quart.easeOut',
    });
  }

  private finishRun(outcome: 'won' | 'lost'): void {
    if (this.runSummaryReported) return;
    this.runSummaryReported = true;
    this.waitingForRunAction = true;
    this.inputManager.reset();

    const teamHealthRemaining = this.sim.players.reduce(
      (total, player) => total + Math.max(0, player.health),
      0,
    );
    const teamMaxHealth = this.sim.players.reduce(
      (total, player) => total + player.maxHealth,
      0,
    );
    const durationSeconds = Math.max(0, Math.round(this.sim.tick / 60));
    const result = scoreRushRun({
      completed: outcome === 'won',
      durationSeconds,
      enemiesDefeated: this.runStats.enemiesDefeated,
      obstaclesDestroyed: this.runStats.obstaclesDestroyed,
      checkpointsCleared: this.runStats.checkpointsCleared,
      revives: this.runStats.revives,
      teamHealthRemaining,
      teamMaxHealth,
    });
    const detail: RushRunCompleteDetail = {
      outcome,
      stageId: this.stageId,
      stageLabel: getStageTheme(this.stageId).label,
      durationSeconds,
      score: result.score,
      rank: result.rank,
      enemiesDefeated: this.runStats.enemiesDefeated,
      obstaclesDestroyed: this.runStats.obstaclesDestroyed,
      checkpointsCleared: this.runStats.checkpointsCleared,
      revives: this.runStats.revives,
      damageTaken: this.runStats.damageTaken,
      teamHealthRemaining,
      teamMaxHealth,
      difficulty: this.rushDifficulty,
    };
    window.dispatchEvent(new CustomEvent(RUSH_RUN_COMPLETE_EVENT, { detail }));
  }

  private performRunAction(action: MatchAction): void {
    if (!this.waitingForRunAction || this.runActionCommitted) return;
    this.runActionCommitted = true;

    if (action === 'run_it_back' || action === 'remix') {
      this.cameras.main.flash(180, 255, 255, 255);
      this.time.delayedCall(180, () => {
        this.scene.restart({
          ...this.matchData,
          remix: action === 'remix'
            ? (this.matchData.remix ?? 0) + 1
            : this.matchData.remix,
        });
      });
      return;
    }

    this.exitToMenu();
  }

  private createHitEffect(x: number, y: number, damage: number): void {
    const impact = this.add.circle(x, y, 22, 0xffce3a, 0.86).setDepth(3500);
    this.tweens.add({
      targets: impact,
      alpha: 0,
      scale: 1.8,
      duration: 150,
      ease: 'Quart.easeOut',
      onComplete: () => impact.destroy(),
    });
    this.createFloatingText(x + 22, y - 10, String(damage), '#fff4d6');
    this.cameras.main.shake(55, damage >= 40 ? 0.004 : 0.002);
  }

  private createCastEffect(x: number, y: number, isSuper: boolean, hostile = false): void {
    const color = hostile ? (isSuper ? 0xff6b3d : 0xd56bff) : (isSuper ? 0x78ddff : 0xffce3a);
    const ring = this.add.circle(x, y, isSuper ? 30 : 20, color, 0.54)
      .setDepth(3500)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: ring,
      alpha: 0,
      scale: 1.7,
      duration: 180,
      ease: 'Quart.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  private createVentBurst(x: number, y: number): void {
    const burst = this.add.ellipse(x, y - 36, 84, 104, 0x9ee7ff, 0.28)
      .setDepth(Math.round(y) + 4)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: burst,
      y: y - 82,
      alpha: 0,
      scaleX: 1.35,
      scaleY: 1.5,
      duration: 360,
      ease: 'Quart.easeOut',
      onComplete: () => burst.destroy(),
    });
  }

  private createExplosionEffect(x: number, y: number): void {
    const flash = this.add.circle(x, y, 34, 0xfff4d6, 0.94)
      .setDepth(3550)
      .setBlendMode(Phaser.BlendModes.ADD);
    const blast = this.add.circle(x, y, 56, 0xff6b3d, 0.72)
      .setDepth(3549)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      scale: 2.6,
      duration: 190,
      ease: 'Quart.easeOut',
      onComplete: () => flash.destroy(),
    });
    this.tweens.add({
      targets: blast,
      alpha: 0,
      scale: 3.2,
      duration: 340,
      ease: 'Quart.easeOut',
      onComplete: () => blast.destroy(),
    });
    this.createFloatingText(x, y - 74, 'CHAIN HIT!', '#ffce3a');
    this.cameras.main.shake(130, 0.009);
  }

  private createFloatingText(x: number, y: number, text: string, color: string): void {
    const label = this.add.text(x, y, text, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '10px',
      color,
      stroke: '#050507',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(3600);
    this.tweens.add({
      targets: label,
      y: y - 34,
      alpha: 0,
      duration: 520,
      ease: 'Quart.easeOut',
      onComplete: () => label.destroy(),
    });
  }

  private loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
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

  private isCurrent(lifecycle: number): boolean {
    return lifecycle === this.lifecycle && this.scene.isActive();
  }

  private exitToMenu(): void {
    const exit = (window as Window & { __ASF_EXIT_TO_MENU__?: () => void }).__ASF_EXIT_TO_MENU__;
    if (exit) exit();
    else window.location.href = '/menu';
  }

  private queueJump(): void {
    this.jumpQueued = true;
  }

  private consumeQueuedJump(): boolean {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  private shutdown(): void {
    this.ready = false;
    this.lifecycle += 1;
    window.removeEventListener(PAUSE_EVENT, this.onPauseEvent);
    window.removeEventListener(MATCH_ACTION_EVENT, this.onMatchAction);
    window.removeEventListener(RUSH_COMPANION_ORDER_EVENT, this.onCompanionOrder);
    this.escapeKey?.off('down', this.exitToMenu, this);
    this.jumpKey?.off('down', this.queueJump, this);
    this.jumpQueued = false;
    this.paused = false;
    this.waitingForRunAction = false;
    this.inputManager?.reset();
    resetVirtualInput();
    delete window.__ASF_RUSH_STATE__;
    for (const presentation of this.presentations.values()) {
      presentation.view.destroy();
      presentation.tag?.destroy();
      presentation.health?.destroy();
    }
    this.presentations.clear();
    for (const sprite of this.projectileSprites.values()) sprite.destroy();
    this.projectileSprites.clear();
    for (const presentation of this.obstaclePresentations.values()) {
      presentation.graphics.destroy();
      presentation.sprite?.destroy();
    }
    this.obstaclePresentations.clear();
    for (const sprite of this.stageEntrySprites) sprite.destroy();
    this.stageEntrySprites = [];
    this.stageEntryKeys.clear();
    this.entranceCueGraphics?.destroy();
    this.soundManager?.destroy();
    this.soundManager = null;
    if (this.stageTextureKey && this.textures.exists(this.stageTextureKey)) {
      this.textures.remove(this.stageTextureKey);
    }
  }
}
