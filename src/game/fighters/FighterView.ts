import Phaser from 'phaser';
import { ATTACKS, FighterState } from '../constants.ts';
import {
  composeSpritePresentation,
  getFacingSpriteOriginX,
  getSpriteLayout,
  getSpritePresentationProfile,
  type ComposedSpritePresentation,
  type SpriteSheetLayout,
} from '../sprites/SpriteGenerator.ts';
import { getActionAnimationFrame } from '../sprites/AnimationFrameMapping.ts';
import type { Fighter } from './Fighter.ts';

interface VisibleFrameBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const VISIBLE_ALPHA_THRESHOLD = 32;
const visibleFrameBoundsCache = new WeakMap<Phaser.Textures.Frame, VisibleFrameBounds | null>();
let frameMeasurementCanvas: HTMLCanvasElement | null = null;

function measureVisibleFrameBounds(frame: Phaser.Textures.Frame): VisibleFrameBounds | null {
  if (visibleFrameBoundsCache.has(frame)) {
    return visibleFrameBoundsCache.get(frame) ?? null;
  }

  let bounds: VisibleFrameBounds | null = null;
  if (typeof document !== 'undefined') {
    try {
      const width = Math.max(1, Math.round(frame.cutWidth));
      const height = Math.max(1, Math.round(frame.cutHeight));
      frameMeasurementCanvas ??= document.createElement('canvas');
      if (frameMeasurementCanvas.width !== width) frameMeasurementCanvas.width = width;
      if (frameMeasurementCanvas.height !== height) frameMeasurementCanvas.height = height;
      const context = frameMeasurementCanvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.clearRect(0, 0, width, height);
        context.drawImage(
          frame.source.image as CanvasImageSource,
          frame.cutX,
          frame.cutY,
          width,
          height,
          0,
          0,
          width,
          height,
        );
        const pixels = context.getImageData(0, 0, width, height).data;
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (pixels[(y * width + x) * 4 + 3] < VISIBLE_ALPHA_THRESHOLD) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
        if (maxX >= minX && maxY >= minY) {
          bounds = {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
          };
        }
      }
    } catch {
      frameMeasurementCanvas = null;
      // Cross-origin or non-canvas texture sources fall back to frame geometry.
    }
  }

  visibleFrameBoundsCache.set(frame, bounds);
  return bounds;
}

/**
 * Phaser presentation of a `Fighter`. Reads simulation state, never writes
 * it: the sim must stay identical on every machine, while stage scale,
 * texture density, and sprite layouts are free to differ per device.
 */
export class FighterView {
  readonly fighter: Fighter;
  private readonly spriteKey: string;
  private layout: SpriteSheetLayout;
  private renderScale = 1;
  private renderYOffset = 0;
  private shadowOffsetX = 8;
  private shadowOffsetY = 8;
  private shadowAlpha = 0.16;

  sprite!: Phaser.GameObjects.Sprite;
  shadowSprite?: Phaser.GameObjects.Sprite;

  constructor(fighter: Fighter, spriteKey: string) {
    this.fighter = fighter;
    this.spriteKey = spriteKey;
    this.layout = getSpriteLayout(spriteKey);
  }

  createSprite(scene: Phaser.Scene): void {
    const presentation = this.getComposedSpritePresentation();
    const flipped = !this.fighter.facingRight;
    this.shadowSprite = scene.add.sprite(this.fighter.x, presentation.y, this.spriteKey, 0);
    this.shadowSprite
      .setOrigin(presentation.originX, presentation.originY)
      .setFlipX(flipped)
      .setScale(presentation.scale * 1.015)
      .setTint(0x000000)
      .setAlpha(this.shadowAlpha)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.sprite = scene.add.sprite(this.fighter.x, presentation.y, this.spriteKey, 0);
    this.sprite
      .setOrigin(presentation.originX, presentation.originY)
      .setFlipX(flipped)
      .setScale(presentation.scale);
  }

  setRenderPresentation(scale: number, yOffset = 0): void {
    this.renderScale = scale;
    this.renderYOffset = yOffset;
    this.shadowOffsetX = Math.max(7, Math.round(8 * scale));
    this.shadowOffsetY = Math.max(7, Math.round(9 * scale));
    this.shadowAlpha = scale > 1 ? 0.18 : 0.14;
    const presentation = this.getComposedSpritePresentation();
    const flipped = !this.fighter.facingRight;
    if (this.shadowSprite) {
      this.shadowSprite
        .setOrigin(presentation.originX, presentation.originY)
        .setFlipX(flipped)
        .setScale(presentation.scale * 1.015)
        .setAlpha(this.shadowAlpha)
        .setPosition(
          this.fighter.x + this.shadowOffsetX,
          presentation.y + this.shadowOffsetY,
        );
    }
    if (this.sprite) {
      this.sprite
        .setOrigin(presentation.originX, presentation.originY)
        .setFlipX(flipped)
        .setScale(presentation.scale)
        .setY(presentation.y);
    }
  }

  /** Screen-space floor position (sim y plus the stage presentation offset). */
  getRenderY(): number {
    return this.fighter.y + this.renderYOffset;
  }

  getRenderYOffset(): number {
    return this.renderYOffset;
  }

