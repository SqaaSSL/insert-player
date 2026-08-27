import { useEffect, useMemo, useState } from 'react';
import {
  CACHE_VERSION,
  getAllCachedMetas,
  getAllCachedStageBackgrounds,
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

type RosterMode = 'watch' | 'cpu' | 'vs';
type RosterFilter = 'official' | 'yours' | 'all';

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

interface RosterFighterEntry {
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

function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);

  return url;
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
    title: 'Arcade Mode',
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

function getCloudPreviewUrl(fighter: CloudFighter): string | null {
  return fighter.sources.side ?? fighter.sources.upright ?? fighter.sources.crouch ?? null;
}

function formatTier(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getCachedArcadeSlug(photoHash: string): string | null {
  if (!photoHash.startsWith('arcade:')) return null;
  const slug = photoHash.slice('arcade:'.length).split(':', 1)[0]?.trim();
  return slug || null;
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
    arcadeSlug: getCachedArcadeSlug(meta.photoHash),
    meta,
    cloud: null,
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
    previewUrl: getCloudPreviewUrl(fighter),
    challengerLine: fighter.arcade?.challengerLine ?? null,
    defaultPersonality: fighter.arcade?.defaultPersonality ?? null,
    arcadeSlug: fighter.arcade?.slug ?? null,
    meta: null,
    cloud: fighter,
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
        <span>{formatTier(fighter.qualityTier)} · {fighter.animationCount} anims</span>
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
        <button className={`gallery-chip${isP1Selected ? ' is-active' : ''}`} onClick={onAssignP1}>
          <span>{p1Label}</span>
          <small>{isP1Selected ? 'Selected' : 'Assign'}</small>
        </button>
        <button className={`gallery-chip${isP2Selected ? ' is-active' : ''}`} onClick={onAssignP2}>
          <span>{p2Label}</span>
          <small>{isP2Selected ? 'Selected' : 'Assign'}</small>
        </button>
      </div>
    </div>
  );
}

export function RosterPage({ authStatus, authSessionKey, mode, onBack, onCreateFighter, onStartFight }: RosterPageProps) {
  const modeMeta = getModeMeta(mode);
  const [metas, setMetas] = useState<CachedMeta[]>([]);
  const [arcadeFighters, setArcadeFighters] = useState<CloudFighter[]>([]);
  const [photoStages, setPhotoStages] = useState<CachedStageBackground[]>([]);
  const [status, setStatus] = useState('Loading roster...');
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [billingProfile, setBillingProfile] = useState<BillingProfile | null>(null);
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>(mode === 'vs' ? 'all' : 'official');
  const [p1Key, setP1Key] = useState<string | null>(null);
  const [p2Key, setP2Key] = useState<string | null>(null);
  const [p1PersonalityId, setP1PersonalityId] = useState<FighterPersonalityId>(getDefaultPersonalityId(0));
  const [p2PersonalityId, setP2PersonalityId] = useState<FighterPersonalityId>(getDefaultPersonalityId(1));
  const [stageChoice, setStageChoice] = useState<StageChoice>({ kind: 'auto' });
  const [preparingFight, setPreparingFight] = useState(false);

  useEffect(() => {
    const apiContext = captureApiRequestContext();
    let cancelled = false;
    const load = async () => {
      setRosterLoaded(false);
      let [allMetas, allStages, officialFighters, profile] = await Promise.all([
        getAllCachedMetas(),
        getAllCachedStageBackgrounds(),
        listArcadeFighters().catch((err: any) => {
          debugWarn('[Roster] Official Arcade roster unavailable:', err?.message ?? err);
          return [];
        }),
        authStatus === 'signed-in' ? getBillingProfile(apiContext) : Promise.resolve(null),
      ]);
      let cloudImported = 0;
      let cloudUpdated = 0;
      try {
        const cloudSync = await syncCloudFightersToLocal(allMetas, apiContext);
        if (cloudSync.imported > 0 || cloudSync.updated > 0) {
          cloudImported = cloudSync.imported;
          cloudUpdated = cloudSync.updated;
          [allMetas, allStages] = await Promise.all([
            getAllCachedMetas(),
            getAllCachedStageBackgrounds(),
          ]);
        }
      } catch (err: any) {
        if (cancelled) return;
        debugWarn('[Roster] Cloud import skipped:', err?.message ?? err);
      }
      if (cancelled) return;
      const filteredMetas = allMetas
        .filter((item) => item.version === CACHE_VERSION && item.status === 'ready')
        .sort((a, b) => b.createdAt - a.createdAt);
      const filteredStages = allStages
        .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
        .sort((a, b) => b.createdAt - a.createdAt);
      setMetas(filteredMetas);
      setArcadeFighters(officialFighters);
      setPhotoStages(filteredStages);
      setBillingProfile(profile);
      setRosterLoaded(true);
      setStatus(
        cloudImported > 0 || cloudUpdated > 0
          ? `Cloud synced: ${cloudImported} imported, ${cloudUpdated} updated`
          : officialFighters.length > 0
            ? `${officialFighters.length} official challengers ready`
            : filteredMetas.length > 0
              ? 'Roster ready'
              : 'No fighters yet',
      );

      const localEntries = filteredMetas.map(localRosterEntry);
      const officialEntries = officialFighters.map(arcadeRosterEntry);
      const firstPlayer = localEntries[0] ?? officialEntries[0] ?? null;
      const firstOpponent = officialEntries.find((entry) => entry.key !== firstPlayer?.key)
        ?? localEntries.find((entry) => entry.key !== firstPlayer?.key)
        ?? firstPlayer;
      const firstOpponentPersonality = firstOpponent?.defaultPersonality;
      if (firstOpponentPersonality) {
        setP2PersonalityId((current) => current === 'balanced' ? firstOpponentPersonality : current);
      }
      if (filteredMetas.length === 0 && officialEntries.length > 0) {
        setRosterFilter('official');
      } else if (officialEntries.length === 0 && filteredMetas.length > 0) {
        setRosterFilter('yours');
      }
      setP1Key((current) => {
        const available = [...localEntries, ...officialEntries];
        return current && available.some((entry) => entry.key === current)
          ? current
          : firstPlayer?.key ?? null;
      });
      setP2Key((current) => {
        const available = [...localEntries, ...officialEntries];
        return current && available.some((entry) => entry.key === current)
          ? current
          : firstOpponent?.key ?? null;
      });
    };
    void load().catch((err: any) => {
      if (cancelled) return;
      debugWarn('[Roster] Roster load failed:', err?.message ?? err);
      setStatus('Roster is temporarily unavailable');
      setBillingProfile(null);
      setRosterLoaded(true);
    });
    return () => { cancelled = true; };
  }, [authSessionKey, authStatus]);

  const localEntries = useMemo(() => metas.map(localRosterEntry), [metas]);
  const officialEntries = useMemo(() => arcadeFighters.map(arcadeRosterEntry), [arcadeFighters]);
  const rosterEntries = useMemo(() => [...officialEntries, ...localEntries], [officialEntries, localEntries]);
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

  const canStartFight = Boolean(p1Fighter && p2Fighter);
  const rookieStatus = includedRookieStatus(authStatus, billingProfile);
  const createLabel = rookieStatus === 'included' ? 'Create Free Rookie' : 'Create Rookie';
  const firstFighterCopy = rookieStatus === 'included'
    ? 'Your first Rookie is included. Upload one photo, then come back here to face the Arcade roster.'
    : rookieStatus === 'credits'
      ? 'Rookie costs 2 credits. Upload one photo, then come back here to face the Arcade roster.'
      : 'Upload one photo. We will check your included Rookie or credit balance before generation starts.';

  const stageSummary =
    stageChoice.kind === 'auto'
      ? effectiveStageTheme
        ? { label: `AUTO · ${effectiveStageTheme.label}`, blurb: effectiveStageTheme.blurb }
        : { label: 'AUTO', blurb: 'Let the matchup choose the arena.' }
      : stageChoice.kind === 'built-in'
        ? { label: getStageChoiceLabel(stageChoice.stageId), blurb: getStageChoiceBlurb(stageChoice.stageId) }
        : { label: selectedPhotoStage?.label ?? stageChoice.label, blurb: 'Custom photo stage from your local cache.' };

  const assignFighter = (slot: 'p1' | 'p2', fighter: RosterFighterEntry) => {
    if (slot === 'p1') {
      setP1Key(fighter.key);
      if (fighter.defaultPersonality) setP1PersonalityId(fighter.defaultPersonality);
      return;
    }
    setP2Key(fighter.key);
    if (fighter.defaultPersonality) setP2PersonalityId(fighter.defaultPersonality);
  };

  const launchFight = async () => {
    if (!p1Fighter || !p2Fighter || preparingFight) return;
    setPreparingFight(true);
    const officialNames = [p1Fighter, p2Fighter]
      .filter((fighter) => fighter.kind === 'arcade')
      .map((fighter) => fighter.name);
    setStatus(
      officialNames.length > 0
        ? `Loading Champion sprites for ${officialNames.join(' and ')}...`
        : 'Preparing fighter sprites...',
    );
    try {
      const selected = Array.from(new Map(
        [p1Fighter, p2Fighter].map((fighter) => [fighter.key, fighter]),
      ).values());
      let upgraded = 0;
      for (const fighter of selected) {
        if (fighter.kind === 'arcade' && fighter.cloud) {
          await downloadArcadeFighterToLocal(fighter.cloud, captureApiRequestContext());
        } else {
          upgraded += await ensurePlayableSpritesUpToDate(fighter.photoHash);
        }
      }
      if (upgraded > 0) {
        setStatus(`Updated ${upgraded} cached animations`);
      }
      onStartFight({
        vsAI: modeMeta.vsAI,
        cpuVsCpu: modeMeta.cpuVsCpu,
        p1PhotoHash: p1Fighter.photoHash,
        p2PhotoHash: p2Fighter.photoHash,
        p1CloudFighterId: p1Fighter.cloudFighterId,
        p2CloudFighterId: p2Fighter.cloudFighterId,
        p1Name: p1Fighter.name,
        p2Name: p2Fighter.name,
        p1PersonalityId,
        p2PersonalityId,
        stageId: effectiveStageId,
        customStageKey: stageChoice.kind === 'photo' ? stageChoice.stageKey : undefined,
        customStageLabel: stageChoice.kind === 'photo' ? (selectedPhotoStage?.label ?? stageChoice.label) : undefined,
      });
    } catch (err: any) {
      debugWarn('[Roster] Sprite preparation failed:', err?.message ?? err);
      setStatus(err?.message ? `Could not prepare fighters: ${err.message}` : 'Could not prepare fighters');
    } finally {
      setPreparingFight(false);
    }
  };

  return (
    <div className="roster-app">
      <header className="roster-hero">
        <div>
          <p className="gallery-eyebrow">Select Your Fighter</p>
          <h1>{modeMeta.title}</h1>
          <p className="roster-hero__copy">{modeMeta.description}</p>
        </div>
        <div className="roster-hero__actions">
          <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
          <button className="gallery-back" onClick={onBack}>
            Back
          </button>
        </div>
      </header>

      <section className="roster-layout">
        <div className="roster-column">
          <div className="gallery-panel">
            <h3>{modeMeta.p1Label}</h3>
            <div className="roster-slot-card">
              <div className="roster-slot-card__preview">
                {p1PreviewUrl ? <img src={p1PreviewUrl} alt="" /> : <div className="gallery-preview__empty">No preview</div>}
              </div>
              <div className="roster-slot-card__meta">
                <strong>{p1Fighter?.name ?? 'Pick fighter'}</strong>
                <span>
                  {p1Fighter
                    ? `${formatTier(p1Fighter.qualityTier)} · ${p1Fighter.animationCount} animations ready`
                    : 'Select a fighter below'}
                </span>
                {p1Fighter?.kind === 'arcade' ? <span>Official Arcade challenger</span> : null}
              </div>
            </div>
            <div className="roster-personality">
              {FIGHTER_PERSONALITIES.map((personality) => (
                <button
                  key={personality.id}
                  className={`gallery-chip${p1PersonalityId === personality.id ? ' is-active' : ''}`}
                  onClick={() => setP1PersonalityId(personality.id)}
                >
                  <span>{personality.label}</span>
                  <small>{personality.blurb}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="sf-vs-divider" aria-hidden="true">
            <span className="sf-vs-divider__line" />
            <span className="sf-vs-divider__text">VS</span>
            <span className="sf-vs-divider__line" />
          </div>

          <div className="gallery-panel">
            <h3>{modeMeta.p2Label}</h3>
            <div className="roster-slot-card">
              <div className="roster-slot-card__preview">
                {p2PreviewUrl ? <img src={p2PreviewUrl} alt="" /> : <div className="gallery-preview__empty">No preview</div>}
              </div>
              <div className="roster-slot-card__meta">
                <strong>{p2Fighter?.name ?? 'Pick fighter'}</strong>
                <span>
                  {p2Fighter
                    ? `${formatTier(p2Fighter.qualityTier)} · ${p2Fighter.animationCount} animations ready`
                    : 'Select a fighter below'}
                </span>
                {p2Fighter?.kind === 'arcade' ? <span>Official Arcade challenger</span> : null}
              </div>
            </div>
            <div className="roster-personality">
              {FIGHTER_PERSONALITIES.map((personality) => (
                <button
                  key={personality.id}
                  className={`gallery-chip${p2PersonalityId === personality.id ? ' is-active' : ''}`}
                  onClick={() => setP2PersonalityId(personality.id)}
                >
                  <span>{personality.label}</span>
                  <small>{personality.blurb}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="roster-column roster-column--fighters">
          <div className="gallery-panel">
            <div className="roster-panel__header">
              <div>
                <p className="gallery-eyebrow">Roster</p>
                <h3>Select Fighters</h3>
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
                <button className="home-menu__action is-primary roster-fight-btn" disabled={!canStartFight || preparingFight} onClick={() => void launchFight()}>
                  <span>{preparingFight ? 'Preparing...' : modeMeta.actionLabel}</span>
                  <small>
                    {preparingFight
                      ? 'Checking cached sprites'
                      : canStartFight
                      ? `${p1Fighter?.name ?? 'P1'} vs ${p2Fighter?.name ?? 'P2'}`
                      : 'Select both fighters first'}
                  </small>
                </button>
              ) : null}
            </div>

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
                  <button className="home-menu__action is-primary" onClick={onCreateFighter}>
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
                        <button className="gallery-back" onClick={() => setRosterFilter('yours')}>
                          View Your Fighters
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <h2>Create Your First Fighter</h2>
                      <p>{firstFighterCopy}</p>
                      <button className="home-menu__action is-primary" onClick={onCreateFighter}>
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
            <h3>Stage</h3>
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
                onClick={() => setStageChoice({ kind: 'auto' })}
              >
                <span>AUTO</span>
                <small>Let the fight choose</small>
              </button>
              {STAGE_THEMES.map((stage) => (
                <button
                  key={stage.id}
                  className={`gallery-chip${stageChoice.kind === 'built-in' && stageChoice.stageId === stage.id ? ' is-active' : ''}`}
                  onClick={() => setStageChoice({ kind: 'built-in', stageId: stage.id })}
                >
                  <span>{stage.label}</span>
                  <small>{stage.blurb}</small>
                </button>
              ))}
              {photoStages.map((stage) => (
                <button
                  key={stage.stageKey}
                  className={`gallery-chip${stageChoice.kind === 'photo' && stageChoice.stageKey === stage.stageKey ? ' is-active' : ''}`}
                  onClick={() => setStageChoice({ kind: 'photo', stageKey: stage.stageKey, label: stage.label ?? 'PHOTO STAGE' })}
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
