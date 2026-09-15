import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { apiFetch } from '../../../src/services/ApiClient.ts';
import {
  getTemplateAtlasPlanIds, TEMPLATE_ATLAS_ANIMATION_NAMES,
  type SubmitTemplateAtlasRequest,
} from '../../../src/services/TemplateAtlasContract.ts';
import {
  generateTemplateAtlas, prepareWhiteUpright, sha256, templateAtlasPayload,
  TemplateAtlasRequestError, validateGenerateTemplateAtlasRequest,
  type TemplateAtlasProviderDependencies,
} from './provider.ts';
import type { TemplateAtlasPlan } from './templates.ts';

function fixturePng(width = 8, height = 12) {
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = '#112233'; context.fillRect(2, 3, 3, 5);
  return canvas.toBuffer('image/png');
}
const upright = fixturePng();
const template = fixturePng(12, 16);
const plan: TemplateAtlasPlan = {
  schemaVersion: 1, rendererVersion: 'rookie-two-atlas-v1', planId: 'rookie-two-atlas-v1:two-01',
  templateVersion: 'template-zero-v3', templateManifestSha256: 'a'.repeat(64), templateImageSha256: sha256(template),
  width: 4096, height: 4096, grid: { columns: 10, rows: 7 },
  cells: Array.from({ length: 66 }, (_, index) => ({ index, masterId: `master-${index}`,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    placement: { x: 0, y: 0, width: 1, height: 1, uniformScale: 1, sourceWidth: 1, sourceHeight: 1 } })),
  blankCells: [], selectedAnimationNames: ['idle'], animations: [], planFingerprint: 'b'.repeat(64),
};
const body: SubmitTemplateAtlasRequest = {
  operation: 'submit', rendererVersion: 'rookie-two-atlas-v1', animationNames: ['idle'], planId: plan.planId,
  uprightBase64: upright.toString('base64'), apiBaseUrl: 'https://api.example.test',
  generationToken: 'test-only-generation-token', providerSessionId: 'test-session', requestScope: 'test-run:two-01',
};
const jobId = '01a0a225-88a2-7570-8dab-1d7ca8d5e0ed';
function deps(fetch: typeof apiFetch): TemplateAtlasProviderDependencies {
  return { resolvePlan: async () => plan, templateImage: async () => template, fetch };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function receipt() {
  const result = await generateTemplateAtlas(body, deps(async (_input, init) => json({ request_id: jobId, insert_player_request_body_sha256: sha256(String(init?.body)) })));
  assert.equal(result.status, 'submitted');
  return result.receipt;
}

test('Worker and processor use stable separate Rookie/Champion plan IDs', () => {
  assert.equal(TEMPLATE_ATLAS_ANIMATION_NAMES.length, 20);
  assert.deepEqual(getTemplateAtlasPlanIds('rookie-two-atlas-v1', ['ko']), ['rookie-two-atlas-v1:two-01', 'rookie-two-atlas-v1:two-02']);
  assert.deepEqual(getTemplateAtlasPlanIds('champion-animation-sheet-v1', ['ko', 'idle']), ['champion-animation-sheet-v1:idle', 'champion-animation-sheet-v1:ko']);
  assert.throws(() => getTemplateAtlasPlanIds('champion-animation-sheet-v1', ['ko', 'ko']));
});

test('strict request contract rejects caller model, original, prompt, URL, invalid selection and missing auth', () => {
  for (const extra of [{ model: 'other' }, { originalBase64: 'image' }, { prompt: 'invent' }, { templateUrl: 'https://unsafe' },
    { animationNames: ['unknown'] }, { animationNames: ['idle', 'idle'] }, { generationToken: '' }, { requestScope: 'scope/unsafe' },
    { apiBaseUrl: 'https://token:password@example.test' }, { rendererVersion: 'legacy-v1' }]) {
    assert.throws(() => validateGenerateTemplateAtlasRequest({ ...body, ...extra }), TemplateAtlasRequestError);
  }
});

test('prepared upright stays at its original canvas and retains opaque RGB with only white compositing', async () => {
  const result = await prepareWhiteUpright(upright.toString('base64'));
  assert.equal(result.inputSha256, sha256(upright));
  const decoded = await loadImage(result.bytes), canvas = createCanvas(decoded.width, decoded.height);
  assert.equal(decoded.width, 8); assert.equal(decoded.height, 12);
  const context = canvas.getContext('2d'); context.drawImage(decoded, 0, 0);
  assert.deepEqual([...context.getImageData(0, 0, 1, 1).data], [255, 255, 255, 255]);
  assert.deepEqual([...context.getImageData(2, 3, 1, 1).data], [17, 34, 51, 255]);
});

test('payload is pinned 4K white PNG with exactly template then upright, no original or dynamic prompt', () => {
  const payload = templateAtlasPayload(plan, template, upright);
  assert.equal(payload.resolution, '4K'); assert.equal(payload.aspect_ratio, '1:1'); assert.equal(payload.num_images, 1);
  assert.equal(payload.sync_mode, false); assert.equal(payload.limit_generations, true); assert.equal(payload.enable_web_search, false);
  assert.deepEqual(payload.image_urls, [template, upright].map(bytes => `data:image/png;base64,${bytes.toString('base64')}`));
  assert.match(payload.prompt, /66 occupied cells/); assert.match(payload.prompt, /4 trailing empty white cells/);
  assert.match(payload.prompt, /#FFFFFF/); assert.match(payload.prompt, /intentionally exaggerated close-to-camera kiss/);
  assert.doesNotMatch(payload.prompt, /Francisco|Trump|floral short-sleeve/);
});

test('submit makes exactly one POST via Generation-scoped Worker, records exact body and reference hashes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return json({ request_id: jobId,
    insert_player_request_body_sha256: sha256(String(init?.body)), response_url: 'https://ignored.invalid/result' }); };
  try {
    const result = await generateTemplateAtlas(body, deps(apiFetch));
    assert.equal(result.status, 'submitted'); assert.equal(calls.length, 1);
    const call = calls[0], headers = new Headers(call.init?.headers);
    assert.equal(call.url, 'https://api.example.test/proxy/fal/fal-ai/nano-banana-2/edit');
    assert.equal(call.init?.method, 'POST'); assert.equal(headers.get('authorization'), 'Generation test-only-generation-token');
    assert.equal(headers.get('x-asf-provider-session'), 'test-session');
    assert.equal(headers.get('x-insert-player-provider-request-key'), body.requestScope);
    assert.equal(headers.get('x-fal-no-retry'), '1'); assert.equal(headers.get('cf-aig-max-attempts'), '1'); assert.equal(headers.get('cf-aig-skip-cache'), 'true');
    assert.equal(result.receipt.provenance.requestBodySha256, sha256(String(call.init?.body)));
    const payload = JSON.parse(String(call.init?.body));
    assert.equal(result.receipt.provenance.templateImageSha256, sha256(Buffer.from(payload.image_urls[0].split(',')[1], 'base64')));
    assert.equal(result.receipt.provenance.preparedUprightSha256, sha256(Buffer.from(payload.image_urls[1].split(',')[1], 'base64')));
  } finally { globalThis.fetch = previousFetch; }
});

