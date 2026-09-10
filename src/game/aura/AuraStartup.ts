/** Presentation time only. The song, chart and recorded judgements still start at zero. */
export const AURA_STARTUP_EVENT = 'asf:aura-startup';
export const AURA_STARTUP_READY_EVENT = 'asf:aura-startup-ready';
export const AURA_VERSUS_MS = 1_500;
export const AURA_STARTUP_COUNTDOWN_MS = 3_000;

export interface AuraStartupDetail {
  token: number;
  seed: number;
  phase: 'awaiting-input' | 'preparing' | 'versus' | 'countdown' | 'playing';
  remainingMs: number;
  count: number | null;
}

export function isAuraStartupDetail(value: unknown): value is AuraStartupDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<AuraStartupDetail>;
  return Number.isSafeInteger(detail.token) && detail.token! > 0
    && Number.isInteger(detail.seed) && detail.seed! >= 0 && detail.seed! <= 0xffff_ffff
    && ['awaiting-input', 'preparing', 'versus', 'countdown', 'playing'].includes(detail.phase ?? '')
    && Number.isFinite(detail.remainingMs) && detail.remainingMs! >= 0
    && (detail.count === null || (Number.isInteger(detail.count) && detail.count! >= 1 && detail.count! <= 3));
}

/** Offline delays count rendered time, so a blocked frame cannot eat the ready
 * sequence. Online countdown is driven by the already agreed network deadline. */
export class AuraStartup {
  private phase: AuraStartupDetail['phase'] = 'preparing';
  private remainingMs = 0;
  private presentedVersus = false;

  constructor(private readonly online = false) {}

  get readyForOnline(): boolean { return this.online && this.presentedVersus && this.phase === 'preparing'; }

  get snapshot(): Pick<AuraStartupDetail, 'phase' | 'remainingMs' | 'count'> {
    return { phase: this.phase, remainingMs: this.remainingMs,
      count: this.phase === 'countdown' ? Math.max(1, Math.min(3, Math.ceil(this.remainingMs / 1_000))) : null };
  }

  begin(): void {
    if (this.phase !== 'preparing' || this.presentedVersus) return;
    this.phase = 'versus';
    this.remainingMs = AURA_VERSUS_MS;
  }

  countdown(remainingMs = AURA_STARTUP_COUNTDOWN_MS): void {
    this.phase = 'countdown';
    this.remainingMs = Math.max(0, remainingMs);
  }

  play(): void { this.phase = 'playing'; this.remainingMs = 0; }

  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0 || this.phase === 'preparing' || this.phase === 'playing') return;
    if (this.online && this.phase === 'countdown') return;
    this.remainingMs = Math.max(0, this.remainingMs - Math.min(deltaMs, 100));
    if (this.remainingMs > 0) return;
    if (this.phase === 'versus') {
      this.presentedVersus = true;
      if (this.online) this.phase = 'preparing';
      else this.countdown();
    } else this.play();
  }
}

interface RenderEvents {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** Resolves only after actual renderer submissions, not timers or update calls. */
export function waitForAuraRenderedFrames(events: RenderEvents, signal: AbortSignal, frames = 2): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let remaining = Math.max(1, frames);
    const finish = (ready: boolean) => {
      events.off('postrender', rendered);
      signal.removeEventListener('abort', aborted);
      resolve(ready);
    };
    const rendered = () => { if (--remaining === 0) finish(true); };
    const aborted = () => finish(false);
    events.on('postrender', rendered);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

declare global {
  interface WindowEventMap {
    [AURA_STARTUP_EVENT]: CustomEvent<AuraStartupDetail>;
    [AURA_STARTUP_READY_EVENT]: CustomEvent<{ token: number; seed: number }>;
  }
}
