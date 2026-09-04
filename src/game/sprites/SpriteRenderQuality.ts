export type SpriteTextureDensity = 1 | 2;

export interface SpriteRenderCapabilities {
  maxTextureSize: number;
  deviceMemoryGb: number | null;
  saveData: boolean;
  coarsePointer: boolean;
}

/** Minimal sprite shape needed to decide 2x-atlas eligibility. */
export interface HighResolutionSpriteSource {
  animationFormat?: string | null;
  frameWidth: number;
  frameHeight: number;
  rawPngBlob?: Blob | null;
  rawFrameWidth?: number | null;
  rawFrameHeight?: number | null;
  rawFrameCount?: number | null;
}

/**
 * A sprite can feed the 2x atlas either through its preserved RAW video
 * frames (video-dense) or directly through its processed sheet when that
 * sheet was generated at high resolution (Champion legacy sheets store
 * 768x1024 cells — four times the 1x atlas cell in each axis). Without the
 * second branch, a paid Champion legacy fighter renders at Rookie density
 * while its HD pixels sit unused in the cache.
 */
export function spriteSupportsHighResolutionAtlas(
  sprite: HighResolutionSpriteSource,
  targetFrameWidth: number,
  targetFrameHeight: number,
): boolean {
  if (sprite.animationFormat === 'video-dense-v1') {
    return (
      sprite.rawPngBlob instanceof Blob &&
      Number.isInteger(sprite.rawFrameWidth) && (sprite.rawFrameWidth ?? 0) > 0 &&
      Number.isInteger(sprite.rawFrameHeight) && (sprite.rawFrameHeight ?? 0) > 0 &&
      Number.isInteger(sprite.rawFrameCount) && (sprite.rawFrameCount ?? 0) > 0
    );
  }
  return sprite.frameWidth >= targetFrameWidth && sprite.frameHeight >= targetFrameHeight;
}

export interface SpriteDensityRequest {
  atlasWidthAt1x: number;
  atlasHeightAt1x: number;
  highResolutionSourcesAvailable: boolean;
}

const MIN_HIGH_DENSITY_MEMORY_GB = 8;

export function chooseSpriteTextureDensity(
  capabilities: SpriteRenderCapabilities,
  request: SpriteDensityRequest,
): SpriteTextureDensity {
  if (
    !request.highResolutionSourcesAvailable ||
    capabilities.saveData ||
    capabilities.coarsePointer
  ) return 1;

  const requiredWidth = request.atlasWidthAt1x * 2;
  const requiredHeight = request.atlasHeightAt1x * 2;
  if (
    capabilities.maxTextureSize < requiredWidth ||
    capabilities.maxTextureSize < requiredHeight
  ) {
    return 1;
  }

  if (capabilities.deviceMemoryGb !== null) {
    return capabilities.deviceMemoryGb >= MIN_HIGH_DENSITY_MEMORY_GB ? 2 : 1;
  }

  // Browsers that conceal deviceMemory need additional GPU headroom. A
  // 16K texture limit is a useful capability signal without fingerprinting a
  // renderer model or relying on user-agent strings.
  return capabilities.maxTextureSize >= 16_384 ? 2 : 1;
}

function browserDeviceMemoryGb(): number | null {
  if (typeof navigator === 'undefined') return null;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function browserSaveDataEnabled(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean };
  }).connection;
  return connection?.saveData === true;
}

function browserUsesCoarsePointer(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
}

function detectMaxTextureSize(
  suppliedContext?: WebGLRenderingContext | WebGL2RenderingContext | null,
): number {
  if (suppliedContext) {
    return Number(suppliedContext.getParameter(suppliedContext.MAX_TEXTURE_SIZE)) || 0;
  }
  if (typeof document === 'undefined') return 0;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!context) return 0;
  const size = Number(context.getParameter(context.MAX_TEXTURE_SIZE)) || 0;
  context.getExtension('WEBGL_lose_context')?.loseContext();
  return size;
}

export function detectSpriteRenderCapabilities(
  context?: WebGLRenderingContext | WebGL2RenderingContext | null,
): SpriteRenderCapabilities {
  return {
    maxTextureSize: detectMaxTextureSize(context),
    deviceMemoryGb: browserDeviceMemoryGb(),
    saveData: browserSaveDataEnabled(),
    coarsePointer: browserUsesCoarsePointer(),
  };
}

export function prefersHighDensitySpriteTextures(): boolean {
  return chooseSpriteTextureDensity(detectSpriteRenderCapabilities(), {
    atlasWidthAt1x: 12 * 192,
    atlasHeightAt1x: 16 * 256,
    highResolutionSourcesAvailable: true,
  }) === 2;
}
