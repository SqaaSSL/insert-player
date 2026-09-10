export interface AuraCanvasSize { width: number; height: number; portrait: boolean }

/** Viewport shape, not input hardware: desktop device emulation works too. */
export function getAuraCanvasSize(viewportWidth: number, viewportHeight: number): AuraCanvasSize {
  const portrait = Number.isFinite(viewportWidth) && Number.isFinite(viewportHeight)
    && viewportWidth > 0 && viewportWidth < 768 && viewportHeight > viewportWidth;
  return portrait
    ? { width: 576, height: 1024, portrait: true }
    : { width: 1024, height: 576, portrait: false };
}