test('submit network, malformed or missing-handle outcomes never retry or fall back', async () => {
  for (const outcome of ['throw', 'bad-json', 'no-handle', 'http-503'] as const) {
    let attempts = 0;
    await assert.rejects(() => generateTemplateAtlas(body, deps(async () => {
      attempts++;
      if (outcome === 'throw') throw new Error('connect failed');
      if (outcome === 'bad-json') return new Response('not-json');
      return json({}, outcome === 'http-503' ? 503 : 200);
    })), (error: unknown) => error instanceof TemplateAtlasRequestError && error.code === 'provider_request_outcome_unknown');
    assert.equal(attempts, 1);
  }
});

test('a gateway not-dispatched decision stays explicit and does not retry', async () => {
  let attempts = 0;
  await assert.rejects(() => generateTemplateAtlas(body, deps(async () => { attempts++; return json({ code: 'provider_request_not_dispatched' }, 403); })),
    (error: unknown) => error instanceof TemplateAtlasRequestError && error.code === 'provider_request_not_dispatched');
  assert.equal(attempts, 1);
});

test('a cached receipt with changed input bytes never acquires false new provenance', async () => {
  let attempts = 0;
  await assert.rejects(() => generateTemplateAtlas(body, deps(async () => {
    attempts++; return json({ request_id: jobId, insert_player_request_body_sha256: '0'.repeat(64) });
  })), (error: unknown) => error instanceof TemplateAtlasRequestError
    && error.code === 'provider_request_outcome_unknown' && error.requestId === jobId);
  assert.equal(attempts, 1);
});

