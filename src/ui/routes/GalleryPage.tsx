import { useEffect, useMemo, useState } from 'react';
import {
  getAllCachedMetas,
  getAllCachedStageBackgrounds,
  getAllSpritesForHash,
  getCachedIntro,
  deleteCachedStageBackground,
  renameCachedStageBackground,
  CACHE_VERSION,
  type CachedFailedAnimationArtifact,
  type CachedIntro,
  type CachedMeta,
  type CachedSprite,
  type CachedStageBackground,
} from '../../services/SpriteCache.ts';
import {
  getAnimationList,
  retryAnimation,
  retryCrouchView,
  retrySideView,
  retryUprightView,
  type IdleGenerationMode,
} from '../../services/CharacterPipeline.ts';
import { clearDebugLog, DEBUG_EVENT_NAME, getDebugLogLines } from '../../services/DebugLog.ts';
import { SpritePreviewCanvas } from '../components/SpritePreviewCanvas.tsx';

const ANIM_LABELS: Record<string, string> = {
  idle: 'IDLE',
  walk: 'WALK',
  high_punch: 'PUNCH',
  low_punch: 'C.PUNCH',
  high_kick: 'KICK',
  low_kick: 'C.KICK',
  jump: 'JUMP',
  crouch: 'CROUCH',
  hit: 'HIT',
  ko: 'K.O.',
  victory: 'WIN',
};

type PreviewSelection =
  | { kind: 'source'; source: 'original' | 'side' | 'upright' | 'crouch' }
  | { kind: 'animation'; animationName: string };

