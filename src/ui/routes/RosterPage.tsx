import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CACHE_VERSION,
  getAllCachedMetas,
  getAllCachedStageBackgrounds,
  getAllSpritesForHash,
  getActiveSpriteCacheScope,
  setCachedMeta,
  type CachedMeta,
  type CachedStageBackground,
} from '../../services/SpriteCache.ts';
import {
  FIGHTER_PERSONALITIES,
  getDefaultPersonalityId,
  type FighterPersonalityId,
  type MatchSceneData,
} from '../../game/match/MatchConfig.ts';
import {
  STAGE_THEMES,
  getStageChoiceBlurb,
  getStageChoiceLabel,
  getStageTheme,
  resolveRosterStageThemeId,
  type StageThemeId,
} from '../../game/match/StageConfig.ts';
import {
  arcadeFighterPhotoHash,
  downloadArcadeFighterToLocal,
  listArcadeFighters,
  syncCloudFightersToLocal,
  type CloudFighter,
} from '../../services/CloudFighters.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import { debugWarn } from '../../services/DebugLog.ts';
import { ensurePlayableSpritesUpToDate } from '../../services/CharacterPipeline.ts';
import { getBillingProfile, type BillingProfile } from '../../services/Billing.ts';
import type { AuthStatus } from '../authState.ts';
import { includedRookieStatus } from '../shared/rookieEntitlement.ts';
import { assertCompletePlayableSpriteSet } from '../../services/PlayableFighterAssets.ts';
import { useObjectUrl } from '../shared/useObjectUrl.ts';
import { cloudPreviewUrl, isArcadeCachedMeta, tierLabel } from '../shared/fighterPreview.ts';
import { Button } from '../components/Button.tsx';
import { TierBadge } from '../components/TierBadge.tsx';
import { cachedArcadeSlug } from '../shared/galleryArcadeRoster.ts';
import {
  markArcadeManagedMetas,
  ownedRosterMetas,
} from '../shared/arcadeRosterIdentity.ts';
import {
  createAsyncEpochGuard,
  isCpuRosterSlot,
  personalityAfterFighterAssignment,
  rosterLoadPresentation,
  shouldBlockTouchVersus,
  type RosterSourceState,
  type RosterMode,
} from '../shared/rosterMatch.ts';

type RosterFilter = 'official' | 'yours' | 'all';

const LOCAL_ROSTER_LOAD_TIMEOUT_MS = 4_000;
const OFFICIAL_ROSTER_LOAD_TIMEOUT_MS = 12_000;

interface RosterPageProps {
  authStatus: AuthStatus;
  authSessionKey: string;
  mode: RosterMode;
  onBack: () => void;
  onCreateFighter: () => void;
  onStartFight: (data: MatchSceneData) => void;
}

type StageChoice =
  | { kind: 'auto' }
  | { kind: 'built-in'; stageId: StageThemeId }
  | { kind: 'photo'; stageKey: string; label: string };

export interface RosterFighterEntry {
  key: string;
  kind: 'local' | 'arcade';
  name: string;
  photoHash: string;
  cloudFighterId: string | null;
  qualityTier: string;
  animationCount: number;
  previewBlob: Blob | null;
  previewUrl: string | null;
  challengerLine: string | null;
  defaultPersonality: FighterPersonalityId | null;
  arcadeSlug: string | null;
  meta: CachedMeta | null;
  cloud: CloudFighter | null;
}

function getModeMeta(mode: RosterMode) {
  if (mode === 'watch') {
    return {
      title: 'Attract Mode',
      description: 'Two CPUs, one arena. Pick the matchup and watch them fight.',
      vsAI: true,
      cpuVsCpu: true,
      p1Label: 'CPU 1',
      p2Label: 'CPU 2',
      actionLabel: 'Start Match',
    };
  }
  if (mode === 'rush') {
    return {
      title: 'Co-op Rush',
      description: 'Pick your fighter and a CPU partner, choose a stage, and push right through every checkpoint.',
      vsAI: true,
      cpuVsCpu: false,
      p1Label: 'Player 1',
      p2Label: 'CPU Partner',
      actionLabel: 'Start Rush',
    };
  }
  if (mode === 'vs') {
    return {
      title: 'Versus',
      description: 'Pick both fighters for a local 1P vs 2P showdown.',
      vsAI: false,
      cpuVsCpu: false,
      p1Label: 'Player 1',
      p2Label: 'Player 2',
      actionLabel: 'Fight!',
    };
  }
  return {
    title: 'CPU Match',
    description: 'Pick your fighter. Choose the CPU challenger. Fight!',
    vsAI: true,
    cpuVsCpu: false,
    p1Label: 'Player 1',
    p2Label: 'CPU',
    actionLabel: 'Fight!',
  };
}