test('collect pending uses only canonical base-model GET and no supplied receipt URL', async () => {
  const stored = await receipt(), calls: string[] = [];
  const { uprightBase64: _upright, ...common } = body;
  const result = await generateTemplateAtlas({ ...common, operation: 'collect', receipt: stored }, deps(async (input, init) => {
    assert.equal(init?.method, 'GET'); calls.push(String(input)); return json({ status: 'IN_QUEUE' });
  }));
  assert.equal(result.status, 'pending');
  assert.deepEqual(calls, [`/proxy/fal/fal-ai/nano-banana-2/requests/${jobId}/status`]);
});

test('collect rejects forged receipt plan/hash/scope before any request', async () => {
  const stored = await receipt();
  for (const changed of [{ ...stored, requestScope: 'different' }, { ...stored, requestId: '../../escape' },
    { ...stored, provenance: { ...stored.provenance, templateImageSha256: 'e'.repeat(64) } }]) {
    let calls = 0;
    const { uprightBase64: _upright, ...common } = body;
    await assert.rejects(() => generateTemplateAtlas({ ...common, operation: 'collect', receipt: changed }, deps(async () => { calls++; return json({}); })), TemplateAtlasRequestError);
    assert.equal(calls, 0);
  }
});

test('collect completed keeps native PNG bytes unchanged, using three GETs only', async () => {
  const stored = await receipt(), output = fixturePng(4096, 4096), urls: string[] = [];
  const { uprightBase64: _upright, ...common } = body;
  const result = await generateTemplateAtlas({ ...common, operation: 'collect', receipt: stored }, deps(async (input, init) => {
    assert.equal(init?.method, 'GET'); urls.push(String(input));
    if (urls.length === 1) return json({ status: 'COMPLETED' });
    if (urls.length === 2) return json({ images: [{ url: 'https://v3b.fal.media/files/native.png' }] });
    return new Response(new Uint8Array(output), { headers: { 'Content-Type': 'image/png' } });
  }));
  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') assert.fail();
  assert.equal(result.rawBase64, output.toString('base64')); assert.equal(result.sha256, sha256(output));
  assert.equal(result.width, 4096); assert.equal(result.height, 4096);
  assert.match(urls[2], /^\/proxy\/image\?url=https%3A%2F%2Fv3b\.fal\.media/);
});

test('collect rejects untrusted output URL without touching it', async () => {
  const stored = await receipt(); let calls = 0;
  const { uprightBase64: _upright, ...common } = body;
  await assert.rejects(() => generateTemplateAtlas({ ...common, operation: 'collect', receipt: stored }, deps(async () => {
    calls++;
    return calls === 1 ? json({ status: 'COMPLETED' }) : json({ images: [{ url: 'https://attacker.test/image.png' }] });
  })), (error: unknown) => error instanceof TemplateAtlasRequestError && error.code === 'provider_result_invalid');
  assert.equal(calls, 2);
});

test('failed GET collection retains receipt ID and can never submit', async () => {
  const stored = await receipt(); let calls = 0;
  const { uprightBase64: _upright, ...common } = body;
  await assert.rejects(() => generateTemplateAtlas({ ...common, operation: 'collect', receipt: stored }, deps(async (_input, init) => {
    calls++; assert.equal(init?.method, 'GET'); throw new Error('offline');
  })), (error: unknown) => error instanceof TemplateAtlasRequestError && error.code === 'provider_collection_failed' && error.requestId === jobId);
  assert.equal(calls, 1);
});
