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
  readonly src: string;
  loop = false;
  preload = '';
  volume = 1;
  playbackRate = 1;
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

  it('preloads desynchronised looping layers for one continuous Aura crowd', () => {
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
    expect(FakeAudio.instances.every((track) => track.loop)).toBe(true);
    expect(FakeAudio.instances.every((track) => track.volume === 0)).toBe(true);
    expect(FakeAudio.instances.map((track) => track.playbackRate)).toEqual(
      AURA_CROWD_LAYERS.map((layer) => layer.playbackRate),
    );
  });

  it('morphs crowd gain without restarting clips for repeated judgements', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const sound = new SoundManager();

    sound.startAuraCrowd();
    expect(FakeAudio.instances.every((track) => track.play.mock.calls.length === 1)).toBe(true);
    expect(FakeAudio.instances.map((track) => track.currentTime)).toEqual(
      AURA_CROWD_LAYERS.map((layer) => layer.startAt),
    );

    sound.setAuraCrowdMix(1, 1);
    for (let frame = 0; frame < 20; frame += 1) sound.updateAuraCrowd(100);
    const hype = FakeAudio.instances[2];
    expect(hype.volume).toBeGreaterThan(0.05);

    sound.setAuraCrowdMix(0.2, 1, 0.9);
    sound.setAuraCrowdMix(0.2, 1, 0.9);
    for (let frame = 0; frame < 4; frame += 1) sound.updateAuraCrowd(100);
    const negative = FakeAudio.instances[3];
    expect(negative.volume).toBeGreaterThan(0.03);
    expect(FakeAudio.instances.every((track) => track.play.mock.calls.length === 1)).toBe(true);
    expect(FakeAudio.instances.every((track) => track.pause.mock.calls.length === 0)).toBe(true);
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
