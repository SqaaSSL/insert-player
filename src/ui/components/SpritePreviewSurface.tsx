import { SpritePreviewCanvas } from './SpritePreviewCanvas.tsx';
import type { PreviewSpriteLike } from '../shared/fighterPreview.ts';

const PING_PONG_ANIMATIONS = new Set(['high_punch', 'low_punch', 'high_kick', 'low_kick']);

export function previewPlaybackFrameIndices(sprite: PreviewSpriteLike): number[] | undefined {
  if (
    !sprite.rawBlob ||
    !sprite.rawFrameCount ||
    sprite.animationFormat !== 'video-dense-v1' ||
    !sprite.animationName ||
    !PING_PONG_ANIMATIONS.has(sprite.animationName)
  ) {
    return undefined;
  }
  const forward = Array.from({ length: sprite.rawFrameCount }, (_, index) => index);
  return [...forward, ...forward.slice(0, -1).reverse()];
}

interface SpritePreviewSurfaceProps {
  sourceImageUrl?: string | null;
  sprite?: PreviewSpriteLike | null;
  loading?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
}

export function SpritePreviewSurface({
  sourceImageUrl,
  sprite,
  loading,
  loadingLabel = 'Generating',
  emptyLabel = 'No preview',
}: SpritePreviewSurfaceProps) {
  // Loading takes precedence over cached sprite/source — when a regen is in
  // flight we want the user to see "Regenerating..." not the stale blob,
  // otherwise it looks like nothing is happening.
  if (loading) {
    return (
      <div className="preview-loading">
        <div className="preview-loading__orb" aria-hidden="true" />
        <p className="preview-loading__label">{loadingLabel}</p>
        <div className="preview-loading__dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  if (sourceImageUrl) {
    return <img src={sourceImageUrl} alt="" className="gallery-preview__image" />;
  }
  if (sprite) {
    const useRawPreview = Boolean(
      sprite.rawBlob && sprite.rawFrameWidth && sprite.rawFrameHeight && sprite.rawFrameCount,
    );
    return (
      <>
        <div className="gallery-preview__sprite">
          <SpritePreviewCanvas
            blob={useRawPreview ? sprite.rawBlob! : sprite.blob}
            frameWidth={useRawPreview ? sprite.rawFrameWidth! : sprite.frameWidth}
            frameHeight={useRawPreview ? sprite.rawFrameHeight! : sprite.frameHeight}
            frameCount={useRawPreview ? sprite.rawFrameCount! : sprite.frameCount}
            playbackFrameIndices={useRawPreview ? previewPlaybackFrameIndices(sprite) : undefined}
            className="gallery-preview__canvas"
          />
        </div>
        {sprite.failed ? (
          <div className="gallery-preview__warning">
            Showing failed result
            {sprite.reason ? `: ${sprite.reason}` : ''}
          </div>
        ) : null}
      </>
    );
  }
  return <div className="gallery-preview__empty">{emptyLabel}</div>;
}
