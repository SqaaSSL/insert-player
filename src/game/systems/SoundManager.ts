import { AuraCrowdDynamics } from './AuraCrowdDynamics.ts';
import { isVerifiedAuraChallengeMusicUrl } from '../aura/AuraChallengeMedia.ts';
import { AURA_MOVE_SOUNDS } from './AuraMoveSound.ts';
import type { AuraAnimationName } from '../../services/FighterAssetPacks.ts';

export const BATTLE_MUSIC_URL = '/assets/audio/neon-arena-battle-v1.mp3';
// The source averages roughly -17.6 dBFS. 0.20 keeps it behind impacts while
// remaining audible on phone speakers and remote-browser sessions.
export const BATTLE_MUSIC_VOLUME = 0.20;

export type AuraCrowdReaction = 'applause' | 'cheer' | 'boo';

export type MusicClockSample =
  | { status: 'unavailable' | 'waiting' }
  | { status: 'playing'; positionMs: number; durationMs: number | null; loop: boolean };

export const AURA_CROWD_URLS: Record<AuraCrowdReaction, string> = {
  applause: '/assets/audio/aura-crowd-applause-v1.wav',
  cheer: '/assets/audio/aura-crowd-cheer-v1.wav',
  boo: '/assets/audio/aura-crowd-boo-v1.wav',
};

export const AURA_CROWD_LAYERS = [
  { id: 'room-a', reaction: 'applause', playbackRate: 0.93, startAt: 0.18, loop: true },
  { id: 'room-b', reaction: 'applause', playbackRate: 1.07, startAt: 1.74, loop: true },
  { id: 'hype', reaction: 'cheer', playbackRate: 1, startAt: 0, loop: false },
  { id: 'negative', reaction: 'boo', playbackRate: 1, startAt: 0, loop: false },
] as const satisfies readonly {
  id: string;
  reaction: AuraCrowdReaction;
  playbackRate: number;
  startAt: number;
  loop: boolean;
}[];

interface AuraCrowdLayer {
  audio: HTMLAudioElement;
  config: (typeof AURA_CROWD_LAYERS)[number];
  active: boolean;
}

interface AuraMoveVoice {
  oscillator: OscillatorNode;
  gain: GainNode;
}