function getPreviewBlob(meta: CachedMeta | null): Blob | null {
  if (!meta) return null;
  return meta.sideViewBlob ?? meta.uprightViewBlob ?? meta.originalPhotoBlob ?? null;
}

function localRosterEntry(meta: CachedMeta): RosterFighterEntry {
  return {
    key: `local:${meta.photoHash}`,
    kind: 'local',
    name: meta.characterName,
    photoHash: meta.photoHash,
    cloudFighterId: meta.cloudFighterId ?? null,
    qualityTier: meta.qualityTier ?? 'contender',
    animationCount: meta.animationsReady.length,
    previewBlob: getPreviewBlob(meta),
    previewUrl: null,
    challengerLine: null,
    defaultPersonality: null,
    arcadeSlug: cachedArcadeSlug(meta.photoHash),
    meta,
    cloud: null,
  };
}

function cachedArcadeRosterEntry(meta: CachedMeta): RosterFighterEntry {
  return {
    ...localRosterEntry(meta),
    key: `arcade-cache:${meta.photoHash}`,
    kind: 'arcade',
  };
}

function arcadeRosterEntry(fighter: CloudFighter): RosterFighterEntry {
  return {
    key: `arcade:${fighter.id}`,
    kind: 'arcade',
    name: fighter.name,
    photoHash: arcadeFighterPhotoHash(fighter),
    cloudFighterId: fighter.id,
    qualityTier: fighter.qualityTier,
    animationCount: new Set(fighter.sprites.map((sprite) => sprite.animationName)).size,
    previewBlob: null,
    previewUrl: cloudPreviewUrl(fighter),
    challengerLine: fighter.arcade?.challengerLine ?? null,
    defaultPersonality: fighter.arcade?.defaultPersonality ?? null,
    arcadeSlug: fighter.arcade?.slug ?? null,
    meta: null,
    cloud: fighter,
  };
}

export interface RosterFighterSections {
  official: RosterFighterEntry[];
  owned: RosterFighterEntry[];
  all: RosterFighterEntry[];
}

export function buildRosterFighterSections(
  metas: CachedMeta[],
  arcadeFighters: CloudFighter[],
  includeCachedFallback = false,
): RosterFighterSections {
  const official = arcadeFighters.map(arcadeRosterEntry);
  const representedIds = new Set(arcadeFighters.map((fighter) => fighter.id));
  const representedSlugs = new Set(
    arcadeFighters
      .map((fighter) => fighter.arcade?.slug)
      .filter((slug): slug is string => Boolean(slug)),
  );
  const representedCacheKeys = new Set<string>();
  const cachedFallbacks = includeCachedFallback
    ? metas
      .filter(isArcadeCachedMeta)
      .sort((left, right) => {
        const leftSlug = cachedArcadeSlug(left.photoHash);
        const rightSlug = cachedArcadeSlug(right.photoHash);
        const leftHasCurrentKey = leftSlug !== null && left.photoHash !== `arcade:${leftSlug}`;
        const rightHasCurrentKey = rightSlug !== null && right.photoHash !== `arcade:${rightSlug}`;
        return Number(rightHasCurrentKey) - Number(leftHasCurrentKey);
      })
    : [];

  for (const meta of cachedFallbacks) {
    const slug = cachedArcadeSlug(meta.photoHash);
    if (meta.cloudFighterId && representedIds.has(meta.cloudFighterId)) continue;
    if (slug && representedSlugs.has(slug)) continue;
    const identity = meta.cloudFighterId
      ? `id:${meta.cloudFighterId}`
      : slug
        ? `slug:${slug}`
        : `hash:${meta.photoHash}`;
    if (representedCacheKeys.has(identity)) continue;
    representedCacheKeys.add(identity);
    if (meta.cloudFighterId) representedIds.add(meta.cloudFighterId);
    if (slug) representedSlugs.add(slug);
    official.push(cachedArcadeRosterEntry(meta));
  }

  const owned = ownedRosterMetas(metas, arcadeFighters).map(localRosterEntry);
  return {
    official,
    owned,
    all: [...official, ...owned],
  };
}

function useRosterPreviewUrl(entry: RosterFighterEntry | null): string | null {
  const localUrl = useObjectUrl(entry?.previewBlob ?? null);
  return localUrl ?? entry?.previewUrl ?? null;
}

