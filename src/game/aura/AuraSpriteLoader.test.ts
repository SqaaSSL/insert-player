import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import type { AuraAtlasGeometry } from './AuraPoseCalibration.ts';
import { AURA_ANIMATION_NAMES, type AuraAnimationName } from '../../services/FighterAssetPacks.ts';

const mocks = vi.hoisted(() => ({
  cache: vi.fn(), meta: vi.fn(), measure: vi.fn(), hash: vi.fn(), info: vi.fn(), warn: vi.fn(),
}));
vi.mock('phaser', () => ({ default: {} }));
vi.mock('../../services/SpriteCache.ts', () => ({ getAllSpritesForHash: mocks.cache, getCachedMeta: mocks.meta }));
vi.mock('../../services/DebugLog.ts', () => ({ debugInfo: mocks.info, debugWarn: mocks.warn }));
vi.mock('./AuraPoseCalibration.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./AuraPoseCalibration.ts')>(),
  // Only browser decoding/hash/alpha measurement are replaced. Registration,
  // hash-bound template selection and pack-wide idle calibration remain real.
  measureAuraAtlas: mocks.measure,
  auraAtlasContentHash: mocks.hash,
}));

import { AURA_POSE_TEMPLATES } from './AuraPoseTemplates.ts';
import { destroyLoadedAuraAnimationPack, loadAuraAnimationPack } from './AuraSpriteLoader.ts';

type CachedSprite = Awaited<ReturnType<typeof import('../../services/SpriteCache.ts').getAllSpritesForHash>>[number];
const geometryByName = new Map<string, AuraAtlasGeometry>();
const geometryByBlob = new Map<Blob, AuraAtlasGeometry>();
let network: ReturnType<typeof vi.fn>;
let revokeObjectUrl: ReturnType<typeof vi.spyOn>;
let publicDemoNetwork = false;

function geometry(name: keyof typeof AURA_POSE_TEMPLATES, trump = false): AuraAtlasGeometry {
  const template = AURA_POSE_TEMPLATES[name];
  return { name, contentHash: trump ? template.trumpSha256 : template.templateSha256,
    frameWidth: template.frameWidth, frameHeight: template.frameHeight, frameCount: template.frames.length,
    bounds: template.frames.map(bounds => ({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h })) };
}

function cacheEntry(atlas: AuraAtlasGeometry): CachedSprite {
  const pngBlob = new Blob(['local decoded-image fixture'], { type: 'image/png' });
  geometryByName.set(atlas.name, atlas); geometryByBlob.set(pngBlob, atlas);
  // The loader reads only these cache fields. No IndexedDB, provider, private
  // photo or file-system fixture is accessed by these wiring tests.
  return { animationName: atlas.name, pngBlob, frameWidth: atlas.frameWidth,
    frameHeight: atlas.frameHeight, frameCount: atlas.frameCount } as CachedSprite;
}

function sceneFixture(initialKeys: string[] = []) {
  const keys = new Set(initialKeys);
  const textures = {
    exists: vi.fn((key: string) => keys.has(key)),
    remove: vi.fn((key: string) => { keys.delete(key); }),
    addSpriteSheet: vi.fn((key: string, _image: HTMLImageElement, _config: unknown) => { keys.add(key); }),
  };
  return { scene: { textures } as unknown as Phaser.Scene, textures, keys };
}

