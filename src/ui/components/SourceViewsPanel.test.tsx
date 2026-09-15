import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CachedMeta, CachedSprite } from '../../services/SpriteCache.ts';
import { SourceViewsPanel } from './SourceViewsPanel.tsx';
import { FighterPreviewColumn } from './FighterPreviewColumn.tsx';

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
    expect(markup).toContain('<span>Crouch</span><small>Missing</small>');
  });

  it('marks an absent template crouch as optional without changing global Original privacy', () => {
    const markup = renderToStaticMarkup(<SourceViewsPanel meta={metaWithHash('arcade:template-fighter')}
      crouchOptional selectedSource="crouch" onSelectSource={vi.fn()} />);
    expect(markup).toContain('<span>Crouch</span><small>Optional</small>');
    expect(markup).toContain('do not need a crouch photo');
    expect(markup).toContain('<span>Original</span><small>Private reference</small>');
    expect(markup).toContain('<span>Upright</span><small>Missing</small>');
  });

  it('still exposes a saved crouch and shows an explicit optional-source retry in progress', () => {
    const meta = metaWithHash('template-fighter');
    meta.crouchViewBlob = new Blob(['saved crouch'], { type: 'image/png' });
    const props = { meta, crouchOptional: true, selectedSource: 'crouch' as const, onSelectSource: vi.fn() };
    expect(renderToStaticMarkup(<SourceViewsPanel {...props} />)).toContain('<span>Crouch</span><small>Ready</small>');
    expect(renderToStaticMarkup(<SourceViewsPanel {...props} regeneratingSource="crouch" />))
      .toContain('<span>Crouch</span><small>Regenerating...</small>');
  });

  it('explains the optional preview without hiding missing sources for legacy or mixed packs', () => {
    const template = { animationName: 'idle', animationFormat: 'template-atlas-v1', pngBlob: new Blob(['idle']),
      frameWidth: 384, frameHeight: 512, frameCount: 8, qualityTier: 'rookie' } as CachedSprite;
    const legacy = { ...template, animationName: 'walk', animationFormat: 'legacy' } as CachedSprite;
    const render = (sprites: CachedSprite[]) => renderToStaticMarkup(<FighterPreviewColumn meta={metaWithHash('template-fighter')}
      sprites={sprites} selection={{ kind: 'source', source: 'crouch' }} onSelectionChange={vi.fn()}
      loading={false} loadingLabel="Generating" safeName="test" />);
    expect(render([template])).toContain('Optional source. These animations use the upright reference');
    for (const sprites of [[legacy], [template, legacy]]) {
      expect(render(sprites)).toContain('<span>Crouch</span><small>Missing</small>');
      expect(render(sprites)).not.toContain('Optional source.');
    }
  });
});
