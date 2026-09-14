import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Task tooling consumes an ESM transport also covered independently by Vitest.
// @ts-expect-error JavaScript task transport intentionally has no declaration file.
import { CasualTransport, LOCAL_ORIGIN, acquireLock, atomicJson, immutable, installCasualWindow, sha256 } from '../../scripts/casual-generation-transport.mjs';
import { AURA_GENERATION_ANIMATIONS, assertPackageAnimationFrameCount } from '../../src/services/GenerationPackages';
import { PLAYABLE_ANIMATION_NAMES } from '../../src/services/PlayableFighterAssets';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIRECTORY = join(ROOT, '.artifacts/casual-generation-v1');
const ORIGINAL = 'public/assets/landing-panel-photo2-2de4f7af.webp';
const ORIGINAL_SHA = 'e29f551726c5e80941bcf63618401bbf00429d56df52f6cbb20d8da57435c210';
const MANIFEST = join(DIRECTORY, 'manifest.json');
const PRODUCT_FILES = [
  'src/services/GeminiApi.ts', 'src/services/SpritePostProcess.ts', 'src/services/BackgroundRemovalService.ts',
  'src/services/GenerationPackages.ts', 'src/services/AnimationProfiles.ts', 'src/services/FrameSequence.ts',
  'src/services/AlphaMask.ts', 'worker/src/generationWorkflow.ts', 'worker/src/tiers.ts',
  'src/services/CharacterPipeline.ts', 'src/services/ImageProviderContract.ts', 'src/services/GeminiRequestPolicy.ts',
  'src/services/SpriteGrid.ts', 'src/services/FreepikApi.ts', 'src/services/ApiClient.ts',
  'processor/src/canvasRuntime.ts', 'processor/src/casualGenerationCli.ts',
];
interface Animation { name: string; motion: string; frames: number; base: 'standing' | 'crouched' }
interface Artifact { path: string; sha256: string; bytes: number; mime: string }
interface Source extends Artifact { kind: string }
interface Sprite extends Artifact {
  animationName: string; qualityTier: 'rookie' | 'contender'; frameWidth: number; frameHeight: number;
  frameCount: number; processingVersion: number; rawPath: string; rawSha256: string; rawBytes: number;
  rawWidth: number; rawHeight: number; rawMime: 'image/png'; animationFormat: 'legacy';
  gridCols: number; gridRows: number; debugPath: string;
}
interface Manifest {
  schemaVersion: 1; identity: { slug: string; name: string; sourceSha256: string };
  fingerprint: string; productRevision: string; productFiles: { path: string; sha256: string }[];
  sources: Source[]; sprites: Sprite[]; conversions: object[]; phaseStatus: Record<string, string>;
  sourcePrompt: string; createdAt: string; updatedAt: string;
}

function option(name: string): string | undefined {
  const value = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return value?.slice(name.length + 3);
}
function artifact(name: string, bytes: Buffer, mime = 'image/png'): Artifact {
  const path = join(DIRECTORY, name);
  immutable(path, bytes);
  return { path: relative(DIRECTORY, path), sha256: sha256(bytes), bytes: bytes.length, mime };
}
function readArtifact(item: Artifact): Buffer {
  const path = resolve(DIRECTORY, item.path);
  assert.ok(path.startsWith(`${DIRECTORY}/`));
  const bytes = readFileSync(path); assert.equal(sha256(bytes), item.sha256);
  return bytes;
}
function imageArtifact(name: string, base64: string): Artifact {
  const bytes = Buffer.from(base64, 'base64');
  return artifact(`outputs/${name}-${sha256(bytes)}.png`, bytes);
}
function loadAnimations(): Animation[] {
  // Extract the actual immutable contract rather than maintaining a second motion prompt catalogue.
  const code = readFileSync(join(ROOT, 'worker/src/generationWorkflow.ts'), 'utf8');
  const combat = [...code.matchAll(/\{ name: '([^']+)', motion: '([^']+)', frames: (\d+), base: '(standing|crouched)' \}/g)]
    .map(match => ({ name: match[1], motion: match[2], frames: Number(match[3]), base: match[4] as Animation['base'] }));
  assert.deepEqual(combat.map(item => item.name), [...PLAYABLE_ANIMATION_NAMES], 'Product animation contract extraction changed');
  return [...combat, ...AURA_GENERATION_ANIMATIONS.map(item => ({ ...item, frames: 6, base: 'standing' as const }))];
}
function save(manifest: Manifest) {
  manifest.updatedAt = new Date().toISOString(); atomicJson(MANIFEST, manifest);
}

