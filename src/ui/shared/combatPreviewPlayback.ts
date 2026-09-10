export interface CombatPreviewMedia {
  src: string;
  poster: string;
  actionTime: number;
}

export type CombatPreviewStatus = 'loading' | 'playing' | 'paused' | 'reduced-motion' | 'offscreen' | 'play-required' | 'error';

export const COMBAT_PREVIEW_MEDIA: Readonly<Record<'fight' | 'rush', CombatPreviewMedia>> = {
  fight: {
    src: '/assets/insert-player-gameplay-5a19b606.mp4',
    poster: '/assets/play-mode-fight-gameplay-poster-v1.webp',
    actionTime: 2,
  },
  rush: {
    src: '/assets/play-mode-rush-loop-v1.mp4',
    poster: '/assets/play-mode-rush-gameplay-poster-v1.webp',
    actionTime: 8.7,
  },
};

/** Own only this preview element: no game runtime, audio, or offscreen playback.
 * Loading begins on first visibility, including for compact cards. */
export function bindCombatPreviewPlayback(
  video: HTMLVideoElement,
  container: Element,
  media: CombatPreviewMedia,
  onStatus: (status: CombatPreviewStatus) => void,
): { toggle: () => void; destroy: () => void } {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let inView = false;
  let loaded = false;
  let disposed = false;
  let userPaused = false;
  let explicitMotion = false;
  let failed = false;
  let playRequired = false;
  let reducedFrameShown = false;
  let playbackEpoch = 0;
  let desiredPlayback = false;

  const isReduced = () => motion.matches && !explicitMotion;
  const showActionFrame = () => {
    if (!isReduced() || reducedFrameShown || video.readyState < 1) return;
    const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : media.actionTime;
    video.currentTime = Math.min(media.actionTime, maximum);
    reducedFrameShown = true;
  };
  const update = () => {
    if (disposed) return;
    const visible = inView && !document.hidden;
    if (visible && !loaded) {
      loaded = true;
      video.poster = media.poster;
      video.src = media.src;
      video.preload = 'auto';
      video.load();
    }
    desiredPlayback = visible && !userPaused && !isReduced() && !failed;
    const epoch = ++playbackEpoch;
    if (!desiredPlayback) {
      video.pause();
      showActionFrame();
      onStatus(failed ? 'error' : !visible ? 'offscreen' : isReduced() ? 'reduced-motion' : 'paused');
      return;
    }
    playRequired = false;
    onStatus('loading');
    void video.play().then(() => {
      if (disposed || epoch !== playbackEpoch) {
        if (!desiredPlayback) video.pause();
        return;
      }
      onStatus('playing');
    }).catch(() => {
      if (!disposed && epoch === playbackEpoch) { playRequired = true; onStatus('play-required'); }
    });
  };
  const onMotion = () => { explicitMotion = false; reducedFrameShown = false; update(); };
  const onError = () => { failed = true; update(); };
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    update();
  }, { threshold: 0.01 });

  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.addEventListener('loadedmetadata', showActionFrame);
  video.addEventListener('error', onError);
  motion.addEventListener('change', onMotion);
  document.addEventListener('visibilitychange', update);
  if (observer) observer.observe(container);
  else { inView = true; update(); }

  return {
    toggle: () => {
      if (disposed) return;
      if (!loaded) {
        explicitMotion = true;
        userPaused = false;
      } else if (failed) {
        failed = false;
        userPaused = false;
        video.load();
      } else if (isReduced() || playRequired) {
        explicitMotion = true;
        userPaused = false;
      } else userPaused = !userPaused;
      update();
    },
    destroy: () => {
      disposed = true;
      desiredPlayback = false;
      playbackEpoch += 1;
      observer?.disconnect();
      motion.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', update);
      video.removeEventListener('loadedmetadata', showActionFrame);
      video.removeEventListener('error', onError);
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}
