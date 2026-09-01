import Phaser from 'phaser';
import { Fighter } from '../fighters/Fighter.ts';
import { FighterView } from '../fighters/FighterView.ts';
import { FighterState, FIXED_TIMESTEP, GAME_HEIGHT, GAME_WIDTH } from '../constants.ts';
import { InputManager } from '../systems/InputManager.ts';
import { resetVirtualInput } from '../systems/VirtualInput.ts';
import { loadAiSprites } from '../sprites/AiSpriteLoader.ts';
import type { MatchSceneData } from '../match/MatchConfig.ts';
import { getStageTheme, type StageThemeId } from '../match/StageConfig.ts';
import { getCachedStageBackground } from '../../services/SpriteCache.ts';
import { debugInfo, debugWarn } from '../../services/DebugLog.ts';
import {
  BrawlSimulation,
  type BrawlActor,
  type BrawlSimEvent,
} from '../brawl/BrawlSimulation.ts';
import { RUSH_ROUTE_MAP } from '../brawl/BrawlMap.ts';
import { getBrawlCompanionInput } from '../brawl/BrawlCompanionAI.ts';

const MAX_TICKS_PER_FRAME = 5;
const DEFAULT_STAGE_ID: StageThemeId = 'insert-player-arena';
const PLAYER_TAG_POINTER_REACH = 22;
const PLAYER_TAG_CLEARANCE = 6;

interface ActorPresentation {
  fighter: Fighter;
  view: FighterView;
  tag: Phaser.GameObjects.Container | null;
  health: Phaser.GameObjects.Graphics | null;
}

declare global {
  interface Window {
    __ASF_RUSH_STATE__?: () => ReturnType<BrawlSimulation['snapshot']>;
  }
}

export class RushScene extends Phaser.Scene {
  private matchData!: MatchSceneData;
  private sim!: BrawlSimulation;
  private inputManager!: InputManager;
  private companionCpu = false;
  private ready = false;
  private accumulator = 0;
  private stageId: StageThemeId = DEFAULT_STAGE_ID;
  private customStageKey: string | null = null;
  private stageTextureKey: string | null = null;
  private lifecycle = 0;
  private presentations = new Map<string, ActorPresentation>();
  private hudGraphics!: Phaser.GameObjects.Graphics;
  private hudP1!: Phaser.GameObjects.Text;
  private hudP2!: Phaser.GameObjects.Text;
  private hudObjective!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;
  private resultPanel!: Phaser.GameObjects.Container;
  private escapeKey?: Phaser.Input.Keyboard.Key;

  constructor() {
    super({ key: 'RushScene' });
  }

  init(data: MatchSceneData): void {
    this.matchData = data;
    this.stageId = data.stageId ?? DEFAULT_STAGE_ID;
    this.customStageKey = data.customStageKey ?? null;
    this.companionCpu = data.vsAI === true;
    this.accumulator = 0;
    this.ready = false;
    this.presentations.clear();
  }

  preload(): void {
    if (this.customStageKey) return;
    const stage = getStageTheme(this.stageId);
    if (stage.assetPath && !this.textures.exists('rush_stage_backdrop')) {
      this.load.image('rush_stage_backdrop', stage.assetPath);
    }
  }

