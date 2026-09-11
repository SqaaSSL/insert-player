import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATTLE_MUSIC_VOLUME, SoundManager } from './SoundManager.ts';
import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';
import { AURA_CHALLENGE_ASSETS } from '../aura/AuraChallengeAssets.ts';
import { prepareAuraChallengeMusic, createAuraChallengeMusicUrl, revokeAuraChallengeMusicUrl } from '../aura/AuraChallengeMedia.ts';
import { createAuraChallenge, createAuraChallengeRoutine } from '../aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../aura/AuraTracks.ts';

class FakeAudio {
  static instances: FakeAudio[] = [];
  assignments: string[] = [];
  private source = '';
  private cors: string | null = null;
  loop = false;
  preload = '';
  volume = 1;
  playbackRate = 1;
  currentTime = 12;
  duration = 120;
  paused = true;
  seeking = false;
  error: unknown = null;
  play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor() { FakeAudio.instances.push(this); }
  set crossOrigin(value: string | null) { this.cors = value; this.assignments.push('crossOrigin'); }
  get crossOrigin() { return this.cors; }
  set src(value: string) { this.source = value; this.assignments.push('src'); }
  get src() { return this.source; }
}

class FakeNode {
  connected = new Set<FakeNode>();
  connect = vi.fn((target: FakeNode) => { this.connected.add(target); return target; });
  disconnect = vi.fn((target?: FakeNode) => {
    if (target) this.connected.delete(target);
    else this.connected.clear();
  });
}

function parameter(value = 0) {
  return { value, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
}

function track() {
  const result = {
    kind: 'audio', readyState: 'live', enabled: true,
    stop: vi.fn(() => { result.readyState = 'ended'; }),
    clone: vi.fn(() => track()),
  };
  return result;
}

function advanceCrowd(sound: SoundManager, durationMs: number): void {
  for (let elapsed = 0; elapsed < durationMs; elapsed += 100) {
    sound.updateAuraCrowd(Math.min(100, durationMs - elapsed));
  }
}

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  static initialState: 'running' | 'suspended' = 'running';
  state: 'running' | 'suspended' | 'closed' = FakeAudioContext.initialState;
  currentTime = 0;
  sampleRate = 100;
  destination = new FakeNode();
  gains: (FakeNode & { gain: ReturnType<typeof parameter> })[] = [];
  media: { audio: FakeAudio; source: FakeNode }[] = [];
  recordingTrack = track();
  recordingDestination = Object.assign(new FakeNode(), {
    stream: { getAudioTracks: () => [this.recordingTrack], getTracks: () => [this.recordingTrack] },
  });
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => { this.state = 'closed'; return Promise.resolve(); });
  createGain = vi.fn(() => {
    const gain = Object.assign(new FakeNode(), { gain: parameter(1) });
    this.gains.push(gain); return gain;
  });
  createMediaStreamDestination = vi.fn(() => this.recordingDestination);
  createMediaElementSource = vi.fn((audio: FakeAudio) => {
    const source = new FakeNode(); this.media.push({ audio, source }); return source;
  });
  createBuffer = vi.fn((_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) }));
  createBufferSource = vi.fn(() => Object.assign(new FakeNode(), { buffer: null, start: vi.fn(), stop: vi.fn() }));
  createBiquadFilter = vi.fn(() => Object.assign(new FakeNode(), { type: '', frequency: parameter(), Q: parameter() }));
  createOscillator = vi.fn(() => Object.assign(new FakeNode(), { type: '', frequency: parameter(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null }));
  constructor() { super(); FakeAudioContext.instances.push(this); }
  running() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); }
}

