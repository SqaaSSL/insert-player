import { INPUT_BITS, INPUT_MASK, packInput, unpackInput, type FighterInput } from '../sim/FighterInput.ts';

/**
 * Wire format for input frames. One packet carries the sender's last few
 * tick words (redundancy), so a lost datagram on the unreliable channel is
 * covered by the next one — no acks, no retransmit timers.
 *
 *   u8  version
 *   u32 firstTick (little-endian)
 *   u8  count
 *   u16 × count — tick words, oldest first (10 input bits + flag bits)
 */
export const INPUT_PACKET_VERSION = 1;
export const MAX_PACKET_WORDS = 32;

/** Tick-word flag above the ten input bits: this player asked to skip the intro. */
export const SKIP_INTRO_BIT = 1 << INPUT_BITS;
export const TICK_WORD_MASK = 0xffff;

export interface InputPacket {
  firstTick: number;
  words: number[];
}

export function tickWord(input: FighterInput, skipIntro = false): number {
  return (packInput(input) | (skipIntro ? SKIP_INTRO_BIT : 0)) & TICK_WORD_MASK;
}

export function tickWordInput(word: number): FighterInput {
  return unpackInput(word & INPUT_MASK);
}

export function tickWordSkipsIntro(word: number): boolean {
  return (word & SKIP_INTRO_BIT) !== 0;
}

export function encodeInputPacket(packet: InputPacket): Uint8Array {
  const count = Math.min(packet.words.length, MAX_PACKET_WORDS);
  const bytes = new Uint8Array(1 + 4 + 1 + count * 2);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, INPUT_PACKET_VERSION);
  const start = packet.words.length - count;
  view.setUint32(1, (packet.firstTick + start) >>> 0, true);
  view.setUint8(5, count);
  for (let i = 0; i < count; i++) {
    view.setUint16(6 + i * 2, packet.words[start + i] & TICK_WORD_MASK, true);
  }
  return bytes;
}

export function decodeInputPacket(bytes: Uint8Array): InputPacket | null {
  if (bytes.byteLength < 6) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== INPUT_PACKET_VERSION) return null;
  const count = view.getUint8(5);
  if (count > MAX_PACKET_WORDS || bytes.byteLength < 6 + count * 2) return null;
  const words: number[] = [];
  for (let i = 0; i < count; i++) words.push(view.getUint16(6 + i * 2, true));
  return { firstTick: view.getUint32(1, true), words };
}