async function main() {
  const phase = option('phase') ?? 'canary'; assert.ok(['canary', 'full'].includes(phase));
  const execute = process.argv.includes('--execute');
  const recoverOnly = process.argv.includes('--recover-only');
  const reconcileFalOnly = process.argv.includes('--reconcile-fal-meterkey-only');
  assert.ok(!(recoverOnly && reconcileFalOnly), 'Choose either queue recovery or routing reconciliation');
  const sourceBytes = readFileSync(join(ROOT, ORIGINAL)); assert.equal(sha256(sourceBytes), ORIGINAL_SHA);
  const productFiles = PRODUCT_FILES.map(path => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) }));
  const productCode = readFileSync(join(ROOT, 'src/services/GeminiApi.ts'), 'utf8');
  const reposeBase = productCode.match(/const REPOSE_BASE = `([^`]+)`;/)?.[1]; assert.ok(reposeBase);
  const sourcePrompt = `${reposeBase} Preserve the original clothing/outfit faithfully. This is Casual, the existing synthetic adult platform character. Keep his grey zip-front hoodie, dark charcoal-grey long trousers, and brown lace-up boots. Preserve his short dark curly hair, light facial stubble and realistic adult proportions. No gloves, accessories, logos, weapons, additional people, or costume change.`;
  const fingerprint = sha256(JSON.stringify({ schemaVersion: 1, sourceSha: ORIGINAL_SHA, productFiles, sourcePrompt }));
  const animations = loadAnimations();
  const selected = phase === 'canary' ? animations.filter(item => item.name === 'idle') : animations;
  const caps = { gemini: Number(option('max-gemini') ?? (phase === 'canary' ? 32 : 240)),
    fal: Number(option('max-fal') ?? (phase === 'canary' ? 16 : 120)) };
  const plan = { schemaVersion: 1, phase, source: { path: ORIGINAL, sha256: ORIGINAL_SHA }, fingerprint,
    tiers: [{ id: 'rookie', label: 'Rookie', pipeline: 'sheet' }, { id: 'contender', label: 'Champion', pipeline: 'sheet_refined' }],
    animations: selected, caps, duplicateRequestPolicy: 'replay-identical-body-without-another-submission',
    estimatedNominalCalls: phase === 'canary' ? { gemini: 10, fal: 8 } : { gemini: 124, fal: 104 },
    note: 'Nominal calls assume successful validation and shared exact scaffold responses; caps include retries. No artificial degradation or provider substitutions.',
    manifest: relative(ROOT, MANIFEST) };
  if (!execute) { console.log(JSON.stringify(plan, null, 2)); return; }
  assert.equal(option('confirm'), `casual-${phase}-v1`, 'Execution requires exact phase confirmation');
  assert.ok(process.env.CASUAL_GENERATION_CREDENTIALS_READY === '1', 'Use the dedicated credential wrapper');
  const release = acquireLock(DIRECTORY);
  const nativeFetch = globalThis.fetch;
  let restoreWindow: (() => void) | undefined;
  let manifest: Manifest | undefined;
  try {
    immutable(join(DIRECTORY, `plan-${phase}.json`), Buffer.from(`${JSON.stringify(plan, null, 2)}\n`));
    manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest : {
      schemaVersion: 1, identity: { slug: 'casual', name: 'Casual', sourceSha256: ORIGINAL_SHA }, fingerprint,
      productRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), productFiles,
      sources: [], sprites: [], conversions: [], phaseStatus: {}, sourcePrompt,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    assert.equal(manifest.fingerprint, fingerprint);
    if (phase === 'full' && !recoverOnly && !reconcileFalOnly) {
      assert.equal(manifest.phaseStatus.canary, 'awaiting_visual_review', 'A complete canary is required first');
      assert.ok(process.argv.includes('--canary-reviewed'), 'Full run requires the existing canary to have been visually reviewed');
    }
    const transport = new CasualTransport({ directory: DIRECTORY, fingerprint, phase, caps, fetchImpl: nativeFetch,
      credentials: { geminiTransport: process.env.CASUAL_GEMINI_TRANSPORT, geminiKey: process.env.CASUAL_GEMINI_KEY, falMeterkeyKey: process.env.CASUAL_FAL_METERKEY_KEY } });
    if (reconcileFalOnly) {
      console.log(JSON.stringify(transport.reconcileDirectFal403({ confirmation: option('confirm-reconciliation') }), null, 2));
      return;
    }
    if (recoverOnly) {
      console.log(JSON.stringify({ recovery: await transport.recoverKnownQueues(), submittedNewProviderCalls: 0 }, null, 2));
      return;
    }
    const disk = statfsSync(DIRECTORY);
    const requiredBytes = (phase === 'canary' ? 512 : 2048) * 1024 * 1024;
    assert.ok(Number(disk.bavail) * Number(disk.bsize) >= requiredBytes, `Insufficient disk for ${phase}; at least ${requiredBytes / 1024 / 1024} MiB required before generation`);
    transport.assertHealthy();
    globalThis.fetch = transport.handle.bind(transport) as typeof fetch;
    const { installCanvasRuntime } = await import('./canvasRuntime'); installCanvasRuntime();
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const { createDetachedApiRequestContext } = await import('../../src/services/ApiClient');
    const { geminiReposeDetailed, geminiUprightReposeDetailed, geminiCrouchReposeDetailed, geminiSpriteSheet, geminiSheetRefined } = await import('../../src/services/GeminiApi');
    const { CELL_W, CELL_H, measureOpaqueBoundsFromBase64 } = await import('../../src/services/SpritePostProcess');
    const { getAnimationProfile } = await import('../../src/services/AnimationProfiles');
    const { clearDebugLog, getDebugLogLines } = await import('../../src/services/DebugLog');
    // Keep every product diagnostic; its normal in-memory log ring stores only the last 40 lines.
    const diagnostics: string[] = [];
    restoreWindow = installCasualWindow(diagnostics);
    const processingVersion = Number(readFileSync(join(ROOT, 'src/services/CharacterPipeline.ts'), 'utf8').match(/export const SPRITE_PROCESSING_VERSION = (\d+)/)?.[1]);
    assert.ok(processingVersion > 0);
    const context = createDetachedApiRequestContext({ apiBaseUrl: LOCAL_ORIGIN, authorizationToken: 'local-artifact-only', providerRequestScope: 'casual-v1' });
    const original = artifact(`inputs/original-${ORIGINAL_SHA}.webp`, sourceBytes, 'image/webp');
    if (!manifest.sources.some(item => item.kind === 'original')) manifest.sources.push({ ...original, kind: 'original' });
    const decoded = await loadImage(sourceBytes); const canvas = createCanvas(decoded.width, decoded.height);
    canvas.getContext('2d').drawImage(decoded, 0, 0);
    const input = artifact(`inputs/source-png-${ORIGINAL_SHA}.png`, canvas.toBuffer('image/png'));
    if (manifest.conversions.length === 0) manifest.conversions.push({ from: original, to: input, operation: 'Lossless pixel decode WebP to PNG; no resize, generation, or enhancement', width: decoded.width, height: decoded.height });
    save(manifest);
    const source = (kind: string) => {
      const item = manifest!.sources.find(candidate => candidate.kind === kind); assert.ok(item, `Missing source ${kind}`);
      return readArtifact(item).toString('base64');
    };
    async function createSource(kind: string, action: () => Promise<{ rawBase64: string; cleanedBase64: string }>) {
      const existing = manifest!.sources.find(item => item.kind === kind);
      if (existing) { readArtifact(existing); source(`${kind}_raw`); return; }
      transport.setStage(`source:${kind}`); console.log(`Generating shared ${kind} source...`);
      const result = await action(); transport.assertHealthy();
      manifest!.sources.push({ ...imageArtifact(`${kind}-raw`, result.rawBase64), kind: `${kind}_raw` },
        { ...imageArtifact(kind, result.cleanedBase64), kind }); save(manifest!);
    }
    await createSource('side', () => geminiReposeDetailed(readArtifact(input).toString('base64'), context, sourcePrompt));
    if (phase === 'full') {
      await createSource('upright', () => geminiUprightReposeDetailed(source('side_raw'), context));
      const bounds = await measureOpaqueBoundsFromBase64(source('upright')); assert.ok(bounds);
      const profile = getAnimationProfile('idle');
      const scale = Math.min(CELL_H * profile.targetHeightRatio / bounds.h, CELL_W * profile.targetWidthRatio / bounds.w);
      const normalization = { targetDrawHeight: Math.round(bounds.h * scale * 0.94), targetDrawWidth: Math.round(bounds.w * scale * 1.16), baselineRatio: 0.98 };
      await createSource('crouch', () => geminiCrouchReposeDetailed(source('upright_raw'), normalization, source('upright_raw'), context));
    }
    for (const animation of selected) {
      for (const tier of ['rookie', 'contender'] as const) {
        const prior = manifest.sprites.find(item => item.animationName === animation.name && item.qualityTier === tier);
        if (prior) {
          readArtifact(prior); readArtifact({ path: prior.rawPath, sha256: prior.rawSha256, bytes: prior.rawBytes, mime: 'image/png' }); continue;
        }
        transport.setStage(`sprite:${animation.name}:${tier}`); clearDebugLog(); diagnostics.length = 0;
        console.log(`Generating ${animation.name} / ${tier === 'contender' ? 'Champion' : 'Rookie'}...`);
        const crouched = animation.name === 'crouch' || animation.base === 'crouched';
        const primary = source(animation.name === 'crouch' ? 'upright_raw' : animation.base === 'crouched' ? 'crouch_raw' : 'side');
        const secondary = animation.name === 'crouch' ? source('crouch_raw') : undefined;
        const normalization = crouched ? { baselineRatio: 0.98 } : undefined;
        const result = tier === 'rookie'
          ? await geminiSpriteSheet(primary, animation.name, animation.motion, animation.frames, secondary, undefined, normalization, context, 'gemini-3.1-flash-image')
          : await geminiSheetRefined(primary, animation.name, animation.motion, animation.frames, secondary, undefined, normalization,
            { enableBgRemoval: true }, context, 'gemini-3.1-flash-image');
        transport.assertHealthy();
        assertPackageAnimationFrameCount(animation.name, result.frameCount);
        assert.equal(result.frameCount, animation.frames, 'Every requested playback frame must be present');
        const debug = diagnostics.length ? [...diagnostics] : getDebugLogLines();
        const raw = imageArtifact(`${animation.name}-${tier}-raw`, result.rawBase64);
        const processed = imageArtifact(`${animation.name}-${tier}`, result.imageBase64);
        const debugArtifact = artifact(`outputs/${animation.name}-${tier}-debug-${sha256(JSON.stringify(debug))}.json`, Buffer.from(JSON.stringify(debug, null, 2)), 'application/json');
        // Preserve generated evidence even when QA rejects it; never sell a fallback cell as a successful refinement.
        assert.ok(!debug.some(line => /falling back to base sheet cell/i.test(line)
          || Number(line.match(/(\d+) chroma-only\)/)?.[1] ?? 0) > 0), 'Refinement/segmentation fallback requires explicit visual recovery');
        const image = await loadImage(readArtifact(processed));
        const rawImage = await loadImage(readArtifact(raw));
        assert.equal(image.width, result.gridCols * CELL_W); assert.equal(image.height, result.gridRows * CELL_H);
        manifest.sprites.push({ ...processed, animationName: animation.name, qualityTier: tier, frameWidth: CELL_W, frameHeight: CELL_H,
          frameCount: result.frameCount, processingVersion, rawPath: raw.path, rawSha256: raw.sha256, rawBytes: raw.bytes,
          rawWidth: rawImage.width, rawHeight: rawImage.height, rawMime: 'image/png', animationFormat: 'legacy',
          gridCols: result.gridCols, gridRows: result.gridRows, debugPath: debugArtifact.path }); save(manifest);
      }
    }
    transport.assertHealthy();
    manifest.phaseStatus[phase] = 'awaiting_visual_review'; save(manifest);
    console.log(`Artifacts ready for visual review: ${MANIFEST}`);
  } catch (error) {
    if (manifest && !recoverOnly && !reconcileFalOnly) { manifest.phaseStatus[phase] = 'incomplete'; save(manifest); }
    throw error;
  } finally {
    globalThis.fetch = nativeFetch;
    restoreWindow?.();
    release();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Casual generation failed'); process.exitCode = 1; });