interface PreviewSpriteLike {
  blob: Blob;
  rawBlob?: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  failed?: boolean;
  reason?: string;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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

function getSourceBlob(
  meta: CachedMeta | null,
  source: 'original' | 'side' | 'upright' | 'crouch',
) {
  if (!meta) return null;
  switch (source) {
    case 'original':
      return meta.originalPhotoBlob;
    case 'side':
      return meta.sideViewBlob;
    case 'upright':
      return meta.uprightViewBlob;
    case 'crouch':
      return meta.crouchViewBlob;
  }
}

function toFailedSprite(artifact: CachedFailedAnimationArtifact): PreviewSpriteLike {
  return {
    blob: artifact.pngBlob,
    rawBlob: artifact.rawPngBlob,
    frameWidth: artifact.frameWidth,
    frameHeight: artifact.frameHeight,
    frameCount: artifact.frameCount,
    failed: true,
    reason: artifact.reason,
  };
}

function getPrimaryIntroBlob(intro: CachedIntro | null): Blob | null {
  return intro?.variants[0]?.videoBlob ?? null;
}

export function GalleryPage({ onBack }: { onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<'characters' | 'stages'>('characters');
  const [metas, setMetas] = useState<CachedMeta[]>([]);
  const [stages, setStages] = useState<CachedStageBackground[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentStageIndex, setCurrentStageIndex] = useState(0);
  const [sprites, setSprites] = useState<CachedSprite[]>([]);
  const [intro, setIntro] = useState<CachedIntro | null>(null);
  const [selection, setSelection] = useState<PreviewSelection>({ kind: 'source', source: 'original' });
  const [status, setStatus] = useState<string>('Loading fighters...');
  const [busy, setBusy] = useState(false);
  const [idleMode, setIdleMode] = useState<IdleGenerationMode>('frame_sequence');
  const [debugLines, setDebugLines] = useState<string[]>([]);

  const meta = metas[currentIndex] ?? null;

  useEffect(() => {
    const load = async () => {
      const [all, allStages] = await Promise.all([
        getAllCachedMetas(),
        getAllCachedStageBackgrounds(),
      ]);
      const filtered = all
        .filter((item) => item.version === CACHE_VERSION)
        .sort((a, b) => b.createdAt - a.createdAt);
      const filteredStages = allStages
        .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
        .sort((a, b) => b.createdAt - a.createdAt);
      setMetas(filtered);
      setStages(filteredStages);
      setCurrentIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
      setCurrentStageIndex((current) => Math.min(current, Math.max(0, filteredStages.length - 1)));
      setStatus(filtered.length > 0 || filteredStages.length > 0 ? 'Ready' : 'No fighters or stages yet');
    };
    void load();
  }, []);

  useEffect(() => {
    if (!meta) {
      setSprites([]);
      setIntro(null);
      return;
    }
    const load = async () => {
      const [nextSprites, nextIntro] = await Promise.all([
        getAllSpritesForHash(meta.photoHash),
        getCachedIntro(meta.photoHash),
      ]);
      setSprites(nextSprites);
      setIntro(nextIntro);
    };
    void load();
  }, [meta?.photoHash]);

  useEffect(() => {
    const onDebug = () => setDebugLines(getDebugLogLines().slice(-8));
    window.addEventListener(DEBUG_EVENT_NAME, onDebug);
    onDebug();
    return () => window.removeEventListener(DEBUG_EVENT_NAME, onDebug);
  }, []);

  const previewSprite = useMemo<PreviewSpriteLike | null>(() => {
    if (!meta || selection.kind !== 'animation') return null;
    const cached = sprites.find((item) => item.animationName === selection.animationName);
    if (cached) {
      return {
        blob: cached.pngBlob,
        rawBlob: cached.rawPngBlob,
        frameWidth: cached.frameWidth,
        frameHeight: cached.frameHeight,
        frameCount: cached.frameCount,
      };
    }
    const failed = meta.failedAnimationArtifacts?.[selection.animationName];
    return failed ? toFailedSprite(failed) : null;
  }, [meta, selection, sprites]);

  const previewBlob = useMemo(() => {
    if (!meta) return null;
    if (selection.kind === 'source') {
      return getSourceBlob(meta, selection.source);
    }
    return previewSprite?.blob ?? null;
  }, [meta, selection, previewSprite]);

  const previewUrl = useObjectUrl(selection.kind === 'source' ? previewBlob : null);
  const introUrl = useObjectUrl(getPrimaryIntroBlob(intro));
  const currentStage = stages[currentStageIndex] ?? null;
  const stagePreviewUrl = useObjectUrl(currentStage?.pngBlob ?? null);

  const safeName = (meta?.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');

  const refreshCurrent = async () => {
    const currentPhotoHash = meta?.photoHash ?? null;
    const [all, allStages, nextSprites, nextIntro] = await Promise.all([
      getAllCachedMetas(),
      getAllCachedStageBackgrounds(),
      currentPhotoHash ? getAllSpritesForHash(currentPhotoHash) : Promise.resolve([]),
      currentPhotoHash ? getCachedIntro(currentPhotoHash) : Promise.resolve(null),
    ]);
    const filtered = all
      .filter((item) => item.version === CACHE_VERSION)
      .sort((a, b) => b.createdAt - a.createdAt);
    const filteredStages = allStages
      .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
      .sort((a, b) => b.createdAt - a.createdAt);
    setMetas(filtered);
    setStages(filteredStages);
    const nextIndex = currentPhotoHash ? filtered.findIndex((item) => item.photoHash === currentPhotoHash) : -1;
    if (nextIndex >= 0) setCurrentIndex(nextIndex);
    setCurrentStageIndex((current) => Math.min(current, Math.max(0, filteredStages.length - 1)));
    setSprites(nextSprites);
    setIntro(nextIntro);
  };

  const runRetry = async (action: () => Promise<void>, nextStatus: string) => {
    clearDebugLog();
    setBusy(true);
    setStatus(nextStatus);
    try {
      await action();
      await refreshCurrent();
      setStatus('Done');
    } catch (err: any) {
      await refreshCurrent();
      setStatus(err?.message ? `Failed: ${err.message}` : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const selectedAnimName = selection.kind === 'animation' ? selection.animationName : null;

  const renameStage = async () => {
    if (!currentStage) return;
    const nextName = window.prompt('Stage name', currentStage.label ?? 'PHOTO STAGE');
    if (!nextName || !nextName.trim()) return;
    setBusy(true);
    setStatus('Renaming stage...');
    try {
      await renameCachedStageBackground(currentStage.stageKey, nextName.trim());
      await refreshCurrent();
      setStatus('Stage renamed');
    } catch (err: any) {
      setStatus(err?.message ? `Failed: ${err.message}` : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteStage = async () => {
    if (!currentStage) return;
    if (!window.confirm(`Delete stage "${currentStage.label ?? 'PHOTO STAGE'}"?`)) return;
    setBusy(true);
    setStatus('Deleting stage...');
    try {
      await deleteCachedStageBackground(currentStage.stageKey);
      const nextStages = stages.filter((stage) => stage.stageKey !== currentStage.stageKey);
      setStages(nextStages);
      setCurrentStageIndex((current) => Math.min(current, Math.max(0, nextStages.length - 1)));
      setStatus('Stage deleted');
    } catch (err: any) {
      setStatus(err?.message ? `Failed: ${err.message}` : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gallery-app">
      <aside className="gallery-sidebar">
        <div className="gallery-sidebar__header">
          <div>
            <p className="gallery-eyebrow">Archive</p>
            <h1>Training Room</h1>
          </div>
          <button className="gallery-back" onClick={onBack}>
            Back
          </button>
        </div>

        <div className="gallery-tab-row">
          <button
            className={`gallery-tab${activeTab === 'characters' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('characters')}
          >
            Characters
          </button>
          <button
            className={`gallery-tab${activeTab === 'stages' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('stages')}
          >
            Stages
          </button>
        </div>

        {activeTab === 'characters' ? (
          <div className="gallery-sidebar__list">
            {metas.map((item, index) => (
              <button
                key={item.photoHash}
                className={`gallery-fighter-card${index === currentIndex ? ' is-active' : ''}`}
                onClick={() => {
                  setCurrentIndex(index);
                  setSelection({ kind: 'source', source: 'original' });
                }}
              >
                <span className="gallery-fighter-card__name">{item.characterName}</span>
                <span className="gallery-fighter-card__meta">
                  {formatDate(item.createdAt)} · {item.animationsReady.length} anims
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="gallery-sidebar__list">
            {stages.map((stage, index) => (
              <button
                key={stage.stageKey}
                className={`gallery-fighter-card${index === currentStageIndex ? ' is-active' : ''}`}
                onClick={() => setCurrentStageIndex(index)}
              >
                <span className="gallery-fighter-card__name">{(stage.label ?? 'PHOTO STAGE').toUpperCase()}</span>
                <span className="gallery-fighter-card__meta">
                  {formatDate(stage.createdAt)} · {stage.kind === 'photo-direct' ? 'direct photo' : 'forged'}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="gallery-main">
        {activeTab === 'characters' ? !meta ? (
          <section className="gallery-empty">
            <h2>No Fighters Yet</h2>
            <p>Step into a match to recruit your first challenger.</p>
          </section>
        ) : (
          <>
            <header className="gallery-hero">
              <div>
                <p className="gallery-eyebrow">
                  Fighter {currentIndex + 1} / {metas.length}
                </p>
                <h2>{meta.characterName}</h2>
                <p className="gallery-hero__meta">
                  Status: {meta.status} · Created {formatDate(meta.createdAt)} · Hash {meta.photoHash.slice(0, 10)}...
                </p>
              </div>
              <div className="gallery-hero__status">{status}</div>
            </header>

            <section className="gallery-layout">
              <div className="gallery-panel gallery-panel--sources">
                <h3>Source Views</h3>
                <div className="gallery-source-grid">
                  {([
                    ['original', 'Original'],
                    ['side', 'Side View'],
                    ['upright', 'Upright'],
                    ['crouch', 'Crouch'],
                  ] as const).map(([sourceKey, label]) => {
                    const blob = getSourceBlob(meta, sourceKey);
                    return (
                      <button
                        key={sourceKey}
                        className={`gallery-chip${selection.kind === 'source' && selection.source === sourceKey ? ' is-active' : ''}`}
                        onClick={() => setSelection({ kind: 'source', source: sourceKey })}
                      >
                        <span>{label}</span>
                        <small>{blob ? 'Ready' : 'Missing'}</small>
                      </button>
                    );
                  })}
                </div>

                <div className="gallery-actions">
                  <button disabled={busy} onClick={() => void runRetry(() => retrySideView(meta.photoHash, () => {}), 'Retrying side view...')}>
                    Retry Side
                  </button>
                  <button disabled={busy} onClick={() => void runRetry(() => retryUprightView(meta.photoHash, () => {}), 'Retrying upright...')}>
                    Retry Upright
                  </button>
                  <button disabled={busy} onClick={() => void runRetry(() => retryCrouchView(meta.photoHash, () => {}), 'Retrying crouch...')}>
                    Retry Crouch
                  </button>
                </div>

                {introUrl ? (
                  <div className="gallery-intro-card">
                    <h4>Intro Video</h4>
                    <video src={introUrl} controls loop muted className="gallery-intro-card__video" />
                  </div>
                ) : null}
              </div>

              <div className="gallery-panel gallery-panel--preview">
                <div className="gallery-preview__header">
                  <div>
                    <p className="gallery-eyebrow">Preview</p>
                    <h3>
                      {selection.kind === 'source'
                        ? selection.source.toUpperCase()
                        : ANIM_LABELS[selection.animationName] || selection.animationName.toUpperCase()}
                    </h3>
                  </div>
                  {selectedAnimName === 'idle' ? (
                    <button
                      className="gallery-mode-toggle"
                      disabled={busy}
                      onClick={() => setIdleMode((current) => (current === 'frame_sequence' ? 'sheet' : 'frame_sequence'))}
                    >
                      Mode: {idleMode === 'frame_sequence' ? 'Frames' : 'Sheet'}
                    </button>
                  ) : null}
                </div>

                <div className="gallery-preview__surface">
                  {selection.kind === 'source' ? (
                    previewUrl ? <img src={previewUrl} alt="" className="gallery-preview__image" /> : <div className="gallery-preview__empty">Missing source</div>
                  ) : previewSprite ? (
                    <>
                      <SpritePreviewCanvas
                        blob={previewSprite.blob}
                        frameWidth={previewSprite.frameWidth}
                        frameHeight={previewSprite.frameHeight}
                        frameCount={previewSprite.frameCount}
                        className="gallery-preview__canvas"
                      />
                      {previewSprite.failed ? (
                        <div className="gallery-preview__warning">
                          Showing failed result
                          {previewSprite.reason ? `: ${previewSprite.reason}` : ''}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="gallery-preview__empty">No preview for this animation yet</div>
                  )}
                </div>

                <div className="gallery-actions">
                  {previewBlob ? (
                    <button onClick={() => downloadBlob(previewBlob, `${safeName}_${selection.kind === 'source' ? selection.source : selection.animationName}.png`)}>
                      Save PNG
                    </button>
                  ) : null}
                  {previewSprite?.rawBlob ? (
                    <button onClick={() => downloadBlob(previewSprite.rawBlob!, `${safeName}_${selectedAnimName}_RAW.png`)}>
                      Save RAW
                    </button>
                  ) : null}
                  {selectedAnimName ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void runRetry(
                          () =>
                            retryAnimation(meta.photoHash, selectedAnimName, () => {}, selectedAnimName === 'idle' ? { idleMode } : undefined),
                          `Retrying ${selectedAnimName}${selectedAnimName === 'idle' ? ` (${idleMode === 'frame_sequence' ? 'frames' : 'sheet'})` : ''}...`,
                        )
                      }
                    >
                      Retry Animation
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="gallery-panel gallery-panel--anims">
                <h3>Animations</h3>
                <div className="gallery-anim-grid">
                  {getAnimationList().map((anim) => {
                    const cached = sprites.find((item) => item.animationName === anim.name);
                    const failed = meta.failedAnimationArtifacts?.[anim.name];
                    const state = cached ? 'ready' : failed ? 'failed' : 'missing';
                    return (
                      <button
                        key={anim.name}
                        className={`gallery-anim-tile is-${state}${selection.kind === 'animation' && selection.animationName === anim.name ? ' is-active' : ''}`}
                        onClick={() => setSelection({ kind: 'animation', animationName: anim.name })}
                      >
                        <span>{ANIM_LABELS[anim.name] || anim.name.toUpperCase()}</span>
                        <small>{state}</small>
                      </button>
                    );
                  })}
                </div>

                <div className="gallery-debug">
                  <h4>Debug Feed</h4>
                  <pre>{debugLines.join('\n') || 'No debug lines yet.'}</pre>
                </div>
              </div>
            </section>
          </>
        ) : !currentStage ? (
          <section className="gallery-empty">
            <h2>No Custom Stages</h2>
            <p>Stages forged from your own photos will appear here.</p>
          </section>
        ) : (
          <>
            <header className="gallery-hero">
              <div>
                <p className="gallery-eyebrow">
                  Stage {currentStageIndex + 1} / {stages.length}
                </p>
                <h2>{(currentStage.label ?? 'PHOTO STAGE').toUpperCase()}</h2>
                <p className="gallery-hero__meta">
                  Created {formatDate(currentStage.createdAt)} · Kind {currentStage.kind ?? 'photo'} · Key {currentStage.stageKey.slice(0, 14)}...
                </p>
              </div>
              <div className="gallery-hero__status">{status}</div>
            </header>

            <section className="gallery-stage-layout">
              <div className="gallery-panel">
                <h3>Preview</h3>
                <div className="gallery-stage-preview">
                  {stagePreviewUrl ? (
                    <img src={stagePreviewUrl} alt="" className="gallery-stage-preview__image" />
                  ) : (
                    <div className="gallery-preview__empty">Missing stage image</div>
                  )}
                </div>
              </div>

              <div className="gallery-panel">
                <h3>Details</h3>
                <div className="gallery-stage-meta">
                  <p><strong>Label</strong> {(currentStage.label ?? 'PHOTO STAGE').toUpperCase()}</p>
                  <p><strong>Kind</strong> {currentStage.kind === 'photo-direct' ? 'DIRECT PHOTO' : 'FORGED PHOTO STAGE'}</p>
                  <p><strong>Created</strong> {formatDate(currentStage.createdAt)}</p>
                </div>
                <div className="gallery-actions">
                  <button disabled={!currentStage.pngBlob} onClick={() => downloadBlob(currentStage.pngBlob, `${((currentStage.label ?? 'photo_stage').toLowerCase().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')) || 'photo_stage'}.png`)}>
                    Save PNG
                  </button>
                  <button disabled={busy} onClick={() => void renameStage()}>
                    Rename
                  </button>
                  <button disabled={busy} onClick={() => void deleteStage()}>
                    Delete
                  </button>
                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
