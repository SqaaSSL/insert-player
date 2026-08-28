import { useEffect, useMemo, useState } from 'react';
import {
  CACHE_VERSION,
  getActiveSpriteCacheScope,
  getAllCachedMetas,
  type CachedMeta,
} from '../../services/SpriteCache.ts';
import {
  arcadeFighterPhotoHash,
  downloadArcadeFighterToLocal,
  listArcadeFighters,
  type CloudFighter,
} from '../../services/CloudFighters.ts';
import { ensurePlayableSpritesUpToDate } from '../../services/CharacterPipeline.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import { debugWarn } from '../../services/DebugLog.ts';
import {
  type MatchSceneData,
  getDefaultPersonalityId,
} from '../../game/match/MatchConfig.ts';
import type { AuthStatus } from '../authState.ts';
import { useObjectUrl } from '../shared/useObjectUrl.ts';
import { tierLabel } from '../shared/fighterPreview.ts';
import {
  buildRosterFighterSections,
  type RosterFighterEntry,
} from './RosterPage.tsx';
import {
  buildRungMatchData,
  clearArcadeRun,
  createArcadeRun,
  readArcadeRun,
  writeArcadeRun,
  type ArcadeRunRung,
  type ArcadeRunState,
} from '../shared/arcadeRun.ts';
import { Button } from '../components/Button.tsx';
import { TierBadge } from '../components/TierBadge.tsx';
import { EmptyState } from '../components/EmptyState.tsx';

interface ArcadePageProps {
  authStatus: AuthStatus;
  authSessionKey: string;
  onBack: () => void;
  onCreateFighter: () => void;
  onStartFight: (data: MatchSceneData) => void;
}

function rungFromCloudFighter(fighter: CloudFighter): ArcadeRunRung {
  return {
    slug: fighter.arcade?.slug ?? null,
    fighterId: fighter.id,
    photoHash: arcadeFighterPhotoHash(fighter),
    name: fighter.name,
    personalityId: fighter.arcade?.defaultPersonality ?? 'balanced',
    challengerLine: fighter.arcade?.challengerLine ?? null,
  };
}

