import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CachedMeta } from '../../services/SpriteCache.ts';
import { SourceViewsPanel } from './SourceViewsPanel.tsx';

function metaWithHash(photoHash: string): CachedMeta {
  return {
    photoHash,
    version: 1,
    originalPhotoBlob: null,
    sideViewBlob: new Blob(['side'], { type: 'image/png' }),
    sideViewRawBlob: null,
    uprightViewBlob: null,
    uprightViewRawBlob: null,
    sideViewCleanBlob: null,
    crouchViewBlob: null,
    crouchViewRawBlob: null,
    crouchViewCleanBlob: null,
    noBgBlob: null,
    characterName: 'Test Fighter',
    status: 'ready',
    animationsReady: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('SourceViewsPanel', () => {
  it('presents a global Original as a private reference instead of a missing asset', () => {
    const markup = renderToStaticMarkup(
      <SourceViewsPanel
        meta={metaWithHash('arcade:donald-trump')}
        selectedSource="side"
        onSelectSource={vi.fn()}
      />,
    );

    expect(markup).toMatch(/<button[^>]+disabled=""[^>]+title="The original reference stays private for Arcade globals\."[^>]*>/);
    expect(markup).toContain('<span>Original</span><small>Private reference</small>');
    expect(markup).toContain('<span>Side View</span><small>Ready</small>');
  });

  it('keeps the ordinary missing state for a private fighter without its original', () => {
    const markup = renderToStaticMarkup(
      <SourceViewsPanel
        meta={metaWithHash('fighter-hash')}
        selectedSource="original"
        onSelectSource={vi.fn()}
      />,
    );

    expect(markup).toContain('<span>Original</span><small>Missing</small>');
    expect(markup).not.toContain('Private reference');
    expect(markup).not.toContain('disabled=""');
  });
});
