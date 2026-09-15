import { TEMPLATE_ATLAS_VERSION, type CompiledTemplateAtlasSprite, type TemplateAtlasAnimationName,
  type TemplateAtlasRendererVersion } from '../../src/services/TemplateAtlasContract';
import { TEMPLATE_ATLAS_MANIFEST_SHA256, templateAtlasPlayback, templateAtlasSourcePlanIds } from '../../src/services/TemplateAtlasPlayback';
import type { TemplateAtlasRawCheckpoint } from './templateAtlasCheckpoints';

export function assertCompiledTemplateSprite(sprite: CompiledTemplateAtlasSprite | undefined,
  renderer: TemplateAtlasRendererVersion, name: TemplateAtlasAnimationName): asserts sprite is CompiledTemplateAtlasSprite {
  const expected = templateAtlasPlayback(name);
  const cols = Math.min(4, expected.sequence.length), rows = Math.ceil(expected.sequence.length / cols);
  if (!sprite || sprite.animationName !== name || sprite.animationFormat !== 'template-atlas-v1' || sprite.processingVersion !== 6
    || sprite.frameW !== 768 || sprite.frameH !== 1024 || sprite.frameCount !== expected.sequence.length
    || sprite.columns !== cols || sprite.rows !== rows || sprite.fps !== expected.fps || sprite.loop !== expected.loop
    || sprite.originX !== .5 || sprite.originY !== 1884 / 2048
    || !Array.isArray(sprite.sequence) || sprite.sequence.length !== expected.sequence.length
    || sprite.sequence.some((id, index) => id !== expected.sequence[index])
    || sprite.qa?.passed !== true || sprite.qa.perFrameFit !== false || sprite.qa.repeatsAreExact !== true
    || sprite.qa.semanticApprovalClaimed !== false
    || sprite.provenance?.rendererVersion !== renderer || sprite.provenance.templateVersion !== TEMPLATE_ATLAS_VERSION
    || sprite.provenance.templateManifestSha256 !== TEMPLATE_ATLAS_MANIFEST_SHA256
    || sprite.provenance.fullCanvasRegistration?.width !== 1536 || sprite.provenance.fullCanvasRegistration.height !== 2048
    || sprite.provenance.fullCanvasRegistration.groundY !== 1884 || sprite.provenance.fullCanvasRegistration.originX !== .5
    || sprite.provenance.fullCanvasRegistration.originY !== 1884 / 2048) {
    throw new Error('Compiler did not return the authorized Template Atlas playback contract');
  }
}

/** A successful-looking compiler response may not substitute another paid RAW. */
export function assertCompiledTemplateSources(sprite: CompiledTemplateAtlasSprite,
  checkpoints: readonly TemplateAtlasRawCheckpoint[]): void {
  const expected = templateAtlasSourcePlanIds(sprite.provenance.rendererVersion as TemplateAtlasRendererVersion, sprite.animationName);
  const sources = sprite.provenance.sources;
  if (!Array.isArray(sources) || sources.length !== expected.length
    || new Set(sources.map(source => source.planId)).size !== sources.length
    || expected.some(planId => {
      const checkpoint = checkpoints.find(candidate => candidate.receipt.provenance.planId === planId);
      if (!checkpoint) return true;
      const receipt = checkpoint.receipt.provenance;
      const source = sources.find(candidate => candidate.planId === receipt.planId);
      return !source || source.rawSha256 !== checkpoint.sha256
        || source.templateImageSha256 !== receipt.templateImageSha256
        || !/^[a-f0-9]{64}$/.test(source.geometryFingerprint);
    })) throw new Error('Compiled sprite provenance does not match the preserved provider RAWs');
}

export function assertCompiledTemplatePng(bytes: ArrayBuffer, sprite: CompiledTemplateAtlasSprite): void {
  if (bytes.byteLength < 24 || bytes.byteLength > 32 * 1024 * 1024) throw new Error('Invalid compiled sprite size');
  const header = new DataView(bytes);
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a
    || header.getUint32(16) !== sprite.columns * sprite.frameW || header.getUint32(20) !== sprite.rows * sprite.frameH) {
    throw new Error('Compiled sprite PNG dimensions differ from its playback metadata');
  }
}
