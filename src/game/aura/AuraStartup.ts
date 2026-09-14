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

export interface AuraMusicalLeadIn {
  firstNoteMs: number;
  beatMs: number;
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

/** Musical lead-ins follow the song. The legacy standalone ready sequence
 * counts rendered time; online countdown keeps its agreed network deadline. */
export class AuraStartup {
  private phase: AuraStartupDetail['phase'] = 'preparing';
  private remainingMs = 0;
  private presentedVersus = false;
  private readonly musicalLeadIn: AuraMusicalLeadIn | null;
  private lastMusicMs = 0;

  constructor(private readonly online = false, musicalLeadIn?: AuraMusicalLeadIn) {
    this.musicalLeadIn = !online && musicalLeadIn
      && Number.isFinite(musicalLeadIn.firstNoteMs) && Number.isFinite(musicalLeadIn.beatMs)
      && musicalLeadIn.beatMs > 0 && musicalLeadIn.firstNoteMs >= 3 * musicalLeadIn.beatMs
      ? { ...musicalLeadIn } : null;
  }

  get readyForOnline(): boolean { return this.online && this.presentedVersus && this.phase === 'preparing'; }

  get snapshot(): Pick<AuraStartupDetail, 'phase' | 'remainingMs' | 'count'> {
    return { phase: this.phase, remainingMs: this.remainingMs,
      count: this.phase === 'countdown'
        ? Math.max(1, Math.min(3, Math.ceil(this.remainingMs / (this.musicalLeadIn?.beatMs ?? 1_000)))) : null };
  }

  begin(): void {
    if (this.phase !== 'preparing' || this.presentedVersus) return;
    this.phase = 'versus';
    this.remainingMs = this.musicalLeadIn
      ? this.musicalLeadIn.firstNoteMs - 3 * this.musicalLeadIn.beatMs : AURA_VERSUS_MS;
  }

  countdown(remainingMs = AURA_STARTUP_COUNTDOWN_MS): void {
    this.phase = 'countdown';
    this.remainingMs = Math.max(0, remainingMs);
  }

  play(): void { this.phase = 'playing'; this.remainingMs = 0; }

  /** The offline intro shares the song's existing lead-in. No extra silent
   * countdown, chart offset or second playback is added before the first hit. */
  syncMusic(elapsedMs: number): void {
    const leadIn = this.musicalLeadIn;
    if (!leadIn || this.phase === 'preparing' || this.phase === 'playing'
      || !Number.isFinite(elapsedMs) || elapsedMs < this.lastMusicMs) return;
    this.lastMusicMs = elapsedMs;
    const countdownStartsMs = leadIn.firstNoteMs - 3 * leadIn.beatMs;
    if (elapsedMs < countdownStartsMs) {
      this.remainingMs = countdownStartsMs - elapsedMs;
      return;
    }
    this.presentedVersus = true;
    if (elapsedMs >= leadIn.firstNoteMs) this.play();
    else this.countdown(leadIn.firstNoteMs - elapsedMs);
  }

  advance(deltaMs: number): void {
    if (this.musicalLeadIn) return;
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
    [AURA_STARTUP_READY_EVENT]: CustomEvent<{ token: number; seed: number; practice?: boolean }>;
  }
}
