import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuraVideoRecorder, AURA_VIDEO_MAX_BYTES, AURA_VIDEO_MAX_DURATION_MS, AURA_VIDEO_START_TIMEOUT_MS } from './AuraVideoRecorder.ts';

class Track {
  readyState: 'live' | 'ended' = 'live';
  clones: Track[] = [];
  constructor(readonly kind: 'audio' | 'video') {}
  stop = vi.fn(() => { this.readyState = 'ended'; });
  clone = vi.fn(() => {
    const clone = new Track(this.kind); clone.readyState = this.readyState;
    this.clones.push(clone); return clone;
  });
}

class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

class Recorder {
  static instances: Recorder[] = [];
  static supported = new Set(['video/mp4', 'video/webm']);
  static isTypeSupported = vi.fn((type: string) => Recorder.supported.has(type));
  static constructorFails = false;
  static startFails = false;
  static emitStartImmediately = true;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onstart: (() => void) | null = null;
  constructor(readonly stream: Stream, readonly options: MediaRecorderOptions) {
    if (Recorder.constructorFails) throw new Error('Encoder construction failed');
    this.mimeType = options.mimeType ?? '';
    Recorder.instances.push(this);
  }
  start = vi.fn(() => {
    if (Recorder.startFails) throw new Error('Encoder start failed');
    this.state = 'recording';
    if (Recorder.emitStartImmediately) this.onstart?.();
  });
  stop = vi.fn(() => { this.state = 'inactive'; });
  pause = vi.fn(() => { this.state = 'paused'; });
  resume = vi.fn(() => { this.state = 'recording'; });
  data(value: string, type = this.mimeType) { this.ondataavailable?.({ data: new Blob([value], { type }) }); }
  end() { this.state = 'inactive'; this.onstop?.(); }
}

function setup(audio = false) {
  const video = new Track('video');
  const audioSource = new Track('audio');
  const canvas = { captureStream: vi.fn(() => new Stream([video])) };
  const recorder = new AuraVideoRecorder();
  const start = () => recorder.start(canvas as unknown as HTMLCanvasElement,
    audio ? [audioSource as unknown as MediaStreamTrack] : [], audio);
  return { recorder, video, audioSource, canvas, start };
}