beforeEach(() => {
  publicDemoNetwork = false;
  vi.clearAllMocks(); geometryByName.clear(); geometryByBlob.clear();
  mocks.meta.mockResolvedValue(null);
  network = vi.fn(() => { throw new Error('Network/inference forbidden in loader unit tests'); });
  vi.stubGlobal('fetch', network);
  // No development canary query: these tests exercise cached real-fighter packs.
  vi.stubGlobal('window', { location: { search: '' } });
  vi.stubGlobal('Image', class {
    width = 768;
    height = 512;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:local-aura-fixture-${nextUrl++}`);
  revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  mocks.hash.mockImplementation(async (blob: Blob) => {
    const atlas = geometryByBlob.get(blob);
    if (!atlas) throw new Error('Unexpected blob');
    return atlas.contentHash;
  });
  mocks.measure.mockImplementation((_image: HTMLImageElement, definition: { name: string }, contentHash: string) => {
    const atlas = geometryByName.get(definition.name);
    if (!atlas || contentHash !== atlas.contentHash) throw new Error('Unexpected image/hash pair');
    expect(definition).toMatchObject({ name: atlas.name, frameWidth: atlas.frameWidth,
      frameHeight: atlas.frameHeight, frameCount: atlas.frameCount });
    return structuredClone(atlas);
  });
});

afterEach(() => {
  if (!publicDemoNetwork) expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('Aura sprite loader calibration wiring', () => {
  for (const spriteKey of ['fighter_p1', 'fighter_p2']) {
    it(`loads the existing official Trump Aura assets for ${spriteKey} in production without a canary query`, async () => {
      publicDemoNetwork = true;
      vi.stubEnv('DEV', false);
      const photoHash = 'arcade:donald-trump:official-manifest-fixture';
      mocks.meta.mockResolvedValue({ photoHash, cloudFighterId: 'official-manifest-fixture', cloudPublic: true });
      // The real public roster currently has only combat sprites. None are
      // needed to prove the separate Aura supplement is correctly selected.
      mocks.cache.mockResolvedValue([]);
      const entries = Object.keys(AURA_POSE_TEMPLATES).map(name => cacheEntry(geometry(name as keyof typeof AURA_POSE_TEMPLATES, true)));
      network.mockImplementation(async (path: string) => {
        const sprite = entries.find(entry => path === `/assets/aura/donald-trump/${entry.animationName}.png`);
        if (!sprite) throw new Error('Unexpected official asset URL');
        return { ok: true, blob: async () => sprite.pngBlob };
      });
      const { scene } = sceneFixture();
      const pack = await loadAuraAnimationPack(scene, spriteKey, photoHash);
      expect(network).toHaveBeenCalledTimes(7);
      expect(pack?.complete).toBe(true);
      expect(pack?.animations.size).toBe(7);
      expect(pack?.demoTint).toBeUndefined();
      expect(pack?.animations.get('aura_one_leg')?.calibration?.frames[0].sourceFrame).toBe(7);
    });
  }

  it('preserves current cached Aura moves and fills only the official character’s missing moves', async () => {
    publicDemoNetwork = true;
    const photoHash = 'arcade:donald-trump:official-manifest-fixture';
    mocks.meta.mockResolvedValue({ photoHash, cloudFighterId: 'official-manifest-fixture', cloudPublic: true });
    const remote = geometry('aura_six_seven'); remote.contentHash = 'new-reviewed-cloud-move';
    const cached = cacheEntry(remote);
    mocks.cache.mockResolvedValue([cached]);
    const entries = Object.keys(AURA_POSE_TEMPLATES).filter(name => name !== 'aura_six_seven')
      .map(name => cacheEntry(geometry(name as keyof typeof AURA_POSE_TEMPLATES, true)));
    network.mockImplementation(async (path: string) => {
      const sprite = entries.find(entry => path === `/assets/aura/donald-trump/${entry.animationName}.png`);
      if (!sprite) throw new Error('Current cloud move must not be replaced');
      return { ok: true, blob: async () => sprite.pngBlob };
    });
    const { scene } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p2', photoHash);
    expect(network).toHaveBeenCalledTimes(6);
    expect(pack?.complete).toBe(true);
    expect(pack?.animations.get('aura_six_seven')?.calibration?.policy).toBe('shared-idle-v1');
    await expect(mocks.cache.mock.results[0].value).resolves.toEqual([cached]);
  });

  it('never applies Trump art to a name collision, another official, or mismatched/private cache metadata', async () => {
    mocks.cache.mockResolvedValue([]);
    const { scene } = sceneFixture();
    for (const [photoHash, meta] of [
      ['private-photo-hash', { characterName: 'Donald Trump', cloudPublic: true }],
      ['arcade:lamine-yamal:other-fixture', { characterName: 'Donald Trump', cloudPublic: true }],
      ['arcade:donald-trump:official-manifest-fixture', { photoHash: 'arcade:donald-trump:official-manifest-fixture', cloudFighterId: 'wrong-id', cloudPublic: true }],
      ['arcade:donald-trump:official-manifest-fixture', { photoHash: 'arcade:donald-trump:official-manifest-fixture', cloudFighterId: 'official-manifest-fixture', cloudPublic: false }],
    ] as const) {
      mocks.meta.mockResolvedValue(meta);
      expect(await loadAuraAnimationPack(scene, 'fighter_p1', photoHash)).toBeNull();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects changed bundled bytes before creating a texture or falling back to stale calibration', async () => {
    publicDemoNetwork = true;
    const photoHash = 'arcade:donald-trump:official-manifest-fixture';
    mocks.meta.mockResolvedValue({ photoHash, cloudFighterId: 'official-manifest-fixture', cloudPublic: true });
    mocks.cache.mockResolvedValue([]);
    mocks.hash.mockResolvedValue('unexpected-regenerated-asset');
    network.mockResolvedValue({ ok: true, blob: async () => new Blob(['unexpected']) });
    const { scene, textures } = sceneFixture();
    expect(await loadAuraAnimationPack(scene, 'fighter_p2', photoHash)).toBeNull();
    expect(network).toHaveBeenCalledTimes(7);
    expect(textures.addSpriteSheet).not.toHaveBeenCalled();
  });

  it('loads all six reviewed demo performances and optional reaction without a development query or cache', async () => {
    publicDemoNetwork = true;
    vi.stubEnv('DEV', false);
    const entries = Object.keys(AURA_POSE_TEMPLATES).map(name => cacheEntry(geometry(name as keyof typeof AURA_POSE_TEMPLATES)));
    network.mockImplementation(async (path: string) => {
      const sprite = entries.find(entry => path === `/assets/aura/template-zero/${entry.animationName}.png`);
      if (!sprite) throw new Error('Unexpected public demo URL');
      return { ok: true, blob: async () => sprite.pngBlob };
    });
    const { scene } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p2', null, () => true, { id: 'template-zero', tint: 0x8cdeff });
    expect(mocks.cache).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(7);
    expect(pack?.complete).toBe(true);
    expect(pack?.animations.size).toBe(7);
    expect(pack?.demoTint).toBe(0x8cdeff);
  });
  it('does not apply a built-in demo option to an owned pack', async () => {
    mocks.cache.mockResolvedValue([cacheEntry(geometry('aura_unbothered'))]);
    const { scene } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'owned', () => true, { id: 'template-zero', tint: 0x8cdeff });
    expect(pack?.animations.size).toBe(1);
    expect(pack?.demoTint).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });
  it('hashes/measures cached atlases and attaches real per-frame registration to all seven known animations', async () => {
    const names = Object.keys(AURA_POSE_TEMPLATES) as (keyof typeof AURA_POSE_TEMPLATES)[];
    const entries = names.map(name => cacheEntry(geometry(name)));
    mocks.cache.mockResolvedValue(entries);
    const { scene, textures } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'local-photo-hash-fixture');

    expect(mocks.cache).toHaveBeenCalledExactlyOnceWith('local-photo-hash-fixture');
    expect(pack?.complete).toBe(true); expect(pack?.animations.size).toBe(7);
    expect(textures.addSpriteSheet).toHaveBeenCalledTimes(7);
    expect(mocks.hash).toHaveBeenCalledTimes(7); expect(mocks.measure).toHaveBeenCalledTimes(7);
    expect(revokeObjectUrl).toHaveBeenCalledTimes(7);
    for (const name of names) {
      const animation = pack!.animations.get(name as AuraAnimationName)!;
      expect(animation.textureKey).toBe(`fighter_p1_${name}`);
      expect(animation.calibration?.policy).toBe('template-pose-v1');
      expect(animation.calibration?.frames).toHaveLength(8);
      expect(animation.calibration?.referenceBodyHeight).toBe(AURA_POSE_TEMPLATES[name].referenceBodyHeight);
      expect(animation.calibration?.audit?.verdict).toBe('geometry-match');
      expect(animation.calibration?.frames.every(frame => frame.scale === 1)).toBe(true);
    }
    // Calibration decorates loaded animation descriptors, never cached records.
    expect(entries.every(entry => !Object.hasOwn(entry, 'calibration'))).toBe(true);
  });

  it('marks the six loaded core performances complete without an optional shrug', async () => {
    mocks.cache.mockResolvedValue(AURA_ANIMATION_NAMES.map(name => cacheEntry(geometry(name))));
    const { scene } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'local-fixture');
    expect(pack?.complete).toBe(true);
    expect(pack?.animations.size).toBe(6);
    expect(pack?.animations.has('aura_shrug')).toBe(false);
  });

  it('marks a cached six-move pack incomplete when a required image cannot decode', async () => {
    mocks.cache.mockResolvedValue(AURA_ANIMATION_NAMES.map(name => cacheEntry(geometry(name))));
    let decodedImages = 0;
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        const fails = decodedImages++ === 1;
        queueMicrotask(() => fails ? this.onerror?.() : this.onload?.());
      }
    });
    const { scene, textures } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'local-fixture');
    expect(pack?.complete).toBe(false);
    expect(pack?.animations.size).toBe(5);
    expect(pack?.animations.has('aura_six_seven')).toBe(false);
    expect(textures.addSpriteSheet).toHaveBeenCalledTimes(5);
    expect(mocks.warn).toHaveBeenCalledWith('[AuraSpriteLoader] aura_six_seven could not be loaded:',
      'Failed to load Aura sprite image');
  });

  it('corrects measured zoom for a known SHA and retains the reviewed source-frame mapping', async () => {
    const atlas = geometry('aura_one_leg', true);
    atlas.bounds = atlas.bounds.map(bounds => {
      const b = bounds!;
      return { x: b.x + b.width * 0.05, y: b.y + b.height * 0.1, width: b.width * 0.9, height: b.height * 0.9 };
    });
    mocks.cache.mockResolvedValue([cacheEntry(atlas)]);
    const { scene } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p2', 'local-fixture');
    const calibration = pack!.animations.get('aura_one_leg')!.calibration!;
    expect(calibration.policy).toBe('template-pose-v1');
    expect(calibration.frames[0].sourceFrame).toBe(7);
    expect(calibration.frames[0]).toEqual(calibration.frames[7]);
    expect(calibration.frames[3].scale).toBeCloseTo(1 / 0.9);
    expect(calibration.audit!.before!.maxAbsolutePrimaryAxisErrorRatio).toBeCloseTo(0.1);
    expect(calibration.audit!.after!.maxAdjacentPrimaryAxisDrift).toBeCloseTo(0);
  });

  it('uses one measured idle baseline for unknown legacy poses, including a 4x atlas', async () => {
    const idle = geometry('aura_unbothered'); idle.contentHash = 'unknown-idle';
    idle.bounds = idle.bounds.map(() => ({ x: 66, y: 40, width: 60, height: 200 }));
    const floor = geometry('aura_floor_worm'); floor.contentHash = 'unknown-floor';
    floor.bounds = floor.bounds.map(() => ({ x: 25, y: 180, width: 300, height: 50 }));
    const hq = geometry('aura_one_leg'); hq.contentHash = 'unknown-hq';
    hq.frameWidth *= 4; hq.frameHeight *= 4;
    hq.bounds = hq.bounds.map(b => ({ x: b!.x * 4, y: b!.y * 4, width: b!.width * 4, height: b!.height * 4 }));
    mocks.cache.mockResolvedValue([cacheEntry(floor), cacheEntry(hq), cacheEntry(idle)]);
    const { scene } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'local-fixture');
    const a = pack!.animations.get('aura_floor_worm')!.calibration!;
    const b = pack!.animations.get('aura_one_leg')!.calibration!;
    expect(a.policy).toBe('shared-idle-v1'); expect(b.policy).toBe('shared-idle-v1');
    expect(a.referenceBodyHeight).toBe(200); expect(b.referenceBodyHeight).toBe(800);
    expect(a.frames).toEqual(b.frames);
    expect(a.frames[0]).toEqual({ scale: 1, originX: 0.5, originY: 240 / 256, offsetX: 0, offsetY: 0 });
    expect(pack!.complete).toBe(false);
  });

  it('removes a corrupt known animation and its texture instead of granting it legacy fallback calibration', async () => {
    const broken = geometry('aura_glide'); broken.bounds = [null, ...broken.bounds.slice(1)];
    mocks.cache.mockResolvedValue([cacheEntry(geometry('aura_unbothered')), cacheEntry(broken)]);
    const { scene, textures, keys } = sceneFixture(['unrelated_texture']);
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'local-fixture');
    expect(pack!.animations.has('aura_glide')).toBe(false);
    expect(pack!.animations.get('aura_unbothered')!.calibration?.policy).toBe('template-pose-v1');
    expect(pack!.textureKeys).toEqual(['fighter_p1_aura_unbothered']);
    expect(textures.remove).toHaveBeenCalledWith('fighter_p1_aura_glide');
    expect(keys.has('unrelated_texture')).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith('[AuraSpriteLoader] aura_glide: unsafe pose registration', expect.any(Error));
    expect(pack!.complete).toBe(false);
  });

  it('keeps independent shape warnings visible after successful scale registration', async () => {
    const narrow = geometry('aura_unbothered', true);
    narrow.bounds = narrow.bounds.map(b => ({ ...b!, width: b!.width * 0.7 }));
    mocks.cache.mockResolvedValue([cacheEntry(narrow)]);
    const { scene } = sceneFixture();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'local-fixture');
    const calibration = pack!.animations.get('aura_unbothered')!.calibration!;
    expect(calibration.audit?.verdict).toBe('shape-mismatch');
    expect(calibration.audit?.after?.maxAbsolutePrimaryAxisErrorRatio).toBe(0);
    expect(calibration.audit?.after?.maxAbsoluteSecondaryAxisErrorRatio).toBeCloseTo(0.3);
    expect(mocks.warn).toHaveBeenCalledWith(
      '[AuraSpriteLoader] aura_unbothered: scale registered; shape review still required for frames',
      calibration.audit!.shapeMismatchFrameIndices,
    );
  });

  it('does no decoding for a stale request and destroys only textures owned by the loaded pack', async () => {
    mocks.cache.mockResolvedValue([cacheEntry(geometry('aura_unbothered'))]);
    const { scene, textures, keys } = sceneFixture(['unrelated_texture']);
    expect(await loadAuraAnimationPack(scene, 'fighter_p1', 'local-fixture', () => false)).toBeNull();
    expect(mocks.hash).not.toHaveBeenCalled(); expect(mocks.measure).not.toHaveBeenCalled();
    expect(textures.addSpriteSheet).not.toHaveBeenCalled();
    const pack = await loadAuraAnimationPack(scene, 'fighter_p1', 'local-fixture');
    destroyLoadedAuraAnimationPack(scene, pack);
    expect(textures.remove).toHaveBeenCalledExactlyOnceWith('fighter_p1_aura_unbothered');
    expect([...keys]).toEqual(['unrelated_texture']);
  });
});
