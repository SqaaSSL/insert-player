import type { FighterInput } from './InputManager.ts';

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

export class MotionInputs {
  private buffer: Dir[] = [];
  private lastConsumedIndex = -1;

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
