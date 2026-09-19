import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateFighterPage, selectCreationRecovery } from './CreateFighterPage.tsx';
import type { GenerationJob } from '../../services/GenerationJobs.ts';

afterEach(() => vi.unstubAllGlobals());

function renderAuraEntry(search = '?package=aura&return=aura', authStatus: 'signed-out' | 'signed-in' = 'signed-out') {
  vi.stubGlobal('window', { location: { search } });
  return renderToStaticMarkup(<CreateFighterPage authStatus={authStatus} authSessionKey={authStatus} authSlot={<button>Sign in / Join</button>} onPlayTrial={() => {}} onBack={() => {}} onComplete={() => {}} />);
}

describe('Aura character creation entry', () => {
  it('starts with Rookie and asks only for the character, leaving quality in advanced options', () => {
    const markup = renderAuraEntry('?package=aura&return=aura', 'signed-in');
    expect(markup).toContain('Create your Aura character');
    expect(markup).toContain('One photo, 20 animations for Aura, Fight and Rush');
    expect(markup).toContain('Quality options');
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="rookie"/);
    expect(markup).not.toContain('Where do you want to play?');
    expect(markup).toContain('Aura + Fight + Rush');
    expect(markup).not.toContain('name="creation-package"');
    expect(markup).not.toContain('fighter-creation-flow');
  });

  it('offers exactly Rookie and Champion and replaces an old Champion link with the current quote', () => {
    const markup = renderAuraEntry('?package=aura&tier=champion', 'signed-in');
    expect(markup.match(/name="fighter-quality-tier"/g)).toHaveLength(2);
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="contender"/);
    expect(markup).toContain('Champion');
    expect(markup).toContain('11 credits');
    expect(markup).not.toContain('6 credits');
    expect(markup).toContain('Checking your account credits and eligibility');
    expect(markup).not.toContain('10 credits');
    expect(markup).not.toContain('Contender');
    expect(markup).not.toContain('value="champion"');
    expect(markup).not.toContain('Gemini');
    expect(markup).not.toContain('Flash');
  });

  it('keeps new combat creation on its available flow without a retired third offer', () => {
    const markup = renderAuraEntry('?package=complete&tier=champion', 'signed-in');
    expect(markup.match(/name="fighter-quality-tier"/g)).toHaveLength(2);
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="contender"/);
    expect(markup).not.toContain('fighter-creation-flow');
    expect(markup).toContain('11 credits');
    expect(markup).not.toContain('18 credits');
  });

  it('requires sign-in without promising an anonymous free Aura generation', () => {
    const markup = renderAuraEntry();
    expect(markup).toContain('Sign in / Join');
    expect(markup).toContain('Play a free battle');
    expect(markup).toContain('First Rookie included if your account has not used it');
    expect(markup).toContain('After that, Rookie costs 2 credits');
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain('Character name');
    expect(markup).not.toContain('Create Free Rookie');
    expect(markup).not.toContain('No credits charged');
  });

  it('asks about public figures before quality, credits and consent with no default answer', () => {
    const markup = renderAuraEntry('?tier=rookie&package=complete', 'signed-in');
    const question = markup.indexOf('Is this a famous person?');
    expect(question).toBeGreaterThan(markup.indexOf('Source Photo'));
    expect(question).toBeLessThan(markup.indexOf('Quality options'));
    expect(question).toBeLessThan(markup.indexOf('Process this photo only'));
    expect(markup.match(/name="fighter-public-figure"/g)).toHaveLength(2);
    expect(markup).not.toMatch(/name="fighter-public-figure"[^>]*checked/);
    expect(markup).toContain('Choose whether this is a famous person to continue');
    expect(markup).not.toContain('Famous people may not generate');
  });
});

function recoveryJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'old-failed-job', fighterId: 'old-fighter', tier: 'contender', creationFlow: 'original',
    creationPackage: 'complete', operation: 'fighter_generation', targetKind: null, targetName: null,
    artifactRunId: 'preserved-run', resumedFromJobId: null, status: 'failed', reviewStatus: 'none',
    fullRunRestartRequired: false, stage: 'failed', failureStage: 'sprite:idle', progressCurrent: 3,
    progressTotal: 14, errorCode: 'generation_failed', errorMessage: 'Idle visual QA rejected frames',
    startedAt: null, finishedAt: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    resumable: true, completedStages: ['source:side', 'source:upright', 'source:crouch'],
    pendingStages: ['sprite:idle'], preservedArtifactCount: 3, events: [], ...overrides,
  };
}

