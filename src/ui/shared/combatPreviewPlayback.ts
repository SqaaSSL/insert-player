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
): { toggle: () => void; setMedia: (next: CombatPreviewMedia) => void; destroy: () => void } {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentMedia = media;
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
    if (disposed || !loaded || !isReduced() || reducedFrameShown || video.readyState < 1) return;
    const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : currentMedia.actionTime;
    video.currentTime = Math.min(currentMedia.actionTime, maximum);
    reducedFrameShown = true;
  };
  const update = () => {
    if (disposed) return;
    const visible = inView && !document.hidden;
    if (visible && !loaded) {
      loaded = true;
      video.poster = currentMedia.poster;
      video.src = currentMedia.src;
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
  const onError = () => { if (!disposed && loaded) { failed = true; update(); } };
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
    setMedia: (next) => {
      if (disposed || (next.src === currentMedia.src && next.poster === currentMedia.poster
        && next.actionTime === currentMedia.actionTime)) return;
      // Retire the previous play/load before choosing the responsive capture.
      // User intent belongs to the preview, not to one orientation's resource.
      desiredPlayback = false;
      playbackEpoch += 1;
      video.pause();
      if (loaded) {
        video.removeAttribute('src');
        video.removeAttribute('poster');
        video.preload = 'none';
        // Visible swaps load their replacement in update(). Offscreen swaps
        // still abort the old download, without requesting the next source.
        if (!inView || document.hidden) video.load();
      }
      currentMedia = next;
      loaded = false;
      failed = false;
      playRequired = false;
      reducedFrameShown = false;
      update();
    },
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