function FighterRosterCard({
  fighter,
  p1Label,
  p2Label,
  isP1Selected,
  isP2Selected,
  onAssignP1,
  onAssignP2,
}: {
  fighter: RosterFighterEntry;
  p1Label: string;
  p2Label: string;
  isP1Selected: boolean;
  isP2Selected: boolean;
  onAssignP1: () => void;
  onAssignP2: () => void;
}) {
  const previewUrl = useRosterPreviewUrl(fighter);

  return (
    <div className={`roster-fighter-card${fighter.kind === 'arcade' ? ' is-official' : ''}`}>
      <div className="roster-fighter-card__surface">
        {previewUrl ? (
          <img src={previewUrl} alt="" className="roster-fighter-card__image" />
        ) : (
          <div className="gallery-preview__empty">No image</div>
        )}
      </div>
      <div className="roster-fighter-card__meta">
        <div className="roster-fighter-card__title">
          <strong>{fighter.name}</strong>
          {fighter.kind === 'arcade' ? <span className="roster-official-badge">Official</span> : null}
        </div>
        <span><TierBadge tier={fighter.qualityTier} /> · {fighter.animationCount} anims</span>
        {fighter.challengerLine ? <span>{fighter.challengerLine}</span> : null}
        {fighter.cloud?.arcade?.reference.sourceUrl ? (
          <a
            className="roster-photo-credit"
            href={fighter.cloud.arcade.reference.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Photo: {fighter.cloud.arcade.reference.credit} · {fighter.cloud.arcade.reference.license}
          </a>
        ) : null}
      </div>
      <div className="roster-fighter-card__actions">
        <button type="button" className={`gallery-chip${isP1Selected ? ' is-active' : ''}`} onClick={onAssignP1}>
          <span>{p1Label}</span>
          <small>{isP1Selected ? 'Selected' : 'Assign'}</small>
        </button>
        <button type="button" className={`gallery-chip${isP2Selected ? ' is-active' : ''}`} onClick={onAssignP2}>
          <span>{p2Label}</span>
          <small>{isP2Selected ? 'Selected' : 'Assign'}</small>
        </button>
      </div>
    </div>
  );
}


function FighterSlotPanel({
  label,
  fighter,
  previewUrl,
  personalityId,
  showPersonality,
  onPersonalityChange,
}: {
  label: string;
  fighter: RosterFighterEntry | null;
  previewUrl: string | null;
  personalityId: FighterPersonalityId;
  showPersonality: boolean;
  onPersonalityChange: (id: FighterPersonalityId) => void;
}) {
  return (
    <div className="gallery-panel">
      <h2>{label}</h2>
      <div className="roster-slot-card">
        <div className="roster-slot-card__preview">
          {previewUrl ? (
            <img src={previewUrl} alt={fighter ? `${fighter.name} preview` : ''} />
          ) : (
            <div className="gallery-preview__empty">No preview</div>
          )}
        </div>
        <div className="roster-slot-card__meta">
          <strong>{fighter?.name ?? 'Pick fighter'}</strong>
          <span>
            {fighter
              ? `${tierLabel(fighter.qualityTier)} · ${fighter.animationCount} animations ready`
              : 'Select a fighter below'}
          </span>
          {fighter?.kind === 'arcade' ? <span>Official Arcade challenger</span> : null}
        </div>
      </div>
      {showPersonality ? (
        <div className="roster-personality" role="group" aria-label={`${label} CPU personality`}>
          {FIGHTER_PERSONALITIES.map((personality) => (
            <button
              type="button"
              key={personality.id}
              className={`gallery-chip${personalityId === personality.id ? ' is-active' : ''}`}
              aria-pressed={personalityId === personality.id}
              onClick={() => onPersonalityChange(personality.id)}
            >
              <span>{personality.label}</span>
              <small>{personality.blurb}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RosterPage({ authStatus, authSessionKey, mode, onBack, onCreateFighter, onStartFight }: RosterPageProps) {
  const modeMeta = getModeMeta(mode);
  const [metas, setMetas] = useState<CachedMeta[]>([]);
  const [arcadeFighters, setArcadeFighters] = useState<CloudFighter[]>([]);
  const [arcadeUnavailable, setArcadeUnavailable] = useState(false);
  const [photoStages, setPhotoStages] = useState<CachedStageBackground[]>([]);
  const [status, setStatus] = useState('Loading roster...');
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [rosterRetryAvailable, setRosterRetryAvailable] = useState(false);
  const [rosterReloadKey, setRosterReloadKey] = useState(0);
  const [billingProfile, setBillingProfile] = useState<BillingProfile | null>(null);
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>(
    mode === 'vs' || mode === 'rush' ? 'all' : 'official',
  );
  const [p1Key, setP1Key] = useState<string | null>(null);
  const [p2Key, setP2Key] = useState<string | null>(null);
  const [p1PersonalityId, setP1PersonalityId] = useState<FighterPersonalityId>(getDefaultPersonalityId(0));
  const [p2PersonalityId, setP2PersonalityId] = useState<FighterPersonalityId>(getDefaultPersonalityId(1));
  const [stageChoice, setStageChoice] = useState<StageChoice>({ kind: 'auto' });
  const [preparingFight, setPreparingFight] = useState(false);
  const [hasCoarsePointer, setHasCoarsePointer] = useState(
    () => window.matchMedia?.('(pointer: coarse)').matches ?? false,
  );
  const p1PersonalityExplicitRef = useRef(false);
  const p2PersonalityExplicitRef = useRef(false);
  const preparationGuardRef = useRef(createAsyncEpochGuard());

  useEffect(() => {
    const guard = preparationGuardRef.current;
    guard.mount();
    return () => guard.unmount();
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.('(pointer: coarse)');
    if (!media) return;
    const sync = () => setHasCoarsePointer(media.matches);
    sync();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    preparationGuardRef.current.cancel();
    setPreparingFight(false);
    p1PersonalityExplicitRef.current = false;
    p2PersonalityExplicitRef.current = false;
  }, [authSessionKey, mode]);

  useEffect(() => {
    const apiContext = captureApiRequestContext();
    const ownerScope = getActiveSpriteCacheScope();
    let cancelled = false;
    let officialState: RosterSourceState = 'loading';
    let localState: RosterSourceState = 'loading';
    let officialFighters: CloudFighter[] = [];
    let allMetas: CachedMeta[] = [];
    let allStages: CachedStageBackground[] = [];
    let cloudSyncing = false;
    let cloudImported = 0;
    let cloudUpdated = 0;

    const publishRosterSnapshot = () => {
      if (cancelled) return;
      const filteredMetas = allMetas
        .filter((item) => item.version === CACHE_VERSION && item.status === 'ready')
        .sort((a, b) => b.createdAt - a.createdAt);
      const filteredStages = allStages
        .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
        .sort((a, b) => b.createdAt - a.createdAt);
      const sections = buildRosterFighterSections(
        filteredMetas,
        officialFighters,
        officialState === 'unavailable',
      );
      const presentation = rosterLoadPresentation({
        officialState,
        localState,
        officialCount: sections.official.length,
        ownedCount: sections.owned.length,
        cloudSyncing,
        cloudImported,
        cloudUpdated,
      });

      setMetas(filteredMetas);
      setArcadeFighters(officialFighters);
      setArcadeUnavailable(officialState === 'unavailable');
      setPhotoStages(filteredStages);
      setRosterLoaded(presentation.loaded);
      setRosterRetryAvailable(presentation.retryAvailable);
      setStatus(presentation.message);

      const firstPlayer = sections.owned[0] ?? sections.official[0] ?? null;
      const firstOpponent = sections.official.find((entry) => entry.key !== firstPlayer?.key)
        ?? sections.owned.find((entry) => entry.key !== firstPlayer?.key)
        ?? firstPlayer;
      setP1PersonalityId((current) => personalityAfterFighterAssignment({
        current,
        fighterDefault: firstPlayer?.defaultPersonality ?? null,
        isCpu: isCpuRosterSlot(mode, 'p1'),
        wasExplicitlyChosen: p1PersonalityExplicitRef.current,
      }));
      setP2PersonalityId((current) => personalityAfterFighterAssignment({
        current,
        fighterDefault: firstOpponent?.defaultPersonality ?? null,
        isCpu: isCpuRosterSlot(mode, 'p2'),
        wasExplicitlyChosen: p2PersonalityExplicitRef.current,
      }));
      if (sections.owned.length === 0 && sections.official.length > 0) {
        setRosterFilter('official');
      } else if (sections.official.length === 0 && sections.owned.length > 0) {
        setRosterFilter('yours');
      }
      setP1Key((current) => (
        current && sections.all.some((entry) => entry.key === current)
          ? current
          : firstPlayer?.key ?? null
      ));
      setP2Key((current) => (
        current && sections.all.some((entry) => entry.key === current)
          ? current
          : firstOpponent?.key ?? null
      ));
    };

    const markAndPublish = () => {
      const marked = markArcadeManagedMetas(allMetas, officialFighters);
      allMetas = marked.metas;
      publishRosterSnapshot();
      if (marked.changed.length > 0) {
        void Promise.all(marked.changed.map((item) => setCachedMeta(item, ownerScope))).catch((err: any) => {
          debugWarn('[Roster] Official roster identity could not be persisted:', err?.message ?? err);
        });
      }
    };

    setMetas([]);
    setArcadeFighters([]);
    setArcadeUnavailable(false);
    setPhotoStages([]);
    setRosterLoaded(false);
    setRosterRetryAvailable(false);
    setBillingProfile(null);
    setStatus(rosterReloadKey > 0 ? 'Retrying roster…' : 'Loading roster…');

    const officialTimeout = window.setTimeout(() => {
      if (cancelled || officialState !== 'loading') return;
      officialState = 'unavailable';
      debugWarn('[Roster] Official Arcade roster timed out. The request may still recover.');
      markAndPublish();
    }, OFFICIAL_ROSTER_LOAD_TIMEOUT_MS);
    const localTimeout = window.setTimeout(() => {
      if (cancelled || localState !== 'loading') return;
      localState = 'unavailable';
      debugWarn('[Roster] Local roster storage timed out. The request may still recover.');
      publishRosterSnapshot();
    }, LOCAL_ROSTER_LOAD_TIMEOUT_MS);

    void listArcadeFighters().then((fighters) => {
      if (cancelled) return;
      window.clearTimeout(officialTimeout);
      officialFighters = fighters;
      officialState = 'ready';
      markAndPublish();
    }).catch((err: any) => {
      if (cancelled) return;
      window.clearTimeout(officialTimeout);
      officialState = 'unavailable';
      debugWarn('[Roster] Official Arcade roster unavailable:', err?.message ?? err);
      markAndPublish();
    });

    const localLoad = Promise.all([
      getAllCachedMetas(ownerScope),
      getAllCachedStageBackgrounds(ownerScope),
    ]);
    void localLoad.then(async ([loadedMetas, loadedStages]) => {
      if (cancelled) return;
      window.clearTimeout(localTimeout);
      allMetas = loadedMetas;
      allStages = loadedStages;
      localState = 'ready';
      markAndPublish();

      if (authStatus !== 'signed-in') return;
      cloudSyncing = true;
      publishRosterSnapshot();
      try {
        const cloudSync = await syncCloudFightersToLocal(allMetas, apiContext);
        if (cancelled) return;
        cloudImported = cloudSync.imported;
        cloudUpdated = cloudSync.updated;
        cloudSyncing = false;
        publishRosterSnapshot();
        if (cloudImported > 0 || cloudUpdated > 0) {
          void Promise.all([
            getAllCachedMetas(ownerScope),
            getAllCachedStageBackgrounds(ownerScope),
          ]).then(([refreshedMetas, refreshedStages]) => {
            if (cancelled) return;
            allMetas = refreshedMetas;
            allStages = refreshedStages;
            markAndPublish();
          }).catch((err: any) => {
            debugWarn('[Roster] Synced roster cache could not be refreshed:', err?.message ?? err);
          });
        }
      } catch (err: any) {
        if (cancelled) return;
        cloudSyncing = false;
        debugWarn('[Roster] Cloud import skipped:', err?.message ?? err);
        publishRosterSnapshot();
      }
    }).catch((err: any) => {
      if (cancelled) return;
      window.clearTimeout(localTimeout);
      localState = 'unavailable';
      debugWarn('[Roster] Local roster storage unavailable:', err?.message ?? err);
      publishRosterSnapshot();
    });

    if (authStatus === 'signed-in') {
      void getBillingProfile(apiContext).then((profile) => {
        if (!cancelled) setBillingProfile(profile);
      });
    }

    return () => {
      cancelled = true;
      window.clearTimeout(officialTimeout);
      window.clearTimeout(localTimeout);
    };
  }, [authSessionKey, authStatus, mode, rosterReloadKey]);

  const rosterSections = useMemo(
    () => buildRosterFighterSections(metas, arcadeFighters, arcadeUnavailable),
    [arcadeFighters, arcadeUnavailable, metas],
  );
  const localEntries = rosterSections.owned;
  const officialEntries = rosterSections.official;
  const rosterEntries = rosterSections.all;
  const visibleEntries = useMemo(() => {
    if (rosterFilter === 'official') return officialEntries;
    if (rosterFilter === 'yours') return localEntries;
    return rosterEntries;
  }, [localEntries, officialEntries, rosterEntries, rosterFilter]);
  const p1Fighter = useMemo(
    () => rosterEntries.find((entry) => entry.key === p1Key) ?? null,
    [p1Key, rosterEntries],
  );
  const p2Fighter = useMemo(
    () => rosterEntries.find((entry) => entry.key === p2Key) ?? null,
    [p2Key, rosterEntries],
  );
  const p1PreviewUrl = useRosterPreviewUrl(p1Fighter);
  const p2PreviewUrl = useRosterPreviewUrl(p2Fighter);
  const selectedPhotoStage = useMemo(
    () => (stageChoice.kind === 'photo' ? photoStages.find((item) => item.stageKey === stageChoice.stageKey) ?? null : null),
    [photoStages, stageChoice],
  );
  const photoStageUrl = useObjectUrl(selectedPhotoStage?.pngBlob ?? null);
  const effectiveStageId = resolveRosterStageThemeId({
    manualStageId: stageChoice.kind === 'built-in' ? stageChoice.stageId : null,
    hasCustomPhotoStage: stageChoice.kind === 'photo',
    p1ArcadeSlug: p1Fighter?.arcadeSlug,
    p2ArcadeSlug: p2Fighter?.arcadeSlug,
  });
  const effectiveStageTheme = effectiveStageId ? getStageTheme(effectiveStageId) : null;
  const stagePreviewUrl = photoStageUrl ?? effectiveStageTheme?.assetPath ?? null;

  const touchVersusBlocked = shouldBlockTouchVersus(mode, hasCoarsePointer);
  const canStartFight = Boolean(p1Fighter && p2Fighter) && !touchVersusBlocked;
  const rookieStatus = includedRookieStatus(authStatus, billingProfile);
  const createLabel = rookieStatus === 'included' ? 'Create Free Rookie' : 'Create Rookie';
  const firstFighterCopy = rookieStatus === 'included'
    ? `Your first Rookie is included. Upload one photo, then come back here to ${mode === 'rush' ? 'join the team' : 'face the Arcade roster'}.`
    : rookieStatus === 'credits'
      ? `Rookie costs 2 credits. Upload one photo, then come back here to ${mode === 'rush' ? 'join the team' : 'face the Arcade roster'}.`
      : 'Upload one photo. We will check your included Rookie or credit balance before generation starts.';

  const stageSummary =
    stageChoice.kind === 'auto'
      ? effectiveStageTheme
        ? { label: `AUTO · ${effectiveStageTheme.label}`, blurb: effectiveStageTheme.blurb }
        : { label: 'AUTO', blurb: 'Let the matchup choose the arena.' }
      : stageChoice.kind === 'built-in'
        ? { label: getStageChoiceLabel(stageChoice.stageId), blurb: getStageChoiceBlurb(stageChoice.stageId) }
        : { label: selectedPhotoStage?.label ?? stageChoice.label, blurb: 'Custom photo stage from your local cache.' };

  const cancelFightPreparation = (message = 'Preparation cancelled. Review the matchup and start again.') => {
    if (!preparingFight) return;
    preparationGuardRef.current.cancel();
    setPreparingFight(false);
    setStatus(message);
  };

  const assignFighter = (slot: 'p1' | 'p2', fighter: RosterFighterEntry) => {
    cancelFightPreparation();
    if (slot === 'p1') {
      setP1Key(fighter.key);
      setP1PersonalityId((current) => personalityAfterFighterAssignment({
        current,
        fighterDefault: fighter.defaultPersonality,
        isCpu: isCpuRosterSlot(mode, 'p1'),
        wasExplicitlyChosen: p1PersonalityExplicitRef.current,
      }));
      return;
    }
    setP2Key(fighter.key);
    setP2PersonalityId((current) => personalityAfterFighterAssignment({
      current,
      fighterDefault: fighter.defaultPersonality,
      isCpu: isCpuRosterSlot(mode, 'p2'),
      wasExplicitlyChosen: p2PersonalityExplicitRef.current,
    }));
  };

  const changePersonality = (slot: 'p1' | 'p2', personalityId: FighterPersonalityId) => {
    cancelFightPreparation();
    if (slot === 'p1') {
      p1PersonalityExplicitRef.current = true;
      setP1PersonalityId(personalityId);
      return;
    }
    p2PersonalityExplicitRef.current = true;
    setP2PersonalityId(personalityId);
  };

  const chooseStage = (choice: StageChoice) => {
    cancelFightPreparation();
    setStageChoice(choice);
  };

  const goBack = () => {
    preparationGuardRef.current.cancel();
    setPreparingFight(false);
    onBack();
  };

  const launchFight = async () => {
    if (!p1Fighter || !p2Fighter || preparingFight || touchVersusBlocked) return;
    const ownerScope = getActiveSpriteCacheScope();
    const preparationEpoch = preparationGuardRef.current.begin();
    const selectedP1 = p1Fighter;
    const selectedP2 = p2Fighter;
    const selectedP1Personality = p1PersonalityId;
    const selectedP2Personality = p2PersonalityId;
    const selectedStageId = effectiveStageId;
    const selectedStageChoice = stageChoice;
    const selectedStage = selectedPhotoStage;
    setPreparingFight(true);
    const officialNames = [selectedP1, selectedP2]
      .filter((fighter) => fighter.kind === 'arcade')
      .map((fighter) => fighter.name);
    setStatus(
      officialNames.length > 0
        ? `Loading Champion sprites for ${officialNames.join(' and ')}...`
        : 'Preparing fighter sprites...',
    );
    try {
      const selected = Array.from(new Map(
        [selectedP1, selectedP2].map((fighter) => [fighter.key, fighter]),
      ).values());
      let upgraded = 0;
      for (const fighter of selected) {
        if (fighter.kind === 'arcade' && fighter.cloud) {
          await downloadArcadeFighterToLocal(fighter.cloud, captureApiRequestContext());
        } else {
          upgraded += await ensurePlayableSpritesUpToDate(fighter.photoHash);
        }
        if (!preparationGuardRef.current.isCurrent(preparationEpoch)) return;
        const playableSprites = await getAllSpritesForHash(fighter.photoHash, ownerScope);
        if (!preparationGuardRef.current.isCurrent(preparationEpoch)) return;
        assertCompletePlayableSpriteSet(playableSprites, fighter.name);
      }
      if (!preparationGuardRef.current.isCurrent(preparationEpoch)) return;
      if (upgraded > 0) {
        setStatus(`Updated ${upgraded} cached animations`);
      }
      onStartFight({
        gameMode: mode === 'rush' ? 'rush' : 'fight',
        vsAI: modeMeta.vsAI,
        cpuVsCpu: modeMeta.cpuVsCpu,
        p1PhotoHash: selectedP1.photoHash,
        p2PhotoHash: selectedP2.photoHash,
        p1CloudFighterId: selectedP1.cloudFighterId,
        p2CloudFighterId: selectedP2.cloudFighterId,
        p1Name: selectedP1.name,
        p2Name: selectedP2.name,
        p1PersonalityId: isCpuRosterSlot(mode, 'p1') ? selectedP1Personality : undefined,
        p2PersonalityId: isCpuRosterSlot(mode, 'p2') ? selectedP2Personality : undefined,
        stageId: selectedStageId,
        customStageKey: selectedStageChoice.kind === 'photo' ? selectedStageChoice.stageKey : undefined,
        customStageLabel: selectedStageChoice.kind === 'photo'
          ? (selectedStage?.label ?? selectedStageChoice.label)
          : undefined,
      });
    } catch (err: any) {
      if (!preparationGuardRef.current.isCurrent(preparationEpoch)) return;
      debugWarn('[Roster] Sprite preparation failed:', err?.message ?? err);
      setStatus(err?.message ? `Could not prepare fighters: ${err.message}` : 'Could not prepare fighters');
    } finally {
      if (preparationGuardRef.current.isCurrent(preparationEpoch)) {
        setPreparingFight(false);
      }
    }
  };

  return (
    <div className="roster-app">
      <header className="roster-hero">
        <div>
          <h1>{modeMeta.title}</h1>
          <p className="roster-hero__copy">{modeMeta.description}</p>
        </div>
        <div className="roster-hero__actions">
          <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
          {rosterRetryAvailable ? (
            <Button onClick={() => setRosterReloadKey((value) => value + 1)} disabled={preparingFight}>
              Retry Roster
            </Button>
          ) : null}
          <Button onClick={goBack}>{preparingFight ? 'Cancel & Back' : 'Back'}</Button>
        </div>
      </header>

      <section className="roster-layout">
        <div className="roster-column">
          <FighterSlotPanel
            label={modeMeta.p1Label}
            fighter={p1Fighter}
            previewUrl={p1PreviewUrl}
            personalityId={p1PersonalityId}
            showPersonality={isCpuRosterSlot(mode, 'p1')}
            onPersonalityChange={(personalityId) => changePersonality('p1', personalityId)}
          />

          <div className="sf-vs-divider" aria-hidden="true">
            <span className="sf-vs-divider__line" />
            <span className="sf-vs-divider__text">{mode === 'rush' ? '+' : 'VS'}</span>
            <span className="sf-vs-divider__line" />
          </div>

          <FighterSlotPanel
            label={modeMeta.p2Label}
            fighter={p2Fighter}
            previewUrl={p2PreviewUrl}
            personalityId={p2PersonalityId}
            showPersonality={isCpuRosterSlot(mode, 'p2')}
            onPersonalityChange={(personalityId) => changePersonality('p2', personalityId)}
          />
        </div>

        <div className="roster-column roster-column--fighters">
          <div className="gallery-panel">
            <div className="roster-panel__header">
              <div>
                <h2>Select Fighters</h2>
                <div className="roster-filter-tabs" role="group" aria-label="Roster source">
                  <button
                    className={`roster-filter-tab${rosterFilter === 'official' ? ' is-active' : ''}`}
                    aria-pressed={rosterFilter === 'official'}
                    onClick={() => setRosterFilter('official')}
                  >
                    Official <span>{officialEntries.length}</span>
                  </button>
                  <button
                    className={`roster-filter-tab${rosterFilter === 'yours' ? ' is-active' : ''}`}
                    aria-pressed={rosterFilter === 'yours'}
                    onClick={() => setRosterFilter('yours')}
                  >
                    Yours <span>{localEntries.length}</span>
                  </button>
                  <button
                    className={`roster-filter-tab${rosterFilter === 'all' ? ' is-active' : ''}`}
                    aria-pressed={rosterFilter === 'all'}
                    onClick={() => setRosterFilter('all')}
                  >
                    All <span>{rosterEntries.length}</span>
                  </button>
                </div>
              </div>
              {rosterLoaded && rosterEntries.length > 0 ? (
                <button type="button" className="home-menu__action is-primary roster-fight-btn" disabled={!canStartFight || preparingFight} onClick={() => void launchFight()}>
                  <span>{preparingFight ? 'Preparing...' : modeMeta.actionLabel}</span>
                  <small>
                    {preparingFight
                      ? 'Checking cached sprites'
                      : touchVersusBlocked
                      ? 'Touch Versus needs a keyboard or controllers'
                      : canStartFight
                      ? `${p1Fighter?.name ?? 'P1'} ${mode === 'rush' ? '+' : 'vs'} ${p2Fighter?.name ?? 'P2'}`
                      : 'Select both fighters first'}
                  </small>
                </button>
              ) : null}
            </div>

            {touchVersusBlocked ? (
              <p className="roster-touch-notice" role="status">
                Touch Versus needs two control sets, which do not fit safely on this screen. Open it on a keyboard
                or controller device, or choose Arcade Mode on touch.
              </p>
            ) : null}

            <div className="roster-fighter-grid">
              {!rosterLoaded ? (
                <section className="gallery-empty roster-empty" aria-live="polite">
                  <h2>Syncing Your Roster</h2>
                  <p>Checking this device and your cloud fighters.</p>
                </section>
              ) : rosterEntries.length === 0 ? (
                <section className="gallery-empty roster-empty">
                  <h2>Make Yourself Playable</h2>
                  <p>{firstFighterCopy}</p>
                  <button type="button" className="home-menu__action is-primary" onClick={onCreateFighter}>
                    <span>{createLabel}</span>
                    <small>One photo · about 2 minutes</small>
                  </button>
                </section>
              ) : visibleEntries.length === 0 ? (
                <section className="gallery-empty roster-empty">
                  {rosterFilter === 'official' ? (
                    <>
                      <h2>Official Challengers Incoming</h2>
                      <p>The headline roster is being prepared in Champion quality.</p>
                      {localEntries.length > 0 ? (
                        <Button onClick={() => setRosterFilter('yours')}>View Your Fighters</Button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <h2>Create Your First Fighter</h2>
                      <p>{firstFighterCopy}</p>
                      <button type="button" className="home-menu__action is-primary" onClick={onCreateFighter}>
                        <span>{createLabel}</span>
                        <small>Start with one photo</small>
                      </button>
                    </>
                  )}
                </section>
              ) : visibleEntries.map((fighter) => (
                <FighterRosterCard
                  key={fighter.key}
                  fighter={fighter}
                  p1Label={modeMeta.p1Label}
                  p2Label={modeMeta.p2Label}
                  isP1Selected={p1Key === fighter.key}
                  isP2Selected={p2Key === fighter.key}
                  onAssignP1={() => assignFighter('p1', fighter)}
                  onAssignP2={() => assignFighter('p2', fighter)}
                />
              ))}
            </div>
            {officialEntries.length > 0 && rosterFilter !== 'yours' ? (
              <p className="roster-official-disclosure">
                Unofficial AI-generated parody. No featured person sponsors or endorses Insert Player.
              </p>
            ) : null}
          </div>
        </div>

        <div className="roster-column">
          <div className="gallery-panel">
            <h2>Stage</h2>
            <div className="roster-stage-preview">
              {stagePreviewUrl ? (
                <img src={stagePreviewUrl} alt={`${stageSummary.label} stage preview`} />
              ) : (
                <div className="gallery-preview__empty">{stageSummary.label}</div>
              )}
            </div>
            <div className="roster-stage-summary">
              <strong>{stageSummary.label}</strong>
              <span>{stageSummary.blurb}</span>
            </div>
            <div className="roster-stage-list">
              <button
                className={`gallery-chip${stageChoice.kind === 'auto' ? ' is-active' : ''}`}
                onClick={() => chooseStage({ kind: 'auto' })}
              >
                <span>AUTO</span>
                <small>Let the fight choose</small>
              </button>
              {STAGE_THEMES.map((stage) => (
                <button
                  key={stage.id}
                  className={`gallery-chip${stageChoice.kind === 'built-in' && stageChoice.stageId === stage.id ? ' is-active' : ''}`}
                  onClick={() => chooseStage({ kind: 'built-in', stageId: stage.id })}
                >
                  <span>{stage.label}</span>
                  <small>{stage.blurb}</small>
                </button>
              ))}
              {photoStages.map((stage) => (
                <button
                  key={stage.stageKey}
                  className={`gallery-chip${stageChoice.kind === 'photo' && stageChoice.stageKey === stage.stageKey ? ' is-active' : ''}`}
                  onClick={() => chooseStage({ kind: 'photo', stageKey: stage.stageKey, label: stage.label ?? 'PHOTO STAGE' })}
                >
                  <span>{stage.label ?? 'PHOTO STAGE'}</span>
                  <small>Cached custom stage</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
