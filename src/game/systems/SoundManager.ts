export class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

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
  ): void {
    const ctx = this.ensureContext();
    const master = this.getMaster();
    const now = ctx.currentTime;
    const decay = decayMs ?? duration;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer!;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
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
    if (heavy) {
      this.noiseBurst(180, 800, 2, 0.7, 2, 160);
      this.osc('sine', 200, 60, 120, 0.5);
    } else {
      this.noiseBurst(100, 2000, 3, 0.5, 1, 80);
      this.osc('sine', 400, 150, 60, 0.3);
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
    lowpass.frequency.value = 600;
    lowpass.Q.value = 1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

    source.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(master);

    source.start(now);
    source.stop(now + 0.12);

    this.osc('triangle', 150, 80, 80, 0.15);
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
}
