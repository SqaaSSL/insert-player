import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CachedMeta, CachedSprite } from '../../services/SpriteCache.ts';
import { FighterPreviewColumn, useFighterPreview, type FighterPreviewState } from './FighterPreviewColumn.tsx';

const pngBlob = new Blob(['gameplay']);
const rawPngBlob = new Blob(['clean HQ']);
const meta = { photoHash: 'fighter', characterName: 'Fighter' } as CachedMeta;
const sprite: CachedSprite = {
  photoHash: 'fighter', animationName: 'high_kick', qualityTier: 'champion',
  pngBlob, rawPngBlob, frameWidth: 192, frameHeight: 256, frameCount: 23,
  rawFrameWidth: 768, rawFrameHeight: 1024, rawFrameCount: 12,
  animationFormat: 'video-dense-v1', createdAt: 1,
};

function stateFor(sprites: CachedSprite[]): FighterPreviewState {
  let result: FighterPreviewState | undefined;
  function Probe() {
    result = useFighterPreview(meta, sprites, { kind: 'animation', animationName: 'high_kick' });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result!;
}

describe('fighter preview downloads', () => {
  it('hands the PNG download the exact native blob while retaining both sources for preview', () => {
    const state = stateFor([sprite]);
    expect(state.previewBlob).toBe(rawPngBlob);
    expect(state.previewSprite?.blob).toBe(pngBlob);
    expect(state.previewSprite?.rawBlob).toBe(rawPngBlob);
  });

  it('downloads the clean processed sheet for legacy sprites instead of unfinished RAW', () => {
    expect(stateFor([{ ...sprite, animationFormat: 'legacy' }]).previewBlob).toBe(pngBlob);
  });

  it('keeps one PNG and one GIF action and shows encoding feedback without a quality selector', () => {
    const markup = renderToStaticMarkup(<FighterPreviewColumn
      meta={meta} sprites={[sprite]} selection={{ kind: 'animation', animationName: 'high_kick' }}
      onSelectionChange={() => {}} loading={false} loadingLabel="Loading" safeName="fighter"
      onSaveGif={() => {}} savingGif
    />);
    expect(markup.match(/>Save PNG<\/button>/g)).toHaveLength(1);
    expect(markup).toContain('Preparing GIF...');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Preparing GIF/);
    expect(markup).not.toContain('<select');
  });

  it('shows PNG preparation and blocks other downloads while its best source loads', () => {
    const markup = renderToStaticMarkup(<FighterPreviewColumn
      meta={meta} sprites={[sprite]} selection={{ kind: 'animation', animationName: 'high_kick' }}
      onSelectionChange={() => {}} loading={false} loadingLabel="Loading" safeName="fighter"
      onSavePng={() => {}} onSaveGif={() => {}} savingPng downloadsDisabled
    />);

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Preparing PNG/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save GIF/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save RAW/);
  });
});
