import type Phaser from 'phaser';
import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';
import type { AuraSlot } from './AuraChart.ts';
import { CREAM, HEAT, INK, PIXEL_FONT } from '../ui/CabinetTheme.ts';
import { drawAuraComicIcon } from './AuraComicArt.ts';

/** Deliberately short game copy, not a claim that every move is a named meme. */
export const AURA_COMIC_COPY: Record<AuraAnimationName, readonly [string, string]> = {
  aura_unbothered: ['UNBOTHERED', 'ZERO STRESS'],
  aura_six_seven: ['67', 'SIX SEVEN!'],
  aura_mog_check: ['MOG CHECK', 'GIGACHAD'],
  aura_glide: ['SMOOTH!', 'NO FRICTION'],
  aura_floor_worm: ['WORM MODE', 'FLOOR IS YOURS'],
  aura_one_leg: ['HOP MODE', 'ONE FOOT.'],
  aura_shrug: ['WHO, ME?', 'NO IDEA.'],
};

// UI-space safe zones: outside the note highway, below scores, above bodies.
// They do not inherit the camera zoom or the sprite sheet's transparent padding.
export const AURA_COMIC_LAYOUT = {
  x: [194, 830] as const, moveY: 192, streakY: 118,
  moveWidth: 208, moveHeight: 74, streakWidth: 208, streakHeight: 24,
  moveRise: 24, streakRise: 12,
};

type Bubble = { object: Phaser.GameObjects.Container; timer: Phaser.Time.TimerEvent };
export interface AuraMoveInput { key: string; tone: number; phrase: string }
type InputTrail = { phrase: string; inputs: AuraMoveInput[]; labels: Phaser.GameObjects.Text[]; pads: Phaser.GameObjects.Graphics };
export const AURA_DOCKED_MOVE_NAMES: Record<AuraAnimationName, string> = {
  aura_unbothered: 'UNBOTHERED', aura_six_seven: 'SIX\nSEVEN!', aura_mog_check: 'MOG\nCHECK',
  aura_glide: 'GLIDE', aura_floor_worm: 'FLOOR\nWORM', aura_one_leg: 'ONE-LEG\nHOP', aura_shrug: 'WHO, ME?',
};
/** Coordinates in the feedback layer, independent of fighter/camera transforms. */
export interface AuraComicAnchor {
  x: number;
  moveY: number;
  streakY: number;
  /** Optional nonnegative flight distances; omitted values retain 24/12px. */
  moveRise?: number;
  streakRise?: number;
  /** Compact move rail with successful input history. */
  docked?: boolean;
  /** Portrait cards live over the stage and carry their own contrast surface. */
  stageCard?: boolean;
  scale?: number;
}

/** Two bounded slots per seat; no particles, queues, or per-note popups. */
export class AuraComicFeedback {
  private moves: [Bubble | null, Bubble | null] = [null, null];
  private streaks: [Bubble | null, Bubble | null] = [null, null];
  private currentMoves: [AuraAnimationName | null, AuraAnimationName | null] = [null, null];
  private failures: [number, number] = [0, 0];
  private visible: [boolean, boolean] = [true, true];
  private trails: [InputTrail | null, InputTrail | null] = [null, null];
  private anchors: [AuraComicAnchor, AuraComicAnchor] = [
    { x: AURA_COMIC_LAYOUT.x[0], moveY: AURA_COMIC_LAYOUT.moveY, streakY: AURA_COMIC_LAYOUT.streakY },
    { x: AURA_COMIC_LAYOUT.x[1], moveY: AURA_COMIC_LAYOUT.moveY, streakY: AURA_COMIC_LAYOUT.streakY },
  ];

  constructor(
    private scene: Phaser.Scene,
    private layer: Phaser.GameObjects.Container,
    private reduceMotion: boolean,
    private onMove?: (name: AuraAnimationName) => void,
  ) {}

  /** A layout change retires the old flight; it must not tween across a head
   * or highway on its way to a newly reserved safe zone. Same anchor is a no-op. */
  setAnchor(slot: AuraSlot, anchor: Readonly<AuraComicAnchor>): void {
    if (![anchor.x, anchor.moveY, anchor.streakY].every(Number.isFinite)) {
      throw new RangeError('Aura comic anchor coordinates must be finite');
    }
    const moveRise = anchor.moveRise ?? AURA_COMIC_LAYOUT.moveRise;
    const streakRise = anchor.streakRise ?? AURA_COMIC_LAYOUT.streakRise;
    if (![moveRise, streakRise].every(value => Number.isFinite(value) && value >= 0)) {
      throw new RangeError('Aura comic flight distances must be finite and nonnegative');
    }
    const scale = anchor.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Aura comic scale must be finite and positive');
    const previous = this.anchors[slot];
    if (previous.x === anchor.x && previous.moveY === anchor.moveY && previous.streakY === anchor.streakY
      && (previous.moveRise ?? AURA_COMIC_LAYOUT.moveRise) === moveRise
      && (previous.streakRise ?? AURA_COMIC_LAYOUT.streakRise) === streakRise
      && !!previous.docked === !!anchor.docked
      && !!previous.stageCard === !!anchor.stageCard && (previous.scale ?? 1) === scale) return;
    this.resetSlot(slot);
    this.anchors[slot] = { x: anchor.x, moveY: anchor.moveY, streakY: anchor.streakY, moveRise, streakRise, docked: anchor.docked, stageCard: anchor.stageCard, scale };
  }

