import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { getAllSpritesForHash, type CachedSprite } from '../../services/SpriteCache.ts';
import { loadAiSprites } from './AiSpriteLoader.ts';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../services/SpriteCache.ts', () => ({ getAllSpritesForHash: vi.fn() }));

let failDecode = false;
let afterDecode: (() => void) | undefined;

function sprite(animationName: string): CachedSprite {
  return { photoHash: 'authored-finales', animationName, qualityTier: 'contender',
    pngBlob: new Blob(['decoded-by-test-image']), frameWidth: 8, frameHeight: 8,
    frameCount: 1, animationFormat: 'legacy', createdAt: 1 };
}

function scene() {
  return { game: { renderer: {} }, textures: {
    exists: vi.fn(() => false), remove: vi.fn(), addSpriteSheet: vi.fn(),
  } };
}

beforeEach(() => {
  failDecode = false;
  afterDecode = undefined;
  vi.mocked(getAllSpritesForHash).mockReset();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:authored-finales');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  // The loader's real extraction, fallback resolution and atlas registration run;
  // these small pixel/decoder fixtures isolate capability reporting from rendering.
  vi.stubGlobal('Image', class {
    width = 8;
    height = 8;
    onload?: () => void;
    onerror?: () => void;
    set src(_value: string) {
      queueMicrotask(() => {
        afterDecode?.();
        if (failDecode) this.onerror?.();
        else this.onload?.();
      });
    }
  });
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('canvas');
      const context = {
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        clearRect: vi.fn(), drawImage: vi.fn(),
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
      };
      return { width: 0, height: 0, getContext: (kind: string) => kind === '2d' ? context : null };
    },
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('AI sprite loader authored animation capabilities', () => {
  it.each(['rookie', 'contender'] as const)('reports actual %s victory and KO only after a complete atlas is registered', async (qualityTier) => {
    vi.mocked(getAllSpritesForHash).mockResolvedValue(['idle', 'victory', 'ko'].map(name => ({ ...sprite(name), qualityTier })));
    const runtime = scene();
    const loaded = vi.fn((names: ReadonlySet<string>) => {
      expect(runtime.textures.addSpriteSheet).toHaveBeenCalledOnce();
      expect([...names].sort()).toEqual(['idle', 'ko', 'victory']);
    });
    await expect(loadAiSprites(runtime as unknown as Phaser.Scene, 'finale-complete', 'authored-finales', () => true, loaded)).resolves.toBe(true);
    expect(loaded).toHaveBeenCalledOnce();
  });

  it('does not advertise fallback-filled victory or KO for an idle-only atlas', async () => {
    vi.mocked(getAllSpritesForHash).mockResolvedValue(['idle', 'aura_unbothered'].map(sprite));
    const runtime = scene();
    const loaded = vi.fn();
    await expect(loadAiSprites(runtime as unknown as Phaser.Scene, 'finale-partial', 'authored-finales', () => true, loaded)).resolves.toBe(true);
    expect(runtime.textures.addSpriteSheet).toHaveBeenCalledOnce();
    expect([...loaded.mock.calls[0][0]]).toEqual(['idle']);
    expect(loaded.mock.calls[0][0].has('victory')).toBe(false);
    expect(loaded.mock.calls[0][0].has('ko')).toBe(false);
  });

  it('does not report capabilities from a scene that became stale during decode', async () => {
    vi.mocked(getAllSpritesForHash).mockResolvedValue(['idle', 'victory', 'ko'].map(sprite));
    let current = true;
    afterDecode = () => { current = false; };
    const runtime = scene();
    const loaded = vi.fn();
    await expect(loadAiSprites(runtime as unknown as Phaser.Scene, 'finale-stale', 'authored-finales', () => current, loaded)).resolves.toBe(false);
    expect(runtime.textures.addSpriteSheet).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
  });

  it('does not report a capability when a source cannot decode', async () => {
    vi.mocked(getAllSpritesForHash).mockResolvedValue(['idle', 'victory', 'ko'].map(sprite));
    failDecode = true;
    const runtime = scene();
    const loaded = vi.fn();
    await expect(loadAiSprites(runtime as unknown as Phaser.Scene, 'finale-invalid', 'authored-finales', () => true, loaded)).rejects.toThrow('Failed to load sprite image');
    expect(runtime.textures.addSpriteSheet).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
  });

  it('does not report a capability if texture registration fails after decoding', async () => {
    vi.mocked(getAllSpritesForHash).mockResolvedValue(['idle', 'victory', 'ko'].map(sprite));
    const runtime = scene();
    runtime.textures.addSpriteSheet.mockImplementation(() => { throw new Error('Atlas registration failed'); });
    const loaded = vi.fn();
    await expect(loadAiSprites(runtime as unknown as Phaser.Scene, 'finale-no-atlas', 'authored-finales', () => true, loaded)).rejects.toThrow('Atlas registration failed');
    expect(loaded).not.toHaveBeenCalled();
  });
});
