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
  loadedSources: string[] = [];
  load = vi.fn(() => { this.loadedSources.push(this.src); this.readyState = 0; this.currentTime = 0; });
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
    if (name === 'poster') this.poster = '';
  });
}

let page: EventTarget & { hidden: boolean };
let motion: EventTarget & { matches: boolean };
let visibility: (entries: { isIntersecting: boolean }[]) => void;
let disconnect: ReturnType<typeof vi.fn>;
const media = { src: '/actual-match.mp4', poster: '/actual-match.webp', actionTime: 2 };
const portraitMedia = { src: '/actual-match-portrait.mp4', poster: '/actual-match-portrait.webp', actionTime: 5 };
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

  it('changes the visible capture and ignores equivalent media without restarting playback', async () => {
    const { video, states, controller } = mount();
    visibility([{ isIntersecting: true }]);
    await settle();
    controller.setMedia(portraitMedia);
    await settle();
    expect(video).toMatchObject({ src: portraitMedia.src, poster: portraitMedia.poster, paused: false });
    expect(video.loadedSources).toEqual([media.src, portraitMedia.src]);
    expect(states.at(-1)).toBe('playing');
    controller.setMedia({ ...portraitMedia });
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.load).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it('preserves manual pause across a visible source change and visibility changes', async () => {
    const { video, states, controller } = mount();
    visibility([{ isIntersecting: true }]);
    await settle();
    controller.toggle();
    controller.setMedia(portraitMedia);
    visibility([{ isIntersecting: false }]);
    visibility([{ isIntersecting: true }]);
    await settle();
    expect(video).toMatchObject({ src: portraitMedia.src, paused: true });
    expect(states.at(-1)).toBe('paused');
    expect(video.play).toHaveBeenCalledTimes(1);
    controller.toggle();
    await settle();
    expect(states.at(-1)).toBe('playing');
    controller.destroy();
  });

  it('chooses the latest source before first visibility without loading discarded videos or posters', async () => {
    const { video, states, controller } = mount();
    controller.setMedia(portraitMedia);
    controller.setMedia(media);
    controller.setMedia(portraitMedia);
    expect(video).toMatchObject({ src: '', poster: '' });
    expect(video.load).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('offscreen');
    visibility([{ isIntersecting: true }]);
    await settle();
    expect(video.loadedSources).toEqual([portraitMedia.src]);
    expect(video.poster).toBe(portraitMedia.poster);
    controller.destroy();
  });

  it.each(['offscreen', 'hidden-tab'])('releases a loaded source during an %s swap and waits for visibility', async (reason) => {
    const { video, states, controller } = mount();
    visibility([{ isIntersecting: true }]);
    await settle();
    if (reason === 'offscreen') visibility([{ isIntersecting: false }]);
    else { page.hidden = true; page.dispatchEvent(new Event('visibilitychange')); }
    controller.setMedia(portraitMedia);
    expect(video).toMatchObject({ src: '', poster: '', paused: true, preload: 'none' });
    expect(video.loadedSources).toEqual([media.src, '']);
    expect(states.at(-1)).toBe('offscreen');
    // A late event from the retired load cannot poison the pending capture.
    video.dispatchEvent(new Event('error'));
    if (reason === 'offscreen') visibility([{ isIntersecting: true }]);
    else { page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); }
    await settle();
    expect(video.loadedSources).toEqual([media.src, '', portraitMedia.src]);
    expect(states.at(-1)).toBe('playing');
    controller.destroy();
  });

  it('retains explicit playback permission under reduced motion when the source changes', async () => {
    motion.matches = true;
    const { video, states, controller } = mount();
    visibility([{ isIntersecting: true }]);
    controller.toggle();
    await settle();
    controller.setMedia(portraitMedia);
    await settle();
    expect(video).toMatchObject({ src: portraitMedia.src, paused: false });
    expect(states.at(-1)).toBe('playing');
    controller.destroy();
  });

  it('shows the new reduced-motion action frame and clears a previous media failure on swap', async () => {
    motion.matches = true;
    const { video, states, controller } = mount();
    visibility([{ isIntersecting: true }]);
    video.readyState = 1;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(media.actionTime);
    video.dispatchEvent(new Event('error'));
    expect(states.at(-1)).toBe('error');
    controller.setMedia(portraitMedia);
    expect(video.currentTime).toBe(0);
    video.readyState = 1;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(portraitMedia.actionTime);
    expect(states.at(-1)).toBe('reduced-motion');
    expect(video.play).not.toHaveBeenCalled();
    controller.destroy();
  });

  it.each(['resolve', 'reject'])('ignores a stale %s from the old source while its replacement is pending', async (outcome) => {
    const { video, states, controller } = mount();
    let resolveOld!: () => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: () => void;
    video.play.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
    video.play.mockImplementationOnce(() => new Promise<void>(resolve => { resolveNew = resolve; }));
    visibility([{ isIntersecting: true }]);
    controller.setMedia(portraitMedia);
    const pauses = video.pause.mock.calls.length;
    if (outcome === 'resolve') resolveOld();
    else rejectOld(new Error('Old source cancelled'));
    await settle();
    expect(states.at(-1)).toBe('loading');
    expect(video.pause).toHaveBeenCalledTimes(pauses);
    resolveNew();
    await settle();
    expect(states.at(-1)).toBe('playing');
    controller.destroy();
  });

  it('cannot resume a paused replacement from an old play promise or set media after destruction', async () => {
    const { video, states, controller } = mount();
    let complete!: () => void;
    video.play.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    visibility([{ isIntersecting: true }]);
    controller.toggle();
    controller.setMedia(portraitMedia);
    complete();
    await settle();
    expect(states.at(-1)).toBe('paused');
    expect(video.paused).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(1);
    controller.destroy();
    const loads = video.load.mock.calls.length;
    controller.setMedia(media);
    expect(video.src).toBe('');
    expect(video.load).toHaveBeenCalledTimes(loads);
  });
});