  /** Hide the waiting seat and discard late feedback without accumulating it.
   * Showing it again requires a fresh move/judgement; nothing is replayed. */
  setSlotVisible(slot: AuraSlot, visible: boolean): void {
    if (this.visible[slot] === visible) return;
    this.visible[slot] = visible;
    if (!visible) this.resetSlot(slot);
  }

  beginTurn(): void {
    for (const slot of [0, 1] as const) this.resetSlot(slot);
  }

  move(slot: AuraSlot, name: AuraAnimationName, input?: AuraMoveInput): void {
    if (!this.visible[slot]) return;
    if (this.anchors[slot].docked) {
      this.dockedMove(slot, name, input);
      return;
    }
    if (this.currentMoves[slot] === name) return;
    this.currentMoves[slot] = name;
    const [title, caption] = AURA_COMIC_COPY[name];
    const anchor = this.anchors[slot];
    const object = this.scene.add.container(anchor.x, anchor.moveY);
    const icon = this.scene.add.graphics().setPosition(-62, 0);
    drawAuraComicIcon(icon, name);
    object.add(icon);
    if (name === 'aura_six_seven') {
      object.add(this.text(-62, -8, title, 28, '#ffce3a'));
      object.add(this.text(34, -5, 'SIX\nSEVEN!', 15));
    } else {
      object.add(this.text(35, -9, title, 11));
      object.add(this.text(35, 14, caption, 8));
    }
    this.present(this.moves, slot, object, 1_800, anchor.moveRise ?? AURA_COMIC_LAYOUT.moveRise);
    this.onMove?.(name);
  }

  private dockedMove(slot: AuraSlot, name: AuraAnimationName, input?: AuraMoveInput): void {
    const changed = this.currentMoves[slot] !== name;
    const trail = this.trails[slot];
    if (changed || !this.moves[slot] || (input && trail?.phrase !== input.phrase)) {
      this.currentMoves[slot] = name;
      const anchor = this.anchors[slot];
      const object = this.scene.add.container(anchor.x, anchor.moveY);
      if (anchor.stageCard) {
        const surface = this.scene.add.graphics();
        surface.fillStyle(INK, 0.88).fillRoundedRect(-80, -84, 160, 218, 8);
        surface.lineStyle(1, CREAM, 0.35).strokeRoundedRect(-80, -84, 160, 218, 8);
        object.add(surface);
      }
      const icon = this.scene.add.graphics().setPosition(0, -18);
      drawAuraComicIcon(icon, name);
      object.add([this.text(0, -72, 'MOVE', 10), icon]);
      if (name === 'aura_six_seven') object.add(this.text(0, -25, '67', 28, '#ffce3a'));
      object.add(this.text(0, 34, AURA_DOCKED_MOVE_NAMES[name], 13, '#ffce3a'));
      object.add(this.text(0, 77, 'LAST HITS', 9));
      const keys = this.scene.add.graphics();
      const labels = [-51, -17, 17, 51].map(x => {
        keys.lineStyle(1, CREAM, 0.35).strokeRoundedRect(x - 14, 95, 28, 30, 3);
        return this.text(x, 110, '·', 14);
      });
      const pads = this.scene.add.graphics();
      object.add([keys, pads, ...labels]);
      this.present(this.moves, slot, object, 1_800, 0);
      this.trails[slot] = { phrase: input?.phrase ?? '', inputs: [], labels, pads };
      if (changed) this.onMove?.(name);
    }
    if (!input) return;
    const current = this.trails[slot]!;
    current.inputs = [...current.inputs, input].slice(-4);
    current.pads.clear();
    current.labels.forEach((label, index) => {
      const hit = current.inputs[index];
      // Touch history repeats the actual coloured pads without keyboard letters.
      if (hit && hit.key === '') {
        current.pads.fillStyle(hit.tone, 1).fillRoundedRect(-63 + index * 34, 102, 24, 16, 2);
      }
      label.setText(hit?.key ?? '·').setColor(hit ? `#${hit.tone.toString(16).padStart(6, '0')}` : '#fff4d6');
    });
    // A sustained phrase keeps one readable card. Each hit updates the history
    // without another pop-up, sound or entrance tween.
    const bubble = this.moves[slot]!;
    bubble.timer.remove(false);
    this.scene.tweens.killTweensOf(bubble.object);
    bubble.object.setAlpha(1);
    bubble.timer = this.scene.time.delayedCall(1_800, () => {
      if (this.moves[slot] === bubble) this.clear(this.moves, slot);
    });
  }