function isLocalAudioUrl(url: string): boolean {
  try {
    const base = typeof window === 'undefined' ? 'https://sound-manager.invalid/' : window.location.href;
    const resolved = new URL(url, base);
    return (resolved.protocol === 'https:' || resolved.protocol === 'http:')
      && resolved.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function createAudio(url: string): HTMLAudioElement {
  const audio = new Audio();
  // Set before src: Web Audio must never reroute a CORS-tainted element,
  // which would replace otherwise audible HTML playback with silence.
  if (isLocalAudioUrl(url) || isVerifiedAuraChallengeMusicUrl(url)) audio.crossOrigin = 'anonymous';
  audio.src = url;
  return audio;
}

export class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private battleMusic: HTMLAudioElement | null = null;
  private battleMusicUrl: string | null = null;
  private auraCrowd: AuraCrowdLayer[] = [];
  private auraCrowdRunning = false;
  private auraCrowdStarted = false;
  private readonly auraCrowdDynamics = new AuraCrowdDynamics();
  private mediaPlaybackPaused = false;
  private removeMusicUnlockListeners: (() => void) | null = null;
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  private mediaSources = new Map<HTMLAudioElement, MediaElementAudioSourceNode>();
  private removeRecordingStateListener: (() => void) | null = null;
  private recordingFailed = false;
  private destroyed = false;
  private auraMoveVoices = new Set<AuraMoveVoice>();
  private lastAuraMoveAt = -Infinity;
  private lastAuraMoveName: AuraAnimationName | null = null;
  private removeAuraMoveStateListener: (() => void) | null = null;

  startBattleMusic(url: string = BATTLE_MUSIC_URL): void {
    if (typeof Audio === 'undefined') return;
    this.mediaPlaybackPaused = false;

    if (this.battleMusic && this.battleMusicUrl !== url) {
      this.battleMusic.pause();
      this.releaseMediaSource(this.battleMusic);
      this.battleMusic = null;
    }
    if (!this.battleMusic) {
      this.battleMusicUrl = url;
      this.battleMusic = createAudio(url);
      this.battleMusic.loop = true;
      this.battleMusic.preload = 'auto';
      this.battleMusic.volume = BATTLE_MUSIC_VOLUME;
    }

    this.connectRecordingMedia();
    this.tryPlayBattleMusic();
  }

  /**
   * A lazy, game-only mix: HTML music/crowd at their existing volumes plus
   * synthesized SFX after masterGain. Never captures microphone/system audio.
   * The caller must clone these tracks; SoundManager owns and stops originals.
   * May be called before music starts. Suspended contexts keep ordinary HTML
   * playback until resumed; unsupported or external media returns no tracks.
   */
  getRecordingAudioTracks(): MediaStreamTrack[] {
    if (this.destroyed || this.recordingFailed || typeof AudioContext === 'undefined') return [];
    if (!this.canRecordMedia()) return [];
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'closed') return [];
      if (!this.recordingDestination) {
        const destination = ctx.createMediaStreamDestination();
        this.recordingDestination = destination;
        // This is a second, inaudible branch, not another speaker connection.
        this.masterGain!.connect(destination);
        const onStateChange = () => {
          if (ctx.state === 'running') this.connectRecordingMedia();
          else if (ctx.state !== 'closed') this.armMusicUnlock();
        };
        ctx.addEventListener('statechange', onStateChange);
        this.removeRecordingStateListener = () => ctx.removeEventListener('statechange', onStateChange);
      }
      this.connectRecordingMedia();
      if (ctx.state !== 'running') this.armMusicUnlock();
      return this.recordingDestination?.stream.getAudioTracks()
        .filter(track => track.readyState === 'live') ?? [];
    } catch {
      this.failRecording();
      return [];
    }
  }

  private canRecordMedia(): boolean {
    return [this.battleMusic, ...this.auraCrowd.map(layer => layer.audio)]
      .every(audio => !audio || (!audio.error && audio.crossOrigin === 'anonymous'
        && (isLocalAudioUrl(audio.src) || isVerifiedAuraChallengeMusicUrl(audio.src))));
  }

  private connectRecordingMedia(): void {
    const ctx = this.ctx;
    const destination = this.recordingDestination;
    if (!ctx || !destination || this.destroyed || this.recordingFailed) return;
    if (!this.canRecordMedia()) {
      this.failRecording();
      return;
    }
    // createMediaElementSource permanently reroutes HTML audio. Do not do it
    // before autoplay unlock: a suspended graph would silence the speakers.
    if (ctx.state !== 'running') return;
    try {
      for (const audio of [this.battleMusic, ...this.auraCrowd.map(layer => layer.audio)]) {
        if (!audio || this.mediaSources.has(audio)) continue;
        const source = ctx.createMediaElementSource(audio);
        source.connect(ctx.destination);
        this.mediaSources.set(audio, source);
        // HTML volume, currentTime, looping and playbackRate remain untouched.
        source.connect(destination);
      }
    } catch {
      // Keep any successful speaker routes even if the recording branch fails.
      this.failRecording();
    }
  }

  private releaseMediaSource(audio: HTMLAudioElement): void {
    this.mediaSources.get(audio)?.disconnect();
    this.mediaSources.delete(audio);
  }

  private failRecording(): void {
    this.recordingFailed = true;
    this.releaseRecordingDestination();
  }

  private releaseRecordingDestination(): void {
    this.removeRecordingStateListener?.();
    this.removeRecordingStateListener = null;
    const destination = this.recordingDestination;
    this.recordingDestination = null;
    if (!destination) return;
    for (const source of [this.masterGain, ...this.mediaSources.values()]) {
      try { source?.disconnect(destination); } catch { /* Not every branch connected successfully. */ }
    }
    for (const track of destination.stream.getTracks()) track.stop();
    destination.disconnect();
  }

  pauseBattleMusic(): void {
    this.mediaPlaybackPaused = true;
    this.stopAuraMoveVoices();
    this.battleMusic?.pause();
    for (const layer of this.auraCrowd) layer.audio.pause();
  }

  resumeBattleMusic(): void {
    this.mediaPlaybackPaused = false;
    if (this.ctx) this.resumeContext(this.ctx);
    this.tryPlayBattleMusic();
    if (this.auraCrowdRunning) this.tryPlayAuraCrowd();
  }

  /** Current media position for beat-synchronised modes; null while blocked. */
  getBattleMusicTimeMs(): number | null {
    const sample = this.getBattleMusicClockSample();
    return sample.status === 'playing' ? sample.positionMs : null;
  }

  /** Waiting/autoplay-blocked media must not be confused with an absent track. */
  getBattleMusicClockSample(): MusicClockSample {
    const music = this.battleMusic;
    if (!music || music.error) return { status: 'unavailable' };
    const positionMs = music.currentTime * 1_000;
    if (music.paused || music.seeking || !Number.isFinite(positionMs) || positionMs < 0
      || (this.mediaSources.has(music) && this.ctx?.state !== 'running')) {
      return { status: 'waiting' };
    }
    return {
      status: 'playing',
      positionMs,
      durationMs: Number.isFinite(music.duration) && music.duration > 0 ? music.duration * 1_000 : null,
      loop: music.loop,
    };
  }

  stopBattleMusic(): void {
    this.mediaPlaybackPaused = true;
    this.stopAuraMoveVoices();
    this.removeMusicUnlockListeners?.();
    this.removeMusicUnlockListeners = null;
    if (this.battleMusic) {
      this.battleMusic.pause();
      this.battleMusic.currentTime = 0;
      this.battleMusic.volume = BATTLE_MUSIC_VOLUME;
    }
    this.auraCrowdRunning = false;
    this.auraCrowdStarted = false;
    this.auraCrowdDynamics.reset();
    for (const layer of this.auraCrowd) {
      layer.audio.pause();
      layer.audio.currentTime = 0;
      layer.audio.volume = 0;
      layer.active = false;
    }
  }

  prepareAuraCrowd(): void {
    if (typeof Audio === 'undefined' || this.auraCrowd.length > 0) return;
    for (const config of AURA_CROWD_LAYERS) {
      const crowd = createAudio(AURA_CROWD_URLS[config.reaction]);
      crowd.loop = config.loop;
      crowd.preload = 'auto';
      crowd.volume = 0;
      crowd.playbackRate = config.playbackRate;
      this.auraCrowd.push({ audio: crowd, config, active: false });
    }
    this.connectRecordingMedia();
  }

  startAuraCrowd(): void {
    this.prepareAuraCrowd();
    if (this.auraCrowd.length === 0) return;
    this.mediaPlaybackPaused = false;
    this.auraCrowdRunning = true;
    if (!this.auraCrowdStarted) {
      this.auraCrowdStarted = true;
      for (const layer of this.auraCrowd) {
        try {
          layer.audio.currentTime = layer.config.startAt;
        } catch {
          // Some browsers defer the initial seek until metadata is available.
        }
      }
    }
    this.tryPlayAuraCrowd();
  }

  /**
   * Slowly build a quiet audience bed. Cheers and boos are bounded reactions,
   * not looping layers; elapsed rounds alone never make the crowd louder.
   */
  setAuraCrowdMix(heat: number, roundProgress = 0, negativePunch = 0): void {
    this.auraCrowdDynamics.setMix(heat, roundProgress, negativePunch);
  }

  peakAuraCrowd(): void {
    this.auraCrowdDynamics.peak();
  }

  updateAuraCrowd(deltaMs: number): void {
    if (!this.auraCrowdRunning || this.mediaPlaybackPaused || this.destroyed) return;
    const frame = this.auraCrowdDynamics.update(deltaMs);
    for (const layer of this.auraCrowd) {
      const start = layer.config.id === 'hype' ? frame.startCheer
        : layer.config.id === 'negative' ? frame.startBoo : false;
      const active = layer.config.loop || (layer.config.id === 'hype' ? frame.cheerActive : frame.booActive);
      layer.audio.volume = frame.gains[layer.config.id];
      if (start) {
        layer.active = true;
        try { layer.audio.currentTime = layer.config.startAt; } catch { /* Metadata may not be ready. */ }
        this.tryPlayCrowdLayer(layer);
      } else if (!active && layer.active) {
        layer.active = false;
        layer.audio.pause();
      }
    }
  }

  private tryPlayBattleMusic(): void {
    if (this.mediaPlaybackPaused || this.destroyed) return;
    const playback = this.battleMusic?.play();
    if (!playback || typeof playback.catch !== 'function') return;
    void playback.catch(() => this.armMusicUnlock());
  }

  private tryPlayAuraCrowd(): void {
    if (this.mediaPlaybackPaused || this.destroyed) return;
    for (const layer of this.auraCrowd) {
      if (layer.config.loop || layer.active) this.tryPlayCrowdLayer(layer);
    }
  }

  private tryPlayCrowdLayer(layer: AuraCrowdLayer): void {
    if (this.mediaPlaybackPaused || this.destroyed || !this.auraCrowdRunning) return;
    const playback = layer.audio.play();
    if (!playback || typeof playback.catch !== 'function') return;
    void playback.catch(() => this.armMusicUnlock());
  }

  private armMusicUnlock(): void {
    if (this.destroyed || this.mediaPlaybackPaused || this.removeMusicUnlockListeners || typeof window === 'undefined') return;

    const unlock = () => {
      this.removeMusicUnlockListeners?.();
      this.removeMusicUnlockListeners = null;
      if (this.ctx) this.resumeContext(this.ctx);
      this.tryPlayBattleMusic();
      if (this.auraCrowdRunning) this.tryPlayAuraCrowd();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    this.removeMusicUnlockListeners = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.4;
      this.masterGain.connect(this.ctx.destination);
      this.noiseBuffer = this.createNoiseBuffer();
    }
    if (this.ctx.state === 'suspended') {
      this.resumeContext(this.ctx);
    }
    return this.ctx;
  }

  private resumeContext(ctx: AudioContext): void {
    try {
      void ctx.resume().then(() => {
        if (!this.destroyed && this.ctx === ctx) this.connectRecordingMedia();
      }).catch(() => {
        if (!this.destroyed) this.armMusicUnlock();
      });
    } catch {
      if (!this.destroyed) this.armMusicUnlock();
    }
  }

  private getMaster(): GainNode {
    this.ensureContext();
    return this.masterGain!;
  }

  private createNoiseBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const sampleRate = ctx.sampleRate;
    const length = sampleRate; // 1 second of noise
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private noiseBurst(
    duration: number,
    frequency: number,
    bandQ: number,
    volume: number,
    attackMs = 2,
    decayMs?: number,
    filterType: BiquadFilterType = 'bandpass',
  ): void {
    const ctx = this.ensureContext();
    const master = this.getMaster();
    const now = ctx.currentTime;
    const decay = decayMs ?? duration;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer!;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = filterType;
    bandpass.frequency.value = frequency;
    bandpass.Q.value = bandQ;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + attackMs / 1000);
    gain.gain.exponentialRampToValueAtTime(0.001, now + decay / 1000);

    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(master);

    source.start(now);
    source.stop(now + duration / 1000);
  }

  private osc(
    type: OscillatorType,
    startFreq: number,
    endFreq: number | null,
    duration: number,
    volume: number,
    startTime = 0,
  ): void {
    const ctx = this.ensureContext();
    const master = this.getMaster();
    const now = ctx.currentTime + startTime / 1000;

    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFreq, now);
    if (endFreq !== null) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(endFreq, 20),
        now + duration / 1000,
      );
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration / 1000);

    oscillator.connect(gain);
    gain.connect(master);

    oscillator.start(now);
    oscillator.stop(now + duration / 1000);
  }

  /** Call inside an explicit user gesture when enabling a silent preview.
   * This unlocks the synth without replaying a move or opening a recording tap. */
  prepareAuraMoveAudio(): void {
    if (this.destroyed || typeof AudioContext === 'undefined') return;
    try {
      const ctx = this.ensureContext();
      if (!this.removeAuraMoveStateListener) {
        const onStateChange = () => {
          if (ctx.state !== 'running') this.stopAuraMoveVoices();
        };
        ctx.addEventListener('statechange', onStateChange);
        this.removeAuraMoveStateListener = () => ctx.removeEventListener('statechange', onStateChange);
      }
    } catch { /* Audio is optional; unavailable devices must not interrupt play. */ }
  }

  /** One signature per new move bubble, never per frame or scored note. No
   * blocked sound is queued: an old bubble must stay silent after autoplay unlock. */
  playAuraMove(name: AuraAnimationName): void {
    if (this.destroyed || this.mediaPlaybackPaused || typeof AudioContext === 'undefined') return;
    const tones = AURA_MOVE_SOUNDS[name];
    if (!tones) return;
    this.prepareAuraMoveAudio();
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const cooldown = this.lastAuraMoveName === name ? 0.65 : 0.32;
    if (now - this.lastAuraMoveAt < cooldown) return;
    this.lastAuraMoveAt = now;
    this.lastAuraMoveName = name;
    try {
      for (const tone of tones) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const voice = { oscillator, gain };
        this.auraMoveVoices.add(voice);
        oscillator.onended = () => this.releaseAuraMoveVoice(voice);
        const start = now + tone.delayMs / 1_000;
        const end = start + tone.durationMs / 1_000;
        oscillator.type = tone.wave;
        oscillator.frequency.setValueAtTime(tone.fromHz, start);
        oscillator.frequency.exponentialRampToValueAtTime(tone.toHz, end);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(tone.gain, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start);
        oscillator.stop(end + 0.008);
      }
    } catch {
      this.stopAuraMoveVoices();
    }
  }

  private releaseAuraMoveVoice(voice: AuraMoveVoice): void {
    if (!this.auraMoveVoices.delete(voice)) return;
    voice.oscillator.onended = null;
    voice.oscillator.disconnect();
    voice.gain.disconnect();
  }

  private stopAuraMoveVoices(): void {
    for (const voice of this.auraMoveVoices) {
      try { voice.oscillator.stop(this.ctx?.currentTime ?? 0); } catch { /* Already ended. */ }
      this.releaseAuraMoveVoice(voice);
    }
    this.lastAuraMoveAt = -Infinity;
    this.lastAuraMoveName = null;
  }

  playHit(heavy: boolean): void {
    // Bassy arcade thump: low square drop + lowpass-filtered noise.
    if (heavy) {
      this.osc('square', 95, 38, 170, 0.5);
      this.noiseBurst(200, 200, 1, 0.65, 2, 180, 'lowpass');
      this.osc('sine', 70, 34, 200, 0.35);
    } else {
      this.osc('square', 120, 50, 110, 0.4);
      this.noiseBurst(130, 240, 1, 0.5, 1, 110, 'lowpass');
    }
  }

  playBlock(): void {
    const ctx = this.ensureContext();
    const master = this.getMaster();
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer!;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 900;
    lowpass.Q.value = 1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    source.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(master);

    source.start(now);
    source.stop(now + 0.12);

    this.osc('triangle', 680, 260, 90, 0.16);
  }

  playWhoosh(): void {
    const ctx = this.ensureContext();
    const master = this.getMaster();
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer!;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(4000, now);
    bandpass.frequency.exponentialRampToValueAtTime(800, now + 0.12);
    bandpass.Q.value = 2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    source.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(master);

    source.start(now);
    source.stop(now + 0.15);
  }

  playKO(): void {
    this.noiseBurst(400, 400, 1, 0.8, 5, 350);
    this.osc('sine', 120, 30, 400, 0.6);
    this.osc('sawtooth', 80, 25, 500, 0.3, 50);
  }

  playFireball(): void {
    this.osc('sawtooth', 200, 1200, 250, 0.25);
    this.noiseBurst(300, 3000, 2, 0.2, 5, 280);
  }

  playUppercut(): void {
    this.osc('sawtooth', 200, 800, 120, 0.35);
    this.noiseBurst(150, 1200, 2, 0.5, 2, 130);
    this.osc('sine', 300, 100, 80, 0.3, 80);
  }

  playAnnounce(type: 'round' | 'fight' | 'ko' | 'wins'): void {
    switch (type) {
      case 'round':
        this.osc('square', 440, null, 150, 0.2);
        this.osc('square', 550, null, 150, 0.2, 160);
        break;
      case 'fight':
        this.osc('square', 330, null, 100, 0.2);
        this.osc('square', 440, null, 100, 0.2, 110);
        this.osc('square', 550, null, 100, 0.2, 220);
        this.osc('sawtooth', 660, null, 300, 0.25, 330);
        break;
      case 'ko':
        this.osc('sawtooth', 600, null, 200, 0.25);
        this.osc('sawtooth', 400, null, 200, 0.25, 210);
        this.osc('sawtooth', 200, null, 400, 0.3, 420);
        break;
      case 'wins':
        this.osc('square', 523, null, 150, 0.2);
        this.osc('square', 659, null, 150, 0.2, 160);
        this.osc('square', 784, null, 150, 0.2, 320);
        this.osc('sawtooth', 523, null, 500, 0.15, 480);
        this.osc('sawtooth', 659, null, 500, 0.15, 480);
        this.osc('sawtooth', 784, null, 500, 0.15, 480);
        break;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopBattleMusic();
    this.removeAuraMoveStateListener?.();
    this.removeAuraMoveStateListener = null;
    this.releaseRecordingDestination();
    for (const source of this.mediaSources.values()) source.disconnect();
    this.mediaSources.clear();
    if (this.battleMusic) {
      this.battleMusic.removeAttribute('src');
      this.battleMusic.load();
      this.battleMusic = null;
    }
    for (const layer of this.auraCrowd) {
      layer.audio.removeAttribute('src');
      layer.audio.load();
    }
    this.auraCrowd = [];
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.noiseBuffer = null;
    const context = this.ctx;
    this.ctx = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {
        // Audio teardown is best effort while the Phaser scene is leaving.
      });
    }
  }
}
