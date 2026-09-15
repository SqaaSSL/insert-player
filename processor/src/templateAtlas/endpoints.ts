import {
  getTemplateAtlasPlanIds, isTemplateAtlasRendererVersion, normalizeTemplateAtlasAnimationNames,
  type CompileTemplateAtlasRequest, type CompileTemplateAtlasResult,
} from '../../../src/services/TemplateAtlasContract';
import { decodePngBase64, TemplateAtlasRequestError } from './provider';
import { getTemplateAtlasPlans } from './templates';
import { assembleTemplateAtlasHqAnimation, compileTemplateAtlas } from './compiler';

export const MAX_COMPILED_TEMPLATE_RESPONSE_BYTES = 24 * 1024 * 1024;

function invalid(message: string): never {
  throw new TemplateAtlasRequestError(message, 400, 'invalid_template_atlas_request');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validateCompileTemplateAtlasRequest(value: unknown): CompileTemplateAtlasRequest {
  if (!record(value)) invalid('Expected a compile Template Atlas request');
  // The common Worker RPC helper also injects this context; compilation never uses it.
  const allowed = new Set(['rendererVersion', 'animationNames', 'atlases', 'apiBaseUrl', 'generationToken', 'providerSessionId', 'requestScope']);
  if (Object.keys(value).some(key => !allowed.has(key))) invalid('Unexpected compile Template Atlas request field');
  if (!isTemplateAtlasRendererVersion(value.rendererVersion)) invalid('Unsupported Template Atlas renderer');
  let animationNames;
  try { animationNames = normalizeTemplateAtlasAnimationNames(value.animationNames); }
  catch { invalid('Invalid Template Atlas animation selection'); }
  // Twenty HQ clean+RAW sheets exceed the RPC body budget. Worker checkpoints one output at a time.
  if (animationNames.length !== 1) invalid('Compile exactly one animation per checkpoint');
  const expected = getTemplateAtlasPlanIds(value.rendererVersion, animationNames);
  const atlases = value.atlases;
  if (!Array.isArray(atlases) || atlases.length !== expected.length
    || atlases.some(atlas => !record(atlas) || Object.keys(atlas).some(key => !['planId', 'rawBase64'].includes(key))
      || typeof atlas.planId !== 'string' || typeof atlas.rawBase64 !== 'string' || !atlas.rawBase64)
    || new Set(atlases.map(atlas => atlas.planId)).size !== expected.length
    || expected.some(planId => !atlases.some(atlas => atlas.planId === planId))) {
    invalid('Supply each required native RAW atlas exactly once');
  }
  return { rendererVersion: value.rendererVersion, animationNames,
    atlases: atlases.map(atlas => ({ planId: atlas.planId, rawBase64: atlas.rawBase64 })) };
}

export interface TemplateAtlasCompileDependencies {
  plans: typeof getTemplateAtlasPlans;
  compile: typeof compileTemplateAtlas;
  assemble: typeof assembleTemplateAtlasHqAnimation;
}
const defaults: TemplateAtlasCompileDependencies = {
  plans: getTemplateAtlasPlans, compile: compileTemplateAtlas, assemble: assembleTemplateAtlasHqAnimation,
};

/** Inference-free. A failed matte/grid check can only reprocess the checkpointed bytes. */
export async function compileTemplateAtlasRequest(input: unknown, dependencies: TemplateAtlasCompileDependencies = defaults): Promise<CompileTemplateAtlasResult> {
  const request = validateCompileTemplateAtlasRequest(input);
  const plans = await dependencies.plans(request.rendererVersion, request.animationNames);
  const compiled = [];
  // Sequential decoding bounds peak memory; the compiler's bounded cache shares prior mattes.
  for (const plan of plans) {
    const atlas = request.atlases.find(candidate => candidate.planId === plan.planId);
    if (!atlas) invalid('Required native RAW atlas is missing');
    compiled.push(await dependencies.compile(decodePngBase64(atlas.rawBase64), plan));
  }
  const result = await dependencies.assemble(plans, compiled, request.animationNames[0]);
  // Reject certain oversize results before allocating base64 strings/JSON.
  const encodedImageBytes = 4 * Math.ceil(result.hqPng.length / 3) + 4 * Math.ceil(result.rawHqPng.length / 3);
  if (encodedImageBytes > MAX_COMPILED_TEMPLATE_RESPONSE_BYTES) {
    throw new TemplateAtlasRequestError('Compiled animation exceeds the safe response limit. Native RAWs remain checkpointed.', 413, 'template_atlas_output_too_large');
  }
  const response: CompileTemplateAtlasResult = { sprites: [{
    animationName: result.animationName,
    imageBase64: result.hqPng.toString('base64'), rawBase64: result.rawHqPng.toString('base64'),
    frameW: result.hqFrameWidth, frameH: result.hqFrameHeight, frameCount: result.frameCount,
    columns: result.columns, rows: result.rows, fps: result.fps, loop: result.loop,
    originX: result.originX, originY: result.originY, sequence: result.sequence,
    animationFormat: result.animationFormat, processingVersion: result.processingVersion,
    provenance: result.provenance, qa: result.qa,
  }] };
  if (Buffer.byteLength(JSON.stringify(response)) > MAX_COMPILED_TEMPLATE_RESPONSE_BYTES) {
    throw new TemplateAtlasRequestError('Compiled animation exceeds the safe response limit. Native RAWs remain checkpointed.', 413, 'template_atlas_output_too_large');
  }
  return response;
}
