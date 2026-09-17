import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { clearCreationDraft, readCreationDraft, restoreCreationChoices, saveCreationDraft } from './creationDraft.ts';
import { readCreationNavigationContext } from './onboardingFlow.ts';

async function seedStoredDraft(scope: string, draft: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ip-creation-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put(draft, scope);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

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

  it.each([true, false, null])('persists the public-figure answer %s through IndexedDB reload', async (isPublicFigure) => {
    const scope = `declaration-${String(isPublicFigure)}`;
    const draft = { file: new Blob(['answer photo']), fileName: 'player.png', name: 'Player', tier: 'rookie', creationPackage: 'complete', isPublicFigure, savedAt: Date.now() } as const;
    expect(await saveCreationDraft(scope, draft)).toBe(true);
    vi.resetModules();
    const reloaded = await import('./creationDraft.ts');
    const restored = await reloaded.readCreationDraft(scope);
    expect(restored?.isPublicFigure).toBe(isPublicFigure);
    expect(await restored?.file.text()).toBe('answer photo');
    expect(await reloaded.readCreationDraft(`${scope}-different-account`)).toBeNull();
    await reloaded.clearCreationDraft(scope);
  });

  it('restores a legacy draft with no public-figure field as unanswered without losing its photo', async () => {
    const scope = 'legacy-declaration';
    await seedStoredDraft(scope, { file: new Blob(['legacy photo']), fileName: 'legacy.png', name: 'Legacy', tier: 'rookie', creationPackage: 'aura', savedAt: Date.now() });
    vi.resetModules();
    const reloaded = await import('./creationDraft.ts');
    const restored = await reloaded.readCreationDraft(scope);
    expect(restored?.isPublicFigure).toBeNull();
    expect(restored?.fileName).toBe('legacy.png');
    expect(await restored?.file.text()).toBe('legacy photo');
    await reloaded.clearCreationDraft(scope);
  });

  it.each(['false', 'true', 0, 1, {}, []])('treats malformed declaration %j as unanswered and retains the photo', async (isPublicFigure) => {
    const scope = `malformed-declaration-${JSON.stringify(isPublicFigure)}`;
    await seedStoredDraft(scope, { file: new Blob(['retained photo']), fileName: 'kept.png', name: 'Kept', tier: 'rookie', creationPackage: 'complete', isPublicFigure, savedAt: Date.now() });
    vi.resetModules();
    const reloaded = await import('./creationDraft.ts');
    const restored = await reloaded.readCreationDraft(scope);
    expect(restored?.isPublicFigure).toBeNull();
    expect(restored?.name).toBe('Kept');
    expect(await restored?.file.text()).toBe('retained photo');
    await reloaded.clearCreationDraft(scope);
  });

  it('keeps two accounts with opposite declarations and photos isolated', async () => {
    const base = { fileName: 'player.png', name: 'Player', tier: 'rookie', creationPackage: 'complete', savedAt: Date.now() } as const;
    await saveCreationDraft('public-account', { ...base, file: new Blob(['public photo']), isPublicFigure: true });
    await saveCreationDraft('private-account', { ...base, file: new Blob(['private photo']), isPublicFigure: false });
    vi.resetModules();
    const reloaded = await import('./creationDraft.ts');
    const publicDraft = await reloaded.readCreationDraft('public-account');
    const privateDraft = await reloaded.readCreationDraft('private-account');
    expect(publicDraft?.isPublicFigure).toBe(true);
    expect(privateDraft?.isPublicFigure).toBe(false);
    expect(await publicDraft?.file.text()).toBe('public photo');
    expect(await privateDraft?.file.text()).toBe('private photo');
    await reloaded.clearCreationDraft('public-account');
    await reloaded.clearCreationDraft('private-account');
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
