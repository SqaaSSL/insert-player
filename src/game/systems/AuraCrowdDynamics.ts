export type AuraCrowdLayerId = 'room-a' | 'room-b' | 'hype' | 'negative';

export interface AuraCrowdFrame {
  heat: number;
  gains: Record<AuraCrowdLayerId, number>;
  startCheer: boolean;
  startBoo: boolean;
  cheerActive: boolean;
  booActive: boolean;
}

const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const CHEER_MS = 2_200;
const BOO_MS = 1_000;
const envelope = (remaining: number, duration: number, attack: number, release: number) =>
  Math.max(0, Math.min(1, (duration - remaining) / attack, remaining / release));

/** An audience earns its peaks. A steady hot room is not a permanent cheer. */
export class AuraCrowdDynamics {
  private heat = 0;
  private targetHeat = 0;
  private pendingNegative = 0;
  private cheerArmed = true;
  private highMs = 0;
  private lowMs = 0;
  private cheerCooldownMs = 0;
  private booCooldownMs = 0;
  private cheerRemainingMs = 0;
  private booRemainingMs = 0;
  private cheerReleaseScale = 1;
  private booReleaseScale = 1;
  private cheerPeak = 0.055;
  private victory = false;
  private pendingVictory = false;

  setMix(heat: number, _roundProgress = 0, negativePunch = 0): void {
    if (this.victory) return;
    this.targetHeat = unit(heat);
    this.pendingNegative = Math.max(this.pendingNegative, unit(negativePunch));
  }

  peak(): void {
    if (this.victory) return;
    this.victory = true;
    this.pendingVictory = true;
    this.pendingNegative = 0;
    this.targetHeat = 0;
  }

  reset(): void {
    this.heat = 0;
    this.targetHeat = 0;
    this.pendingNegative = 0;
    this.cheerArmed = true;
    this.highMs = this.lowMs = 0;
    this.cheerCooldownMs = this.booCooldownMs = 0;
    this.cheerRemainingMs = this.booRemainingMs = 0;
    this.cheerReleaseScale = this.booReleaseScale = 1;
    this.cheerPeak = 0.055;
    this.victory = this.pendingVictory = false;
  }

  update(deltaMs: number): AuraCrowdFrame {
    const elapsed = Number.isFinite(deltaMs) ? Math.max(0, Math.min(100, deltaMs)) : 0;
    let startCheer = false;
    let startBoo = false;
    if (elapsed > 0) {
      const previousCheer = this.cheerEnvelope();
      const previousBoo = this.booEnvelope();
      this.cheerCooldownMs = Math.max(0, this.cheerCooldownMs - elapsed);
      this.booCooldownMs = Math.max(0, this.booCooldownMs - elapsed);
      this.cheerRemainingMs = Math.max(0, this.cheerRemainingMs - elapsed);
      this.booRemainingMs = Math.max(0, this.booRemainingMs - elapsed);
      const timeConstant = this.targetHeat > this.heat ? 5_000 : 1_700;
      this.heat += (this.targetHeat - this.heat) * (1 - Math.exp(-elapsed / timeConstant));
      this.highMs = this.heat >= 0.78 && this.targetHeat >= 0.8 ? this.highMs + elapsed : 0;
      this.lowMs = this.heat < 0.45 ? this.lowMs + elapsed : 0;
      if (this.lowMs >= 2_000) this.cheerArmed = true;

      if (this.pendingNegative >= 0.45 && this.booCooldownMs === 0 && !this.victory) {
        startBoo = true;
        this.booRemainingMs = BOO_MS;
        this.booReleaseScale = 1;
        this.booCooldownMs = 10_000;
        // Finish the existing cheer through its release, never hard-cut it.
        this.cheerRemainingMs = Math.min(this.cheerRemainingMs, 600);
        if (this.cheerRemainingMs > 0) {
          this.cheerReleaseScale = Math.min(this.cheerReleaseScale,
            previousCheer * 600 / this.cheerRemainingMs);
        }
      }
      this.pendingNegative = 0;

      if (this.pendingVictory) {
        // Do not rewind a cheer that is already playing at the final reveal.
        startCheer = this.cheerRemainingMs === 0;
        if (startCheer) {
          this.cheerRemainingMs = CHEER_MS;
          this.cheerPeak = 0.07;
          this.cheerReleaseScale = 1;
        }
        this.booRemainingMs = Math.min(this.booRemainingMs, 400);
        if (this.booRemainingMs > 0) {
          this.booReleaseScale = Math.min(this.booReleaseScale,
            previousBoo * 400 / this.booRemainingMs);
        }
        this.pendingVictory = false;
      } else if (!this.victory && this.cheerArmed && this.highMs >= 1_600
        && this.cheerCooldownMs === 0 && this.booRemainingMs === 0) {
        startCheer = true;
        this.cheerRemainingMs = CHEER_MS;
        this.cheerPeak = 0.055;
        this.cheerReleaseScale = 1;
        this.cheerCooldownMs = 18_000;
        this.cheerArmed = false;
        this.lowMs = 0;
      }
    }

    const bed = Math.pow(unit((this.heat - 0.18) / 0.82), 1.6) * 0.034;
    return {
      heat: this.heat,
      gains: {
        'room-a': bed * 0.65,
        'room-b': bed * 0.35,
        hype: this.cheerPeak * this.cheerEnvelope(),
        negative: 0.025 * this.booEnvelope(),
      },
      startCheer,
      startBoo,
      cheerActive: this.cheerRemainingMs > 0,
      booActive: this.booRemainingMs > 0,
    };
  }

  private cheerEnvelope(): number {
    // Interrupt an attack at its current level, not at a full-volume release.
    return Math.min(envelope(this.cheerRemainingMs, CHEER_MS, 220, 600),
      this.cheerReleaseScale * this.cheerRemainingMs / 600);
  }

  private booEnvelope(): number {
    return Math.min(envelope(this.booRemainingMs, BOO_MS, 120, 400),
      this.booReleaseScale * this.booRemainingMs / 400);
  }
}
