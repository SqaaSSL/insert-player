import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SpritePreviewCanvas,
  spritePreviewRenderSize,
} from './SpritePreviewCanvas.tsx';

describe('SpritePreviewCanvas', () => {
  it('uses a two-times backing buffer for a smoothly interpolated preview', () => {
    expect(spritePreviewRenderSize(192, 256)).toEqual({ width: 384, height: 512 });

    const markup = renderToStaticMarkup(
      <SpritePreviewCanvas
        blob={new Blob(['sheet'], { type: 'image/png' })}
        frameWidth={192}
        frameHeight={256}
        frameCount={6}
        className="gallery-preview__canvas"
      />,
    );

    expect(markup).toContain('width="384"');
    expect(markup).toContain('height="512"');
    expect(markup).toContain('aria-label="Gameplay-scale animation preview"');
  });

  it('never creates a zero-sized backing buffer', () => {
    expect(spritePreviewRenderSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});
