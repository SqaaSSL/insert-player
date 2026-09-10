export interface AuraVideoRecording {
  blob: Blob;
  /** Actual encoded container/codec MIME, not a requested filename extension. */
  mimeType: string;
  hasAudio: boolean;
}

export type AuraVideoRecorderStatus = 'idle' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'error' | 'destroyed';

export const AURA_VIDEO_MAX_BYTES = 120 * 1024 * 1024;
export const AURA_VIDEO_MAX_DURATION_MS = 5 * 60 * 1000;
const FINALIZE_TIMEOUT_MS = 5_000;

function containerType(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

/** Local canvas-only recording. Never requests a display, camera or microphone.
 * Canvas tracks are created here; supplied game-audio tracks are cloned here.
 * Only those owned tracks are stopped. Source audio is never stopped/mutated.
 */
export class AuraVideoRecorder {
  private recorder: MediaRecorder | null = null;
  private ownedTracks = new Set<MediaStreamTrack>();
  private chunks: Blob[] = [];
  private bytes = 0;
  private selectedMimeType = '';
  private capturedAudio = false;
  private completion: Promise<AuraVideoRecording | null> | null = null;
  private resolveCompletion: ((result: AuraVideoRecording | null) => void) | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private currentStatus: AuraVideoRecorderStatus = 'idle';
  private currentError: string | null = null;

  get status(): AuraVideoRecorderStatus { return this.currentStatus; }
  get error(): string | null { return this.currentError; }

  start(canvas: HTMLCanvasElement, audioTracks: MediaStreamTrack[] = [], hasAudio = false): { ok: boolean; reason?: string } {
    if (this.currentStatus === 'destroyed') return { ok: false, reason: 'recorder-destroyed' };
    if (this.recorder) return { ok: false, reason: 'recording-already-started' };
    this.currentError = null;
    this.completion = null;
    this.chunks = [];
    this.bytes = 0;
    this.capturedAudio = false;
    if (typeof MediaRecorder === 'undefined' || typeof MediaStream === 'undefined'
      || typeof MediaRecorder.isTypeSupported !== 'function' || typeof canvas?.captureStream !== 'function') {
      return this.startFailure('recording-unsupported');
    }
    const usableAudio = hasAudio ? audioTracks.filter(track => track.kind === 'audio' && track.readyState === 'live') : [];
    const codecSuffix = usableAudio.length ? ',opus' : '';
    const candidates = ['video/mp4', `video/webm;codecs=vp9${codecSuffix}`, `video/webm;codecs=vp8${codecSuffix}`, 'video/webm'];
    try {
      this.selectedMimeType = candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
      if (!this.selectedMimeType) return this.startFailure('recording-format-unsupported');
      const capture = canvas.captureStream(30);
      for (const track of capture.getTracks()) this.ownedTracks.add(track);
      const videoTracks = capture.getVideoTracks().filter(track => track.readyState === 'live');
      if (videoTracks.length === 0) return this.startFailure('canvas-video-unavailable');
      const audioClones: MediaStreamTrack[] = [];
      for (const source of usableAudio) {
        const clone = source.clone();
        // Defensive ownership check: a broken clone implementation must never
        // place a caller's original audio track in our cleanup set.
        if (audioTracks.includes(clone)) return this.startFailure('audio-clone-failed');
        this.ownedTracks.add(clone);
        if (clone.kind !== 'audio' || clone.readyState !== 'live') return this.startFailure('audio-clone-failed');
        audioClones.push(clone);
      }
      this.capturedAudio = audioClones.length > 0;
      const stream = new MediaStream([...videoTracks, ...audioClones]);
      const recorder = new MediaRecorder(stream, { mimeType: this.selectedMimeType, videoBitsPerSecond: 5_000_000 });
      this.recorder = recorder;
      this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
      recorder.ondataavailable = event => {
        if (this.recorder !== recorder || this.currentError || !event.data || event.data.size === 0) return;
        if (event.data.size > AURA_VIDEO_MAX_BYTES - this.bytes) {
          this.abort('recording-size-limit');
          return;
        }
        this.bytes += event.data.size;
        this.chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (this.recorder !== recorder) return;
        // A stream/encoder ending mid-match is not a complete match video.
        // Only our explicit stop request may publish the buffered recording.
        if (this.currentStatus !== 'stopping') { this.abort('recording-ended-early'); return; }
        this.completeRecording(recorder);
      };
      recorder.onerror = () => { if (this.recorder === recorder) this.abort('recording-encoder-error'); };
      this.currentStatus = 'recording';
      // Timeslices limit normal buffering but are not a clock: browsers may
      // delay chunks. A separate wall-clock timer also bounds paused sessions.
      this.durationTimer = setTimeout(() => this.abort('recording-duration-limit'), AURA_VIDEO_MAX_DURATION_MS);
      recorder.start(1_000);
      return this.currentError ? { ok: false, reason: this.currentError } : { ok: true };
    } catch {
      return this.startFailure('recording-start-failed');
    }
  }

  pause(): void {
    if (this.currentStatus !== 'recording' || !this.recorder) return;
    try { this.recorder.pause(); this.currentStatus = 'paused'; }
    catch { this.abort('recording-pause-failed'); }
  }

  resume(): void {
    if (this.currentStatus !== 'paused' || !this.recorder) return;
    try { this.recorder.resume(); this.currentStatus = 'recording'; }
    catch { this.abort('recording-resume-failed'); }
  }

  stop(): Promise<AuraVideoRecording | null> {
    const completion = this.completion ?? Promise.resolve(null);
    if (!this.recorder || this.currentStatus === 'stopping') return completion;
    this.currentStatus = 'stopping';
    if (this.durationTimer !== null) clearTimeout(this.durationTimer);
    this.durationTimer = null;
    this.finalizeTimer = setTimeout(() => this.abort('recording-finalize-timeout'), FINALIZE_TIMEOUT_MS);
    try {
      // An automatically ended stream may already be inactive with its final
      // dataavailable/stop events still queued. Keep waiting for those events.
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch { this.abort('recording-stop-failed'); }
    return completion;
  }

  destroy(): void {
    if (this.currentStatus === 'destroyed') return;
    this.currentStatus = 'destroyed';
    this.currentError = 'recording-cancelled';
    this.finish(null, true);
    this.completion = null; // Release our reference to any previously returned Blob.
  }

  private startFailure(reason: string): { ok: false; reason: string } {
    this.abort(reason);
    return { ok: false, reason };
  }

  private abort(reason: string): void {
    if (this.currentStatus === 'destroyed') return;
    this.currentError = reason;
    this.currentStatus = 'error';
    this.finish(null, true);
  }

  private completeRecording(recorder: MediaRecorder): void {
    if (this.chunks.length === 0 || this.bytes === 0) { this.abort('recording-empty'); return; }
    const mimeType = recorder.mimeType || this.chunks.find(chunk => chunk.type)?.type || this.selectedMimeType;
    const type = containerType(mimeType);
    if (!['video/mp4', 'video/webm'].includes(type)
      || this.chunks.some(chunk => chunk.type && containerType(chunk.type) !== type)) {
      this.abort('recording-format-mismatch');
      return;
    }
    try {
      const blob = new Blob(this.chunks, { type: mimeType });
      this.currentStatus = 'stopped';
      this.finish({ blob, mimeType: blob.type, hasAudio: this.capturedAudio });
    } catch { this.abort('recording-blob-failed'); }
  }

  private finish(result: AuraVideoRecording | null, stopEncoder = false): void {
    const recorder = this.recorder;
    this.recorder = null; // Invalidate queued callbacks before stopping anything.
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
      if (stopEncoder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Tracks still get released below. */ }
      }
    }
    for (const timer of [this.durationTimer, this.finalizeTimer]) if (timer !== null) clearTimeout(timer);
    this.durationTimer = null; this.finalizeTimer = null;
    for (const track of this.ownedTracks) {
      try { track.stop(); } catch { /* Continue releasing the other owned tracks. */ }
    }
    this.ownedTracks.clear();
    this.chunks = []; this.bytes = 0;
    const resolve = this.resolveCompletion;
    this.resolveCompletion = null;
    resolve?.(result);
  }
}
