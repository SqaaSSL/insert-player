/** Same-page React/Phaser handoff, never a gameplay or network message. */
export const AURA_PRESENTATION_EVENT = 'asf:aura-presentation';
export const AURA_PRESENTATION_START_EVENT = 'asf:aura-presentation-start';
export const AURA_PRESENTATION_TURN_EVENT = 'asf:aura-presentation-turn';

export interface AuraPresentationStartDetail {
  /** A fresh token for every init/restart, including rematches with one seed. */
  token: number;
  seed: number;
  /** Optional local first-play guide; never changes the match seed or chart. */
  onboarding?: boolean;
}

export interface AuraPresentationDetail extends AuraPresentationStartDetail {
  phase: 'loading' | 'ready' | 'error';
  /** Fixed human side for solo/online play; absent for local turn-based play. */
  localControlledSlot?: 0 | 1;
}

export interface AuraPresentationTurnDetail extends AuraPresentationStartDetail {
  playerIndex: 0 | 1;
}

let presentationToken = 0;
export function createAuraPresentationToken(): number {
  return ++presentationToken;
}

export function isAuraPresentationDetail(value: unknown): value is AuraPresentationDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<AuraPresentationDetail>;
  return Number.isSafeInteger(detail.token) && detail.token! > 0
    && Number.isInteger(detail.seed) && detail.seed! >= 0 && detail.seed! <= 0xffff_ffff
    && (detail.localControlledSlot === undefined || detail.localControlledSlot === 0 || detail.localControlledSlot === 1)
    && (detail.phase === 'loading' || detail.phase === 'ready' || detail.phase === 'error');
}

declare global {
  interface WindowEventMap {
    [AURA_PRESENTATION_EVENT]: CustomEvent<AuraPresentationDetail>;
    [AURA_PRESENTATION_START_EVENT]: CustomEvent<AuraPresentationStartDetail>;
    [AURA_PRESENTATION_TURN_EVENT]: CustomEvent<AuraPresentationTurnDetail>;
  }
}
