import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AURA_CROWD_URLS,
  BATTLE_MUSIC_URL,
  BATTLE_MUSIC_VOLUME,
  SoundManager,
} from './SoundManager.ts';

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly src: string;
  loop = false;
  preload = '';
  volume = 1;
  currentTime = 12;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
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

  it('preloads Aura crowd reactions and scales their intensity', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();

    sound.prepareAuraCrowd();

    expect(FakeAudio.instances.map((track) => track.src)).toEqual([
      AURA_CROWD_URLS.applause,
      AURA_CROWD_URLS.cheer,
      AURA_CROWD_URLS.boo,
    ]);
    expect(FakeAudio.instances.every((track) => track.preload === 'auto')).toBe(true);

    const cheer = FakeAudio.instances[1];
    sound.playAuraCrowd('cheer', 0.5);
    expect(cheer.pause).toHaveBeenCalledOnce();
    expect(cheer.currentTime).toBe(0);
    expect(cheer.volume).toBeCloseTo(0.18);
    expect(cheer.play).toHaveBeenCalledOnce();
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