describe('new-character entry and preserved cloud work', () => {
  it('offers an old failed job without replacing a fresh Rookie form or mutating its record', () => {
    const failed = recoveryJob();
    const before = JSON.stringify(failed);
    const choice = selectCreationRecovery([failed]);
    expect(choice.recovering).toBeUndefined();
    expect(choice.active).toBeUndefined();
    expect(choice.available).toBe(failed);
    expect(JSON.stringify(failed)).toBe(before);
    const markup = renderAuraEntry('?tier=rookie&package=complete', 'signed-in');
    expect(markup).toMatch(/name="fighter-quality-tier"[^>]*checked=""[^>]*value="rookie"/);
    expect(markup).toContain('One photo, 20 animations');
    expect(markup).not.toContain('Idle visual QA rejected frames');
  });

  it.each(['queued', 'running'] as const)('automatically reconnects %s work instead of opening a duplicate generation', status => {
    const failed = recoveryJob();
    const active = recoveryJob({ id: 'live-job', status, resumable: false });
    expect(selectCreationRecovery([failed, active]).recovering).toBe(active);
  });

  it('loads only the explicitly chosen paused job with its original tier, renderer and saved stages', () => {
    const other = recoveryJob({ id: 'different-failed-job' });
    const selected = recoveryJob({ id: 'selected-job', creationPackage: 'aura', progressTotal: 9 });
    const choice = selectCreationRecovery([other, selected], selected.id);
    expect(choice.recovering).toBe(selected);
    expect(choice.resumable).toBe(selected);
    expect(choice.recovering?.rendererVersion).toBeUndefined();
    expect(choice.recovering?.creationPackage).toBe('aura');
    expect(choice.recovering?.preservedArtifactCount).toBe(3);
  });

  it('also keeps paused work from the new renderer opt-in', () => {
    const job = recoveryJob({ tier: 'rookie', rendererVersion: 'rookie-two-atlas-v1', progressTotal: 22 });
    expect(selectCreationRecovery([job]).recovering).toBeUndefined();
    expect(selectCreationRecovery([job], job.id).recovering).toBe(job);
  });

  it('offers saved video reviews without hijacking new creation and opens them explicitly', () => {
    const job = recoveryJob({ creationFlow: 'video', status: 'succeeded', reviewStatus: 'awaiting_review', resumable: false });
    expect(selectCreationRecovery([job]).recovering).toBeUndefined();
    expect(selectCreationRecovery([job]).available).toBe(job);
    expect(selectCreationRecovery([job], job.id).videoReview).toBe(job);
    expect(selectCreationRecovery([job], job.id).recovering).toBe(job);
  });

  it('preserves resumable cancellations but does not offer archived or completed work', () => {
    const cancelled = recoveryJob({ status: 'cancelled' });
    expect(selectCreationRecovery([cancelled]).available).toBe(cancelled);
    expect(selectCreationRecovery([cancelled], cancelled.id).recovering).toBe(cancelled);
    for (const job of [
      recoveryJob({ resumable: false }),
      recoveryJob({ fullRunRestartRequired: true }),
      recoveryJob({ status: 'succeeded', resumable: true }),
      recoveryJob({ creationFlow: 'video', status: 'succeeded', reviewStatus: 'rejected' }),
      recoveryJob({ operation: 'fighter_retry_animation' }),
    ]) {
      expect(selectCreationRecovery([job]).available).toBeNull();
      expect(selectCreationRecovery([job]).recovering).toBeUndefined();
    }
  });

  it('fails closed for a stale explicit choice instead of selecting different paused work', () => {
    expect(() => selectCreationRecovery([recoveryJob()], 'gone-job')).toThrow('no longer available');
    const finished = recoveryJob({ status: 'succeeded', resumable: false });
    expect(() => selectCreationRecovery([finished], finished.id)).toThrow('no longer available');
  });

  it('gives any live job precedence even when a different paused job was selected', () => {
    const paused = recoveryJob();
    const active = recoveryJob({ id: 'live-job', status: 'running', resumable: false });
    expect(selectCreationRecovery([paused, active], paused.id).recovering).toBe(active);
    expect(selectCreationRecovery([active], 'gone-job').recovering).toBe(active);
  });
});