beforeEach(() => {
  vi.useFakeTimers();
  Recorder.instances = [];
  Recorder.supported = new Set(['video/mp4', 'video/webm']);
  Recorder.constructorFails = false; Recorder.startFails = false;
  Recorder.emitStartImmediately = true;
  Recorder.isTypeSupported.mockClear();
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() } });
});

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('Aura canvas video recorder', () => {
  it('waits for native media gathering before releasing the rendered intro', async () => {
    Recorder.emitStartImmediately = false;
    const h = setup();
    const requestFrame = vi.fn();
    Object.assign(h.video, { requestFrame });
    expect(await h.recorder.whenStarted()).toBe(false);
    expect(h.start()).toEqual({ ok: true });
    const native = Recorder.instances[0];
    const ready = h.recorder.whenStarted();
    const resolved = vi.fn(); void ready.then(resolved);
    expect(h.recorder.whenStarted()).toBe(ready);
    expect(h.recorder.status).toBe('recording'); // Keep the synchronous public status contract.
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
    native.onstart?.();
    expect(await ready).toBe(true);
    expect(requestFrame).toHaveBeenCalledOnce();
    native.onstart?.();
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1); // Only the overall recording duration remains.
    vi.advanceTimersByTime(AURA_VIDEO_START_TIMEOUT_MS);
    expect(h.recorder.error).toBeNull();
    native.data('intro and battle'); const pending = h.recorder.stop(); native.end();
    expect(await (await pending)!.blob.text()).toBe('intro and battle');
  });

  it.each(['missing', 'throws'] as const)('keeps automatic capture when requestFrame %s', async condition => {
    const h = setup();
    if (condition === 'throws') Object.assign(h.video, { requestFrame: () => { throw new Error('Manual capture unavailable'); } });
    expect(h.start()).toEqual({ ok: true });
    expect(await h.recorder.whenStarted()).toBe(true);
    const native = Recorder.instances[0];
    native.data('automatic frames'); const pending = h.recorder.stop(); native.end();
    expect(await (await pending)!.blob.text()).toBe('automatic frames');
  });

  it('bounds a missing native start and releases only owned tracks', async () => {
    Recorder.emitStartImmediately = false;
    const h = setup(true); h.start();
    const native = Recorder.instances[0];
    const lateStart = native.onstart!;
    const ready = h.recorder.whenStarted();
    vi.advanceTimersByTime(AURA_VIDEO_START_TIMEOUT_MS - 1);
    expect(h.recorder.error).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await ready).toBe(false);
    expect(h.recorder.error).toBe('recording-start-timeout');
    expect(await h.recorder.stop()).toBeNull();
    lateStart();
    expect(h.recorder.status).toBe('error');
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(h.audioSource.clones[0].stop).toHaveBeenCalledOnce();
    expect(h.audioSource.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'destroy'] as const)('settles pending startup after %s and ignores delayed native start', async action => {
    Recorder.emitStartImmediately = false;
    const h = setup(); h.start(); const native = Recorder.instances[0];
    const lateStart = native.onstart!;
    const ready = h.recorder.whenStarted();
    if (action === 'destroy') h.recorder.destroy(); else native.onerror?.();
    expect(await ready).toBe(false);
    lateStart();
    expect(await h.recorder.whenStarted()).toBe(false);
    expect(h.recorder.status).toBe(action === 'destroy' ? 'destroyed' : 'error');
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels startup on stop and cannot release a newer capture from an old start callback', async () => {
    Recorder.emitStartImmediately = false;
    const h = setup(); h.start(); const first = Recorder.instances[0];
    const lateStart = first.onstart!;
    const firstReady = h.recorder.whenStarted();
    const stopped = h.recorder.stop();
    expect(await firstReady).toBe(false);
    first.data('finished'); first.end(); await stopped;
    h.canvas.captureStream.mockReturnValue(new Stream([new Track('video')]));
    h.start(); const second = Recorder.instances[1];
    const secondReady = h.recorder.whenStarted();
    const resolved = vi.fn(); void secondReady.then(resolved);
    lateStart(); await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    second.onstart?.();
    expect(await secondReady).toBe(true);
    h.recorder.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a pause requested while native startup is pending', async () => {
    Recorder.emitStartImmediately = false;
    const h = setup(); h.start(); const native = Recorder.instances[0];
    h.recorder.pause();
    expect(h.recorder.status).toBe('paused');
    native.onstart?.();
    expect(await h.recorder.whenStarted()).toBe(true);
    expect(h.recorder.status).toBe('paused');
    expect(native.resume).not.toHaveBeenCalled();
    h.recorder.resume();
    expect(h.recorder.status).toBe('recording');
    h.recorder.destroy();
  });

  it('captures only the canvas at 30fps and clones game audio without requesting any device', async () => {
    const h = setup(true);
    expect(h.start()).toEqual({ ok: true });
    const native = Recorder.instances[0];
    expect(h.canvas.captureStream).toHaveBeenCalledExactlyOnceWith(30);
    expect(native.start).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(h.audioSource.clone).toHaveBeenCalledOnce();
    expect(native.stream.tracks).toEqual([h.video, h.audioSource.clones[0]]);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
    native.data('video'); const result = h.recorder.stop(); native.end();
    expect((await result)?.hasAudio).toBe(true);
    expect(h.audioSource.stop).not.toHaveBeenCalled();
    expect(h.audioSource.clones[0].stop).toHaveBeenCalledOnce();
    expect(h.video.stop).toHaveBeenCalledOnce();
    h.recorder.destroy();
    expect(h.video.stop).toHaveBeenCalledOnce();
  });

  it('waits for the asynchronous final chunk and shares one stop operation', async () => {
    const h = setup(); h.start(); const native = Recorder.instances[0];
    native.data('first');
    const pending = h.recorder.stop(); const resolved = vi.fn(); void pending.then(resolved);
    expect(h.recorder.stop()).toBe(pending);
    expect(native.stop).toHaveBeenCalledOnce();
    expect(h.recorder.status).toBe('stopping');
    await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    expect(h.video.stop).not.toHaveBeenCalled();
    native.data('last');
    await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    native.end();
    const result = await pending;
    expect(await result!.blob.text()).toBe('firstlast');
    expect(result!.mimeType).toBe('video/mp4');
    expect(result!.blob.type).toBe('video/mp4');
    expect(result!.hasAudio).toBe(false);
    expect(h.recorder.status).toBe('stopped');
    expect(h.recorder.error).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(await h.recorder.stop()).toBe(result);
  });

  it.each(['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'])
  ('chooses supported %s and reports the encoded MIME without pretending it is MP4', async expected => {
    Recorder.supported = new Set([expected]);
    const h = setup(); expect(h.start()).toEqual({ ok: true });
    const native = Recorder.instances[0];
    expect(native.options.mimeType).toBe(expected);
    native.data('encoded'); const pending = h.recorder.stop(); native.end();
    expect((await pending)?.mimeType).toBe(expected);
  });

  it('prefers MP4 when MP4 and WebM are both available', () => {
    const h = setup(); h.start();
    expect(Recorder.instances[0].options.mimeType).toBe('video/mp4');
    h.recorder.destroy();
  });

  it('reports the actual native MIME if the encoder selected another supported container', async () => {
    const h = setup(); h.start(); const native = Recorder.instances[0];
    native.mimeType = 'video/webm;codecs=vp8'; native.data('encoded');
    const pending = h.recorder.stop(); native.end();
    expect((await pending)?.mimeType).toBe('video/webm;codecs=vp8');
  });

  it('uses final chunk MIME when the encoder leaves its MIME empty', async () => {
    const h = setup(); h.start(); const native = Recorder.instances[0];
    native.mimeType = ''; native.data('encoded', 'video/webm');
    const pending = h.recorder.stop(); native.end();
    expect((await pending)?.mimeType).toBe('video/webm');
  });

  it('fails closed on mixed or non-video output container types', async () => {
    const h = setup(); h.start(); const native = Recorder.instances[0];
    native.data('one', 'video/mp4'); native.data('two', 'video/webm');
    const pending = h.recorder.stop(); native.end();
    expect(await pending).toBeNull();
    expect(h.recorder.error).toBe('recording-format-mismatch');
    expect(h.video.stop).toHaveBeenCalledOnce();
  });

  it.each(['recorder', 'stream', 'capture', 'mime-check', 'all-formats'])
  ('rejects unsupported %s safely before capturing', async missing => {
    const h = setup();
    if (missing === 'recorder') vi.stubGlobal('MediaRecorder', undefined);
    if (missing === 'stream') vi.stubGlobal('MediaStream', undefined);
    if (missing === 'capture') Object.assign(h.canvas, { captureStream: undefined });
    if (missing === 'mime-check') vi.stubGlobal('MediaRecorder', class {});
    if (missing === 'all-formats') Recorder.supported.clear();
    expect(h.start().ok).toBe(false);
    expect(await h.recorder.whenStarted()).toBe(false);
    expect(h.recorder.status).toBe('error');
    expect(h.recorder.error).toMatch(/unsupported/);
    expect(await h.recorder.stop()).toBeNull();
    expect(h.video.stop).not.toHaveBeenCalled();
    expect(Recorder.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['capture', 'constructor', 'start', 'clone'])('releases owned tracks after a %s exception', async failure => {
    const h = setup(true);
    if (failure === 'capture') h.canvas.captureStream.mockImplementation(() => { throw new Error('Tainted canvas'); });
    if (failure === 'constructor') Recorder.constructorFails = true;
    if (failure === 'start') Recorder.startFails = true;
    if (failure === 'clone') h.audioSource.clone.mockImplementation(() => { throw new Error('Clone failed'); });
    expect(h.start()).toEqual({ ok: false, reason: 'recording-start-failed' });
    expect(await h.recorder.whenStarted()).toBe(false);
    expect(await h.recorder.stop()).toBeNull();
    expect(h.audioSource.stop).not.toHaveBeenCalled();
    expect(h.video.stop).toHaveBeenCalledTimes(failure === 'capture' ? 0 : 1);
    for (const clone of h.audioSource.clones) expect(clone.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an empty capture stream and never captures an unrelated supplied video track', () => {
    const h = setup(); h.video.readyState = 'ended';
    const foreignVideo = new Track('video');
    expect(h.recorder.start(h.canvas as unknown as HTMLCanvasElement,
      [foreignVideo as unknown as MediaStreamTrack], true).reason).toBe('canvas-video-unavailable');
    expect(foreignVideo.clone).not.toHaveBeenCalled();
    expect(foreignVideo.stop).not.toHaveBeenCalled();
    expect(h.video.stop).toHaveBeenCalledOnce();
  });

  it('does not stop original tracks even if a broken clone method returns an original', () => {
    const h = setup(true); h.audioSource.clone.mockReturnValue(h.audioSource);
    expect(h.start()).toEqual({ ok: false, reason: 'audio-clone-failed' });
    expect(h.audioSource.stop).not.toHaveBeenCalled();
    expect(h.video.stop).toHaveBeenCalledOnce();
  });

  it.each([false, true])('marks silent output honestly when no live authorized audio is available (hasAudio=%s)', async declaredAudio => {
    const h = setup(true); if (declaredAudio) h.audioSource.readyState = 'ended';
    h.recorder.start(h.canvas as unknown as HTMLCanvasElement, [h.audioSource as unknown as MediaStreamTrack], declaredAudio);
    const native = Recorder.instances[0];
    expect(native.stream.tracks).toEqual([h.video]);
    expect(h.audioSource.clone).not.toHaveBeenCalled();
    native.data('silent'); const pending = h.recorder.stop(); native.end();
    expect((await pending)?.hasAudio).toBe(false);
  });

  it('pauses/resumes idempotently without replacing the stream or recorder', async () => {
    const h = setup(); h.recorder.pause(); h.recorder.resume();
    h.start(); const native = Recorder.instances[0];
    h.recorder.pause(); h.recorder.pause();
    expect(h.recorder.status).toBe('paused'); expect(native.pause).toHaveBeenCalledOnce();
    h.recorder.resume(); h.recorder.resume();
    expect(h.recorder.status).toBe('recording'); expect(native.resume).toHaveBeenCalledOnce();
    h.recorder.pause(); native.data('paused end');
    const pending = h.recorder.stop(); h.recorder.resume(); native.end();
    expect(await pending).not.toBeNull();
    expect(native.resume).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(1);
  });

  it.each(['pause', 'resume', 'stop'] as const)('cleans up after a native %s exception', async operation => {
    const h = setup(true); h.start(); const native = Recorder.instances[0];
    if (operation === 'resume') h.recorder.pause();
    native[operation].mockImplementation(() => { throw new Error('Native failure'); });
    if (operation === 'stop') await h.recorder.stop(); else h.recorder[operation]();
    expect(h.recorder.error).toBe(`recording-${operation}-failed`);
    expect(await h.recorder.stop()).toBeNull();
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(h.audioSource.clones[0].stop).toHaveBeenCalledOnce();
    expect(h.audioSource.stop).not.toHaveBeenCalled();
  });

  it('rejects all-empty chunks after an explicit stop', async () => {
    const h = setup(); h.start(); const native = Recorder.instances[0];
    native.data(''); const pending = h.recorder.stop(); native.end();
    expect(await pending).toBeNull();
    expect(await h.recorder.stop()).toBeNull();
    expect(h.recorder.error).toBe('recording-empty');
    expect(h.video.stop).toHaveBeenCalledOnce();
  });

  it.each(['recording', 'paused'] as const)('rejects a spontaneous stop while %s instead of publishing a partial match', async state => {
    const h = setup(true); h.start(); const native = Recorder.instances[0];
    native.data('partial match');
    if (state === 'paused') h.recorder.pause();
    native.end();
    expect(h.recorder.status).toBe('error');
    expect(h.recorder.error).toBe('recording-ended-early');
    expect(await h.recorder.stop()).toBeNull();
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(h.audioSource.clones[0].stop).toHaveBeenCalledOnce();
    expect(h.audioSource.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves final data when an inactive encoder has stop events queued', async () => {
    const h = setup(); h.start(); const native = Recorder.instances[0];
    native.state = 'inactive'; const pending = h.recorder.stop();
    expect(native.stop).not.toHaveBeenCalled();
    native.data('automatic final'); native.end();
    expect(await (await pending)!.blob.text()).toBe('automatic final');
  });

  it('discards an over-limit chunk without allocating it into the final blob', async () => {
    const h = setup(true); h.start(); const native = Recorder.instances[0];
    native.data('one');
    native.ondataavailable?.({ data: { size: AURA_VIDEO_MAX_BYTES, type: 'video/mp4' } as Blob });
    expect(h.recorder.error).toBe('recording-size-limit');
    expect(await h.recorder.stop()).toBeNull();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(h.audioSource.stop).not.toHaveBeenCalled();
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('enforces the five-minute wall-clock bound even when paused=%s', async paused => {
    const h = setup(); h.start(); if (paused) h.recorder.pause();
    vi.advanceTimersByTime(AURA_VIDEO_MAX_DURATION_MS - 1);
    expect(h.recorder.error).toBeNull();
    vi.advanceTimersByTime(1);
    expect(h.recorder.error).toBe('recording-duration-limit');
    expect(await h.recorder.stop()).toBeNull();
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a missing final stop event and resolves the pending stop safely', async () => {
    const h = setup(); h.start(); const pending = h.recorder.stop();
    vi.advanceTimersByTime(5_000);
    expect(await pending).toBeNull();
    expect(h.recorder.error).toBe('recording-finalize-timeout');
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['recording', 'stopping', 'error'] as const)('destroy cancels %s once and ignores all late native events', async state => {
    const h = setup(true); h.start(); const native = Recorder.instances[0];
    const lateData = native.ondataavailable!, lateStop = native.onstop!, lateError = native.onerror!;
    if (state === 'error') native.onerror?.();
    const pending = state === 'stopping' ? h.recorder.stop() : null;
    h.recorder.destroy(); h.recorder.destroy();
    if (pending) expect(await pending).toBeNull();
    lateData({ data: new Blob(['late']) }); lateStop(); lateError();
    expect(h.recorder.status).toBe('destroyed');
    expect(await h.recorder.stop()).toBeNull();
    expect(h.video.stop).toHaveBeenCalledOnce();
    expect(h.audioSource.clones[0].stop).toHaveBeenCalledOnce();
    expect(h.audioSource.stop).not.toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.start()).toEqual({ ok: false, reason: 'recorder-destroyed' });
  });

  it('rejects duplicate starts without disrupting the active capture and can start again after stop', async () => {
    const h = setup(); h.start(); const native = Recorder.instances[0];
    expect(h.start()).toEqual({ ok: false, reason: 'recording-already-started' });
    expect(h.recorder.status).toBe('recording');
    expect(h.canvas.captureStream).toHaveBeenCalledOnce();
    native.data('first'); const pending = h.recorder.stop(); native.end(); await pending;
    const newVideo = new Track('video'); h.canvas.captureStream.mockReturnValue(new Stream([newVideo]));
    expect(h.start()).toEqual({ ok: true });
    const next = Recorder.instances[1]; next.data('second'); const nextPending = h.recorder.stop(); next.end();
    expect(await (await nextPending)!.blob.text()).toBe('second');
    expect(h.video.stop).toHaveBeenCalledOnce(); expect(newVideo.stop).toHaveBeenCalledOnce();
  });
});
