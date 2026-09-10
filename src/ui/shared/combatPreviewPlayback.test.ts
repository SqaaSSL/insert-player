import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCombatPreviewPlayback, type CombatPreviewStatus } from './combatPreviewPlayback.ts';

class PreviewVideo extends EventTarget {
  src = '';
  poster = '';
  preload = 'none';
  muted = false;
  loop = false;
  playsInline = false;
  currentTime = 0;
  duration = 8;
  readyState = 0;
  paused = true;
  load = vi.fn();
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
}

let page: EventTarget & { hidden: boolean };
let motion: EventTarget & { matches: boolean };
let visibility: (entries: { isIntersecting: boolean }[]) => void;
let disconnect: ReturnType<typeof vi.fn>;
const media = { src: '/actual-match.mp4', poster: '/actual-match.webp', actionTime: 2 };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  page = Object.assign(new EventTarget(), { hidden: false });
  motion = Object.assign(new EventTarget(), { matches: false });
  disconnect = vi.fn();
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', { matchMedia: () => motion });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof visibility) { visibility = callback; }
    observe() {}
    disconnect = disconnect;
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const video = new PreviewVideo();
  const states: CombatPreviewStatus[] = [];
  const controller = bindCombatPreviewPlayback(video as unknown as HTMLVideoElement, {} as Element, media, state => states.push(state));
  return { video, states, controller };
}

describe('real gameplay preview lifecycle', () => {
  it('loads neither the video nor its poster before visibility and never plays outside the viewport or hidden tab', async () => {
    const { video, states, controller } = mount();
    expect(video.src).toBe('');
    expect(video.poster).toBe('');
    expect(video.play).not.toHaveBeenCalled();
    visibility([{ isIntersecting: true }]);
    await settle();
    expect(video).toMatchObject({ src: media.src, poster: media.poster, muted: true, loop: true, playsInline: true });
    expect(states.at(-1)).toBe('playing');
    visibility([{ isIntersecting: false }]);
    expect(video.paused).toBe(true);
    page.hidden = true;
    visibility([{ isIntersecting: true }]);
    expect(video.play).toHaveBeenCalledTimes(1);
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.load).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('preserves a deliberate pause through visibility changes and resumes only from the control', async () => {
    const { video, controller, states } = mount();
    visibility([{ isIntersecting: true }]);
    await settle();
    controller.toggle();
    visibility([{ isIntersecting: false }]);
    visibility([{ isIntersecting: true }]);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('paused');
    controller.toggle();
    await settle();
    expect(states.at(-1)).toBe('playing');
    controller.destroy();
  });

  it('shows a real action frame for reduced motion, allows explicit playback, and responds to changed preferences', async () => {
    motion.matches = true;
    const { video, controller, states } = mount();
    visibility([{ isIntersecting: true }]);
    expect(video.play).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('reduced-motion');
    video.readyState = 1;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(2);
    controller.toggle();
    await settle();
    expect(states.at(-1)).toBe('playing');
    motion.dispatchEvent(new Event('change'));
    expect(video.paused).toBe(true);
    expect(states.at(-1)).toBe('reduced-motion');
    controller.destroy();
  });

  it('can pause while play is pending and ignores a stale autoplay completion', async () => {
    const { video, states, controller } = mount();
    let complete!: () => void;
    video.play.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    visibility([{ isIntersecting: true }]);
    controller.toggle();
    complete();
    await settle();
    expect(states.at(-1)).toBe('paused');
    expect(video.paused).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('lets the user start playback after the browser rejects autoplay', async () => {
    const { video, states, controller } = mount();
    video.play.mockRejectedValueOnce(new Error('Autoplay blocked'));
    visibility([{ isIntersecting: true }]);
    await settle();
    expect(states.at(-1)).toBe('play-required');
    controller.toggle();
    await settle();
    expect(states.at(-1)).toBe('playing');
    controller.destroy();
  });

  it('retries failed media and releases playback, listeners and downloads on unmount', async () => {
    const { video, states, controller } = mount();
    visibility([{ isIntersecting: true }]);
    await settle();
    video.dispatchEvent(new Event('error'));
    expect(states.at(-1)).toBe('error');
    controller.toggle();
    await settle();
    expect(video.load).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe('playing');
    controller.destroy();
    const plays = video.play.mock.calls.length;
    visibility([{ isIntersecting: true }]);
    page.dispatchEvent(new Event('visibilitychange'));
    expect(video.play).toHaveBeenCalledTimes(plays);
    expect(video.src).toBe('');
    expect(video.paused).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
