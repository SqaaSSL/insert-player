export const BATTLE_MUSIC_URL = '/assets/audio/neon-arena-battle-v1.mp3';
// The source averages roughly -17.6 dBFS. 0.20 keeps it behind impacts while
// remaining audible on phone speakers and remote-browser sessions.
export const BATTLE_MUSIC_VOLUME = 0.20;

export type AuraCrowdReaction = 'applause' | 'cheer' | 'boo';

export const AURA_CROWD_URLS: Record<AuraCrowdReaction, string> = {
  applause: '/assets/audio/aura-crowd-applause-v1.wav',
  cheer: '/assets/audio/aura-crowd-cheer-v1.wav',
  boo: '/assets/audio/aura-crowd-boo-v1.wav',
};

export const AURA_CROWD_LAYERS = [
  { id: 'room-a', reaction: 'applause', playbackRate: 0.93, startAt: 0.18 },
  { id: 'room-b', reaction: 'applause', playbackRate: 1.07, startAt: 1.74 },
  { id: 'hype', reaction: 'cheer', playbackRate: 0.98, startAt: 0.82 },
  { id: 'negative', reaction: 'boo', playbackRate: 1.02, startAt: 0.36 },
] as const satisfies readonly {
  id: string;
  reaction: AuraCrowdReaction;
  playbackRate: number;
  startAt: number;
}[];

interface AuraCrowdLayer {
  audio: HTMLAudioElement;
  config: (typeof AURA_CROWD_LAYERS)[number];
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private battleMusic: HTMLAudioElement | null = null;
  private auraCrowd: AuraCrowdLayer[] = [];
  private auraCrowdRunning = false;
  private auraCrowdStarted = false;
  private auraCrowdHeat = 0;
  private auraCrowdHeatTarget = 0;
  private auraCrowdRoundProgress = 0;
  private auraCrowdNegative = 0;
  private auraCrowdPhase = 0;
  private removeMusicUnlockListeners: (() => void) | null = null;

  startBattleMusic(): void {
    if (typeof Audio === 'undefined') return;

    if (!this.battleMusic) {
      this.battleMusic = new Audio(BATTLE_MUSIC_URL);
      this.battleMusic.loop = true;
      this.battleMusic.preload = 'auto';
      this.battleMusic.volume = BATTLE_MUSIC_VOLUME;
    }

    this.tryPlayBattleMusic();
  }

  pauseBattleMusic(): void {
    this.battleMusic?.pause();
    for (const layer of this.auraCrowd) layer.audio.pause();
  }

  resumeBattleMusic(): void {
    this.tryPlayBattleMusic();
    if (this.auraCrowdRunning) this.tryPlayAuraCrowd();
  }

  /** Current media position for beat-synchronised modes; null while blocked. */
  getBattleMusicTimeMs(): number | null {
    if (!this.battleMusic || this.battleMusic.paused) return null;
    return this.battleMusic.currentTime * 1_000;
  }

  stopBattleMusic(): void {
    this.removeMusicUnlockListeners?.();
    this.removeMusicUnlockListeners = null;
    if (this.battleMusic) {
      this.battleMusic.pause();
      this.battleMusic.currentTime = 0;
      this.battleMusic.volume = BATTLE_MUSIC_VOLUME;
    }
    this.auraCrowdRunning = false;
    this.auraCrowdStarted = false;
    this.auraCrowdHeat = 0;
    this.auraCrowdHeatTarget = 0;
    this.auraCrowdRoundProgress = 0;
    this.auraCrowdNegative = 0;
    this.auraCrowdPhase = 0;
    for (const layer of this.auraCrowd) {
      layer.audio.pause();
      layer.audio.currentTime = 0;
      layer.audio.volume = 0;
    }
  }

