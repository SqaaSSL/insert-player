/** Seven reviewed Aura poses, same normal product helper. No manifest changes; one provider attempt per target/step. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CasualTransport, LOCAL_ORIGIN, acquireLock, immutable, installCasualWindow, sha256 } from './casual-generation-transport.mjs';

export const AURA_GRID_RESCUE_ID = 'casual-aura-grid-rescue-v1';
export const AURA_GRID_FINGERPRINT = '0863b1b9bb5eb5c8c1884ddeaeecc206937aef883c230fa870226e1adb89e127';
export const AURA_GRID_TARGETS = ['aura_unbothered:2', ...Array.from({ length: 6 }, (_, i) => `aura_floor_worm:${i + 1}`)];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, '.artifacts/casual-generation-v1');
const INPUTS = join(ROOT, '.artifacts/casual-aura-grid-rescue-v1/inputs.json');
const INPUTS_SHA = '410f51d1f5c0e84e8e58e79f8f698fe22c418c2f2e5557d21c16e719fabc3a8a';
const SHA = /^[a-f0-9]{64}$/;
const MODEL = 'gemini-3.1-flash-image';
const GEMINI_PATH = `/v1beta/models/${MODEL}:generateContent`;
const stopped = message => new Response(JSON.stringify({ code: 'provider_request_not_dispatched', error: { message } }), { status: 409 });
const hashJson = value => sha256(JSON.stringify(value));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => immutable(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));

export function auraGridOptions(args) {
  assert.ok(args.every(arg => arg === '--execute' || /^(?:--target=|--step=|--confirm=|--plan-sha256=|--raw-reviewed=)/.test(arg)), 'Unexpected Aura grid option');
  assert.ok(args.filter(arg => arg === '--execute').length <= 1, 'Duplicate execute');
  const get = name => { const found = args.filter(arg => arg.startsWith(`--${name}=`)); assert.ok(found.length <= 1, 'Duplicate option'); return found[0]?.slice(name.length + 3); };
  const execute = args.includes('--execute'), target = get('target') ?? 'all', step = get('step') ?? 'render';
  assert.ok(target === 'all' || AURA_GRID_TARGETS.includes(target), 'Only the seven reviewed Aura poses may be rescued');
  assert.ok(['render', 'clean'].includes(step), 'Unknown rescue step');
  const planSha256 = get('plan-sha256'), rawReviewed = get('raw-reviewed');
  if (execute) {
    assert.notEqual(target, 'all', 'Execute one reviewed target at a time');
    assert.equal(get('confirm'), AURA_GRID_RESCUE_ID); assert.ok(SHA.test(planSha256 ?? ''), 'Exact reviewed plan SHA required');
    if (step === 'clean') assert.ok(SHA.test(rawReviewed ?? ''), 'Exact reviewed RAW SHA required before cleanup');
  }
  return { execute, target, step, planSha256, rawReviewed };
}
export function validateAuraGridInputs(inputs, identity) {
  assert.equal(inputs.schemaVersion, 1); assert.equal(inputs.id, AURA_GRID_RESCUE_ID);
  assert.equal(inputs.fingerprint, AURA_GRID_FINGERPRINT); assert.deepEqual(inputs.identity, identity);
  assert.deepEqual(inputs.frames.map(frame => `${frame.target.animationName}:${frame.target.uniqueFrame}`).sort(), [...AURA_GRID_TARGETS].sort(), 'Exactly seven unique approved targets required');
  for (const frame of inputs.frames) {
    assert.equal(frame.target.qualityTier, 'contender'); assert.deepEqual(frame.target.playbackFrames, [frame.target.uniqueFrame]);
    assert.equal(frame.pose.width, 768); assert.equal(frame.pose.height, 1024); assert.equal(frame.pose.mime, 'image/png');
    assert.ok(SHA.test(frame.pose.sha256)); assert.ok(Number.isSafeInteger(frame.pose.bytes) && frame.pose.bytes > 0);
    assert.ok(frame.pose.path.startsWith('.artifacts/'), 'Pose must be a versioned local task artifact');
    if (frame.parent !== null) for (const field of ['id', 'requestSha256', 'responseSha256']) assert.ok(SHA.test(frame.parent?.[field] ?? ''), 'Malformed prior render reference');
  }
}
export function assertAuraGridDispatch({ provider, path, bodySha256, expected, owned, exists }) {
  assert.equal(provider, expected.provider, 'No alternate provider or fallback');
  assert.equal(path, expected.path, 'Only the reviewed endpoint');
  assert.equal(bodySha256, expected.sha256, 'Only the exact reviewed request body');
  assert.ok(exists || owned < 1, 'One provider attempt per target/step; explicit recovery required');
}
function verified(base, entry) {
  const path = resolve(base, entry.path); assert.ok(path.startsWith(`${resolve(base)}/`), 'Artifact escaped its root');
  const bytes = readFileSync(path); assert.equal(sha256(bytes), entry.sha256);
  if (entry.bytes !== undefined) assert.equal(bytes.length, entry.bytes);
  return bytes;
}
function parentVerified(frame, ledger) {
  if (!frame.parent) return;
  const record = ledger.requests[frame.parent.id]; assert.ok(record); assert.equal(record.provider, 'gemini');
  assert.equal(record.status, 'complete'); assert.equal(record.httpStatus, 200);
  assert.equal(record.request.sha256, frame.parent.requestSha256); assert.equal(record.response.sha256, frame.parent.responseSha256);
  verified(DIRECTORY, record.request); verified(DIRECTORY, record.response);
}
// Reuse the actual transport's temp-image conversion, but intercept submission before any
// ledger or network operation. Its temporary inputs are immutable QA artifacts only.
export async function captureAuraGridRequest(run, directory, expectedProvider) {
  let captured;
  const nativeFetch = globalThis.fetch;
  const capture = Object.assign(Object.create(CasualTransport.prototype), { directory, tempImages: new Map(),
    async submit(provider, path, body) {
      assert.equal(captured, undefined, 'Only one first product request may be captured');
      assert.equal(provider, expectedProvider); captured = { provider, path, body }; return stopped('Offline Aura grid request captured');
    } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); assert.equal(url.origin, LOCAL_ORIGIN);
    const allowed = url.pathname === `/proxy/gemini${GEMINI_PATH}` || url.pathname === '/proxy/upload-temp' || url.pathname === '/proxy/fal/fal-ai/birefnet';
    if (!allowed || captured) return stopped('Offline Aura grid forbids any retry or fallback');
    assert.equal(init.method, 'POST'); return capture.handle(input, init);
  };
  try {
    await run().catch(error => { assert.match(error.message, /Offline Aura grid/); });
    assert.ok(captured, 'Normal product request was not captured'); return captured;
  } finally { globalThis.fetch = nativeFetch; }
}

export async function runAuraGridRescue(args = process.argv.slice(2)) {
  const options = auraGridOptions(args), manifest = readJson(join(DIRECTORY, 'manifest.json')), ledger = readJson(join(DIRECTORY, 'provider-ledger.json'));
  const inputsBytes = readFileSync(INPUTS); assert.equal(sha256(inputsBytes), INPUTS_SHA, 'Exact reviewed seven-pose input index required');
  const inputs = JSON.parse(inputsBytes); validateAuraGridInputs(inputs, manifest.identity);
  assert.equal(manifest.identity.sourceSha256, 'e29f551726c5e80941bcf63618401bbf00429d56df52f6cbb20d8da57435c210');
  assert.equal(manifest.fingerprint, AURA_GRID_FINGERPRINT); assert.equal(ledger.fingerprint, AURA_GRID_FINGERPRINT);
  assert.deepEqual(ledger.phases.full.caps, { gemini: 240, fal: 120 }, 'Existing full caps cannot change');
  const productFiles = manifest.productFiles.map(entry => ({ path: entry.path, sha256: sha256(readFileSync(join(ROOT, entry.path))) }));
  assert.deepEqual(productFiles, manifest.productFiles);
  assert.equal(hashJson({ schemaVersion: 1, sourceSha: manifest.identity.sourceSha256, productFiles, sourcePrompt: manifest.sourcePrompt }), AURA_GRID_FINGERPRINT);
  const runnerFiles = ['scripts/run-casual-aura-grid-rescue.mjs', 'scripts/casual-aura-grid-rescue-cli.mjs'].map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) }));
  const { installCanvasRuntime } = await import('../processor/src/canvasRuntime.ts'); installCanvasRuntime();
  const { loadImage } = await import('../processor/node_modules/@napi-rs/canvas/index.js');
  const { geminiRefineSpriteFrame, cleanCellsWithUnionMasks } = await import('../src/services/GeminiApi.ts');
  const { createDetachedApiRequestContext } = await import('../src/services/ApiClient.ts');
  const { getConfiguredBgRemovalProvider } = await import('../src/services/BackgroundRemovalService.ts');
  const nativeFetch = globalThis.fetch, diagnostics = [], restore = installCasualWindow(diagnostics), plans = [];
  try {
    for (const targetKey of options.target === 'all' ? AURA_GRID_TARGETS : [options.target]) {
      const frame = inputs.frames.find(frame => `${frame.target.animationName}:${frame.target.uniqueFrame}` === targetKey);
      const poseBytes = verified(ROOT, frame.pose), poseImage = await loadImage(poseBytes); assert.equal(poseImage.width, 768); assert.equal(poseImage.height, 1024);
      parentVerified(frame, ledger);
      const source = manifest.sources.find(source => source.kind === 'side'), identity = verified(DIRECTORY, source).toString('base64');
      const context = createDetachedApiRequestContext({ apiBaseUrl: LOCAL_ORIGIN, authorizationToken: 'local-artifact-only', providerRequestScope: `${AURA_GRID_RESCUE_ID}:${targetKey}` });
      const refine = () => geminiRefineSpriteFrame(identity, poseBytes.toString('base64'), frame.target.animationName, 'Restore the exact reviewed still.', frame.target.uniqueFrame - 1, 6, context, MODEL);
      const captured = await captureAuraGridRequest(refine, join(DIRECTORY, 'review/aura-grid-rescue-v1/capture'), 'gemini');
      assert.equal(captured.path, GEMINI_PATH);
      const inline = captured.body.contents[0].parts.filter(part => part.inlineData); assert.equal(inline.length, 1); assert.equal(sha256(Buffer.from(inline[0].inlineData.data, 'base64')), frame.pose.sha256);
      const plan = { schemaVersion: 1, id: AURA_GRID_RESCUE_ID, fingerprint: AURA_GRID_FINGERPRINT, productFiles, runnerFiles,
        inputs: { path: relative(ROOT, INPUTS), sha256: sha256(inputsBytes) }, target: frame.target, parent: frame.parent,
        pose: frame.pose, identity: { kind: 'side', sha256: source.sha256 }, request: { path: captured.path, sha256: hashJson(captured.body) },
        dispatchCaps: { render: { gemini: 1, fal: 0 }, clean: { gemini: 0, fal: 1 } }, selectionSourceFrame: frame.selectionSourceFrame ?? frame.sourceFrame ?? null };
      const planSha256 = hashJson(plan), output = join(DIRECTORY, 'review/aura-grid-rescue-v1', targetKey.replace(':', '-'), planSha256);
      if (!options.execute) {
        immutable(join(output, 'request.json'), Buffer.from(JSON.stringify(captured.body))); writeJson(join(output, 'plan.json'), plan);
        immutable(join(output, 'inputs.json'), inputsBytes);
        plans.push({ target: targetKey, planSha256, output: relative(ROOT, output) }); continue;
      }
      assert.equal(options.planSha256, planSha256); assert.equal(process.env.CASUAL_GENERATION_CREDENTIALS_READY, '1');
      assert.deepEqual(readJson(join(output, 'plan.json')), plan, 'Prepare and review the exact plan first');
      assert.equal(sha256(readFileSync(join(output, 'request.json'))), plan.request.sha256);
      const release = acquireLock(DIRECTORY);
      try {
        const latest = readJson(join(DIRECTORY, 'manifest.json')), latestLedger = readJson(join(DIRECTORY, 'provider-ledger.json'));
        assert.equal(latest.fingerprint, AURA_GRID_FINGERPRINT); assert.deepEqual(latest.productFiles, productFiles); assert.equal(latestLedger.fingerprint, AURA_GRID_FINGERPRINT);
        assert.equal(sha256(readFileSync(INPUTS)), plan.inputs.sha256); parentVerified(frame, latestLedger);
        const resultPath = join(output, `${options.step}.result.json`);
        if (existsSync(resultPath)) { const prior = readJson(resultPath); assert.equal(prior.planSha256, planSha256); verified(DIRECTORY, prior.image); if (options.step === 'clean') assert.equal(prior.rawReviewedSha256, options.rawReviewed); plans.push({ target: targetKey, status: 'already-complete', result: relative(ROOT, resultPath) }); continue; }
        const disk = statfsSync(DIRECTORY); assert.ok(Number(disk.bavail) * Number(disk.bsize) > 256 * 1024 * 1024, 'Insufficient local artifact space');
        let operation = refine, expected = { provider: 'gemini', ...plan.request };
        if (options.step === 'clean') {
          const raw = readJson(join(output, 'render.result.json')); assert.equal(raw.planSha256, planSha256); assert.deepEqual(raw.target, plan.target);
          assert.equal(raw.image.sha256, options.rawReviewed, 'Only the exact visually reviewed RAW may be cleaned');
          const rawBytes = verified(DIRECTORY, raw.image); assert.equal(getConfiguredBgRemovalProvider(), 'fal');
          operation = async () => (await cleanCellsWithUnionMasks([rawBytes.toString('base64')], frame.target.animationName, context))[0];
          const cleanup = await captureAuraGridRequest(operation, join(output, 'cleanup-capture'), 'fal'); assert.equal(cleanup.path, '/fal-ai/birefnet');
          expected = { provider: 'fal', path: cleanup.path, sha256: hashJson(cleanup.body) };
          immutable(join(output, 'clean.request.json'), Buffer.from(JSON.stringify(cleanup.body)));
          writeJson(join(output, 'clean.plan.json'), { schemaVersion: 1, id: AURA_GRID_RESCUE_ID, planSha256, rawReviewedSha256: options.rawReviewed, request: expected });
        }
        const stage = `${AURA_GRID_RESCUE_ID}:${targetKey}:${planSha256}:${options.step}`;
        class GridTransport extends CasualTransport {
          async submit(provider, path, body) {
            const id = sha256(`${provider}\n${path}\n${JSON.stringify(body)}`);
            try { assertAuraGridDispatch({ provider, path, bodySha256: hashJson(body), expected, owned: Object.values(this.state.requests).filter(record => record.stage?.startsWith(`${AURA_GRID_RESCUE_ID}:${targetKey}:`) && record.stage.endsWith(`:${options.step}`)).length, exists: !!this.state.requests[id] }); }
            catch (error) { return stopped(error.message); }
            return super.submit(provider, path, body);
          }
        }
        const transport = new GridTransport({ directory: DIRECTORY, fingerprint: AURA_GRID_FINGERPRINT, phase: 'full', caps: latestLedger.phases.full.caps, fetchImpl: nativeFetch,
          credentials: { geminiTransport: process.env.CASUAL_GEMINI_TRANSPORT, geminiKey: process.env.CASUAL_GEMINI_KEY, falMeterkeyKey: process.env.CASUAL_FAL_METERKEY_KEY } });
        transport.assertHealthy(); transport.setStage(stage); globalThis.fetch = transport.handle.bind(transport); diagnostics.length = 0;
        const image = await operation(); transport.assertHealthy();
        if (options.step === 'clean') assert.ok(diagnostics.some(line => /1\/1 unioned with fal, 0 chroma-only/.test(line)), 'No cleanup fallback is publishable');
        const bytes = Buffer.from(image, 'base64'), decoded = await loadImage(bytes), imagePath = join(output, `${options.step}-${sha256(bytes)}.png`); immutable(imagePath, bytes);
        const requests = Object.values(transport.state.requests).filter(record => record.stage === stage || record.reusedBy?.includes(stage)).map(record => ({ id: record.id, provider: record.provider, requestSha256: record.request.sha256, responseSha256: record.response?.sha256, status: record.status }));
        assert.equal(requests.length, 1); assert.equal(requests[0].status, 'complete'); assert.equal(requests[0].requestSha256, expected.sha256);
        writeJson(resultPath, { schemaVersion: 1, id: AURA_GRID_RESCUE_ID, step: options.step, planSha256, parent: plan.parent, target: plan.target,
          image: { path: relative(DIRECTORY, imagePath), sha256: sha256(bytes), bytes: bytes.length, mime: 'image/png', width: decoded.width, height: decoded.height }, requests, diagnostics,
          ...(options.step === 'clean' ? { rawReviewedSha256: options.rawReviewed } : {}) });
        plans.push({ target: targetKey, status: 'awaiting-visual-review', result: relative(ROOT, resultPath), imageSha256: sha256(bytes) });
      } finally { globalThis.fetch = nativeFetch; release(); }
    }
    console.log(JSON.stringify({ id: AURA_GRID_RESCUE_ID, execute: options.execute, plans, ...(!options.execute ? { plannedNewRenderCalls: plans.length, plannedNewCleanupCalls: plans.length } : {}) }, null, 2)); return plans;
  } finally { globalThis.fetch = nativeFetch; restore(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runAuraGridRescue().catch(error => { console.error(error.message); process.exitCode = 1; });
