declare module 'gifenc' {
  interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number; first?: boolean },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
  }

  export function GIFEncoder(): GIFEncoderInstance;
  export function quantize(data: Uint8ClampedArray, maxColors: number, opts?: Record<string, unknown>): number[][];
  export function applyPalette(data: Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}
