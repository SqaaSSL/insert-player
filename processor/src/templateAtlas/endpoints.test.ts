import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { getTemplateAtlasPlanIds, type TemplateAtlasAnimationName } from '../../../src/services/TemplateAtlasContract.ts';
import { compileTemplateAtlasRequest, validateCompileTemplateAtlasRequest, MAX_COMPILED_TEMPLATE_RESPONSE_BYTES,
  type TemplateAtlasCompileDependencies } from './endpoints.ts';
import { TemplateAtlasCompileError, type CompiledTemplateAnimation, type CompiledTemplateAtlas } from './compiler.ts';
import { TemplateAtlasRequestError } from './provider.ts';
import type { TemplateAtlasPlan } from './templates.ts';

const raw = createCanvas(4, 4).toBuffer('image/png');
const names: TemplateAtlasAnimationName[] = ['ko'];
const ids = getTemplateAtlasPlanIds('rookie-two-atlas-v1', names);
const request = { rendererVersion: 'rookie-two-atlas-v1', animationNames: names,
  atlases: ids.map(planId => ({ planId, rawBase64: raw.toString('base64') })) };
const plans = ids.map(planId => ({ planId }) as TemplateAtlasPlan);
const result: CompiledTemplateAnimation = {
  animationName: 'ko', family: 'fight', runtimePng: Buffer.from('runtime'), hqPng: Buffer.from('clean-hq'), rawHqPng: Buffer.from('native-cells-hq'),
  frameWidth: 384, frameHeight: 512, hqFrameWidth: 768, hqFrameHeight: 1024, frameCount: 12, columns: 4, rows: 3,
  fps: 8, loop: false, originX: .5, originY: 1884 / 2048,
  animationFormat: 'template-atlas-v1', processingVersion: 6, sequence: Array(12).fill('master-001'),
  runtimeSha256: 'a', hqSha256: 'b', rawHqSha256: 'c',
  provenance: { rendererVersion: 'rookie-two-atlas-v1', templateVersion: 'template-zero-v3', templateManifestSha256: 'a'.repeat(64),
    sources: [], fullCanvasRegistration: { width: 1536, height: 2048, groundY: 1884, originX: .5, originY: 1884 / 2048 } },
  qa: { passed: true, semanticApprovalClaimed: false, warnings: [], perFrameFit: false, repeatsAreExact: true },
};

test('compile accepts exactly both trusted Rookie RAWs, independent of request ordering', () => {
  assert.deepEqual(validateCompileTemplateAtlasRequest(request).animationNames, names);
  assert.equal(validateCompileTemplateAtlasRequest({ ...request, atlases: [...request.atlases].reverse() }).atlases.length, 2);
});

test('compile rejects missing, duplicated, foreign, arbitrary-URL and multi-animation inputs', () => {
  for (const invalid of [
    { ...request, atlases: [request.atlases[0]] },
    { ...request, atlases: [request.atlases[0], request.atlases[0]] },
    { ...request, atlases: [{ ...request.atlases[0], planId: 'foreign' }, request.atlases[1]] },
    { ...request, atlases: [{ ...request.atlases[0], url: 'https://untrusted' }, request.atlases[1]] },
    { ...request, animationNames: ['idle', 'ko'] },
    { ...request, model: 'other' },
  ]) assert.throws(() => validateCompileTemplateAtlasRequest(invalid), TemplateAtlasRequestError);
});

test('Champion compile accepts only its single animation-specific RAW', () => {
  const valid = { rendererVersion: 'champion-animation-sheet-v1', animationNames: ['ko'],
    atlases: [{ planId: 'champion-animation-sheet-v1:ko', rawBase64: raw.toString('base64') }] };
  assert.equal(validateCompileTemplateAtlasRequest(valid).atlases.length, 1);
  assert.throws(() => validateCompileTemplateAtlasRequest({ ...valid, atlases: request.atlases }), TemplateAtlasRequestError);
});

test('compile never uses injected credentials and publishes clean+RAW HQ, not runtime or provider atlas', async () => {
  const compiledIds: string[] = [];
  const dependencies: TemplateAtlasCompileDependencies = {
    plans: async () => plans,
    compile: async (bytes, plan) => {
      assert.deepEqual(Buffer.from(bytes), raw); compiledIds.push(plan.planId);
      return { planId: plan.planId } as CompiledTemplateAtlas;
    },
    assemble: async (passedPlans, compiled, name) => {
      assert.deepEqual(passedPlans, plans); assert.deepEqual(compiled.map(atlas => atlas.planId), ids); assert.equal(name, 'ko');
      return result;
    },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('Compilation must not perform any network/provider request'); };
  try {
    const output = await compileTemplateAtlasRequest({ ...request, generationToken: 'unused', apiBaseUrl: 'https://unused.test', providerSessionId: 'unused', requestScope: 'unused' }, dependencies);
    assert.deepEqual(compiledIds, ids); assert.equal(output.sprites.length, 1);
    const sprite = output.sprites[0];
    assert.equal(sprite.imageBase64, result.hqPng.toString('base64'));
    assert.equal(sprite.rawBase64, result.rawHqPng.toString('base64'));
    assert.notEqual(sprite.rawBase64, raw.toString('base64'));
    assert.equal(sprite.frameW, 768); assert.equal(sprite.frameH, 1024); assert.equal(sprite.frameCount, 12);
    assert.equal(sprite.animationFormat, 'template-atlas-v1'); assert.equal(sprite.processingVersion, 6);
    assert.equal(sprite.qa.semanticApprovalClaimed, false); assert.deepEqual(sprite.sequence, result.sequence);
  } finally { globalThis.fetch = previousFetch; }
});

test('QA failure is propagated without assembling, retrying or replacing a failed pose', async () => {
  let attempts = 0, assembled = 0;
  const error = new TemplateAtlasCompileError('Wrong grid');
  await assert.rejects(() => compileTemplateAtlasRequest(request, {
    plans: async () => plans,
    compile: async () => { attempts++; throw error; },
    assemble: async () => { assembled++; return result; },
  }), candidate => candidate === error);
  assert.equal(attempts, 1); assert.equal(assembled, 0);
});

test('invalid native PNG is rejected before the compiler sees it', async () => {
  let calls = 0;
  await assert.rejects(() => compileTemplateAtlasRequest({ ...request, atlases: request.atlases.map(atlas => ({ ...atlas, rawBase64: 'not-png' })) }, {
    plans: async () => plans,
    compile: async () => { calls++; return {} as CompiledTemplateAtlas; },
    assemble: async () => result,
  }), TemplateAtlasRequestError);
  assert.equal(calls, 0);
});

test('oversized output fails explicitly at the 24 MiB Worker response budget without changing pixels', async () => {
  assert.equal(MAX_COMPILED_TEMPLATE_RESPONSE_BYTES, 24 * 1024 * 1024);
  let assemblies = 0;
  await assert.rejects(compileTemplateAtlasRequest(request, {
    plans: async () => plans,
    compile: async (_bytes, plan) => ({ planId: plan.planId }) as CompiledTemplateAtlas,
    assemble: async () => { assemblies++; return { ...result, hqPng: Buffer.alloc(18 * 1024 * 1024) }; },
  }), { code: 'template_atlas_output_too_large', status: 413 });
  assert.equal(assemblies, 1, 'No quality degradation or replacement attempt');
});
