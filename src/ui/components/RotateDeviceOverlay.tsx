import { useState } from 'react';

type LockableOrientation = ScreenOrientation & {
  lock?: (mode: string) => Promise<void>;
};

function canForceLandscape(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.documentElement.requestFullscreen === 'function' &&
    typeof (screen.orientation as LockableOrientation)?.lock === 'function'
  );
}

/**
 * Landscape enforcement for the fight screen on touch devices, CSS-gated to
 * coarse-pointer portrait. Most phones keep OS auto-rotate locked, and the
 * browser cannot read that setting — but a fullscreen page may still lock
 * its own orientation on Android. So the overlay is a tap target: one tap
 * goes fullscreen and forces landscape regardless of the system rotation
 * lock. iOS has neither API; there the overlay stays a static prompt.
 */
export function RotateDeviceOverlay() {
  const [lockFailed, setLockFailed] = useState(false);
  const interactive = !lockFailed && canForceLandscape();

  const forceLandscape = async () => {
    try {
      await document.documentElement.requestFullscreen();
      await (screen.orientation as LockableOrientation).lock?.('landscape');
    } catch {
      setLockFailed(true);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  if (interactive) {
    return (
      <button type="button" className="rotate-overlay rotate-overlay--tap" onClick={forceLandscape}>
        <span className="rotate-overlay__phone" aria-hidden="true" />
        <span className="rotate-overlay__title">Tap To Rotate</span>
        <span className="rotate-overlay__copy">
          Goes fullscreen and turns the arena sideways — no need to unlock your phone&apos;s rotation.
        </span>
      </button>
    );
  }

  return (
    <div className="rotate-overlay" role="status">
      <span className="rotate-overlay__phone" aria-hidden="true" />
      <p className="rotate-overlay__title">Rotate Your Device</p>
      <p className="rotate-overlay__copy">The arena plays in landscape.</p>
    </div>
  );
}
