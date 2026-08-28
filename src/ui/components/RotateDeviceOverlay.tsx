/**
 * Landscape enforcement for the fight screen on touch devices. Android
 * honors screen.orientation.lock (attempted by GamePage); iOS has no lock
 * API, so this CSS-gated overlay (visible only in coarse-pointer portrait)
 * is the universal fallback.
 */
export function RotateDeviceOverlay() {
  return (
    <div className="rotate-overlay" role="status">
      <span className="rotate-overlay__phone" aria-hidden="true" />
      <p className="rotate-overlay__title">Rotate Your Device</p>
      <p className="rotate-overlay__copy">The arena plays in landscape.</p>
    </div>
  );
}
