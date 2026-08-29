/**
 * FNV-1a over the raw IEEE-754 bytes of every number fed in. Two machines
 * that agree on the digest agree bit-for-bit on the simulation state, which
 * is the desync check netplay runs every N ticks.
 */
export class StateHasher {
  private hash = 0x811c9dc5;
  private readonly scratch = new DataView(new ArrayBuffer(8));

  num(value: number): void {
    this.scratch.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) {
      this.hash ^= this.scratch.getUint8(i);
      this.hash = Math.imul(this.hash, 0x01000193);
    }
  }

  digest(): number {
    return this.hash >>> 0;
  }
}
