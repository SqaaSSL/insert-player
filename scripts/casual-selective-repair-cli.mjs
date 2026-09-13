/** Exact Casual repairs. Dry run builds real normal-product requests; execution is one reviewed target and step at a time. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CasualTransport, LOCAL_ORIGIN, acquireLock, immutable, installCasualWindow, sha256 } from './casual-generation-transport.mjs';
import { CASUAL_SELECTIVE_REPAIR_ID as ID, CASUAL_REPAIR_TARGETS } from './casual-selective-repair-provenance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, '.artifacts/casual-generation-v1');
const PREPARATION = join(ROOT, '.artifacts/casual-selective-repair/merged-preparation-v2/preparation.json');
const PILOT = join(DIRECTORY, 'review/pose-primary-refinement-v1/pilot');
const PILOT_RAW = '1289f764245504a0f1ff14e5314f84631998e1c22297d3ea41e160eba748ab5f';
const PILOT_CLEAN = 'd580d7caf1c113146cca536d94dba895051550ac79a433d338200c9540dbab40';
const CANARIES = ['crouch:1', ...Array.from({ length: 8 }, (_, index) => `ko:${index + 1}`)];
const KO_PREPARATION = join(ROOT, '.artifacts/casual-selective-repair/ko-native-c4fcc7ae5c52594d/preparation-7fd4ab7e6fc7481f862e0dd516d600f8e86eb1bb9f38a6e5452bbc88031baa90.json');
const APPROVED_REUSE = {
  'low_kick:4': { rawSha256: PILOT_RAW, cleanSha256: PILOT_CLEAN, path: relative(DIRECTORY, PILOT) },
  'crouch:1': { rawSha256: '371d7bac584e916b0f1f8354b0ce89baca1b0684a4dd3e81d09b9769a47e8e70', cleanSha256: '1e317fbf0c6254d6f39c7738773beed469a621555d17854a77e9f26a6c6be6d0', path: 'review/selective-repair-v1/crouch-1/fa8f43936ed3a7e081cbc647ad309c1fc7bc95da138b25b08c23f169544fefe7' },
  'ko:6': { rawSha256: '359768bf01787de0dfe6284a141267ebc6c85463e328408926e88214a32cb0ab', cleanSha256: '80d4ae3a768de672d4f115ee101c2be52a9ff023c930265dd92ab27798e7b1bf', path: 'review/selective-repair-v1/ko-6/16de046f6ebcd91ec5835a8a33797473a1a318a4957ac64fe1f1bb80a594c737' },
};
const TARGETS = [...new Set(Object.entries(CASUAL_REPAIR_TARGETS).flatMap(([name, frames]) => frames.map(frame => `${name}:${frame}`)).concat(CANARIES))];
const SHA = /^[a-f0-9]{64}$/;
const stopped = message => new Response(JSON.stringify({ code: 'provider_request_not_dispatched', error: { message } }), { status: 409 });

export function selectiveRepairOptions(args) {
  assert.ok(args.every(arg => arg === '--execute' || /^(?:--target=|--step=|--confirm=|--plan-sha256=|--raw-reviewed=)/.test(arg)), 'Unexpected selective repair option');
  const get = name => { const found = args.filter(arg => arg.startsWith(`--${name}=`)); assert.ok(found.length <= 1, 'Duplicate option'); return found[0]?.slice(name.length + 3); };
  const execute = args.includes('--execute'), target = get('target') ?? 'all', step = get('step') ?? 'render';
  assert.ok(target === 'all' || TARGETS.includes(target), 'Outside the eleven approved Casual repairs and the explicit crouch/KO recovery');
  assert.ok(['render', 'clean'].includes(step));
  if (execute) { assert.notEqual(target, 'all', 'Paid repair executes one reviewed target at a time'); assert.equal(get('confirm'), ID); assert.ok(SHA.test(get('plan-sha256') ?? ''), 'Exact reviewed plan SHA required'); if (step === 'clean') assert.ok(SHA.test(get('raw-reviewed') ?? ''), 'Exact reviewed RAW SHA required'); }
  return { execute, target, step, confirm: get('confirm'), planSha256: get('plan-sha256'), rawReviewed: get('raw-reviewed') };
}
export function assertSelectiveDispatch({ provider, path, bodySha256, step, plan, owned, exists }) {
  if (step === 'render') assert.ok(provider === 'gemini' && path === plan.request.path && bodySha256 === plan.request.sha256, 'Only the exact reviewed first render is permitted');
  else assert.ok(provider === 'fal' && path === '/fal-ai/birefnet', 'Only normal BiRefNet cleanup is permitted');
  assert.ok(exists || owned < 1, 'One provider attempt per target/step; recovery needs explicit review');
}
export function selectiveAnimationMotion(workflowSource, animationName) {
  const entries = workflowSource.matchAll(/\{ name: '([a-z_]+)', motion: '([^']+)', frames: \d+, base: '(?:standing|crouched)' \}/g);
  const entry = Array.from(entries).find(match => match[1] === animationName);
  assert.ok(entry, 'Unknown animation in the generation workflow');
  return entry[2];
}
export function assertHistoricalCrouchPose({ targetKey, activeRookie, originalRookie, proof, approvedReuse }) {
  assert.equal(targetKey, 'crouch:1'); assert.equal(activeRookie.derivativeId, 'casual-postprocess-repair-v1');
  assert.equal(proof.operation, 'reprocess-original-raw'); assert.equal(proof.providerCalls, 0);
  assert.equal(proof.originalEntry.sha256, originalRookie.sha256); assert.equal(proof.outputEntry.sha256, activeRookie.sha256);
  for (const field of ['rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight', 'frameCount', 'gridCols', 'gridRows']) {
    assert.equal(proof.originalEntry[field], originalRookie[field]); assert.equal(originalRookie[field], activeRookie[field], 'Historical pose requires unchanged raw metadata');
  }
  assert.ok(approvedReuse, 'A historical pose is allowed only for the already reviewed native result');
}
function verified(base, entry) {
  const path = resolve(base, entry.path); assert.ok(path.startsWith(`${resolve(base)}/`), 'Artifact escaped its root');
  const bytes = readFileSync(path); assert.equal(sha256(bytes), entry.sha256); if (entry.bytes !== undefined) assert.equal(bytes.length, entry.bytes); if (entry.sizeBytes !== undefined) assert.equal(bytes.length, entry.sizeBytes); return bytes;
}
const artifactJson = (path, value) => immutable(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
const bodyHash = value => sha256(JSON.stringify(value));

function koGroup(targetKey, manifest, ledger) {
  const uniqueFrame = Number(targetKey.split(':')[1]);
  const bytes = readFileSync(KO_PREPARATION), prep = JSON.parse(bytes.toString());
  assert.deepEqual(prep.identity, manifest.identity); assert.deepEqual(prep.reviewedReuseFrames, [2, 5]);
  const prior = prep.records.filter(record => record.uniqueFrame === uniqueFrame);
  for (const record of prior) {
    const request = ledger.requests[record.parent.id]; assert.equal(request.status, 'complete'); assert.equal(request.provider, 'gemini');
    assert.equal(request.request.sha256, record.parent.requestSha256); assert.equal(request.response.sha256, record.parent.responseSha256);
    verified(DIRECTORY, request.request); verified(DIRECTORY, request.response); verified(dirname(KO_PREPARATION), record.raw);
  }
  const pose = prep.poses[uniqueFrame - 1]; verified(dirname(KO_PREPARATION), pose);
  return { animationName: 'ko', uniqueFrameCount: 8, rookieOriginal: prep.originalSpriteEntry, championOriginal: null,
    canaryEvidence: { preparationSha256: sha256(bytes), originalAttempts: prior.map(record => record.parent), originalChampion: null, pendingFinalDerivativeScope: true },
    reuseNative: [2, 5].includes(uniqueFrame) ? { ...prior[0].raw, path: relative(ROOT, resolve(dirname(KO_PREPARATION), prior[0].raw.path)) } : null,
    frames: [{ uniqueFrame, playbackFrames: [uniqueFrame], pose, render: prior[0]?.parent ?? null }] };
}

export async function runSelectiveRepair(args = process.argv.slice(2)) {
  const options = selectiveRepairOptions(args);
  const manifest = JSON.parse(readFileSync(join(DIRECTORY, 'manifest.json'), 'utf8'));
  const ledger = JSON.parse(readFileSync(join(DIRECTORY, 'provider-ledger.json'), 'utf8'));
  const preparationBytes = readFileSync(PREPARATION), preparation = JSON.parse(preparationBytes.toString());
  assert.equal(preparation.completed, true); assert.deepEqual(preparation.identity, manifest.identity);
  const { installCanvasRuntime } = await import('../processor/src/canvasRuntime.ts'); installCanvasRuntime();
  const { createCanvas, loadImage } = await import('../processor/node_modules/@napi-rs/canvas/index.js');
  const { geminiRefineSpriteFrame, cleanCellsWithUnionMasks } = await import('../src/services/GeminiApi.ts');
  const { createDetachedApiRequestContext } = await import('../src/services/ApiClient.ts');
  const { getConfiguredBgRemovalProvider } = await import('../src/services/BackgroundRemovalService.ts');
  const productFiles = manifest.productFiles.map(entry => ({ path: entry.path, sha256: sha256(readFileSync(join(ROOT, entry.path))) }));
  const fingerprint = sha256(JSON.stringify({ schemaVersion: 1, sourceSha: manifest.identity.sourceSha256, productFiles, sourcePrompt: manifest.sourcePrompt }));
  const runnerFiles = ['scripts/run-casual-selective-repair.mjs', 'scripts/casual-selective-repair-cli.mjs', 'scripts/casual-selective-repair-provenance.mjs'].map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) }));
  const nativeFetch = globalThis.fetch, diagnostics = [], restore = installCasualWindow(diagnostics), plans = [];
  try {
    for (const targetKey of options.target === 'all' ? TARGETS : [options.target]) {
      const [animationName, frameString] = targetKey.split(':'), uniqueFrame = Number(frameString);
      const group = animationName === 'ko' ? koGroup(targetKey, manifest, ledger) : preparation.groups.find(group => group.animationName === animationName), frame = group.frames.find(frame => frame.uniqueFrame === uniqueFrame);
      const current = manifest.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'contender');
      if (group.championOriginal) { assert.equal(current.sha256, group.championOriginal.sha256, 'Original Champion changed before repair'); assert.equal(current.rawSha256, group.championOriginal.rawSha256); }
      else assert.equal(current, undefined, 'The incomplete KO must not acquire an unreviewed completed sheet');
      const sourceKind = animationName === 'crouch' ? 'upright_raw' : animationName === 'low_kick' ? 'crouch_raw' : 'side', source = manifest.sources.find(source => source.kind === sourceKind);
      const identity = { data: verified(DIRECTORY, source).toString('base64'), mimeType: 'image/png' };
      const activeRookie = manifest.sprites.find(sprite => sprite.animationName === animationName && sprite.qualityTier === 'rookie');
      let rookie = activeRookie, rookieCorrection = null;
      if (targetKey === 'crouch:1' && activeRookie.sha256 !== group.rookieOriginal.sha256) {
        const descriptor = manifest.derivatives.find(item => item.id === activeRookie.derivativeId), proof = JSON.parse(verified(DIRECTORY, descriptor));
        assertHistoricalCrouchPose({ targetKey, activeRookie, originalRookie: group.rookieOriginal, proof, approvedReuse: !!APPROVED_REUSE[targetKey] });
        rookie = group.rookieOriginal; rookieCorrection = { proof: descriptor, originalRookieSha256: rookie.sha256, currentRookieSha256: activeRookie.sha256 };
      }
      assert.equal(rookie.sha256, group.rookieOriginal.sha256);
      const sheet = await loadImage(verified(DIRECTORY, rookie)), cell = createCanvas(768, 1024);
      cell.getContext('2d').drawImage(sheet, (uniqueFrame - 1) % rookie.gridCols * 768, Math.floor((uniqueFrame - 1) / rookie.gridCols) * 1024, 768, 1024, 0, 0, 768, 1024);
      const pose = { data: cell.toDataURL('image/png').split(',')[1], mimeType: 'image/png' };
      assert.equal(sha256(Buffer.from(pose.data, 'base64')), frame.pose.sha256, 'Exact Rookie pose index changed');
      if (frame.render) {
        const parent = ledger.requests[frame.render.id]; assert.equal(parent.status, 'complete'); assert.equal(parent.provider, 'gemini');
        assert.equal(parent.request.sha256, frame.render.requestSha256); assert.equal(parent.response.sha256, frame.render.responseSha256);
        const request = JSON.parse(verified(DIRECTORY, parent.request).toString()); verified(DIRECTORY, parent.response);
        const originalImages = request.contents[0].parts.filter(part => part.inlineData).map(part => sha256(Buffer.from(part.inlineData.data, 'base64')));
        assert.equal(originalImages.length, 2); assert.ok(originalImages.includes(frame.pose.sha256)); assert.ok(originalImages.includes(source.sha256));
      } else assert.ok(animationName === 'ko' && [7, 8].includes(uniqueFrame), 'Only KO7/8 have no prior render');
      const motion = selectiveAnimationMotion(readFileSync(join(ROOT, 'worker/src/generationWorkflow.ts'), 'utf8'), animationName);
      const context = createDetachedApiRequestContext({ apiBaseUrl: LOCAL_ORIGIN, authorizationToken: 'local-artifact-only', providerRequestScope: `${ID}:${targetKey}` });
      let captured;
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        assert.equal(url.origin, LOCAL_ORIGIN); assert.equal(url.pathname, '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent'); assert.equal(captured, undefined, 'Only one normal-product request may be captured');
        captured = { path: url.pathname.replace('/proxy/gemini', ''), body: JSON.parse(String(init?.body)) }; return stopped('Offline selective request captured');
      };
      await geminiRefineSpriteFrame(identity.data, pose.data, animationName, motion, uniqueFrame - 1, group.uniqueFrameCount, context, 'gemini-3.1-flash-image')
        .then(() => { throw new Error('Offline generation unexpectedly succeeded'); }, error => assert.match(error.message, /Offline selective request captured/));
      assert.ok(captured);
      const plan = { schemaVersion: 1, id: ID, fingerprint, productFiles, runnerFiles, preparationSha256: sha256(preparationBytes),
        target: { animationName, qualityTier: 'contender', uniqueFrame, playbackFrames: frame.playbackFrames }, parent: frame.render,
        pose: { sha256: frame.pose.sha256, rookiePath: rookie.path, rookieSha256: rookie.sha256 }, identity: { kind: sourceKind, sha256: source.sha256 },
        request: { path: captured.path, sha256: bodyHash(captured.body) }, dispatchCaps: { render: { gemini: 1, fal: 0 }, clean: { gemini: 0, fal: 1 } },
        canaryEvidence: group.canaryEvidence ?? null, rookieCorrection,
        reuseNative: group.reuseNative ?? null, reusePilot: APPROVED_REUSE[targetKey] ?? null };
      const planSha256 = bodyHash(plan), output = join(DIRECTORY, 'review/selective-repair-v1', `${animationName}-${uniqueFrame}`, planSha256);
      if (!options.execute) {
        immutable(join(output, 'request.json'), Buffer.from(JSON.stringify(captured.body))); artifactJson(join(output, 'plan.json'), plan);
        if (group.canaryEvidence) artifactJson(join(output, `original-manifest-${bodyHash(manifest)}.json`), manifest);
        plans.push({ target: targetKey, planSha256, output: relative(ROOT, output), reusePilot: !!plan.reusePilot, reuseNative: !!plan.reuseNative, canary: !!group.canaryEvidence, migrationRequired: fingerprint !== manifest.fingerprint }); continue;
      }
      assert.equal(options.planSha256, planSha256); assert.equal(process.env.CASUAL_GENERATION_CREDENTIALS_READY, '1');
      assert.equal(fingerprint, manifest.fingerprint, 'Audit/migrate the product fingerprint before repair');
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8')), plan, 'Prepare and review the exact target plan first');
      assert.equal(sha256(readFileSync(join(output, 'request.json'))), plan.request.sha256);
      const release = acquireLock(DIRECTORY);
      try {
        const latest = JSON.parse(readFileSync(join(DIRECTORY, 'manifest.json'), 'utf8')); assert.equal(latest.fingerprint, fingerprint);
        const latestLedger = JSON.parse(readFileSync(join(DIRECTORY, 'provider-ledger.json'), 'utf8')); assert.equal(latestLedger.fingerprint, fingerprint);
        const resultPath = join(output, `${options.step}.result.json`);
        if (existsSync(resultPath)) { const prior = JSON.parse(readFileSync(resultPath, 'utf8')); assert.equal(prior.planSha256, planSha256); verified(DIRECTORY, prior.image); plans.push({ target: targetKey, status: 'already-complete', result: relative(ROOT, resultPath) }); continue; }
        if (plan.reusePilot) {
          if (options.step === 'clean') assert.equal(options.rawReviewed, plan.reusePilot.rawSha256);
          // The reviewed pilot has a distinct frozen plan/history; keep its exact original receipt rather than relabelling it.
          const pilot = JSON.parse(readFileSync(join(DIRECTORY, plan.reusePilot.path, `${options.step}.result.json`), 'utf8'));
          assert.deepEqual(pilot.parent, plan.parent); assert.deepEqual(pilot.target, plan.target);
          assert.equal(pilot.image.sha256, options.step === 'render' ? plan.reusePilot.rawSha256 : plan.reusePilot.cleanSha256); verified(DIRECTORY, pilot.image);
          plans.push({ target: targetKey, status: 'reuse-reviewed-pilot', result: relative(ROOT, join(DIRECTORY, plan.reusePilot.path, `${options.step}.result.json`)) }); continue;
        }
        if (plan.reuseNative && options.step === 'render') {
          const bytes = verified(ROOT, plan.reuseNative), imagePath = join(output, `render-${sha256(bytes)}.png`); immutable(imagePath, bytes);
          const image = { ...plan.reuseNative, path: relative(DIRECTORY, imagePath) };
          artifactJson(resultPath, { schemaVersion: 1, id: ID, step: 'render', planSha256, parent: plan.parent, target: plan.target, image,
            requests: [{ ...plan.parent, provider: 'gemini', status: 'complete' }], reusedOriginalNative: true, newProviderCalls: 0 });
          plans.push({ target: targetKey, status: 'reused-reviewed-original-native', result: relative(ROOT, resultPath), imageSha256: image.sha256 }); continue;
        }
        const disk = statfsSync(DIRECTORY); assert.ok(Number(disk.bavail) * Number(disk.bsize) > 256 * 1024 * 1024);
        const stage = `${ID}:${targetKey}:${planSha256}:${options.step}`;
        class RepairTransport extends CasualTransport {
          async submit(provider, path, body) {
            const id = sha256(`${provider}\n${path}\n${JSON.stringify(body)}`);
            try { assertSelectiveDispatch({ provider, path, bodySha256: bodyHash(body), step: options.step, plan, owned: Object.values(this.state.requests).filter(record => record.stage === stage).length, exists: !!this.state.requests[id] }); }
            catch (error) { return stopped(error.message); }
            return super.submit(provider, path, body);
          }
        }
        const transport = new RepairTransport({ directory: DIRECTORY, fingerprint, phase: 'full', caps: latestLedger.phases.full.caps, fetchImpl: nativeFetch,
          credentials: { geminiTransport: process.env.CASUAL_GEMINI_TRANSPORT, geminiKey: process.env.CASUAL_GEMINI_KEY, falMeterkeyKey: process.env.CASUAL_FAL_METERKEY_KEY } });
        transport.assertHealthy(); transport.setStage(stage); globalThis.fetch = transport.handle.bind(transport); diagnostics.length = 0;
        let image;
        if (options.step === 'render') image = await geminiRefineSpriteFrame(identity.data, pose.data, animationName, motion, uniqueFrame - 1, group.uniqueFrameCount, context, 'gemini-3.1-flash-image');
        else {
          const raw = JSON.parse(readFileSync(join(output, 'render.result.json'), 'utf8')); assert.equal(raw.planSha256, planSha256); assert.equal(raw.image.sha256, options.rawReviewed, 'Clean only the exact visually reviewed RAW');
          assert.equal(getConfiguredBgRemovalProvider(), 'fal'); [image] = await cleanCellsWithUnionMasks([verified(DIRECTORY, raw.image).toString('base64')], animationName, context);
          assert.ok(diagnostics.some(line => /1\/1 unioned with fal, 0 chroma-only/.test(line)), 'No cleanup fallback is publishable');
        }
        transport.assertHealthy(); const bytes = Buffer.from(image, 'base64'), decoded = await loadImage(bytes), imagePath = join(output, `${options.step}-${sha256(bytes)}.png`); immutable(imagePath, bytes);
        const requests = Object.values(transport.state.requests).filter(record => record.stage === stage || record.reusedBy?.includes(stage)).map(record => ({ id: record.id, provider: record.provider, requestSha256: record.request.sha256, responseSha256: record.response?.sha256, status: record.status }));
        assert.equal(requests.length, 1); assert.equal(requests[0].status, 'complete');
        artifactJson(resultPath, { schemaVersion: 1, id: ID, step: options.step, planSha256, parent: plan.parent, target: plan.target,
          image: { path: relative(DIRECTORY, imagePath), sha256: sha256(bytes), bytes: bytes.length, mime: 'image/png', width: decoded.width, height: decoded.height }, requests, diagnostics });
        plans.push({ target: targetKey, status: 'awaiting-visual-review', result: relative(ROOT, resultPath), imageSha256: sha256(bytes) });
      } finally { release(); }
    }
    console.log(JSON.stringify({ id: ID, execute: options.execute, plans, ...(!options.execute ? { plannedNewRenderCalls: plans.filter(plan => !plan.reusePilot && !plan.reuseNative).length } : {}) }, null, 2));
    return plans;
  } finally { globalThis.fetch = nativeFetch; restore(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runSelectiveRepair().catch(error => { console.error(error.message); process.exitCode = 1; });
