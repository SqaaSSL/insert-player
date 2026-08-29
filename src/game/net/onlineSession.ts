import type { PeerTransport } from './PeerTransport.ts';
import type { RoomSeat } from './RoomProtocol.ts';

/**
 * The live online session handed from the React lobby to the Phaser fight
 * scene — same pattern as `launchState.ts`: a module-level singleton, set
 * right before navigating to `/fight`, cleared when the match ends.
 */
export interface OnlineMatchSession {
  transport: PeerTransport;
  roomCode: string;
  seat: RoomSeat;
  /** Fighter slot the local player controls: host = 0 (P1), guest = 1 (P2). */
  localSlot: 0 | 1;
  inputDelay: number;
  /** Cloud fighter ids agreed in the lobby, by slot (null = procedural). */
  fighterIds: [string | null, string | null];
}

let active: OnlineMatchSession | null = null;

export function setActiveOnlineSession(session: OnlineMatchSession | null): void {
  active = session;
}

export function getActiveOnlineSession(): OnlineMatchSession | null {
  return active;
}

/** Close the transport and forget the session (idempotent). */
export function endActiveOnlineSession(): void {
  const session = active;
  active = null;
  session?.transport.close();
}

export function seatToSlot(seat: RoomSeat): 0 | 1 {
  return seat === 'host' ? 0 : 1;
}

/** Control-channel messages exchanged during a match (JSON, reliable). */
export type OnlineControlMessage =
  | { t: 'sync'; tick: number; checksum: number }
  | { t: 'quit' };

export function isOnlineControlMessage(value: unknown): value is OnlineControlMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.t === 'sync') {
    return typeof message.tick === 'number' && typeof message.checksum === 'number';
  }
  return message.t === 'quit';
}
