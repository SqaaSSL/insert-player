import assert from 'node:assert/strict';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error The separately tested artifact transport is ESM JavaScript.
import { CasualTransport, LOCAL_ORIGIN, acquireLock, immutable, installCasualWindow, sha256 } from '../../scripts/casual-generation-transport.mjs';
import { installCanvasRuntime } from './canvasRuntime';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDetachedApiRequestContext } from '../../src/services/ApiClient';
import { cleanCellsWithUnionMasks, geminiRefineSpriteFrame } from '../../src/services/GeminiApi';
import { getConfiguredBgRemovalProvider } from '../../src/services/BackgroundRemovalService';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIRECTORY = join(ROOT, '.artifacts/casual-generation-v1');
const OUTPUT = join(DIRECTORY, 'review/pose-primary-refinement-v1/pilot');
const ID = 'casual-low-kick-unique4-pose-primary-v1';
const PARENT = 'c52cfcd8048afa620f68407b2d0fa96a9361e9311b93c6b4596dea523655bb26';
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
function verified(path: string, hash: string): Buffer { const bytes = readFileSync(path); assert.equal(sha256(bytes), hash); return bytes; }
function readOutput(path: string, hash: string): Buffer {
  const absolute = resolve(DIRECTORY, path); assert.ok(absolute.startsWith(`${DIRECTORY}/`)); return verified(absolute, hash);
}
function writeJson(path: string, value: unknown) { return immutable(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
const stopped = (message: string) => new Response(JSON.stringify({ code: 'provider_request_not_dispatched', error: { message } }), { status: 409 });

async function main() {
  assert.ok(process.argv.slice(2).every(arg => ['--execute', '--step=render', '--step=clean', `--confirm=${ID}`].includes(arg) || arg.startsWith('--raw-reviewed=')), 'Unexpected pilot option');
  const execute = process.argv.includes('--execute'); const step = option('step') ?? 'render';
  const manifest = JSON.parse(readFileSync(join(DIRECTORY, 'manifest.json'), 'utf8'));
  const ledger = JSON.parse(readFileSync(join(DIRECTORY, 'provider-ledger.json'), 'utf8'));
  assert.equal(manifest.fingerprint, ledger.fingerprint);
  const parent = ledger.requests[PARENT]; assert.equal(parent.status, 'complete'); assert.equal(parent.httpStatus, 200);
  assert.equal(parent.provider, 'gemini'); assert.equal(parent.model, '/v1beta/models/gemini-3.1-flash-image:generateContent');
  const original = JSON.parse(verified(parent.request.path, parent.request.sha256).toString()); verified(parent.response.path, parent.response.sha256);
  const [identityPart, posePart] = original.contents[0].parts;
  const identity = identityPart.inlineData.data; const pose = posePart.inlineData.data;
  assert.equal(identityPart.inlineData.mimeType, 'image/png'); assert.equal(posePart.inlineData.mimeType, 'image/png');
  const source = manifest.sources.find((entry: any) => entry.kind === 'crouch_raw'); assert.ok(source);
  assert.equal(sha256(Buffer.from(identity, 'base64')), source.sha256); readOutput(source.path, source.sha256);
  const rookie = manifest.sprites.find((entry: any) => entry.animationName === 'low_kick' && entry.qualityTier === 'rookie'); assert.ok(rookie);
  installCanvasRuntime();
  const sheet = await loadImage(readOutput(rookie.path, rookie.sha256));
  assert.equal(rookie.frameWidth, 768); assert.equal(rookie.frameHeight, 1024);
  const cell = createCanvas(768, 1024); cell.getContext('2d').drawImage(sheet, 3 * 768, 0, 768, 1024, 0, 0, 768, 1024);
  assert.equal(sha256(Buffer.from(cell.toDataURL('image/png').split(',')[1], 'base64')), sha256(Buffer.from(pose, 'base64')), 'The exact original fourth Rookie pose must be used');
  const motion = readFileSync(join(ROOT, 'worker/src/generationWorkflow.ts'), 'utf8').match(/\{ name: 'low_kick', motion: '([^']+)', frames: 7, base: 'crouched' \}/)?.[1]; assert.ok(motion);
  const currentProductFiles = manifest.productFiles.map((entry: any) => ({ path: entry.path, sha256: sha256(readFileSync(join(ROOT, entry.path))) }));
  const currentFingerprint = sha256(JSON.stringify({ schemaVersion: 1, sourceSha: manifest.identity.sourceSha256, productFiles: currentProductFiles, sourcePrompt: manifest.sourcePrompt }));
  const runnerFiles = ['processor/src/casualRefinementPilotCli.ts', 'scripts/run-casual-refinement-pilot.mjs'].map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) }));
  const diagnostics: string[] = []; const restoreWindow = installCasualWindow(diagnostics); const nativeFetch = globalThis.fetch;
  const context = createDetachedApiRequestContext({ apiBaseUrl: LOCAL_ORIGIN, authorizationToken: 'local-artifact-only', providerRequestScope: ID });
  let captured: { path: string; body: unknown } | undefined;
  try {
    // A real shared-helper dry run captures the exact request without creating a transport or touching the paid ledger.
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      assert.equal(url.origin, LOCAL_ORIGIN); assert.equal(url.pathname, '/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent');
      assert.equal(captured, undefined, 'The dry run must construct exactly one request');
      captured = { path: url.pathname.replace('/proxy/gemini', ''), body: JSON.parse(String(init?.body)) };
      return stopped('Offline pilot request captured');
    };
    await geminiRefineSpriteFrame(identity, pose, 'low_kick', motion, 3, 4, context, 'gemini-3.1-flash-image')
      .then(() => { throw new Error('Offline request unexpectedly succeeded'); }, error => assert.match(error.message, /Offline pilot request captured/));
    assert.ok(captured);
    const requestBytes = Buffer.from(JSON.stringify(captured.body));
    const plan = { schemaVersion: 1, id: ID, fingerprint: currentFingerprint, runnerFiles,
      target: { animationName: 'low_kick', qualityTier: 'contender', uniqueFrame: 4, playbackFrames: [4] },
      parent: { id: PARENT, requestSha256: parent.request.sha256, responseSha256: parent.response.sha256 },
      pose: { sha256: sha256(Buffer.from(pose, 'base64')), rookiePath: rookie.path, rookieSha256: rookie.sha256 },
      identity: { kind: 'crouch_raw', sha256: source.sha256 },
      request: { path: captured.path, sha256: sha256(requestBytes) },
      dispatchCaps: { render: { gemini: 1, fal: 0 }, clean: { gemini: 0, fal: 1 } },
      cumulativePhase: 'full', cumulativeCaps: ledger.phases.full.caps,
      note: 'Normal product helper and model. Original source, pose, requests and sprites preserved. Render requires separate raw review before BiRefNet cleanup. No automatic paid second attempt.' };
    if (!execute) {
      immutable(join(OUTPUT, 'request.json'), requestBytes); writeJson(join(OUTPUT, 'plan.json'), plan);
      console.log(JSON.stringify({ ...plan, ledgerMigrationRequired: currentFingerprint !== manifest.fingerprint, requestFile: relative(ROOT, join(OUTPUT, 'request.json')), resultDirectory: relative(ROOT, OUTPUT) }, null, 2)); return;
    }
    assert.equal(option('confirm'), ID); assert.equal(process.env.CASUAL_GENERATION_CREDENTIALS_READY, '1');
    assert.equal(manifest.fingerprint, currentFingerprint, 'Root must audit and migrate the generation fingerprint first');
    assert.deepEqual(JSON.parse(readFileSync(join(OUTPUT, 'plan.json'), 'utf8')), plan, 'Prepare and review this exact frozen pilot first');
    assert.equal(sha256(readFileSync(join(OUTPUT, 'request.json'))), plan.request.sha256);
    const disk = statfsSync(DIRECTORY); assert.ok(Number(disk.bavail) * Number(disk.bsize) > 256 * 1024 * 1024);
    const release = acquireLock(DIRECTORY);
    try {
      const resultPath = join(OUTPUT, `${step}.result.json`);
      if (existsSync(resultPath)) {
        const prior = JSON.parse(readFileSync(resultPath, 'utf8')); assert.equal(prior.planSha256, sha256(JSON.stringify(plan)));
        readOutput(prior.image.path, prior.image.sha256); console.log(JSON.stringify({ status: 'already-complete', result: relative(ROOT, resultPath) })); return;
      }
      const TransportBase = CasualTransport as new (options: Record<string, unknown>) => {
        state: { requests: Record<string, any> };
        submit(provider: string, path: string, body: unknown): Promise<Response>;
        assertHealthy(): void; setStage(stage: string): void; handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      };
      class PilotTransport extends TransportBase {
        async submit(provider: string, path: string, body: unknown) {
          if (step === 'render' && (provider !== 'gemini' || path !== captured!.path || sha256(JSON.stringify(body)) !== plan.request.sha256)) return stopped('Pilot permits only the exact reviewed first Gemini request; automatic correction requires separate review');
          if (step === 'clean' && (provider !== 'fal' || path !== '/fal-ai/birefnet')) return stopped('Pilot cleanup permits only BiRefNet');
          const requestId = sha256(`${provider}\n${path}\n${JSON.stringify(body)}`);
          const owned = Object.values(this.state.requests).filter((record: any) => record.stage === `${ID}:${step}`);
          if (!this.state.requests[requestId] && owned.length >= 1) return stopped('Pilot dispatch cap reached; paid attempts remain preserved');
          return super.submit(provider, path, body);
        }
      }
      const transport = new PilotTransport({ directory: DIRECTORY, fingerprint: manifest.fingerprint, phase: 'full', caps: ledger.phases.full.caps,
        fetchImpl: nativeFetch, credentials: { geminiTransport: process.env.CASUAL_GEMINI_TRANSPORT, geminiKey: process.env.CASUAL_GEMINI_KEY, falMeterkeyKey: process.env.CASUAL_FAL_METERKEY_KEY } });
      transport.assertHealthy(); transport.setStage(`${ID}:${step}`); globalThis.fetch = transport.handle.bind(transport); diagnostics.length = 0;
      let image: string;
      if (step === 'render') image = await geminiRefineSpriteFrame(identity, pose, 'low_kick', motion, 3, 4, context, 'gemini-3.1-flash-image');
      else {
        const raw = JSON.parse(readFileSync(join(OUTPUT, 'render.result.json'), 'utf8')); assert.equal(raw.planSha256, sha256(JSON.stringify(plan)));
        assert.equal(option('raw-reviewed'), raw.image.sha256, 'Cleanup requires review of the exact raw output SHA');
        assert.equal(getConfiguredBgRemovalProvider(), 'fal');
        const [cleaned] = await cleanCellsWithUnionMasks([readOutput(raw.image.path, raw.image.sha256).toString('base64')], 'low_kick', context); image = cleaned;
        assert.ok(diagnostics.some(line => /1\/1 unioned with fal, 0 chroma-only/.test(line)), 'Pilot requires a successful BiRefNet union; no cleanup fallback');
      }
      transport.assertHealthy();
      const bytes = Buffer.from(image, 'base64'); const imagePath = join(OUTPUT, `${step}-${sha256(bytes)}.png`); immutable(imagePath, bytes);
      const decoded = await loadImage(bytes); const requests = Object.values(transport.state.requests).filter((record: any) => record.stage === `${ID}:${step}`)
        .map((record: any) => ({ id: record.id, provider: record.provider, requestSha256: record.request.sha256, responseSha256: record.response?.sha256, status: record.status }));
      writeJson(resultPath, { schemaVersion: 1, id: ID, step, planSha256: sha256(JSON.stringify(plan)), parent: plan.parent, target: plan.target,
        image: { path: relative(DIRECTORY, imagePath), sha256: sha256(bytes), bytes: bytes.length, mime: 'image/png', width: decoded.width, height: decoded.height }, requests, diagnostics });
      console.log(JSON.stringify({ status: 'awaiting-visual-review', result: relative(ROOT, resultPath), imageSha256: sha256(bytes), requests }));
    } finally { release(); }
  } finally { globalThis.fetch = nativeFetch; restoreWindow(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Casual refinement pilot failed'); process.exitCode = 1; });
