import Phaser from 'phaser';
import { Fighter } from '../fighters/Fighter.ts';
import { Projectile } from '../fighters/Projectile.ts';
import { CombatSystem, type HitEvent } from '../systems/CombatSystem.ts';
import { AIController } from '../systems/AIController.ts';
import { InputManager } from '../systems/InputManager.ts';
import { SoundManager } from '../systems/SoundManager.ts';
import { HUD } from '../ui/HUD.ts';
import { SeededRng } from '../utils/SeededRng.ts';
import { ScreenEffects } from '../effects/ScreenEffects.ts';
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
} from '../constants.ts';
import { loadAiSprites } from '../sprites/AiSpriteLoader.ts';

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
  private rng!: SeededRng;
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
  private cloudLayers: Phaser.GameObjects.Graphics[] = [];
  private lanternGlows: Phaser.GameObjects.Graphics[] = [];

  private projectiles: Projectile[] = [];
  private matchOverUI?: Phaser.GameObjects.Text;
  private waitingForMatchInput = false;
  private p1PhotoHash: string | null = null;
  private p2PhotoHash: string | null = null;
  private p1Name = 'Player 1';
  private p2Name = 'CPU';
  private ready = false;

  constructor() {
    super({ key: 'FightScene' });
  }

  init(data: { vsAI?: boolean; cpuVsCpu?: boolean; p1PhotoHash?: string; p2PhotoHash?: string; p1Name?: string; p2Name?: string }): void {
    this.cpuVsCpu = data.cpuVsCpu === true;
    this.isVsAI = data.vsAI !== false || this.cpuVsCpu;
    this.p1PhotoHash = data.p1PhotoHash ?? null;
    this.p2PhotoHash = data.p2PhotoHash ?? null;
    this.p1Name = data.p1Name ?? (this.cpuVsCpu ? 'CPU 1' : 'Player 1');
    this.p2Name = data.p2Name ?? (this.isVsAI ? 'CPU' : 'Player 2');
    this.p1Wins = 0;
    this.p2Wins = 0;
    this.accumulator = 0;
    this.waitingForMatchInput = false;
    this.ready = false;
  }

  async create(): Promise<void> {
    this.rng = new SeededRng(Date.now());
    this.combat = new CombatSystem();
    this.inputMgr = new InputManager(this);
    this.sound_mgr = new SoundManager();

    await this.loadAiSpritesIfNeeded();

    this.drawStage();
    this.createClouds();
    this.createFloorDetail();
    this.createSpectators();
    this.createLanternGlow();
    this.createFighters();

    this.hud = new HUD(this);
    this.hud.create(this.p1.name, this.p2.name);

    this.ai = new AIController(this.rng);
    this.ai2 = new AIController(new SeededRng(Date.now() + 12345));

    this.createParticles();
    ScreenEffects.createCRTOverlay(this);
    this.startRound();
    this.ready = true;
  }

  private async loadAiSpritesIfNeeded(): Promise<void> {
    const loads: Promise<void>[] = [];

    if (this.p1PhotoHash) {
      loads.push(
        loadAiSprites(this, 'fighter_p1', this.p1PhotoHash).then((ok) => {
          if (ok) console.log('Loaded AI sprites for P1');
          else console.warn('No AI sprites found for P1, using procedural');
        }),
      );
    }

    if (this.p2PhotoHash) {
      loads.push(
        loadAiSprites(this, 'fighter_p2', this.p2PhotoHash).then((ok) => {
          if (ok) console.log('Loaded AI sprites for P2');
          else console.warn('No AI sprites found for P2, using procedural');
        }),
      );
    }

    await Promise.all(loads);
  }

  private drawStage(): void {
    this.stageGfx = this.add.graphics();

    // Sky gradient
    for (let y = 0; y < GROUND_Y; y++) {
      const t = y / GROUND_Y;
      const r = Math.floor(20 + t * 40);
      const g = Math.floor(10 + t * 30);
      const b = Math.floor(60 + t * 50);
      this.stageGfx.fillStyle(Phaser.Display.Color.GetColor(r, g, b));
      this.stageGfx.fillRect(0, y, GAME_WIDTH, 1);
    }

    // Ground
    this.stageGfx.fillStyle(0x3a2a1a);
    this.stageGfx.fillRect(0, GROUND_Y, GAME_WIDTH, GAME_HEIGHT - GROUND_Y);

    // Ground line
    this.stageGfx.lineStyle(3, 0x5a4a3a);
    this.stageGfx.lineBetween(0, GROUND_Y, GAME_WIDTH, GROUND_Y);

    // Dojo pillars
    this.stageGfx.fillStyle(0x4a3a2a);
    this.stageGfx.fillRect(30, GROUND_Y - 280, 40, 280);
    this.stageGfx.fillRect(GAME_WIDTH - 70, GROUND_Y - 280, 40, 280);

    // Roof
    this.stageGfx.fillStyle(0x8b0000);
    this.stageGfx.fillTriangle(0, GROUND_Y - 280, GAME_WIDTH / 2, GROUND_Y - 360, GAME_WIDTH, GROUND_Y - 280);

    // Lanterns
    for (let i = 0; i < 5; i++) {
      const lx = 120 + i * 180;
      this.stageGfx.fillStyle(0xcc3333);
      this.stageGfx.fillRoundedRect(lx - 12, GROUND_Y - 300, 24, 36, 6);
      this.stageGfx.fillStyle(0xffaa00, 0.3);
      this.stageGfx.fillCircle(lx, GROUND_Y - 282, 20);
    }

    this.stageGfx.setDepth(0);
  }

  private createClouds(): void {
    const cloudData = [
      { y: 30, speed: 0.008, shapes: [{ x: 100, w: 120, h: 24 }, { x: 500, w: 90, h: 18 }, { x: 820, w: 110, h: 22 }] },
      { y: 70, speed: 0.015, shapes: [{ x: 200, w: 80, h: 16 }, { x: 650, w: 100, h: 20 }, { x: 950, w: 70, h: 14 }] },
    ];

    for (const layer of cloudData) {
      const gfx = this.add.graphics().setDepth(1);
      gfx.setData('cloudLayer', layer);
      this.cloudLayers.push(gfx);
    }
  }

  private updateClouds(time: number): void {
    for (const gfx of this.cloudLayers) {
      const layer = gfx.getData('cloudLayer') as { y: number; speed: number; shapes: { x: number; w: number; h: number }[] };
      gfx.clear();
      gfx.fillStyle(0xffffff, 0.06);
      for (const shape of layer.shapes) {
        const offsetX = (time * layer.speed) % (GAME_WIDTH + shape.w);
        const drawX = (shape.x + offsetX) % (GAME_WIDTH + shape.w) - shape.w;
        gfx.fillEllipse(drawX + shape.w / 2, layer.y, shape.w, shape.h);
      }
    }
  }

  private createFloorDetail(): void {
    const floorGfx = this.add.graphics().setDepth(2);
    floorGfx.lineStyle(1, 0x5a4a3a, 0.4);
    for (let i = 0; i < 16; i++) {
      const plankX = i * 66;
      floorGfx.lineBetween(plankX, GROUND_Y + 2, plankX, GAME_HEIGHT);
    }
    floorGfx.lineStyle(1, 0x4a3a2a, 0.3);
    for (let y = GROUND_Y + 20; y < GAME_HEIGHT; y += 30) {
      floorGfx.lineBetween(0, y, GAME_WIDTH, y);
    }
  }

  private createSpectators(): void {
    const specGfx = this.add.graphics().setDepth(3);
    const spectatorXPositions = [140, 360, 660, 870];
    for (const sx of spectatorXPositions) {
      const headY = GROUND_Y - 30;
      specGfx.fillStyle(0x111111, 0.5);
      specGfx.fillCircle(sx, headY, 8);
      specGfx.fillRoundedRect(sx - 7, headY + 8, 14, 22, 3);
    }
  }

  private createLanternGlow(): void {
    for (let i = 0; i < 5; i++) {
      const lx = 120 + i * 180;
      const glow = this.add.graphics().setDepth(1);
      glow.setData('lanternX', lx);
      glow.setData('lanternY', GROUND_Y - 282);
      this.lanternGlows.push(glow);
    }
  }

  private updateLanternGlow(time: number): void {
    for (let i = 0; i < this.lanternGlows.length; i++) {
      const glow = this.lanternGlows[i];
      const lx = glow.getData('lanternX') as number;
      const ly = glow.getData('lanternY') as number;
      const pulse = 0.15 + Math.sin(time * 0.003 + i * 1.2) * 0.1;
      glow.clear();
      glow.fillStyle(0xffaa00, pulse);
      glow.fillCircle(lx, ly, 28);
      glow.fillStyle(0xffcc44, pulse * 0.5);
      glow.fillCircle(lx, ly, 42);
    }
  }

  private createFighters(): void {
    this.p1 = new Fighter(0, this.p1Name, 'fighter_p1', 250, true);
    this.p2 = new Fighter(1, this.p2Name, 'fighter_p2', GAME_WIDTH - 250, false);

    this.p1.createSprite(this);
    this.p2.createSprite(this);
    this.p1.sprite.setDepth(10);
    this.p2.sprite.setDepth(10);
  }

  private createParticles(): void {
    this.hitSparks = this.add.particles(0, 0, 'spark', {
      speed: { min: 100, max: 300 },
      angle: { min: 0, max: 360 },
      scale: { start: 1, end: 0 },
      lifespan: 300,
      gravityY: 200,
      emitting: false,
    });
    this.hitSparks.setDepth(50);
  }

  private startRound(): void {
    this.phase = RoundPhase.INTRO;
    this.phaseTimer = 120;
    this.roundTimer = ROUND_TIME;
    this.frameCount = 0;

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
    this.hud.showAnnouncement(`ROUND ${roundNum}`, 1200);
    this.sound_mgr.playAnnounce('round');
    this.time.delayedCall(1300, () => {
      if (this.phase === RoundPhase.INTRO) {
        this.hud.showAnnouncement('FIGHT!', 800);
        this.sound_mgr.playAnnounce('fight');
      }
    });
  }

  update(time: number, delta: number): void {
    if (!this.ready) return;

    if (this.phase === RoundPhase.INTRO) {
      this.phaseTimer--;
      if (this.phaseTimer <= 0) {
        this.phase = RoundPhase.FIGHTING;
      }
      this.p1.syncSprite(this.p2.x);
      this.p2.syncSprite(this.p1.x);
      return;
    }

    if (this.phase === RoundPhase.ROUND_END || this.phase === RoundPhase.MATCH_END) {
      this.phaseTimer--;
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
    this.updateLanternGlow(time);

    this.p1.syncSprite(this.p2.x);
    this.p2.syncSprite(this.p1.x);
    this.hud.update(this.p1.health, this.p2.health, this.roundTimer);
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
    const p1Input = this.cpuVsCpu ? this.ai2.getInput(this.p1, this.p2) : this.inputMgr.readPlayer1();
    const p2Input = this.isVsAI ? this.ai.getInput(this.p2, this.p1) : this.inputMgr.readPlayer2();

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

    const spawnX = fighter.x + (fighter.facingRight ? 60 : -60);
    const spawnY = fighter.y - 100;
    const proj = new Projectile(this, spawnX, spawnY, fighter.facingRight, fighter.playerIndex, false);
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
          defender.y - 80,
          isBlocking ? 5 : 12,
        );

        const dmgColor = isBlocking ? '#999999' : '#ff8844';
        const actualDmg = isBlocking ? Math.floor(proj.damage * 0.1) : proj.damage;
        const dmgText = this.add.text(
          defender.x + (defender.facingRight ? -10 : 10),
          defender.y - 100,
          actualDmg.toString(),
          {
            fontFamily: '"Press Start 2P", monospace',
            fontSize: '12px',
            color: dmgColor,
            stroke: '#000000',
            strokeThickness: 3,
          },
        ).setOrigin(0.5).setDepth(105);

        this.tweens.add({
          targets: dmgText,
          y: dmgText.y - 50,
          alpha: 0,
          duration: 800,
          ease: 'Cubic.easeOut',
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
      defender.y - 80,
      event.blocked ? 5 : 12,
    );

    // Combo counter
    if (!event.blocked && defender.comboCount >= 2) {
      this.hud.showCombo(attacker.x, attacker.y, defender.comboCount, attacker.playerIndex);
    }

    // Floating damage number
    const dmgColor = event.blocked ? '#999999' : '#ff4444';
    const dmgText = this.add.text(
      defender.x + (defender.facingRight ? -10 : 10),
      defender.y - 100,
      event.damage.toString(),
      {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: '12px',
        color: dmgColor,
        stroke: '#000000',
        strokeThickness: 3,
      },
    ).setOrigin(0.5).setDepth(105);

    this.tweens.add({
      targets: dmgText,
      y: dmgText.y - 50,
      alpha: 0,
      duration: 800,
      ease: 'Cubic.easeOut',
      onComplete: () => dmgText.destroy(),
    });
  }

  private endRound(): void {
    this.phase = RoundPhase.ROUND_END;
    this.phaseTimer = 180; // 3 seconds

    let winner: Fighter;
    if (this.p1.health <= 0 && this.p2.health <= 0) {
      this.hud.showAnnouncement('DOUBLE K.O.!', 2500);
      this.sound_mgr.playKO();
      this.sound_mgr.playAnnounce('ko');
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
    loser.forceState(FighterState.DEFEAT);
    if (loser.health <= 0) {
      this.hud.showAnnouncement('K.O.!', 2000);
      this.sound_mgr.playKO();
      this.sound_mgr.playAnnounce('ko');
      ScreenEffects.flashWhite(this, 200);
    }

    this.hud.updateRoundWins(this.p1Wins, this.p2Wins);

    if (this.p1Wins >= ROUNDS_TO_WIN || this.p2Wins >= ROUNDS_TO_WIN) {
      this.phase = RoundPhase.MATCH_END;
      this.phaseTimer = 300; // 5 seconds
      this.time.delayedCall(2200, () => {
        this.hud.showAnnouncement(`${winner.name.toUpperCase()} WINS!`, 0);
        this.sound_mgr.playAnnounce('wins');
      });
    }
  }

  private showMatchOverUI(): void {
    this.waitingForMatchInput = true;

    this.matchOverUI = this.add.text(
      GAME_WIDTH / 2,
      GAME_HEIGHT - 60,
      'ENTER: REMATCH  /  ESC: MENU',
      {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: '14px',
        color: '#ffcc00',
        stroke: '#000000',
        strokeThickness: 3,
      },
    ).setOrigin(0.5).setDepth(200);

    this.tweens.add({
      targets: this.matchOverUI,
      alpha: { from: 1, to: 0.3 },
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    const enterKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    const escKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);

    enterKey.once('down', () => {
      escKey.removeAllListeners();
      this.cleanupMatchOverUI();
      this.cameras.main.flash(200, 255, 255, 255);
      this.time.delayedCall(200, () => {
        this.scene.restart({
          vsAI: this.isVsAI,
          cpuVsCpu: this.cpuVsCpu,
          p1PhotoHash: this.p1PhotoHash,
          p2PhotoHash: this.p2PhotoHash,
          p1Name: this.p1Name,
          p2Name: this.p2Name,
        });
      });
    });

    escKey.once('down', () => {
      enterKey.removeAllListeners();
      this.cleanupMatchOverUI();
      this.cameras.main.fadeOut(500, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this.scene.start('TitleScene');
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
}
