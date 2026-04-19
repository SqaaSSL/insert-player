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
  type StageThemeId,
} from '../../game/match/StageConfig.ts';

type RosterMode = 'watch' | 'cpu' | 'vs';

interface RosterPageProps {
  mode: RosterMode;
  onBack: () => void;
  onStartFight: (data: MatchSceneData) => void;
}

type StageChoice =
  | { kind: 'auto' }
  | { kind: 'built-in'; stageId: StageThemeId }
  | { kind: 'photo'; stageKey: string; label: string };

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

function FighterRosterCard({
  meta,
  p1Label,
  p2Label,
  isP1Selected,
  isP2Selected,
  onAssignP1,
  onAssignP2,
}: {
  meta: CachedMeta;
  p1Label: string;
  p2Label: string;
  isP1Selected: boolean;
  isP2Selected: boolean;
  onAssignP1: () => void;
  onAssignP2: () => void;
}) {
  const previewUrl = useObjectUrl(getPreviewBlob(meta));

  return (
    <div className="roster-fighter-card">
      <div className="roster-fighter-card__surface">
        {previewUrl ? (
          <img src={previewUrl} alt="" className="roster-fighter-card__image" />
        ) : (
          <div className="gallery-preview__empty">No image</div>
        )}
      </div>
      <div className="roster-fighter-card__meta">
        <strong>{meta.characterName}</strong>
        <span>{meta.animationsReady.length} anims</span>
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

export function RosterPage({ mode, onBack, onStartFight }: RosterPageProps) {
  const modeMeta = getModeMeta(mode);
  const [metas, setMetas] = useState<CachedMeta[]>([]);
  const [photoStages, setPhotoStages] = useState<CachedStageBackground[]>([]);
  const [status, setStatus] = useState('Loading roster...');
  const [p1Hash, setP1Hash] = useState<string | null>(null);
  const [p2Hash, setP2Hash] = useState<string | null>(null);
  const [p1PersonalityId, setP1PersonalityId] = useState<FighterPersonalityId>(getDefaultPersonalityId(0));
  const [p2PersonalityId, setP2PersonalityId] = useState<FighterPersonalityId>(getDefaultPersonalityId(1));
  const [stageChoice, setStageChoice] = useState<StageChoice>({ kind: 'auto' });

  useEffect(() => {
    const load = async () => {
      const [allMetas, allStages] = await Promise.all([
        getAllCachedMetas(),
        getAllCachedStageBackgrounds(),
      ]);
      const filteredMetas = allMetas
        .filter((item) => item.version === CACHE_VERSION)
        .sort((a, b) => b.createdAt - a.createdAt);
      const filteredStages = allStages.sort((a, b) => b.createdAt - a.createdAt);
      setMetas(filteredMetas);
      setPhotoStages(filteredStages);
      setStatus(filteredMetas.length > 0 ? 'Roster ready' : 'No fighters yet');

      setP1Hash((current) => current ?? filteredMetas[0]?.photoHash ?? null);
      setP2Hash((current) => {
        if (current) return current;
        const fallback = filteredMetas.find((item) => item.photoHash !== (filteredMetas[0]?.photoHash ?? null));
        return fallback?.photoHash ?? filteredMetas[0]?.photoHash ?? null;
      });
    };
    void load();
  }, []);

  const p1Meta = useMemo(() => metas.find((item) => item.photoHash === p1Hash) ?? null, [metas, p1Hash]);
  const p2Meta = useMemo(() => metas.find((item) => item.photoHash === p2Hash) ?? null, [metas, p2Hash]);
  const p1PreviewUrl = useObjectUrl(getPreviewBlob(p1Meta));
  const p2PreviewUrl = useObjectUrl(getPreviewBlob(p2Meta));
  const selectedPhotoStage = useMemo(
    () => (stageChoice.kind === 'photo' ? photoStages.find((item) => item.stageKey === stageChoice.stageKey) ?? null : null),
    [photoStages, stageChoice],
  );
  const photoStageUrl = useObjectUrl(selectedPhotoStage?.pngBlob ?? null);

  const canStartFight = Boolean(p1Meta && p2Meta);

  const stageSummary =
    stageChoice.kind === 'auto'
      ? { label: 'AUTO', blurb: 'Let the matchup choose the arena.' }
      : stageChoice.kind === 'built-in'
        ? { label: getStageChoiceLabel(stageChoice.stageId), blurb: getStageChoiceBlurb(stageChoice.stageId) }
        : { label: selectedPhotoStage?.label ?? stageChoice.label, blurb: 'Custom photo stage from your local cache.' };

  const launchFight = () => {
    if (!p1Meta || !p2Meta) return;
    onStartFight({
      vsAI: modeMeta.vsAI,
      cpuVsCpu: modeMeta.cpuVsCpu,
      p1PhotoHash: p1Meta.photoHash,
      p2PhotoHash: p2Meta.photoHash,
      p1Name: p1Meta.characterName,
      p2Name: p2Meta.characterName,
      p1PersonalityId,
      p2PersonalityId,
      stageId: stageChoice.kind === 'built-in' ? stageChoice.stageId : undefined,
      customStageKey: stageChoice.kind === 'photo' ? stageChoice.stageKey : undefined,
      customStageLabel: stageChoice.kind === 'photo' ? (selectedPhotoStage?.label ?? stageChoice.label) : undefined,
    });
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
          <div className="gallery-hero__status">{status}</div>
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
                <strong>{p1Meta?.characterName ?? 'Pick fighter'}</strong>
                <span>{p1Meta ? `${p1Meta.animationsReady.length} animations ready` : 'Select a fighter below'}</span>
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
                <strong>{p2Meta?.characterName ?? 'Pick fighter'}</strong>
                <span>{p2Meta ? `${p2Meta.animationsReady.length} animations ready` : 'Select a fighter below'}</span>
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
              </div>
              <button className="home-menu__action is-primary roster-fight-btn" disabled={!canStartFight} onClick={launchFight}>
                <span>{modeMeta.actionLabel}</span>
                <small>
                  {canStartFight
                    ? `${p1Meta?.characterName ?? 'P1'} vs ${p2Meta?.characterName ?? 'P2'}`
                    : 'Select both fighters first'}
                </small>
              </button>
            </div>

            <div className="roster-fighter-grid">
              {metas.map((meta) => (
                <FighterRosterCard
                  key={meta.photoHash}
                  meta={meta}
                  p1Label={modeMeta.p1Label}
                  p2Label={modeMeta.p2Label}
                  isP1Selected={p1Hash === meta.photoHash}
                  isP2Selected={p2Hash === meta.photoHash}
                  onAssignP1={() => setP1Hash(meta.photoHash)}
                  onAssignP2={() => setP2Hash(meta.photoHash)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="roster-column">
          <div className="gallery-panel">
            <h3>Stage</h3>
            <div className="roster-stage-preview">
              {photoStageUrl ? <img src={photoStageUrl} alt="" /> : <div className="gallery-preview__empty">{stageSummary.label}</div>}
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