function PlayerCard({
  entry,
  selected,
  onSelect,
}: {
  entry: RosterFighterEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const localUrl = useObjectUrl(entry.previewBlob ?? null);
  const previewUrl = localUrl ?? entry.previewUrl;
  return (
    <button
      type="button"
      className={`gallery-fighter-card arcade-player-card${selected ? ' is-active' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="arcade-player-card__surface">
        {previewUrl ? (
          <img src={previewUrl} alt="" />
        ) : (
          <span className="gallery-preview__empty">No preview</span>
        )}
      </span>
      <span className="gallery-fighter-card__name">{entry.name}</span>
      <span className="gallery-fighter-card__meta">
        {tierLabel(entry.qualityTier)} · {entry.animationCount} anims
      </span>
    </button>
  );
}

export function ArcadePage({ authStatus, authSessionKey, onBack, onCreateFighter, onStartFight }: ArcadePageProps) {
  const ownerScope = getActiveSpriteCacheScope();
  const [metas, setMetas] = useState<CachedMeta[]>([]);
  const [officials, setOfficials] = useState<CloudFighter[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('Loading the arcade...');
  const [playerKey, setPlayerKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [existingRun, setExistingRun] = useState<ArcadeRunState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    const load = async () => {
      const [allMetas, arcadeFighters] = await Promise.all([
        getAllCachedMetas(ownerScope),
        listArcadeFighters().catch((err: any) => {
          debugWarn('[Arcade] Official roster unavailable:', err?.message ?? err);
          return [] as CloudFighter[];
        }),
      ]);
      if (cancelled) return;
      const filtered = allMetas
        .filter((item) => item.version === CACHE_VERSION && item.status === 'ready')
        .sort((a, b) => b.createdAt - a.createdAt);
      setMetas(filtered);
      setOfficials(arcadeFighters);
      setExistingRun(readArcadeRun(ownerScope));
      setLoaded(true);
      setStatus(
        arcadeFighters.length > 0
          ? `${arcadeFighters.length} challengers are waiting`
          : 'The machine roster is unavailable right now',
      );
    };
    void load().catch((err: any) => {
      if (cancelled) return;
      setLoaded(true);
      setStatus(err?.message ? `Arcade failed: ${err.message}` : 'Arcade failed to load');
    });
    return () => { cancelled = true; };
  }, [authSessionKey, authStatus, ownerScope]);

  const sections = useMemo(
    () => buildRosterFighterSections(metas, officials, false),
    [metas, officials],
  );
  const playable = sections.all;
  const player = playable.find((entry) => entry.key === playerKey)
    ?? playable[0]
    ?? null;

  const prepareEntry = async (entry: RosterFighterEntry) => {
    if (entry.kind === 'arcade' && entry.cloud) {
      await downloadArcadeFighterToLocal(entry.cloud, captureApiRequestContext());
      return;
    }
    await ensurePlayableSpritesUpToDate(entry.photoHash);
  };

  const startRun = async () => {
    if (!player || officials.length === 0 || starting) return;
    setStarting(true);
    setStatus(`Warming up against ${officials[0].name}...`);
    try {
      await prepareEntry(player);
      await downloadArcadeFighterToLocal(officials[0], captureApiRequestContext());
      const run = createArcadeRun(
        {
          key: player.key,
          photoHash: player.photoHash,
          cloudFighterId: player.cloudFighterId,
          name: player.name,
          // You drive your own fighter in the ladder; the personality field
          // only matters for CPU-controlled slots.
          personalityId: getDefaultPersonalityId(0),
        },
        officials.map(rungFromCloudFighter),
        ownerScope,
        Date.now(),
      );
      writeArcadeRun(run);
      onStartFight(buildRungMatchData(run));
    } catch (err: any) {
      debugWarn('[Arcade] Failed to start run:', err?.message ?? err);
      setStatus(err?.message ? `Could not start: ${err.message}` : 'Could not start the run');
      setStarting(false);
    }
  };

  const resumeRun = async () => {
    if (!existingRun || starting) return;
    setStarting(true);
    const rung = existingRun.rungs[Math.min(existingRun.currentRung, existingRun.rungs.length - 1)];
    setStatus(`Loading ${rung.name}...`);
    try {
      const challenger = officials.find((fighter) => fighter.id === rung.fighterId);
      if (challenger) await downloadArcadeFighterToLocal(challenger, captureApiRequestContext());
      onStartFight(buildRungMatchData(existingRun));
    } catch (err: any) {
      debugWarn('[Arcade] Failed to resume run:', err?.message ?? err);
      setStatus(err?.message ? `Could not resume: ${err.message}` : 'Could not resume the run');
      setStarting(false);
    }
  };

  const abandonRun = () => {
    clearArcadeRun();
    setExistingRun(null);
    setStatus('Run abandoned. Pick a fighter and start again.');
  };

  return (
    <div className="roster-app arcade-app">
      <header className="roster-hero">
        <div>
          <h1>Arcade Mode</h1>
          <p className="roster-hero__copy">
            Pick your fighter and climb the machine's roster — {officials.length || 13} challengers, easiest to hardest. Three continues. One crown.
          </p>
        </div>
        <div className="roster-hero__actions">
          <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
          <Button onClick={onBack}>Back</Button>
        </div>
      </header>

      {existingRun ? (
        <section className="asf-status arcade-resume" aria-label="Run in progress">
          <strong>Run in progress:</strong>{' '}
          {existingRun.player.name} · Rung {existingRun.currentRung + 1}/{existingRun.rungs.length} ·{' '}
          {existingRun.continuesLeft} {existingRun.continuesLeft === 1 ? 'continue' : 'continues'} left
          <span className="arcade-resume__actions">
            <Button variant="primary" disabled={starting} onClick={() => void resumeRun()}>
              Resume Run
            </Button>
            <Button variant="ghost" disabled={starting} onClick={abandonRun}>
              Abandon
            </Button>
          </span>
        </section>
      ) : null}

      <section className="arcade-layout">
        <div className="gallery-panel">
          <h2>Your Fighter</h2>
          {!loaded ? (
            <EmptyState title="Loading Roster">
              <p>Checking this device and the machine roster.</p>
            </EmptyState>
          ) : playable.length === 0 ? (
            <EmptyState
              title="Make Yourself Playable"
              actions={(
                <button type="button" className="home-menu__action is-primary" onClick={onCreateFighter}>
                  <span>Create Fighter</span>
                  <small>One photo · about 2 minutes</small>
                </button>
              )}
            >
              <p>Create a fighter from one photo, then take on the arcade ladder.</p>
            </EmptyState>
          ) : (
            <>
              <div className="arcade-player-grid" role="group" aria-label="Choose your fighter">
                {playable.map((entry) => (
                  <PlayerCard
                    key={entry.key}
                    entry={entry}
                    selected={player?.key === entry.key}
                    onSelect={() => setPlayerKey(entry.key)}
                  />
                ))}
              </div>
              <button
                type="button"
                className="home-menu__action is-primary arcade-start"
                disabled={!player || officials.length === 0 || starting}
                onClick={() => void startRun()}
              >
                <span>{starting ? 'Loading...' : 'Insert Coin'}</span>
                <small>
                  {officials.length === 0
                    ? 'Machine roster unavailable'
                    : player
                      ? `${player.name} vs the machine`
                      : 'Pick a fighter first'}
                </small>
              </button>
            </>
          )}
        </div>

        <div className="gallery-panel">
          <h2>The Ladder</h2>
          {officials.length === 0 && loaded ? (
            <EmptyState title="Machine Offline">
              <p>The official challengers could not be loaded. Try again in a moment.</p>
            </EmptyState>
          ) : (
            <ol className="arcade-ladder" aria-label="Challenger ladder">
              {officials.map((fighter, index) => {
                const cleared = existingRun ? index < existingRun.currentRung : false;
                const current = existingRun ? index === existingRun.currentRung : index === 0;
                return (
                  <li
                    key={fighter.id}
                    className={`arcade-ladder__rung${cleared ? ' is-cleared' : ''}${current ? ' is-current' : ''}`}
                  >
                    <span className="arcade-ladder__rank">{index + 1}</span>
                    <span className="arcade-ladder__who">
                      <strong>{fighter.name}</strong>
                      {fighter.arcade?.challengerLine ? <small>{fighter.arcade.challengerLine}</small> : null}
                    </span>
                    {cleared ? <span className="arcade-ladder__state">KO</span> : null}
                    {current ? <span className="arcade-ladder__state is-next">Next</span> : null}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
