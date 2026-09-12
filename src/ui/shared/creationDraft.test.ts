import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { clearCreationDraft, readCreationDraft, restoreCreationChoices, saveCreationDraft } from './creationDraft.ts';
import { readCreationNavigationContext } from './onboardingFlow.ts';

describe('creation draft checkout recovery', () => {
  it('retains the photo and package on the same account and never reads another account', async () => {
    const draft = { file: new Blob(['local photo'], { type: 'image/png' }), fileName: 'player.png', name: 'Player', tier: 'contender', creationPackage: 'aura', savedAt: Date.now() } as const;
    expect(await saveCreationDraft('account-one', draft)).toBe(true);
    vi.resetModules();
    const reloaded = await import('./creationDraft.ts');
    expect(await reloaded.readCreationDraft('account-two')).toBeNull();
    const restored = await reloaded.readCreationDraft('account-one');
    expect(restored?.creationPackage).toBe('aura');
    expect(await restored?.file.text()).toBe('local photo');
    await clearCreationDraft('account-one');
    expect(await readCreationDraft('account-one')).toBeNull();
  });

  it('preserves an explicit new game entry instead of replacing it with an old Aura draft', () => {
    const draft = { file: new Blob(['photo']), fileName: 'player.png', name: 'Player', tier: 'contender', creationPackage: 'aura', savedAt: Date.now() } as const;
    expect(restoreCreationChoices(draft, readCreationNavigationContext('?tier=rookie&package=complete&return=fight')))
      .toEqual({ tier: 'rookie', creationPackage: 'complete', creationFlow: 'original' });
    expect(restoreCreationChoices(draft, readCreationNavigationContext('?tier=contender&package=aura&return=aura')))
      .toEqual({ tier: 'contender', creationPackage: 'aura', creationFlow: 'original' });
    expect(restoreCreationChoices({ ...draft, tier: 'champion', creationPackage: 'complete' }, readCreationNavigationContext('?package=aura&return=aura')))
      .toEqual({ tier: 'rookie', creationPackage: 'aura', creationFlow: 'original' });
  });

  it('restores an unsent retired offer as the current Champion without starting a legacy Video run', () => {
    const draft = { file: new Blob(['photo']), fileName: 'player.png', name: 'Player', tier: 'champion', creationPackage: 'complete', creationFlow: 'video', savedAt: Date.now() } as const;
    expect(restoreCreationChoices(draft, readCreationNavigationContext('?tier=champion&package=complete')))
      .toEqual({ tier: 'contender', creationPackage: 'complete', creationFlow: 'original' });
    expect(draft.tier).toBe('champion');
    expect(draft.creationFlow).toBe('video');
    expect(restoreCreationChoices(draft, readCreationNavigationContext('?package=aura')).creationFlow).toBe('original');
  });

  it('does not restore a photo whose expiry timestamp is corrupted', async () => {
    await saveCreationDraft('invalid-time', { file: new Blob(['photo']), fileName: 'player.png', name: 'Player', tier: 'rookie', creationPackage: 'aura', savedAt: Number.NaN });
    expect(await readCreationDraft('invalid-time')).toBeNull();
  });

  it('expires an old photo instead of silently restoring it to a new creation', async () => {
    await saveCreationDraft('expired', { file: new Blob(['old']), fileName: 'old.png', name: 'Old', tier: 'rookie', creationPackage: 'complete', savedAt: Date.now() - 25 * 60 * 60 * 1000 });
    expect(await readCreationDraft('expired')).toBeNull();
  });
});
