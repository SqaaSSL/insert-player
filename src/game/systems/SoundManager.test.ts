import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AURA_CROWD_LAYERS,
  AURA_CROWD_URLS,
  BATTLE_MUSIC_URL,
  BATTLE_MUSIC_VOLUME,
  SoundManager,
} from './SoundManager.ts';

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  crossOrigin: string | null = null;
  loop = false;
  preload = '';
  volume = 1;
  playbackRate = 1;
  currentTime = 12;
  paused = true;
  seeking = false;
  duration = 120;
  error: { code: number } | null = null;
  play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn();
  load = vi.fn();

  constructor(src = '') {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

function advanceCrowd(sound: SoundManager, durationMs: number): void {
  for (let elapsed = 0; elapsed < durationMs; elapsed += 100) {
    sound.updateAuraCrowd(Math.min(100, durationMs - elapsed));
  }
}

describe('SoundManager media', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudio.instances = [];
  });

  it('starts one quiet looping track and reuses it', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();

    sound.startBattleMusic();
    sound.startBattleMusic();

    expect(FakeAudio.instances).toHaveLength(1);
    const track = FakeAudio.instances[0];
    expect(track.src).toBe(BATTLE_MUSIC_URL);
    expect(track.loop).toBe(true);
    expect(track.preload).toBe('auto');
    expect(track.volume).toBe(BATTLE_MUSIC_VOLUME);
    expect(track.play).toHaveBeenCalledTimes(2);
  });

  it('stops and releases the track during teardown', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startBattleMusic();
    const track = FakeAudio.instances[0];

    sound.destroy();

    expect(track.pause).toHaveBeenCalledOnce();
    expect(track.currentTime).toBe(0);
    expect(track.removeAttribute).toHaveBeenCalledWith('src');
    expect(track.load).toHaveBeenCalledOnce();
  });

  it('distinguishes missing, autoplay-blocked, invalid and playing media clock samples', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    expect(sound.getBattleMusicClockSample()).toEqual({ status: 'unavailable' });
    sound.startBattleMusic('/assets/audio/aura-selected.mp3');
    const track = FakeAudio.instances[0];
    track.paused = true;
    expect(sound.getBattleMusicClockSample()).toEqual({ status: 'waiting' });
    expect(sound.getBattleMusicTimeMs()).toBeNull();
    track.paused = false;
    track.currentTime = 0;
    expect(sound.getBattleMusicClockSample()).toEqual({ status: 'playing', positionMs: 0, durationMs: 120_000, loop: true });
    track.currentTime = NaN;
    expect(sound.getBattleMusicClockSample()).toEqual({ status: 'waiting' });
    track.currentTime = 12;
    track.seeking = true;
    expect(sound.getBattleMusicClockSample()).toEqual({ status: 'waiting' });
    track.seeking = false;
    track.error = { code: 4 };
    expect(sound.getBattleMusicClockSample()).toEqual({ status: 'unavailable' });
  });

  it('switches the selected Aura track without keeping the prior music clock', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startBattleMusic('/first.mp3');
    sound.startBattleMusic('/second.mp3');
    expect(FakeAudio.instances[0].pause).toHaveBeenCalledOnce();
    FakeAudio.instances[1].currentTime = 0.5;
    expect(sound.getBattleMusicTimeMs()).toBe(500);
  });

  it('preloads two desynchronised room loops and two silent one-shot reactions', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();

    sound.prepareAuraCrowd();

    expect(FakeAudio.instances.map((track) => track.src)).toEqual([
      AURA_CROWD_URLS.applause,
      AURA_CROWD_URLS.applause,
      AURA_CROWD_URLS.cheer,
      AURA_CROWD_URLS.boo,
    ]);
    expect(FakeAudio.instances.every((track) => track.preload === 'auto')).toBe(true);
    expect(FakeAudio.instances.map((track) => track.loop)).toEqual([true, true, false, false]);
    expect(FakeAudio.instances.every((track) => track.volume === 0)).toBe(true);
    expect(FakeAudio.instances.every((track) => track.play.mock.calls.length === 0)).toBe(true);
    expect(FakeAudio.instances.map((track) => track.playbackRate)).toEqual(
      AURA_CROWD_LAYERS.map((layer) => layer.playbackRate),
    );
  });

  it('starts only the room loops and gradually raises a bounded bed without early cheers', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();

    sound.startAuraCrowd();
    expect(FakeAudio.instances.map((track) => track.play.mock.calls.length)).toEqual([1, 1, 0, 0]);
    expect(FakeAudio.instances.slice(0, 2).map((track) => track.currentTime)).toEqual(
      AURA_CROWD_LAYERS.slice(0, 2).map((layer) => layer.startAt),
    );

    sound.setAuraCrowdMix(1, 1);
    sound.updateAuraCrowd(100);
    const initialBed = FakeAudio.instances[0].volume + FakeAudio.instances[1].volume;
    advanceCrowd(sound, 4_900);
    const builtBed = FakeAudio.instances[0].volume + FakeAudio.instances[1].volume;
    expect(builtBed).toBeGreaterThan(initialBed);
    expect(builtBed).toBeLessThanOrEqual(0.034);
    expect(FakeAudio.instances[2].play).not.toHaveBeenCalled();
    expect(FakeAudio.instances[3].play).not.toHaveBeenCalled();
    expect(FakeAudio.instances.slice(0, 2).every((track) => track.play.mock.calls.length === 1)).toBe(true);
  });

  it('never cheers for round progress alone or repeats a cheer during sustained high heat', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startAuraCrowd();
    sound.setAuraCrowdMix(0, 1);
    advanceCrowd(sound, 30_000);
    const hype = FakeAudio.instances[2];
    expect(hype.play).not.toHaveBeenCalled();

    for (let frame = 0; frame < 600; frame += 1) {
      sound.setAuraCrowdMix(1, 1);
      sound.updateAuraCrowd(100);
      expect(hype.volume).toBeLessThanOrEqual(0.055);
      expect(FakeAudio.instances[0].volume + FakeAudio.instances[1].volume).toBeLessThanOrEqual(0.034);
    }
    expect(hype.play).toHaveBeenCalledOnce();
    expect(hype.loop).toBe(false);
    expect(hype.volume).toBe(0);
    expect(hype.paused).toBe(true);
    expect(FakeAudio.instances.slice(0, 2).every((track) => track.play.mock.calls.length === 1)).toBe(true);
  });

  it('plays at most one victory reaction and never restarts it after it expires', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startAuraCrowd();
    sound.peakAuraCrowd();
    sound.updateAuraCrowd(100);
    const hype = FakeAudio.instances[2];
    expect(hype.play).toHaveBeenCalledOnce();
    advanceCrowd(sound, 3_000);
    sound.peakAuraCrowd();
    advanceCrowd(sound, 20_000);
    sound.pauseBattleMusic();
    sound.resumeBattleMusic();
    expect(hype.play).toHaveBeenCalledOnce();
    expect(hype.volume).toBe(0);
  });

  it('does not seek, replay or extend a cheer already playing when victory arrives', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startAuraCrowd();
    sound.setAuraCrowdMix(1);
    const hype = FakeAudio.instances[2];
    for (let elapsed = 0; elapsed < 12_000 && hype.play.mock.calls.length === 0; elapsed += 100) {
      sound.updateAuraCrowd(100);
    }
    expect(hype.play).toHaveBeenCalledOnce();
    advanceCrowd(sound, 500);
    hype.currentTime = 1.25;
    sound.peakAuraCrowd();
    sound.updateAuraCrowd(100);
    expect(hype.play).toHaveBeenCalledOnce();
    expect(hype.currentTime).toBe(1.25);
    advanceCrowd(sound, 1_500);
    expect(hype.paused).toBe(false);
    sound.updateAuraCrowd(100);
    expect(hype.volume).toBe(0);
    expect(hype.paused).toBe(true);
    expect(hype.play).toHaveBeenCalledOnce();
    expect(hype.currentTime).toBe(1.25);
  });

  it('plays brief quiet boos without replaying repeated negative judgements', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startAuraCrowd();
    const boo = FakeAudio.instances[3];
    for (let frame = 0; frame < 40; frame += 1) {
      sound.setAuraCrowdMix(0.2, 1, 0.9);
      sound.updateAuraCrowd(100);
      expect(boo.volume).toBeLessThanOrEqual(0.025);
    }
    expect(boo.loop).toBe(false);
    expect(boo.play).toHaveBeenCalledOnce();
    expect(boo.volume).toBe(0);
    expect(boo.paused).toBe(true);
    sound.pauseBattleMusic(); sound.resumeBattleMusic();
    expect(boo.play).toHaveBeenCalledOnce();
    expect(FakeAudio.instances[2].play).not.toHaveBeenCalled();
  });

  it('does not retry an autoplay-blocked reaction after its envelope has expired', async () => {
    vi.stubGlobal('Audio', FakeAudio);
    const fakeWindow = Object.assign(new EventTarget(), { location: { href: 'https://insertplayer.ai/fight' } });
    vi.stubGlobal('window', fakeWindow);
    const sound = new SoundManager();
    sound.startAuraCrowd();
    const hype = FakeAudio.instances[2];
    hype.play.mockRejectedValueOnce(new Error('autoplay denied'));
    sound.peakAuraCrowd();
    sound.updateAuraCrowd(100);
    await Promise.resolve();
    advanceCrowd(sound, 3_000);
    fakeWindow.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(FakeAudio.instances.map(track => track.play.mock.calls.length)).toEqual([2, 2, 1, 0]);
    expect(hype.volume).toBe(0);
    expect(hype.paused).toBe(true);
  });

  it('freezes crowd envelopes while paused and resumes an active reaction without rewinding', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startAuraCrowd();
    sound.peakAuraCrowd();
    advanceCrowd(sound, 500);
    const hype = FakeAudio.instances[2];
    expect(hype.play).toHaveBeenCalledOnce();
    expect(hype.volume).toBeGreaterThan(0);
    hype.currentTime = 1.23;
    sound.pauseBattleMusic();
    const pausedVolumes = FakeAudio.instances.map((track) => track.volume);
    advanceCrowd(sound, 30_000);
    expect(FakeAudio.instances.map((track) => track.volume)).toEqual(pausedVolumes);
    expect(hype.play).toHaveBeenCalledOnce();

    sound.resumeBattleMusic();
    expect(hype.currentTime).toBe(1.23);
    expect(hype.play).toHaveBeenCalledTimes(2);
    advanceCrowd(sound, 3_000);
    expect(hype.volume).toBe(0);
    expect(hype.paused).toBe(true);
    expect(FakeAudio.instances[3].play).not.toHaveBeenCalled();
  });

  it('resets reactions on stop and permits one fresh victory on the next run', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startAuraCrowd();
    sound.peakAuraCrowd();
    advanceCrowd(sound, 500);
    sound.stopBattleMusic();
    expect(FakeAudio.instances.every((track) => track.volume === 0 && track.currentTime === 0)).toBe(true);
    advanceCrowd(sound, 10_000);
    sound.resumeBattleMusic();
    expect(FakeAudio.instances[2].play).toHaveBeenCalledOnce();
    sound.startAuraCrowd();
    expect(FakeAudio.instances.map((track) => track.play.mock.calls.length)).toEqual([2, 2, 1, 0]);
    sound.peakAuraCrowd();
    sound.updateAuraCrowd(100);
    expect(FakeAudio.instances[2].play).toHaveBeenCalledTimes(2);
  });

  it('keeps every media volume finite when callers supply invalid heat, progress or frame deltas', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.startBattleMusic();
    sound.startAuraCrowd();
    for (const value of [NaN, Infinity, -Infinity, -1, 2]) {
      sound.setAuraCrowdMix(value, value, value);
      sound.updateAuraCrowd(value);
      sound.updateAuraCrowd(100);
      for (const track of FakeAudio.instances) {
        expect(Number.isFinite(track.volume)).toBe(true);
        expect(track.volume).toBeGreaterThanOrEqual(0);
        expect(track.volume).toBeLessThanOrEqual(1);
      }
    }
  });

  it('releases Aura crowd clips during teardown', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();
    sound.prepareAuraCrowd();

    sound.destroy();

    for (const crowd of FakeAudio.instances) {
      expect(crowd.pause).toHaveBeenCalledOnce();
      expect(crowd.currentTime).toBe(0);
      expect(crowd.removeAttribute).toHaveBeenCalledWith('src');
      expect(crowd.load).toHaveBeenCalledOnce();
    }
  });
});
