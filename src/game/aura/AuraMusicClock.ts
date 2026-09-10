import type { MusicClockSample } from '../systems/SoundManager.ts';

/** Audio is authoritative, including long stalls and late autoplay unlocks.
 * Monotonic output prevents already-judged notes from being replayed after a
 * backwards seek. Wall time is used only when audio is absent/unrecoverable. */
export class AuraMusicClock {
  private elapsedMs = 0;
  private previousWallMs = 0;
  private previousPositionMs: number | null = null;
  private loopOffsetMs = 0;

  reset(): void {
    this.elapsedMs = 0;
    this.previousWallMs = 0;
    this.previousPositionMs = null;
    this.loopOffsetMs = 0;
  }

  get timeMs(): number { return this.elapsedMs; }

  update(wallElapsedMs: number, sample: MusicClockSample): number {
    if (!Number.isFinite(wallElapsedMs) || wallElapsedMs < 0) return this.elapsedMs;
    const wallDelta = Math.max(0, wallElapsedMs - this.previousWallMs);
    this.previousWallMs = wallElapsedMs;
    if (sample.status === 'unavailable') {
      this.elapsedMs += wallDelta;
      return this.elapsedMs;
    }
    if (sample.status !== 'playing' || !Number.isFinite(sample.positionMs) || sample.positionMs < 0) {
      return this.elapsedMs;
    }
    const { positionMs, durationMs, loop } = sample;
    if (this.previousPositionMs !== null && positionMs < this.previousPositionMs) {
      // Only a crossing from the last quarter to the first quarter of a
      // known looping track is a wrap. An arbitrary rewind is not a new lap.
      if (loop && durationMs !== null && Number.isFinite(durationMs) && durationMs > 0
        && this.previousPositionMs >= durationMs * 0.75 && this.previousPositionMs <= durationMs
        && positionMs <= durationMs * 0.25) {
        this.loopOffsetMs += durationMs;
      } else {
        return this.elapsedMs;
      }
    }
    this.previousPositionMs = positionMs;
    this.elapsedMs = Math.max(this.elapsedMs, this.loopOffsetMs + positionMs);
    return this.elapsedMs;
  }
}
