import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
    WorkflowEntrypoint: class {
        env;
        constructor(_ctx, env) { this.env = env; }
    },
}));
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class NonRetryableError extends Error {
    } }));
vi.mock('../../src/services/ApiClient', async (importOriginal) => ({
    ...await importOriginal(), apiFetch: vi.fn(),
}));
import { authorizeGenerationPurchase } from './billing';
import { createGenerationJob } from './generationJobs';
import { FighterGenerationWorkflow } from './generationWorkflow';
import { getFighter } from './fighters';
import { CURRENT_LEGAL_VERSION } from './legal';
import { apiFetch } from '../../src/services/ApiClient';
import { downloadCloudFighterToLocal } from '../../src/services/CloudFighters';
import { AURA_ANIMATION_NAMES, resolveFighterModeReadiness } from '../../src/services/FighterAssetPacks';
import { closeSpriteCacheDatabase, configureSpriteCacheOwner, getAllSpritesForHash, getCachedMeta } from '../../src/services/SpriteCache';
import { buildArcadeSelectionSearch, readPreferredArcadePlayerPhotoHash } from '../../src/ui/shared/onboardingFlow';
const USER_ID = 'aura-lifecycle-owner';
const FIGHTER_ID = '7'.repeat(32);
const PHOTO_HASH = '6'.repeat(64);
const ORIGINAL_KEY = `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/original.png`;
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const auth = { userId: USER_ID, rateLimitKey: `user:${USER_ID}`, user: { id: USER_ID }, claims: {} };
const instances = new Set();
// Same trigger-aware migration harness used by importedGlobalVideoRecuration.
function migrationStatements(sql) {
    const statements = [];
    let statement = '';
    let trigger = false;
    for (const line of sql.split('\n')) {
        if (/^\s*--/.test(line) || (!statement && !line.trim()))
            continue;
        statement += `${line}\n`;
        if (/^\s*CREATE\s+TRIGGER\b/i.test(line))
            trigger = true;
        if (trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
            statements.push(statement.trim());
            statement = '';
            trigger = false;
        }
    }
    if (statement.trim())
        statements.push(statement.trim());
    return statements;
}
// Bounded synthetic PNG contract, as in generatedAssets integration fixtures.
// This tests persistence and identity, not provider image quality or decoding.
function png(marker) {
    const bytes = new Uint8Array(25);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(bytes.buffer).setUint32(16, 192 * 6);
    new DataView(bytes.buffer).setUint32(20, 256);
    bytes[24] = marker;
    return bytes;
}
const base64 = (marker) => Buffer.from(png(marker)).toString('base64');
async function bindings({ failLast = false } = {}) {
    const mf = new Miniflare({ workers: [{ config: {
                    type: 'worker', name: 'aura-lifecycle-test', compatibilityDate: '2026-08-22',
                    manifest: { mainModule: 'index.js', modules: {
                            'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };' },
                        } },
                    env: { DB: { type: 'd1', id: 'aura-lifecycle-db' }, SPRITES: { type: 'r2', name: 'aura-lifecycle-assets' } },
                } }] });
    instances.add(mf);
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('SPRITES');
    for (const migration of readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort()) {
        for (const statement of migrationStatements(readFileSync(join(migrationsDirectory, migration), 'utf8'))) {
            await db.prepare(statement).run();
        }
    }
    await db.batch([
        db.prepare("INSERT INTO users (id, clerk_user_id, oauth_provider, oauth_id, display_name, credits_balance) VALUES (?, ?, 'clerk', ?, 'Aura owner', 20)").bind(USER_ID, USER_ID, USER_ID),
        db.prepare("INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier, original_blob_key) VALUES (?, ?, 'Aura owner', ?, 'rookie', ?)")
            .bind(FIGHTER_ID, USER_ID, PHOTO_HASH, ORIGINAL_KEY),
    ]);
    await bucket.put(ORIGINAL_KEY, png(1));
    const workflowStarts = [];
    const spriteRequests = [];
    let didTransientFailure = false;
    let sixthWasPending = false;
    const processor = vi.fn(async (request) => {
        const path = new URL(request.url).pathname;
        const body = await request.json();
        if (path === '/v1/generate-source')
            return Response.json({ cleanedBase64: base64(10), rawBase64: base64(11), normalizationReference: { baselineRatio: 0.85 } });
        if (path !== '/v1/generate-sprite' || !body.animation)
            throw new Error(`Unexpected processor request: ${path}`);
        expect(body.tier).toBe('rookie');
        expect(body.animation.frames).toBe(6);
        expect(AURA_ANIMATION_NAMES).toContain(body.animation.name);
        spriteRequests.push(body.animation.name);
        if (body.animation.name === 'aura_mog_check' && !didTransientFailure) {
            didTransientFailure = true;
            return Response.json({ error: 'Synthetic transient processor failure before dispatch' }, { status: 503 });
        }
        if (body.animation.name === 'aura_one_leg') {
            expect(await db.prepare('SELECT status, progress_current, progress_total FROM generation_jobs').first())
                .toEqual({ status: 'running', progress_current: 8, progress_total: 9 });
            expect(await db.prepare('SELECT COUNT(*) AS count FROM sprites').first()).toEqual({ count: 5 });
            sixthWasPending = true;
            if (failLast)
                return Response.json({ error: 'Synthetic last sprite unavailable' }, { status: 503 });
        }
        return Response.json({ imageBase64: base64(20 + AURA_ANIMATION_NAMES.indexOf(body.animation.name)),
            rawBase64: base64(40 + AURA_ANIMATION_NAMES.indexOf(body.animation.name)),
            frameW: 192, frameH: 256, frameCount: 6, gridCols: 6, gridRows: 1 });
    });
    const env = {
        DB: db, SPRITES: bucket, ENVIRONMENT: 'development', CORS_ORIGIN: 'https://insertplayer.ai',
        GENERATION_API_BASE_URL: 'https://aura-lifecycle.test',
        GENERATION_JOB_SIGNING_SECRET: 'test-aura-lifecycle-signing-secret',
        IMAGE_PROCESSOR: { getByName: () => ({ fetch: processor }) },
        FIGHTER_GENERATION: { create: async ({ id }) => { workflowStarts.push(id); return { id }; } },
    };
    return { mf, db, bucket, env, processor, spriteRequests, workflowStarts, sixthWasPending: () => sixthWasPending };
}
async function authorizeAndStart(env) {
    const authorization = await authorizeGenerationPurchase(new Request('https://aura-lifecycle.test/api/billing/generation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'rookie', creationPackage: 'aura', creationFlow: 'original', operation: 'fighter_generation',
            fighterId: FIGHTER_ID, expectedCredits: 0,
            legal: { legalVersion: CURRENT_LEGAL_VERSION, ageConfirmed: true, termsAccepted: true, photoRightsConfirmed: true,
                aiProcessingConfirmed: true, immediatePerformanceConfirmed: true, withdrawalLossAcknowledged: true } }),
    }), env, auth);
    expect(authorization.status).toBe(200);
    const purchase = await authorization.json();
    expect(purchase).toMatchObject({ creditsCharged: 0, creationPackage: 'aura' });
    const response = await createGenerationJob(new Request('https://aura-lifecycle.test/api/generation-jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighterId: FIGHTER_ID, purchaseId: purchase.purchaseId,
            providerSessionId: purchase.providerSessionId, creationPackage: 'aura', creationFlow: 'original' }),
    }), env, auth);
    expect(response.status).toBe(202);
    const { job } = await response.json();
    expect(job.progressTotal).toBe(9);
    return job.id;
}
function workflowRunner(env, jobId) {
    const workflow = new FighterGenerationWorkflow({}, env);
    const step = {
        // Emulate the Workflow engine retrying one rejected step, not a new purchase.
        async do(_name, _config, callback) {
            try {
                return await callback();
            }
            catch {
                return callback();
            }
        },
    };
    return () => workflow.run({ payload: { jobId } }, step);
}
afterEach(async () => {
    closeSpriteCacheDatabase();
    configureSpriteCacheOwner(null);
    vi.unstubAllGlobals();
    vi.mocked(apiFetch).mockReset();
    await Promise.all([...instances].map(instance => instance.dispose()));
    instances.clear();
});
describe('Rookie Aura durable completion and device handoff', () => {
    it('persists all six current sprites through a step retry, then downloads and reopens the same selected character', async () => {
        const h = await bindings();
        // The only image boundary is the local binding above; no provider network.
        const externalFetch = vi.fn(() => { throw new Error('External fetch is forbidden in this integration test'); });
        vi.stubGlobal('fetch', externalFetch);
        try {
            const jobId = await authorizeAndStart(h.env);
            const run = workflowRunner(h.env, jobId);
            await expect(run()).resolves.toMatchObject({ status: 'succeeded' });
            expect(h.sixthWasPending()).toBe(true);
            expect(h.spriteRequests.filter(name => name === 'aura_mog_check')).toHaveLength(2);
            expect(h.spriteRequests).toHaveLength(7);
            const { results: rows } = await h.db.prepare('SELECT animation_name, blob_key, content_hash FROM sprites ORDER BY animation_name')
                .all();
            expect(rows.map(row => row.animation_name)).toEqual([...AURA_ANIMATION_NAMES].sort());
            for (const row of rows) {
                const object = await h.bucket.get(row.blob_key);
                expect(object?.customMetadata?.contentHash).toBe(row.content_hash);
            }
            expect(await h.db.prepare("SELECT COUNT(*) AS count FROM generation_artifact_checkpoints WHERE status = 'approved'").first()).toEqual({ count: 9 });
            expect(await h.db.prepare('SELECT status, progress_current, progress_total FROM generation_jobs').first())
                .toEqual({ status: 'succeeded', progress_current: 9, progress_total: 9 });
            expect(await h.db.prepare('SELECT credit_cost, status FROM generation_charges').first()).toEqual({ credit_cost: 0, status: 'committed' });
            const response = await getFighter(new Request('https://aura-lifecycle.test/api/fighters/' + FIGHTER_ID), h.env, auth, FIGHTER_ID);
            const { fighter } = await response.json();
            configureSpriteCacheOwner(USER_ID);
            let failDownloadOnce = true;
            vi.mocked(apiFetch).mockImplementation(async (input) => {
                const sprite = fighter.sprites.find(item => item.url === String(input));
                const row = rows.find(item => item.animation_name === sprite?.animationName);
                if (!row)
                    throw new Error('Unexpected frontend asset request');
                if (row.animation_name === 'aura_one_leg' && failDownloadOnce) {
                    failDownloadOnce = false;
                    return new Response('Synthetic interrupted download', { status: 503 });
                }
                return new Response(await (await h.bucket.get(row.blob_key)).arrayBuffer(), { headers: { 'Content-Type': 'image/png' } });
            });
            const processorCallsBeforeDownload = h.processor.mock.calls.length;
            await expect(downloadCloudFighterToLocal(fighter, undefined, { includeSourceAssets: false, includeRawAssets: false, includeArchivedVersions: false }))
                .rejects.toThrow('did not finish downloading a complete animation pack');
            expect(await getCachedMeta(PHOTO_HASH)).toMatchObject({ status: 'sprites_generating' });
            expect(resolveFighterModeReadiness(await getAllSpritesForHash(PHOTO_HASH), 'aura').kind).toBe('unavailable');
            closeSpriteCacheDatabase();
            await downloadCloudFighterToLocal(fighter, undefined, { includeSourceAssets: false, includeRawAssets: false, includeArchivedVersions: false });
            expect(h.processor).toHaveBeenCalledTimes(processorCallsBeforeDownload);
            closeSpriteCacheDatabase();
            const [meta, sprites] = await Promise.all([getCachedMeta(PHOTO_HASH), getAllSpritesForHash(PHOTO_HASH)]);
            expect(meta).toMatchObject({ status: 'ready', photoHash: PHOTO_HASH, cloudFighterId: FIGHTER_ID, cloudPublic: false });
            expect(sprites.map(sprite => sprite.animationName).sort()).toEqual([...AURA_ANIMATION_NAMES].sort());
            expect(resolveFighterModeReadiness(sprites, 'aura', meta).kind).not.toBe('unavailable');
            expect(resolveFighterModeReadiness(sprites, 'fight', meta).kind).toBe('unavailable');
            expect(readPreferredArcadePlayerPhotoHash(buildArcadeSelectionSearch(PHOTO_HASH))).toBe(PHOTO_HASH);
            const processorCalls = h.processor.mock.calls.length;
            await expect(run()).resolves.toMatchObject({ status: 'succeeded' });
            expect(h.processor).toHaveBeenCalledTimes(processorCalls);
            expect(h.workflowStarts).toEqual([jobId]);
            expect(await h.db.prepare('SELECT COUNT(*) AS count FROM generation_charges').first()).toEqual({ count: 1 });
            expect(await h.db.prepare('SELECT COUNT(*) AS count FROM provider_sessions').first()).toEqual({ count: 1 });
            expect(await h.db.prepare('SELECT credits_balance, free_rookie_generations_used FROM users WHERE id = ?').bind(USER_ID).first())
                .toEqual({ credits_balance: 20, free_rookie_generations_used: 1 });
            expect(externalFetch).not.toHaveBeenCalled();
        }
        finally {
            instances.delete(h.mf);
            await h.mf.dispose();
        }
    }, 30_000);
    it('never marks five persisted moves as a completed Aura character if the sixth fails', async () => {
        const h = await bindings({ failLast: true });
        vi.stubGlobal('fetch', () => { throw new Error('External fetch is forbidden'); });
        try {
            const jobId = await authorizeAndStart(h.env);
            await expect(workflowRunner(h.env, jobId)()).resolves.toMatchObject({ status: 'failed' });
            expect(await h.db.prepare('SELECT status, progress_current, progress_total FROM generation_jobs').first())
                .toEqual({ status: 'failed', progress_current: 8, progress_total: 9 });
            expect(await h.db.prepare('SELECT failure_stage, error_code FROM generation_jobs').first())
                .toEqual({ failure_stage: 'sprite:aura_one_leg', error_code: 'generation_failed' });
            expect(await h.db.prepare('SELECT COUNT(*) AS count FROM sprites').first()).toEqual({ count: 5 });
            expect(await h.db.prepare('SELECT COUNT(*) AS count FROM generation_charges').first()).toEqual({ count: 1 });
            const response = await getFighter(new Request('https://aura-lifecycle.test/api/fighters/' + FIGHTER_ID), h.env, auth, FIGHTER_ID);
            const { fighter } = await response.json();
            configureSpriteCacheOwner('incomplete-aura-owner');
            await expect(downloadCloudFighterToLocal({ ...fighter, sprites: fighter.sprites.map(sprite => ({ ...sprite, url: null })) }, undefined, { includeSourceAssets: false, includeRawAssets: false, includeArchivedVersions: false })).rejects.toThrow('no complete animation pack');
        }
        finally {
            instances.delete(h.mf);
            await h.mf.dispose();
        }
    }, 30_000);
});