  prepareAuraCrowd(): void {
    if (typeof Audio === 'undefined' || this.auraCrowd.length > 0) return;
    for (const config of AURA_CROWD_LAYERS) {
      const crowd = new Audio(AURA_CROWD_URLS[config.reaction]);
      crowd.loop = true;
      crowd.preload = 'auto';
      crowd.volume = 0;
      crowd.playbackRate = config.playbackRate;
      this.auraCrowd.push({ audio: crowd, config });
    }
  }

  startAuraCrowd(): void {
    this.prepareAuraCrowd();
    if (this.auraCrowd.length === 0) return;
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
   * Shape one continuous audience bed. Repeated calls only move gain targets;
   * they never restart a sample, so a streak feels like rising room energy
   * instead of the same reaction clip being triggered on every milestone.
   */
  setAuraCrowdMix(heat: number, roundProgress = 0, negativePunch = 0): void {
    this.auraCrowdHeatTarget = clampUnit(heat);
    this.auraCrowdRoundProgress = clampUnit(roundProgress);
    this.auraCrowdNegative = Math.max(this.auraCrowdNegative, clampUnit(negativePunch));
  }

  peakAuraCrowd(): void {
    this.auraCrowdHeatTarget = 1;
    this.auraCrowdRoundProgress = 1;
    this.auraCrowdNegative = 0;
  }

  updateAuraCrowd(deltaMs: number): void {
    if (this.auraCrowd.length === 0) return;
    const elapsedMs = Math.max(0, Math.min(100, deltaMs));
    if (elapsedMs <= 0) return;

    const heatBlend = 1 - Math.exp(-elapsedMs / 720);
    this.auraCrowdHeat += (this.auraCrowdHeatTarget - this.auraCrowdHeat) * heatBlend;
    this.auraCrowdNegative = Math.max(0, this.auraCrowdNegative - elapsedMs / 3_400);
    this.auraCrowdPhase += elapsedMs / 1_000;

    const energy = clampUnit(this.auraCrowdHeat * 0.84 + this.auraCrowdRoundProgress * 0.16);
    const negative = this.auraCrowdNegative;
    const targets: Record<(typeof AURA_CROWD_LAYERS)[number]['id'], number> = {
      'room-a': (0.034 + energy * 0.05) * (1 + Math.sin(this.auraCrowdPhase * 0.71) * 0.07),
      'room-b': (0.024 + energy * 0.042) * (1 + Math.sin(this.auraCrowdPhase * 0.53 + 2.1) * 0.09),
      hype: Math.pow(energy, 1.65) * 0.125 * (1 - negative * 0.72),
      negative: negative * 0.145,
    };

    for (const layer of this.auraCrowd) {
      const target = clampUnit(targets[layer.config.id]);
      const timeConstant = target > layer.audio.volume ? 420 : 980;
      const volumeBlend = 1 - Math.exp(-elapsedMs / timeConstant);
      layer.audio.volume += (target - layer.audio.volume) * volumeBlend;
    }

    if (this.battleMusic) {
      const targetMusicVolume = BATTLE_MUSIC_VOLUME * (1 - negative * 0.12);
      const musicBlend = 1 - Math.exp(-elapsedMs / 520);
      this.battleMusic.volume += (targetMusicVolume - this.battleMusic.volume) * musicBlend;
    }
  }

  private tryPlayBattleMusic(): void {
    const playback = this.battleMusic?.play();
    if (!playback || typeof playback.catch !== 'function') return;
    void playback.catch(() => this.armMusicUnlock());
  }

  private tryPlayAuraCrowd(): void {
    for (const layer of this.auraCrowd) {
      const playback = layer.audio.play();
      if (!playback || typeof playback.catch !== 'function') continue;
      void playback.catch(() => this.armMusicUnlock());
    }
  }

  private armMusicUnlock(): void {
    if (this.removeMusicUnlockListeners || typeof window === 'undefined') return;

    const unlock = () => {
      this.removeMusicUnlockListeners?.();
      this.removeMusicUnlockListeners = null;
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
      this.ctx.resume();
    }
    return this.ctx;
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
    this.stopBattleMusic();
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