  /** Top-center of the opaque pixels in the current rendered frame. */
  getVisibleTopCenter(): { x: number; y: number } {
    const frame = this.sprite.frame;
    const visibleBounds = measureVisibleFrameBounds(frame);
    if (!visibleBounds) {
      const frameTop = this.sprite.getTopCenter();
      return { x: frameTop.x, y: frameTop.y };
    }

    const frameWidth = frame.cutWidth;
    const frameHeight = frame.cutHeight;
    const sourceCenterX = visibleBounds.x + visibleBounds.width / 2;
    const renderedCenterX = this.sprite.flipX
      ? frameWidth - sourceCenterX
      : sourceCenterX;
    return {
      x: this.sprite.x + (renderedCenterX - this.sprite.originX * frameWidth) * this.sprite.scaleX,
      y: this.sprite.y + (visibleBounds.y - this.sprite.originY * frameHeight) * this.sprite.scaleY,
    };
  }

  syncSprite(opponentX: number): void {
    if (!this.sprite) return;
    const fighter = this.fighter;
    const spriteDepth = fighter.x < opponentX ? 10 : 11;
    const presentation = this.getComposedSpritePresentation();
    if (this.shadowSprite) {
      this.shadowSprite.setPosition(
        fighter.x + this.shadowOffsetX,
        presentation.y + this.shadowOffsetY,
      );
      this.shadowSprite.setOrigin(presentation.originX, presentation.originY);
      this.shadowSprite.setFlipX(!fighter.facingRight);
      this.shadowSprite.setScale(presentation.scale * 1.015);
      this.shadowSprite.setDepth(spriteDepth - 0.5);
    }
    this.sprite.setPosition(fighter.x, presentation.y);
    this.sprite.setOrigin(presentation.originX, presentation.originY);
    this.sprite.setFlipX(!fighter.facingRight);
    this.sprite.setScale(presentation.scale);
    this.sprite.setDepth(spriteDepth);

    const frameIndex = this.getFrameIndex();
    this.shadowSprite?.setFrame(frameIndex);
    this.sprite.setFrame(frameIndex);
  }

  destroy(): void {
    this.sprite?.destroy();
    this.shadowSprite?.destroy();
  }

  private getComposedSpritePresentation(): ComposedSpritePresentation {
    const fighter = this.fighter;
    const presentationState = fighter.state === FighterState.BLOCK && fighter.crouchBlocking
      ? FighterState.CROUCH
      : fighter.state;
    const presentation = composeSpritePresentation(
      getSpritePresentationProfile(this.layout, presentationState),
      this.renderScale,
      fighter.y,
      this.renderYOffset,
      this.layout.textureDensity,
    );
    presentation.originX = getFacingSpriteOriginX(
      presentation.originX,
      !fighter.facingRight,
    );
    return presentation;
  }

  private getFrameIndex(): number {
    const { state, stateFrame } = this.fighter;
    const row = this.layout.stateRow[state] ?? 0;
    const maxFrames = this.layout.frameCounts[state] ?? 1;
    const cols = this.layout.totalColumns;

    let animFrame: number;
    if (
      state === FighterState.IDLE ||
      state === FighterState.WALK_FORWARD
    ) {
      const cycleTicks = this.layout.durationTicks[state];
      if (cycleTicks) {
        animFrame = Math.min(
          Math.floor(((stateFrame % cycleTicks) / cycleTicks) * maxFrames),
          maxFrames - 1,
        );
      } else {
        const animSpeed = state === FighterState.IDLE ? 10 : 6;
        animFrame = Math.floor(stateFrame / animSpeed) % maxFrames;
      }
    } else if (state === FighterState.WALK_BACKWARD) {
      const cycleTicks = this.layout.durationTicks[state];
      const forwardFrame = cycleTicks
        ? Math.min(
          Math.floor(((stateFrame % cycleTicks) / cycleTicks) * maxFrames),
          maxFrames - 1,
        )
        : Math.floor(stateFrame / 6) % maxFrames;
      animFrame = (maxFrames - 1) - forwardFrame;
    } else if (
      state === FighterState.VICTORY ||
      state === FighterState.DEFEAT
    ) {
      const durationTicks = this.layout.durationTicks[state];
      animFrame = durationTicks
        ? getActionAnimationFrame({
          stateFrame,
          frameCount: maxFrames,
          totalDuration: durationTicks,
          playbackMode: 'timeline',
        })
        : Math.min(Math.floor(stateFrame / 15), maxFrames - 1);
    } else {
      const totalDuration = this.layout.durationTicks[state] ?? this.getStateDuration();
      animFrame = getActionAnimationFrame({
        stateFrame,
        frameCount: maxFrames,
        totalDuration,
        playbackMode: this.layout.playbackModes[state] ?? 'timeline',
        attack: ATTACKS[state],
      });
    }

    return row * cols + animFrame;
  }

  private getStateDuration(): number {
    const state = this.fighter.state;
    if (state === FighterState.FIREBALL) return 32;
    if (state === FighterState.UPPERCUT) return 37;
    const atk = ATTACKS[state];
    if (atk) {
      return atk.startup + atk.active + atk.recovery;
    }
    switch (state) {
      case FighterState.JUMP:       return 30;
      case FighterState.CROUCH:     return 8;
      case FighterState.BLOCK:      return 12;
      case FighterState.HIT_STUN:   return 14;
      case FighterState.KNOCKDOWN:  return 40;
      default:                      return 16;
    }
  }
}