describe('SoundManager recording mix', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudio.instances = [];
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = 'running';
  });

  it('records hash-verified challenge blob music together with the crowd, never an arbitrary blob', async () => {
    // The separate media tests verify real public bytes. Here only native
    // hashing/network are replaced so this graph test needs no Node/browser IO.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url)));
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => {
      const url = new TextDecoder().decode(data as ArrayBuffer);
      const asset = Object.values(AURA_CHALLENGE_ASSETS).find(asset => asset.url === url);
      if (!asset) throw new Error('Unexpected challenge fixture');
      return Uint8Array.from(asset.sha256.match(/../g)!, value => parseInt(value, 16)).buffer;
    });
    const challenge = createAuraChallenge(createAuraChallengeRoutine(1234, 'viral', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!, 'Player', 500);
    const music = await prepareAuraChallengeMusic(challenge, new AbortController().signal);
    const verifiedUrl = createAuraChallengeMusicUrl(music);
    const arbitraryUrl = URL.createObjectURL(new Blob(['private audio'], { type: 'audio/mpeg' }));
    const sound = new SoundManager();
    try {
      sound.startBattleMusic(verifiedUrl);
      sound.startAuraCrowd();
      const tracks = sound.getRecordingAudioTracks();
      expect(tracks).toHaveLength(1);
      const ctx = FakeAudioContext.instances[0];
      expect(ctx.media).toHaveLength(5);
      expect(ctx.media[0].audio.src).toBe(verifiedUrl);
      expect(ctx.media[0].audio.assignments).toEqual(['crossOrigin', 'src']);
      expect(ctx.media[0].source.connected.has(ctx.recordingDestination)).toBe(true);
      expect(ctx.media[0].source.connected.has(ctx.destination)).toBe(true);
      sound.startBattleMusic(arbitraryUrl);
      expect(sound.getRecordingAudioTracks()).toEqual([]);
      expect(ctx.media.some(layer => layer.audio.src === arbitraryUrl)).toBe(false);
    } finally {
      sound.destroy();
      revokeAuraChallengeMusicUrl(verifiedUrl);
      URL.revokeObjectURL(arbitraryUrl);
      digest.mockRestore();
    }
  });

  it('keeps ordinary HTML playback lazy and configures local CORS before src', () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.prepareAuraCrowd();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(5);
    for (const audio of FakeAudio.instances) {
      expect(audio.assignments).toEqual(['crossOrigin', 'src']);
      expect(audio.crossOrigin).toBe('anonymous');
    }
    sound.destroy();
  });

  it('mixes all five media layers and post-gain SFX without duplicate speaker routes', () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.startAuraCrowd();
    sound.setAuraCrowdMix(1, 0.8, 0.4); sound.updateAuraCrowd(100);
    const before = FakeAudio.instances.map(audio => [audio.currentTime, audio.volume, audio.playbackRate, audio.loop]);
    const tracks = sound.getRecordingAudioTracks();
    const ctx = FakeAudioContext.instances[0];
    expect(tracks).toEqual([ctx.recordingTrack]);
    expect(ctx.media).toHaveLength(5);
    for (const { source } of ctx.media) {
      expect(source.connect.mock.calls).toEqual([[ctx.destination], [ctx.recordingDestination]]);
    }
    const master = ctx.gains[0];
    expect(master.gain.value).toBe(0.4);
    expect(master.connect.mock.calls).toEqual([[ctx.destination], [ctx.recordingDestination]]);
    expect(FakeAudio.instances.map(audio => [audio.currentTime, audio.volume, audio.playbackRate, audio.loop])).toEqual(before);
    expect(FakeAudio.instances.map(audio => audio.play.mock.calls.length)).toEqual([1, 1, 1, 0, 0]);
    expect(FakeAudio.instances.every(audio => audio.pause.mock.calls.length === 0)).toBe(true);
    expect(sound.getRecordingAudioTracks()[0]).toBe(tracks[0]);
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(5);
    expect(ctx.createMediaStreamDestination).toHaveBeenCalledOnce();
    expect(master.connect).toHaveBeenCalledTimes(2);
    expect(sound.getBattleMusicTimeMs()).toBe(12_000);
    sound.playHit(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx.gains.slice(1).every(gain => gain.connected.has(master))).toBe(true);
    expect(ctx.recordingTrack.clone).not.toHaveBeenCalled();
    sound.destroy();
  });

  it('captures media created after the caller requests the lazy tap', () => {
    const sound = new SoundManager();
    sound.getRecordingAudioTracks();
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.media).toHaveLength(0);
    sound.startBattleMusic(); sound.prepareAuraCrowd();
    expect(ctx.media).toHaveLength(5);
    expect(FakeAudio.instances[0].volume).toBe(BATTLE_MUSIC_VOLUME);
    sound.destroy();
  });

  it('taps an existing SFX context without reconnecting its audible master', () => {
    const sound = new SoundManager();
    sound.playWhoosh();
    const ctx = FakeAudioContext.instances[0];
    sound.getRecordingAudioTracks();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx.gains[0].connect.mock.calls).toEqual([[ctx.destination], [ctx.recordingDestination]]);
    sound.destroy();
  });

  it('does not reroute audible HTML through a suspended context, and attaches on unlock', async () => {
    FakeAudioContext.initialState = 'suspended';
    const fakeWindow = Object.assign(new EventTarget(), { location: { href: 'https://insertplayer.ai/fight' } });
    vi.stubGlobal('window', fakeWindow);
    const sound = new SoundManager();
    sound.startBattleMusic();
    expect(sound.getRecordingAudioTracks()).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0];
    await Promise.resolve();
    expect(ctx.createMediaElementSource).not.toHaveBeenCalled();
    expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled();
    expect(sound.getBattleMusicTimeMs()).toBe(12_000);
    ctx.resume.mockImplementation(() => { ctx.running(); return Promise.resolve(); });
    fakeWindow.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(ctx.media).toHaveLength(1);
    expect(FakeAudio.instances[0].currentTime).toBe(12);
    expect(FakeAudio.instances[0].volume).toBe(BATTLE_MUSIC_VOLUME);
    sound.destroy();
  });

  it('handles rejected resume without an unhandled rejection or muted HTML music', async () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.playWhoosh();
    const ctx = FakeAudioContext.instances[0];
    ctx.state = 'suspended';
    ctx.resume.mockRejectedValue(new Error('autoplay denied'));
    expect(sound.getRecordingAudioTracks()).toHaveLength(1);
    await Promise.resolve(); await Promise.resolve();
    expect(ctx.media).toHaveLength(0);
    expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled();
    sound.destroy();
  });

  it('does not let a pending recording unlock restart explicitly paused music or crowd', async () => {
    FakeAudioContext.initialState = 'suspended';
    const fakeWindow = Object.assign(new EventTarget(), { location: { href: 'https://insertplayer.ai/fight' } });
    vi.stubGlobal('window', fakeWindow);
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.startAuraCrowd(); sound.getRecordingAudioTracks();
    sound.pauseBattleMusic();
    const ctx = FakeAudioContext.instances[0];
    ctx.resume.mockImplementation(() => { ctx.running(); return Promise.resolve(); });
    fakeWindow.dispatchEvent(new Event('keydown'));
    await Promise.resolve();
    expect(FakeAudio.instances.map(audio => audio.play.mock.calls.length)).toEqual([1, 1, 1, 0, 0]);
    sound.resumeBattleMusic();
    expect(FakeAudio.instances.map(audio => audio.play.mock.calls.length)).toEqual([2, 2, 2, 0, 0]);
    sound.destroy();
  });

  it('keeps one recording connection per element as reactions start, pause, resume and expire', () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.startAuraCrowd(); sound.getRecordingAudioTracks();
    const ctx = FakeAudioContext.instances[0];
    const hype = FakeAudio.instances[3];
    expect(hype.play).not.toHaveBeenCalled();

    sound.peakAuraCrowd();
    advanceCrowd(sound, 500);
    expect(hype.play).toHaveBeenCalledOnce();
    hype.currentTime = 1.5;
    sound.pauseBattleMusic();
    advanceCrowd(sound, 10_000);
    sound.resumeBattleMusic();
    expect(hype.currentTime).toBe(1.5);
    expect(hype.play).toHaveBeenCalledTimes(2);
    advanceCrowd(sound, 3_000);
    sound.pauseBattleMusic(); sound.resumeBattleMusic();
    sound.getRecordingAudioTracks();
    expect(hype.play).toHaveBeenCalledTimes(2);
    expect(hype.volume).toBe(0);
    expect(FakeAudio.instances[4].play).not.toHaveBeenCalled();
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(5);
    for (const { source } of ctx.media) {
      expect(source.connect.mock.calls).toEqual([[ctx.destination], [ctx.recordingDestination]]);
    }
    sound.destroy();
  });

  it('never resurrects an expired reaction when a suspended recording tap unlocks', async () => {
    FakeAudioContext.initialState = 'suspended';
    const fakeWindow = Object.assign(new EventTarget(), { location: { href: 'https://insertplayer.ai/fight' } });
    vi.stubGlobal('window', fakeWindow);
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.startAuraCrowd(); sound.getRecordingAudioTracks();
    sound.peakAuraCrowd();
    advanceCrowd(sound, 3_000);
    const hype = FakeAudio.instances[3];
    expect(hype.play).toHaveBeenCalledOnce();
    expect(hype.volume).toBe(0);
    const ctx = FakeAudioContext.instances[0];
    ctx.resume.mockImplementation(() => { ctx.running(); return Promise.resolve(); });
    fakeWindow.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(5);
    expect(FakeAudio.instances.map(audio => audio.play.mock.calls.length)).toEqual([2, 2, 2, 1, 0]);
    expect(hype.paused).toBe(true);
    expect(hype.volume).toBe(0);
    sound.destroy();
  });

  it('leaves external music on native playback instead of risking CORS silence', () => {
    const sound = new SoundManager();
    sound.startBattleMusic('https://external.example/music.mp3');
    expect(sound.getRecordingAudioTracks()).toEqual([]);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeAudio.instances[0].assignments).toEqual(['src']);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledOnce();
    expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled();
    sound.destroy();
  });

  it('fails the recording branch gracefully while preserving a connected speaker route', () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.playWhoosh();
    const ctx = FakeAudioContext.instances[0];
    const source = new FakeNode();
    source.connect.mockImplementation(target => {
      if (target === ctx.recordingDestination) throw new Error('recording connection unavailable');
      source.connected.add(target); return target;
    });
    ctx.createMediaElementSource.mockReturnValue(source);
    expect(sound.getRecordingAudioTracks()).toEqual([]);
    expect(source.connected).toEqual(new Set([ctx.destination]));
    expect(ctx.gains[0].connected).toEqual(new Set([ctx.destination]));
    expect(ctx.recordingTrack.stop).toHaveBeenCalledOnce();
    expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled();
    expect(FakeAudio.instances[0].currentTime).toBe(12);
    expect(sound.getRecordingAudioTracks()).toEqual([]);
    sound.destroy();
  });

  it('handles unavailable APIs and source creation errors without touching HTML playback', () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.playWhoosh();
    const ctx = FakeAudioContext.instances[0];
    ctx.createMediaElementSource.mockImplementation(() => { throw new Error('unsupported media source'); });
    expect(sound.getRecordingAudioTracks()).toEqual([]);
    expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled();
    sound.destroy();
    vi.stubGlobal('AudioContext', undefined);
    expect(new SoundManager().getRecordingAudioTracks()).toEqual([]);
  });

  it('releases replaced music nodes and never reroutes a replacement external track', () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.getRecordingAudioTracks();
    const ctx = FakeAudioContext.instances[0];
    sound.startBattleMusic('/assets/audio/another.mp3');
    expect(ctx.media[0].source.connected.size).toBe(0);
    expect(ctx.media).toHaveLength(2);
    sound.startBattleMusic('https://external.example/music.mp3');
    expect(ctx.media[1].source.connected.size).toBe(0);
    expect(ctx.media).toHaveLength(2);
    expect(ctx.recordingTrack.stop).toHaveBeenCalledOnce();
    expect(FakeAudio.instances[2].play).toHaveBeenCalledOnce();
    expect(FakeAudio.instances[2].pause).not.toHaveBeenCalled();
    expect(sound.getRecordingAudioTracks()).toEqual([]);
    sound.destroy();
  });

  it('reports a waiting clock when a routed graph is suspended, without seeking the music', () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.getRecordingAudioTracks();
    const ctx = FakeAudioContext.instances[0];
    ctx.state = 'suspended';
    expect(sound.getBattleMusicClockSample()).toEqual({ status: 'waiting' });
    ctx.running();
    expect(sound.getBattleMusicTimeMs()).toBe(12_000);
    expect(FakeAudio.instances[0].currentTime).toBe(12);
    sound.destroy();
  });

  it('owns original tracks, leaves caller clones alone and tears every node down once', async () => {
    const sound = new SoundManager();
    sound.startBattleMusic(); sound.startAuraCrowd();
    const original = sound.getRecordingAudioTracks()[0];
    const clone = original.clone();
    clone.stop();
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.recordingTrack.stop).not.toHaveBeenCalled();
    expect(sound.getRecordingAudioTracks()[0]).toBe(original);
    sound.destroy(); sound.destroy();
    await Promise.resolve();
    expect(ctx.recordingTrack.stop).toHaveBeenCalledOnce();
    expect(ctx.recordingDestination.disconnect).toHaveBeenCalledOnce();
    expect(ctx.close).toHaveBeenCalledOnce();
    expect(ctx.media.every(({ source }) => source.connected.size === 0)).toBe(true);
    expect(ctx.gains[0].connected.size).toBe(0);
    expect(sound.getRecordingAudioTracks()).toEqual([]);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it.each([
    'aura_glide', 'aura_six_seven', 'aura_mog_check', 'aura_floor_worm',
    'aura_one_leg', 'aura_shrug', 'aura_unbothered',
  ] satisfies AuraAnimationName[])('routes %s through the quiet master and the existing recording tap with a click-free envelope', name => {
    const sound = new SoundManager();
    sound.getRecordingAudioTracks();
    const ctx = FakeAudioContext.instances[0];
    const master = ctx.gains[0];
    sound.playAuraMove(name as AuraAnimationName);
    const oscillators = ctx.createOscillator.mock.results.map(result => result.value);
    expect(oscillators.length).toBeGreaterThanOrEqual(1);
    expect(oscillators.length).toBeLessThanOrEqual(2);
    expect(master.connect.mock.calls).toEqual([[ctx.destination], [ctx.recordingDestination]]);
    const envelopes = ctx.gains.slice(1);
    expect(envelopes).toHaveLength(oscillators.length);
    let totalPeak = 0;
    for (const [index, oscillator] of oscillators.entries()) {
      const gain = envelopes[index];
      expect(oscillator.connected).toEqual(new Set([gain]));
      expect(gain.connected).toEqual(new Set([master]));
      expect(gain.gain.setValueAtTime.mock.calls[0][0]).toBe(0.0001);
      expect(gain.gain.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(0.0001);
      const [peak, peakAt] = gain.gain.linearRampToValueAtTime.mock.calls[0];
      const start = oscillator.start.mock.calls[0][0];
      const stop = oscillator.stop.mock.calls[0][0];
      expect(peakAt - start).toBeCloseTo(0.008, 10);
      expect(stop).toBeLessThanOrEqual(0.32);
      expect(oscillator.frequency.setValueAtTime.mock.calls[0][0]).toBeGreaterThan(100);
      totalPeak += peak;
    }
    expect(totalPeak * master.gain.value).toBeLessThanOrEqual(0.064);
    sound.destroy();
  });

  it('gives all seven move bubbles distinct sonic signatures without fetching assets', () => {
    const sound = new SoundManager();
    sound.prepareAuraMoveAudio();
    const ctx = FakeAudioContext.instances[0];
    const signatures = new Set<string>();
    for (const name of ['aura_glide', 'aura_six_seven', 'aura_mog_check', 'aura_floor_worm', 'aura_one_leg', 'aura_shrug', 'aura_unbothered'] as const) {
      ctx.currentTime += 1;
      const previousCount = ctx.createOscillator.mock.calls.length;
      sound.playAuraMove(name);
      const voices = ctx.createOscillator.mock.results.slice(previousCount).map(result => result.value);
      signatures.add(JSON.stringify(voices.map(voice => [voice.type,
        voice.frequency.setValueAtTime.mock.calls[0][0], voice.frequency.exponentialRampToValueAtTime.mock.calls[0][0],
        voice.start.mock.calls[0][0] - ctx.currentTime, voice.stop.mock.calls[0][0] - ctx.currentTime,
      ])));
    }
    expect(signatures.size).toBe(7);
    expect(FakeAudio.instances).toHaveLength(0);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(ctx.createMediaStreamDestination).not.toHaveBeenCalled();
    sound.destroy();
  });

  it('does not turn repeated note/frame calls into repeated move cues', () => {
    const sound = new SoundManager();
    sound.prepareAuraMoveAudio();
    const ctx = FakeAudioContext.instances[0];
    for (let frame = 0; frame < 30; frame++) {
      ctx.currentTime = frame / 60;
      sound.playAuraMove('aura_six_seven');
    }
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    ctx.currentTime = 1;
    sound.playAuraMove('aura_six_seven');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4);
    sound.destroy();
  });

  it('cuts playing and future cue voices on pause without replaying them when resumed', () => {
    const sound = new SoundManager();
    sound.playAuraMove('aura_six_seven');
    const ctx = FakeAudioContext.instances[0];
    const voices = ctx.createOscillator.mock.results.map(result => result.value);
    const endedCallbacks = voices.map(voice => voice.onended!);
    ctx.currentTime = 0.04; // The second syllable is scheduled but has not started.
    sound.pauseBattleMusic();
    for (const voice of voices) {
      expect(voice.stop).toHaveBeenLastCalledWith(0.04);
      expect(voice.connected.size).toBe(0);
      expect(voice.onended).toBeNull();
    }
    expect(ctx.gains.slice(1).every(gain => gain.connected.size === 0)).toBe(true);
    sound.playAuraMove('aura_glide');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    sound.resumeBattleMusic();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    sound.playAuraMove('aura_unbothered');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    endedCallbacks.forEach(callback => callback());
    voices.forEach(voice => expect(voice.disconnect).toHaveBeenCalledOnce());
    sound.destroy();
  });

  it('records audible rising count-in cues, bounds repeated ticks and cancels them on pause', () => {
    const sound = new SoundManager();
    sound.getRecordingAudioTracks();
    const ctx = FakeAudioContext.instances[0];
    for (const count of [3, 2, 1, 'go'] as const) {
      sound.playAuraCountIn(count);
      sound.playAuraCountIn(count);
      ctx.currentTime += 1;
    }
    const voices = ctx.createOscillator.mock.results.map(result => result.value);
    expect(voices).toHaveLength(4);
    expect(voices.map(voice => voice.frequency.setValueAtTime.mock.calls[0][0])).toEqual([440, 554, 659, 880]);
    expect(ctx.gains.slice(1).every(gain => gain.connected.has(ctx.gains[0]))).toBe(true);
    expect(ctx.gains[0].connected.has(ctx.recordingDestination)).toBe(true);
    sound.pauseBattleMusic();
    expect(voices.every(voice => voice.connected.size === 0)).toBe(true);
    sound.playAuraCountIn('go');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4);
    sound.resumeBattleMusic();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4);
    sound.playAuraCountIn(3);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(5);
    sound.destroy();
  });

  it('plays a soft practice pulse and move feedback without the song, freezing beats on pause', () => {
    const sound = new SoundManager();
    sound.startAuraPracticeAudio(150);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.createOscillator).toHaveBeenCalledOnce();
    expect(FakeAudio.instances).toHaveLength(4); // Audience only; no song is created.
    sound.updateAuraCrowd(399);
    expect(ctx.createOscillator).toHaveBeenCalledOnce();
    sound.updateAuraCrowd(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    sound.playAuraMove('aura_six_seven');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4);
    sound.pauseBattleMusic(); sound.updateAuraCrowd(30_000);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(4);
    sound.resumeBattleMusic(); sound.updateAuraCrowd(400);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(5);
    sound.updateAuraCrowd(60_000);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(6); // No catch-up burst.
    sound.stopAuraPracticeAudio(); sound.updateAuraCrowd(4_000);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(6);
    expect(FakeAudio.instances.every(audio => audio.paused)).toBe(true);
    sound.destroy();
  });

  it('releases ended cue nodes and never leaves pending voices alive after stop/dispose', () => {
    const sound = new SoundManager();
    sound.playAuraMove('aura_glide');
    const ctx = FakeAudioContext.instances[0];
    const voices = ctx.createOscillator.mock.results.map(result => result.value);
    voices[0].onended!();
    expect(voices[0].connected.size).toBe(0);
    expect(ctx.gains[1].connected.size).toBe(0);
    sound.stopBattleMusic();
    expect(voices[1].connected.size).toBe(0);
    sound.destroy(); sound.destroy();
    expect(ctx.close).toHaveBeenCalledOnce();
    const contexts = FakeAudioContext.instances.length;
    sound.prepareAuraMoveAudio(); sound.resumeBattleMusic(); sound.playAuraMove('aura_shrug');
    expect(FakeAudioContext.instances).toHaveLength(contexts);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('unlocks a silent preview without queueing an old bubble or opening recording', async () => {
    FakeAudioContext.initialState = 'suspended';
    const sound = new SoundManager();
    sound.prepareAuraMoveAudio();
    const ctx = FakeAudioContext.instances[0];
    sound.playAuraMove('aura_glide');
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createMediaStreamDestination).not.toHaveBeenCalled();
    ctx.running();
    await Promise.resolve();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    sound.playAuraMove('aura_mog_check');
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    ctx.state = 'suspended'; ctx.dispatchEvent(new Event('statechange'));
    expect(ctx.createOscillator.mock.results.every(result => result.value.connected.size === 0)).toBe(true);
    ctx.running();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    sound.destroy();
  });

  it('treats an unavailable audio device or voice scheduling failure as optional feedback', () => {
    vi.stubGlobal('AudioContext', undefined);
    const unsupported = new SoundManager();
    expect(() => { unsupported.prepareAuraMoveAudio(); unsupported.playAuraMove('aura_glide'); }).not.toThrow();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const sound = new SoundManager();
    sound.prepareAuraMoveAudio();
    const ctx = FakeAudioContext.instances[0];
    ctx.createOscillator.mockImplementationOnce(() => { throw new Error('audio device unavailable'); });
    expect(() => sound.playAuraMove('aura_glide')).not.toThrow();
    sound.destroy();
  });
});
