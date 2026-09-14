import { SpritePreviewCanvas } from './SpritePreviewCanvas.tsx';
import type { PreviewSpriteLike } from '../shared/fighterPreview.ts';
import { getSpriteSheetPlaybackFrameIndices, selectBestSpriteSheet } from '../../services/SpriteSheetSource.ts';

export function previewPlaybackFrameIndices(sprite: PreviewSpriteLike): number[] | undefined {
  return getSpriteSheetPlaybackFrameIndices(sprite.animationName, sprite.animationFormat, selectBestSpriteSheet(sprite));
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
    const sheet = selectBestSpriteSheet(sprite);
    return (
      <>
        <div className="gallery-preview__sprite">
          <SpritePreviewCanvas
            blob={sheet.blob}
            frameWidth={sheet.frameWidth}
            frameHeight={sheet.frameHeight}
            frameCount={sheet.frameCount}
            playbackFrameIndices={previewPlaybackFrameIndices(sprite)}
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