  /** First miss is already explained by judgement UI. Call out a run of two,
   * then every fourth additional failure, never every bad keypress. */
  judgement(slot: AuraSlot, failed: boolean): void {
    if (!this.visible[slot]) return;
    if (!failed) { this.failures[slot] = 0; return; }
    if (this.anchors[slot].docked) {
      this.clear(this.moves, slot);
      this.trails[slot] = null;
    }
    const count = ++this.failures[slot];
    if (count === 2 || (count > 2 && (count - 2) % 4 === 0)) {
      this.streak(slot, 'AURA LEAK', false);
    }
  }

  milestone(slot: AuraSlot, combo: number): void {
    if (!this.visible[slot]) return;
    this.streak(slot, this.anchors[slot].docked ? `${combo}x\nLOCKED IN` : `${combo}x  LOCKED IN`, true);
  }

  private streak(slot: AuraSlot, label: string, positive: boolean): void {
    const anchor = this.anchors[slot];
    const object = this.scene.add.container(anchor.x, anchor.streakY);
    const g = this.scene.add.graphics();
    if (anchor.stageCard) {
      g.fillStyle(INK, 0.88).fillRoundedRect(-80, -25, 160, 50, 8);
      g.lineStyle(1, positive ? HEAT : CREAM, 0.35).strokeRoundedRect(-80, -25, 160, 50, 8);
    }
    // Arrow direction encodes success/failure without relying on red vs white.
    const arrowX = anchor.docked ? -66 : -87, sign = positive ? -1 : 1;
    for (const [width, color] of [[6, INK], [2, positive ? HEAT : CREAM]]) {
      g.lineStyle(width, color, 1);
      g.lineBetween(arrowX, -5 * sign, arrowX, 5 * sign);
      g.lineBetween(arrowX, 5 * sign, arrowX - 4, sign);
      g.lineBetween(arrowX, 5 * sign, arrowX + 4, sign);
    }
    object.add([g, this.text(8, 0, label, anchor.docked ? 10 : 11, positive ? '#ffce3a' : '#fff4d6')]);
    this.present(this.streaks, slot, object, 1_300, anchor.streakRise ?? AURA_COMIC_LAYOUT.streakRise);
  }

  private text(x: number, y: number, value: string, size: number, color = '#fff4d6'): Phaser.GameObjects.Text {
    return this.scene.add.text(x, y, value, {
      fontFamily: PIXEL_FONT, fontSize: `${size}px`, color, align: 'center', lineSpacing: 5,
      stroke: '#050507', strokeThickness: size >= 15 ? 5 : 3,
    }).setOrigin(0.5);
  }

  private present(slots: [Bubble | null, Bubble | null], slot: AuraSlot, object: Phaser.GameObjects.Container, duration: number, rise: number): void {
    this.clear(slots, slot);
    object.setScale(this.anchors[slot].scale ?? 1);
    this.layer.add(object);
    const release = () => { if (slots[slot]?.object === object) this.clear(slots, slot); };
    slots[slot] = { object, timer: this.scene.time.delayedCall(duration, release) };
    if (this.reduceMotion) return; // Same legible information, no positional movement.
    // Start readable, rise throughout the lifetime, and dissolve near the end,
    // like the Aura score delta. No static hold followed by a last-second hop.
    this.scene.tweens.add({ targets: object, y: object.y - rise, duration, ease: 'Linear' });
    this.scene.tweens.add({ targets: object, alpha: 0, delay: duration - 420, duration: 420, ease: 'Quad.easeIn' });
  }

  private clear(slots: [Bubble | null, Bubble | null], slot: AuraSlot): void {
    const bubble = slots[slot];
    if (!bubble) return;
    bubble.timer.remove(false);
    this.scene.tweens.killTweensOf(bubble.object);
    bubble.object.destroy();
    slots[slot] = null;
  }

  private resetSlot(slot: AuraSlot): void {
    this.clear(this.moves, slot);
    this.clear(this.streaks, slot);
    this.currentMoves[slot] = null;
    this.trails[slot] = null;
    this.failures[slot] = 0;
  }

  destroy(): void { this.beginTurn(); }
}