  async create(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.escapeKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.escapeKey?.on('down', this.exitToMenu, this);

    await this.loadPlayerSprites(lifecycle);
    if (!this.isCurrent(lifecycle)) return;
    await this.createStageBackdrop(lifecycle);
    if (!this.isCurrent(lifecycle)) return;

    this.drawRouteGeometry();
    this.sim = new BrawlSimulation([
      this.matchData.p1Name ?? 'Player 1',
      this.matchData.p2Name ?? 'Player 2',
    ], RUSH_ROUTE_MAP);
    this.inputManager = new InputManager(this);
    this.createHud();
    this.createResultPanel();
    this.handleEvents(this.sim.start());
    this.syncPresentations();
    this.updateHud();

    this.cameras.main
      .setBounds(0, 0, RUSH_ROUTE_MAP.worldWidth, RUSH_ROUTE_MAP.worldHeight)
      .setScroll(0, 0);
    window.__ASF_RUSH_STATE__ = () => this.sim.snapshot();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);
    this.ready = true;
    debugInfo('[RushScene] Co-op route ready', {
      stageId: this.stageId,
      customStage: Boolean(this.customStageKey),
      companionCpu: this.companionCpu,
      p1: this.matchData.p1Name ?? 'Player 1',
      p2: this.matchData.p2Name ?? 'Player 2',
    });
  }

  update(_time: number, delta: number): void {
    if (!this.ready) return;
    this.inputManager.poll();
    this.accumulator += Math.min(delta, FIXED_TIMESTEP * MAX_TICKS_PER_FRAME);
    let ticks = 0;
    while (this.accumulator >= FIXED_TIMESTEP && ticks < MAX_TICKS_PER_FRAME) {
      const p1Input = this.inputManager.readPlayer1();
      const localP2Input = this.inputManager.readPlayer2();
      const events = this.sim.step(
        p1Input,
        this.companionCpu ? getBrawlCompanionInput(this.sim) : localP2Input,
      );
      this.handleEvents(events);
      this.accumulator -= FIXED_TIMESTEP;
      ticks += 1;
    }
    this.syncPresentations();
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

    const textureKey = this.stageTextureKey
      ?? (this.textures.exists('rush_stage_backdrop') ? 'rush_stage_backdrop' : null);
    if (textureKey) {
      const segmentCount = Math.ceil(RUSH_ROUTE_MAP.worldWidth / GAME_WIDTH);
      for (let segment = 0; segment < segmentCount; segment += 1) {
        this.add.image(segment * GAME_WIDTH + GAME_WIDTH / 2, GAME_HEIGHT / 2, textureKey)
          .setDisplaySize(GAME_WIDTH + 2, GAME_HEIGHT)
          .setFlipX(segment % 2 === 1)
          .setDepth(-20);
      }
    } else {
      const fallback = this.add.graphics().setDepth(-20);
      fallback.fillGradientStyle(0x16132f, 0x16132f, 0x050507, 0x050507, 1);
      fallback.fillRect(0, 0, RUSH_ROUTE_MAP.worldWidth, GAME_HEIGHT);
    }

    this.add.rectangle(
      RUSH_ROUTE_MAP.worldWidth / 2,
      GAME_HEIGHT / 2,
      RUSH_ROUTE_MAP.worldWidth,
      GAME_HEIGHT,
      0x020207,
      0.08,
    )
      .setDepth(-19);

    const joins = this.add.graphics().setDepth(-18);
    for (let x = GAME_WIDTH; x < RUSH_ROUTE_MAP.worldWidth; x += GAME_WIDTH) {
      joins.fillStyle(0x050507, 0.42);
      joins.fillRect(x - 15, 92, 30, 250);
      joins.lineStyle(3, 0xffce3a, 0.18);
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

  private drawRouteGeometry(): void {
    const { walkArea } = RUSH_ROUTE_MAP;
    const lines = this.add.graphics().setDepth(-5);
    lines.fillStyle(0x050507, 0.12);
    lines.fillRect(
      0,
      walkArea.back - 8,
      RUSH_ROUTE_MAP.worldWidth,
      walkArea.front - walkArea.back + 28,
    );
    lines.lineStyle(1, 0xffce3a, 0.12);
    for (let lane = walkArea.back; lane <= walkArea.front; lane += 44) {
      lines.lineBetween(walkArea.left, lane, walkArea.right, lane);
    }
    for (let x = walkArea.left; x <= walkArea.right; x += 120) {
      lines.lineBetween(x - 46, walkArea.back, x, walkArea.front + 12);
    }
    lines.lineStyle(2, 0xffce3a, 0.2);
    lines.strokeRoundedRect(
      walkArea.left,
      walkArea.back - 8,
      walkArea.right - walkArea.left,
      walkArea.front - walkArea.back + 28,
      8,
    );

    for (const [index, encounter] of RUSH_ROUTE_MAP.encounters.entries()) {
      lines.fillStyle(0xffce3a, 0.08);
      lines.fillRect(encounter.triggerX - 6, walkArea.back - 8, 12, walkArea.front - walkArea.back + 28);
      lines.lineStyle(2, 0xffce3a, 0.32);
      lines.lineBetween(encounter.triggerX, walkArea.back - 8, encounter.triggerX, walkArea.front + 20);
      this.add.text(encounter.triggerX, walkArea.back - 18, `0${index + 1}`, {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: '10px',
        color: '#ffce3a',
        stroke: '#050507',
        strokeThickness: 3,
      }).setOrigin(0.5, 1).setAlpha(0.7).setDepth(-4);
    }

    lines.fillStyle(0xffce3a, 0.18);
    lines.fillRect(RUSH_ROUTE_MAP.exitX - 8, walkArea.back - 8, 16, walkArea.front - walkArea.back + 28);
    this.add.text(RUSH_ROUTE_MAP.exitX, walkArea.back - 18, 'EXIT →', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '10px',
      color: '#ffce3a',
      stroke: '#050507',
      strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(-4);
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
      ? 'MOVE RIGHT · CPU PARTNER FOLLOWS    P1  WASD · U/J · G GUARD    GUARD NEAR CPU = REVIVE'
      : 'MOVE RIGHT · STAY TOGETHER    P1  WASD · U/J · G    P2  ARROWS · NUM4/NUM1 · NUM0    GUARD NEAR PARTNER = REVIVE';
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

  private createResultPanel(): void {
    const panel = this.add.rectangle(0, 0, 560, 150, 0x050507, 0.94)
      .setStrokeStyle(3, 0xffce3a, 1);
    const title = this.add.text(0, -28, '', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '24px',
      color: '#fff4d6',
      align: 'center',
    }).setOrigin(0.5);
    const copy = this.add.text(0, 28, 'ESC  BACK TO CABINET', {
      fontFamily: '"Space Grotesk", system-ui, sans-serif',
      fontSize: '15px',
      color: '#c9c0a8',
    }).setOrigin(0.5);
    this.resultPanel = this.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 16, [panel, title, copy])
      .setDepth(4000)
      .setScrollFactor(0)
      .setVisible(false)
      .setData('title', title);
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
  }

  private createActorPresentation(actor: BrawlActor): ActorPresentation {
    const playerIndex = actor.slot ?? this.presentations.size + 2;
    const fighter = new Fighter(playerIndex, actor.name, actor.x, actor.facingRight);
    const spriteKey = actor.slot === 0
      ? 'fighter_p1'
      : actor.slot === 1
        ? 'fighter_p2'
        : actor.id.charCodeAt(actor.id.length - 1) % 2 === 0
          ? 'fighter_p1'
          : 'fighter_p2';
    const view = new FighterView(fighter, spriteKey);
    view.createSprite(this);
    const scale = actor.archetype === 'captain'
      ? 0.96
      : actor.archetype === 'bruiser'
        ? 0.82
        : actor.kind === 'enemy'
          ? 0.72
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
    const depth = Math.round(actor.lane) + (actor.kind === 'player' ? 1 : 0);
    presentation.view.shadowSprite?.setDepth(depth - 2);
    presentation.view.sprite.setDepth(depth);
    if (actor.archetype === 'captain') presentation.view.sprite.setTint(0xffce3a);
    else if (actor.archetype === 'bruiser') presentation.view.sprite.setTint(0xff8c42);
    else if (actor.kind === 'enemy') presentation.view.sprite.setTint(0x6f64a8);
    else presentation.view.sprite.clearTint();

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
      if (actor.health > 0) {
        const width = actor.archetype === 'captain' ? 84 : 58;
        const y = actor.lane - (actor.archetype === 'captain' ? 206 : 168);
        presentation.health.fillStyle(0x050507, 0.9);
        presentation.health.fillRoundedRect(actor.x - width / 2 - 2, y - 2, width + 4, 8, 2);
        presentation.health.fillStyle(actor.archetype === 'captain' ? 0xffce3a : 0xff2a2a, 1);
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
    switch (actor.state) {
      case 'walk': return FighterState.WALK_FORWARD;
      case 'attack': return actor.attackKind === 'heavy' ? FighterState.HIGH_KICK : FighterState.HIGH_PUNCH;
      case 'hit': return FighterState.HIT_STUN;
      case 'down': return FighterState.KNOCKDOWN;
      case 'victory': return FighterState.VICTORY;
      default: return FighterState.IDLE;
    }
  }

  private nearestLivingEnemyX(x: number): number {
    const living = this.sim.enemies.filter((enemy) => enemy.health > 0);
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
    const encounterCount = RUSH_ROUTE_MAP.encounters.length;
    if (this.sim.activeEncounterIndex >= 0) {
      this.hudObjective.setText(
        `CHECKPOINT ${this.sim.activeEncounterIndex + 1}/${encounterCount}\n${livingEnemies} HOSTILE${livingEnemies === 1 ? '' : 'S'}`,
      );
    } else {
      const finalCheckpointCleared = this.sim.encounterIndex >= encounterCount - 1;
      const startX = Math.min(...RUSH_ROUTE_MAP.playerSpawns.map((spawn) => spawn.x));
      const routeRatio = Phaser.Math.Clamp(
        (this.sim.progressX - startX) / (RUSH_ROUTE_MAP.exitX - startX),
        0,
        1,
      );
      this.hudObjective.setText(
        `${finalCheckpointCleared ? 'EXIT →' : 'ADVANCE →'}\nROUTE ${Math.round(routeRatio * 100)}%`,
      );
    }
    this.drawRouteProgress();
  }

  private drawRouteProgress(): void {
    const startX = Math.min(...RUSH_ROUTE_MAP.playerSpawns.map((spawn) => spawn.x));
    const railX = GAME_WIDTH / 2 - 145;
    const railY = 82;
    const railWidth = 290;
    const ratioFor = (worldX: number) => Phaser.Math.Clamp(
      (worldX - startX) / (RUSH_ROUTE_MAP.exitX - startX),
      0,
      1,
    );
    const progressRatio = ratioFor(this.sim.progressX);

    this.hudGraphics.fillStyle(0x050507, 0.9);
    this.hudGraphics.fillRoundedRect(railX - 4, railY - 4, railWidth + 8, 12, 3);
    this.hudGraphics.fillStyle(0x4a3e35, 1);
    this.hudGraphics.fillRect(railX, railY, railWidth, 4);
    this.hudGraphics.fillStyle(0xffce3a, 1);
    this.hudGraphics.fillRect(railX, railY, railWidth * progressRatio, 4);

    for (const [index, encounter] of RUSH_ROUTE_MAP.encounters.entries()) {
      const x = railX + railWidth * ratioFor(encounter.triggerX);
      const reached = index <= this.sim.encounterIndex;
      this.hudGraphics.fillStyle(reached ? 0xffce3a : 0x050507, 1);
      this.hudGraphics.fillCircle(x, railY + 2, 5);
      this.hudGraphics.lineStyle(2, 0xffce3a, reached ? 1 : 0.62);
      this.hudGraphics.strokeCircle(x, railY + 2, 5);
    }

    this.hudGraphics.fillStyle(this.sim.progressX >= RUSH_ROUTE_MAP.exitX ? 0xffce3a : 0x050507, 1);
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
    const activeEncounter = RUSH_ROUTE_MAP.encounters[this.sim.activeEncounterIndex];
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
      RUSH_ROUTE_MAP.worldWidth - GAME_WIDTH,
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
        this.showBanner('MOVE RIGHT\nSTAY TOGETHER');
      } else if (event.type === 'encounterStart') {
        this.showBanner(`ROADBLOCK ${event.encounterIndex + 1}\n${event.label}`);
      } else if (event.type === 'encounterCleared') {
        this.showBanner('PATH CLEAR\nMOVE →');
      } else if (event.type === 'hit') {
        const target = [...this.sim.players, ...this.sim.enemies].find((actor) => actor.id === event.targetId);
        if (target) this.createHitEffect(target.x, target.lane - 92, event.damage);
      } else if (event.type === 'revived') {
        const actor = this.sim.players.find((player) => player.id === event.actorId);
        if (actor) this.createFloatingText(actor.x, actor.lane - 180, 'BACK IN!', '#30e07a');
      } else if (event.type === 'missionComplete') {
        this.showResult('ROUTE CLEARED');
      } else if (event.type === 'missionFailed') {
        this.showResult('TEAM DOWN');
      }
    }
  }

  private showBanner(text: string): void {
    this.banner.setText(text).setAlpha(1).setScale(0.92);
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

  private showResult(text: string): void {
    const title = this.resultPanel.getData('title') as Phaser.GameObjects.Text;
    title.setText(text);
    this.resultPanel.setVisible(true).setAlpha(0).setScale(0.96);
    this.tweens.add({
      targets: this.resultPanel,
      alpha: 1,
      scale: 1,
      duration: 220,
      ease: 'Quart.easeOut',
    });
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

  private shutdown(): void {
    this.ready = false;
    this.lifecycle += 1;
    this.escapeKey?.off('down', this.exitToMenu, this);
    this.inputManager?.reset();
    resetVirtualInput();
    delete window.__ASF_RUSH_STATE__;
    for (const presentation of this.presentations.values()) {
      presentation.view.destroy();
      presentation.tag?.destroy();
      presentation.health?.destroy();
    }
    this.presentations.clear();
    if (this.stageTextureKey && this.textures.exists(this.stageTextureKey)) {
      this.textures.remove(this.stageTextureKey);
    }
  }
}
