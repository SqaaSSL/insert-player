import { describe, expect, it, vi } from 'vitest';
import {
  buildVideoSpritePrompt,
  videoAction,
  VIDEO_SPRITE_EXTRA_GENERATION_ACTIONS,
  VIDEO_SPRITE_GENERATION_ACTIONS,
} from './videoSpriteGeneration';
import { SELF_SERVICE_VIDEO_POLICY, STUDIO_CURATED_VIDEO_POLICY } from '../../src/services/VideoGenerationPolicy';
import { VIDEO_SPRITE_ACTIONS } from '../../src/services/VideoSpriteCompileContract';
import type { AuthContext, Env, GenerationJob } from './types';

vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class NonRetryableError extends Error {} }));

const FIGHTER = 'f'.repeat(32);
const ADMIN = { userId: 'admin', user: { plan_tier: 'admin' }, claims: {} } as unknown as AuthContext;
const PLAYER = { userId: 'player', user: { plan_tier: 'studio' }, claims: {} } as unknown as AuthContext;

function dbReturning(rows: Array<{ job_id: string; action: string; status: string }>): Env {
  return {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
  } as unknown as Env;
}

function retryJob(target: string): GenerationJob {
  return {
    id: 'j'.repeat(32), artifact_run_id: 'r'.repeat(32), operation: 'fighter_retry_animation',
    target_kind: 'animation', target_name: target,
  } as unknown as GenerationJob;
}

describe('extra Video move generation', () => {
  it('keeps the full-run prompt list at the 11 actions and adds studio prompts for the extras', () => {
    expect(VIDEO_SPRITE_GENERATION_ACTIONS.map((entry) => entry.action)).toEqual([...VIDEO_SPRITE_ACTIONS]);
    expect(VIDEO_SPRITE_EXTRA_GENERATION_ACTIONS.map((entry) => entry.action)).toEqual(['fireball', 'uppercut']);
    expect(videoAction('fireball').canonical).toBe('side');
    const prompt = buildVideoSpritePrompt('fireball', 'A champion', STUDIO_CURATED_VIDEO_POLICY);
    expect(prompt).toContain('The requested action is FIREBALL.');
    expect(prompt).toContain('RIGHT EDGE OF IMAGE');
    expect(() => buildVideoSpritePrompt('uppercut', 'x', SELF_SERVICE_VIDEO_POLICY)).toThrow(/studio-curated/);
  });

  it('chooses exactly the job target for an extra-move run and refuses foreign or finished candidates', async () => {
    const { nextVideoSpriteAction } = await import('./videoSpriteWorkflow');
    await expect(nextVideoSpriteAction(dbReturning([]), retryJob('fireball'))).resolves.toBe('fireball');
    await expect(nextVideoSpriteAction(
      dbReturning([{ job_id: 'j'.repeat(32), action: 'fireball', status: 'awaiting_review' }]),
      retryJob('fireball'),
    )).resolves.toBe('fireball');
    await expect(nextVideoSpriteAction(
      dbReturning([{ job_id: 'x', action: 'idle', status: 'approved' }]),
      retryJob('fireball'),
    )).rejects.toThrow(/unexpected action/);
    await expect(nextVideoSpriteAction(
      dbReturning([{ job_id: 'x', action: 'fireball', status: 'approved' }]),
      retryJob('fireball'),
    )).rejects.toThrow(/already approved/);
  });

  it('keeps an ordinary animation retry out of the review-gated Video flow', async () => {
    const { nextVideoSpriteAction } = await import('./videoSpriteWorkflow');
    await expect(nextVideoSpriteAction(dbReturning([]), retryJob('idle'))).rejects.toThrow(/full fighter generation only/);
  });

  it('validates the admin extra endpoint before touching storage', async () => {
    const { startAdminArcadeVideoExtraGeneration } = await import('./arcadeVideoExtras');
    const request = (body: unknown) => new Request('https://api.insertplayer.ai/x', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const env = { ENVIRONMENT: 'development' } as Env;
    expect((await startAdminArcadeVideoExtraGeneration(request({}), env, PLAYER, FIGHTER, 'fireball')).status).toBe(403);
    expect((await startAdminArcadeVideoExtraGeneration(request({}), env, ADMIN, FIGHTER, 'high_punch')).status).toBe(400);
    expect((await startAdminArcadeVideoExtraGeneration(request({}), env, ADMIN, 'nope', 'fireball')).status).toBe(400);
    expect((await startAdminArcadeVideoExtraGeneration(request({}), env, ADMIN, FIGHTER, 'fireball')).status).toBe(428);
  });

  it('pins the sealed Trump roster import byte-for-byte to its importer contract', async () => {
    const { SEALED_VIDEO_ROSTER_IMPORTS, sealedVideoRosterImportFor } = await import('./sealedVideoRosterImports');
    const contractPath = new URL('../../scripts/trump-video-roster-production-contract.mjs', import.meta.url).href;
    const { TRUMP_VIDEO_ROSTER_CONTRACT: contract } = await import(/* @vite-ignore */ contractPath);
    const sealed = sealedVideoRosterImportFor(contract.fighter.id);
    expect(SEALED_VIDEO_ROSTER_IMPORTS).toHaveLength(1);
    expect(sealed).toMatchObject({ bundleId: contract.bundleId, slug: contract.fighter.slug });
    const source = (kind: string) => contract.sources.find((entry: { kind: string }) => entry.kind === kind).sha256;
    expect(sealed!.sourceHashes).toEqual(Object.fromEntries(['side', 'upright', 'crouch'].map((name) => [name, {
      processedSha256: source(name), rawSha256: source(`${name}_raw`),
    }])));
    expect(sealed!.sprites).toEqual(Object.fromEntries(contract.sprites.map(
      (sprite: { animationName: string; sha256: string; rawSha256: string }) => [sprite.animationName, {
        processedSha256: sprite.sha256, rawSha256: sprite.rawSha256,
      }],
    )));
    expect(Object.keys(sealed!.sprites).sort()).toEqual([...VIDEO_SPRITE_ACTIONS].sort());
    expect(sealedVideoRosterImportFor(FIGHTER)).toBeNull();
  });
});
