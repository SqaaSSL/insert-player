import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

describe('SoundManager battle music', () => {
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
});
