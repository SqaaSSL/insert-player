import { SpritePreviewCanvas } from './SpritePreviewCanvas.tsx';
import type { PreviewSpriteLike } from '../shared/fighterPreview.ts';

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
    return (
      <>
        <div className="gallery-preview__sprite">
          <SpritePreviewCanvas
            blob={sprite.blob}
            frameWidth={sprite.frameWidth}
            frameHeight={sprite.frameHeight}
            frameCount={sprite.frameCount}
            className="gallery-preview__canvas"
          />
          <small className="gallery-preview__sprite-note">Gameplay-scale runtime preview</small>
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
