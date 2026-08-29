import type { FighterInput } from '../sim/FighterInput.ts';

export type MotionType = 'qcf' | 'dp';

const enum Dir {
  NEUTRAL = 0,
  FORWARD = 1,
  BACK = 2,
  DOWN = 4,
  UP = 8,
  DOWN_FORWARD = DOWN | FORWARD,   // 5
  DOWN_BACK = DOWN | BACK,         // 6
}

const BUFFER_SIZE = 40;
const QCF_WINDOW = 20;
const DP_WINDOW = 24;

export interface MotionInputsSnapshot {
  buffer: number[];
  lastConsumedIndex: number;
}

export class MotionInputs {
  private buffer: Dir[] = [];
  private lastConsumedIndex = -1;

  snapshot(): MotionInputsSnapshot {
    return { buffer: this.buffer.slice(), lastConsumedIndex: this.lastConsumedIndex };
  }

  restore(snap: MotionInputsSnapshot): void {
    this.buffer = snap.buffer.slice() as Dir[];
    this.lastConsumedIndex = snap.lastConsumedIndex;
  }

  /** Deterministic digest input for desync checks. */
  hashInto(hasher: { num(value: number): void }): void {
    hasher.num(this.buffer.length);
    for (const dir of this.buffer) hasher.num(dir);
    hasher.num(this.lastConsumedIndex);
  }

  feedInput(input: FighterInput, facingRight: boolean): void {
    const forward = facingRight ? input.right : input.left;
    const back = facingRight ? input.left : input.right;

    let dir: Dir = Dir.NEUTRAL;
    if (forward) dir |= Dir.FORWARD;
    if (back) dir |= Dir.BACK;
    if (input.down) dir |= Dir.DOWN;
    if (input.up) dir |= Dir.UP;

    this.buffer.push(dir as Dir);
    if (this.buffer.length > BUFFER_SIZE) {
      this.buffer.shift();
      if (this.lastConsumedIndex >= 0) this.lastConsumedIndex--;
    }
  }

  checkMotion(): MotionType | null {
    const dp = this.detectDP();
    if (dp) return dp;

    const qcf = this.detectQCF();
    if (qcf) return qcf;

    return null;
  }

  /**
   * Accepts both classic QCF (↓ ↘ →) and simplified (↓ then →).
   * The simplified form just needs down at some point followed by forward.
   */
  private detectQCF(): MotionType | null {
    const buf = this.buffer;
    const len = buf.length;
    if (len < 2) return null;

    const windowStart = Math.max(0, len - QCF_WINDOW, this.lastConsumedIndex + 1);

    for (let i = windowStart; i < len - 1; i++) {
      if (!this.hasDir(buf[i], Dir.DOWN)) continue;

      for (let j = i + 1; j < Math.min(i + QCF_WINDOW, len); j++) {
        if (this.hasDir(buf[j], Dir.FORWARD) && !(buf[j] & Dir.DOWN)) {
          this.lastConsumedIndex = j;
          return 'qcf';
        }
        if (this.hasDir(buf[j], Dir.DOWN_FORWARD)) {
          for (let k = j + 1; k < Math.min(i + QCF_WINDOW, len); k++) {
            if (this.hasDir(buf[k], Dir.FORWARD) && !(buf[k] & Dir.DOWN)) {
              this.lastConsumedIndex = k;
              return 'qcf';
            }
          }
        }
      }
    }
    return null;
  }

  /**
   * Accepts both classic DP (→ ↓ ↘) and simplified (→ then ↓).
   */
  private detectDP(): MotionType | null {
    const buf = this.buffer;
    const len = buf.length;
    if (len < 2) return null;

    const windowStart = Math.max(0, len - DP_WINDOW, this.lastConsumedIndex + 1);

    for (let i = windowStart; i < len - 1; i++) {
      if (!this.hasDir(buf[i], Dir.FORWARD) || (buf[i] & Dir.DOWN)) continue;

      for (let j = i + 1; j < Math.min(i + DP_WINDOW, len); j++) {
        if (this.hasDir(buf[j], Dir.DOWN_FORWARD)) {
          this.lastConsumedIndex = j;
          return 'dp';
        }
        if (this.hasDir(buf[j], Dir.DOWN)) {
          this.lastConsumedIndex = j;
          return 'dp';
        }
      }
    }
    return null;
  }

  private hasDir(value: Dir, check: Dir): boolean {
    return (value & check) === check;
  }

  reset(): void {
    this.buffer = [];
    this.lastConsumedIndex = -1;
  }
}
