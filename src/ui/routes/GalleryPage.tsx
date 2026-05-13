import { useEffect, useMemo, useState } from 'react';
import {
  getAllCachedMetas,
  getAllCachedStageBackgrounds,
  getAllSpritesForHash,
  getCachedIntro,
  deleteCachedStageBackground,
  deleteCharacter,
  renameCachedStageBackground,
  renameCharacter,
  CACHE_VERSION,
  type CachedIntro,
  type CachedMeta,
  type CachedSprite,
  type CachedStageBackground,
} from '../../services/SpriteCache.ts';
import {
  rebuildCharacter,
  retryAnimation,
  retryCrouchView,
  retrySideView,
  retryUprightView,
  SPRITE_PROCESSING_VERSION,
  type SpriteGenerationMode,
} from '../../services/CharacterPipeline.ts';
import { clearDebugLog } from '../../services/DebugLog.ts';
import { exportAnimationGif } from '../../services/GifExportService.ts';
import { AnimationGrid } from '../components/AnimationGrid.tsx';
import { SourceViewsPanel } from '../components/SourceViewsPanel.tsx';
import { SpritePreviewSurface } from '../components/SpritePreviewSurface.tsx';
import { DebugFeed } from '../components/DebugFeed.tsx';
import {
  animLabel,
  getSourceBlob,
  type PreviewSelection,
  type PreviewSpriteLike,
  type SourceKey,
} from '../shared/fighterPreview.ts';
import { useObjectUrl } from '../shared/useObjectUrl.ts';
import { downloadBlob } from '../shared/downloadBlob.ts';

function formatDate(value: number): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getPrimaryIntroBlob(intro: CachedIntro | null): Blob | null {
  return intro?.variants[0]?.videoBlob ?? null;
}

interface GalleryPageProps {
  onBack: () => void;
  onCreateFighter: () => void;
}

export function GalleryPage({ onBack, onCreateFighter }: GalleryPageProps) {
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
  type RetryTarget = { kind: 'source'; key: SourceKey } | { kind: 'animation'; name: string };
  const [retryingTarget, setRetryingTarget] = useState<RetryTarget | null>(null);
  const [spriteMode, setSpriteMode] = useState<SpriteGenerationMode>('sheet_refined');

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
    if (!failed) return null;
    return {
      blob: failed.pngBlob,
      rawBlob: failed.rawPngBlob,
      frameWidth: failed.frameWidth,
      frameHeight: failed.frameHeight,
      frameCount: failed.frameCount,
      failed: true,
      reason: failed.reason,
    };
  }, [meta, selection, sprites]);

  const previewSourceBlob = useMemo(() => {
    if (!meta || selection.kind !== 'source') return null;
    return getSourceBlob(meta, selection.source);
  }, [meta, selection]);

  const previewBlob = selection.kind === 'source'
    ? previewSourceBlob
    : previewSprite?.blob ?? null;
  const previewUrl = useObjectUrl(selection.kind === 'source' ? previewSourceBlob : null);
  const introUrl = useObjectUrl(getPrimaryIntroBlob(intro));
  const currentStage = stages[currentStageIndex] ?? null;
  const stagePreviewUrl = useObjectUrl(currentStage?.pngBlob ?? null);

  const safeName = (meta?.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
  const selectedAnimName = selection.kind === 'animation' ? selection.animationName : null;

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

  const runRetry = async (
    action: () => Promise<void>,
    nextStatus: string,
    target?: RetryTarget,
  ) => {
    clearDebugLog();
    setBusy(true);
    setRetryingTarget(target ?? null);
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
      setRetryingTarget(null);
    }
  };

  const retryingAnim = retryingTarget?.kind === 'animation' ? retryingTarget.name : null;
  const retryingSource = retryingTarget?.kind === 'source' ? retryingTarget.key : null;

  const hasOutdatedSprites = sprites.some((sprite) => (sprite.processingVersion ?? 0) < SPRITE_PROCESSING_VERSION);

  const renameFighter = async () => {
    if (!meta) return;
    const nextName = window.prompt('Fighter name', meta.characterName);
    if (!nextName || !nextName.trim() || nextName.trim() === meta.characterName) return;
    setBusy(true);
    setStatus('Renaming...');
    try {
      await renameCharacter(meta.photoHash, nextName.trim());
      await refreshCurrent();
      setStatus('Fighter renamed');
    } catch (err: any) {
      setStatus(err?.message ? `Rename failed: ${err.message}` : 'Rename failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteFighter = async () => {
    if (!meta) return;
    if (!window.confirm(`Delete "${meta.characterName}"? This wipes sprites, intro video, and metadata. Cannot be undone.`)) {
      return;
    }
    const removedHash = meta.photoHash;
    setBusy(true);
    setStatus(`Deleting ${meta.characterName}...`);
    try {
      await deleteCharacter(removedHash);
      const nextMetas = metas.filter((item) => item.photoHash !== removedHash);
      setMetas(nextMetas);
      setCurrentIndex((current) => Math.min(current, Math.max(0, nextMetas.length - 1)));
      setSprites([]);
      setIntro(null);
      setSelection({ kind: 'source', source: 'original' });
      setStatus(nextMetas.length > 0 ? 'Fighter deleted' : 'No fighters left');
    } catch (err: any) {
      setStatus(err?.message ? `Delete failed: ${err.message}` : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const rebuildHd = async () => {
    if (!meta) return;
    if (!window.confirm(`Rebuild all sprites for "${meta.characterName}" at HD resolution? Animations without a cached raw blob will be skipped — re-run retry on those.`)) {
      return;
    }
    clearDebugLog();
    setBusy(true);
    setStatus('Rebuilding at HD...');
    try {
      await rebuildCharacter(meta.photoHash, (progress) => {
        if (progress.stage === 'generating_sprites') {
          setStatus(`Rebuilding ${progress.animation} (${progress.current}/${progress.total})...`);
          setRetryingTarget({ kind: 'animation', name: progress.animation });
        } else if (progress.stage === 'sprite_ready') {
          setRetryingTarget(null);
        }
      });
      await refreshCurrent();
      setStatus('HD rebuild complete');
    } catch (err: any) {
      await refreshCurrent();
      setStatus(err?.message ? `Rebuild failed: ${err.message}` : 'Rebuild failed');
    } finally {
      setBusy(false);
      setRetryingTarget(null);
    }
  };

  const saveGif = async () => {
    if (!selectedAnimName) return;
    const cached = sprites.find((item) => item.animationName === selectedAnimName);
    if (!cached) return;
    setBusy(true);
    setStatus(`Encoding ${selectedAnimName}.gif...`);
    try {
      const gif = await exportAnimationGif(cached, selectedAnimName);
      downloadBlob(gif, `${safeName}_${selectedAnimName}.gif`);
      setStatus('GIF saved');
    } catch (err: any) {
      setStatus(err?.message ? `GIF failed: ${err.message}` : 'GIF failed');
    } finally {
      setBusy(false);
    }
  };

  const saveAll = async () => {
    if (!meta) return;
    setBusy(true);
    setStatus('Saving all sprites...');
    try {
      const sources: Array<[string, Blob | null | undefined]> = [
        ['original', meta.originalPhotoBlob],
        ['side', meta.sideViewBlob],
        ['upright', meta.uprightViewBlob],
        ['crouch', meta.crouchViewBlob],
      ];
      for (const [label, blob] of sources) {
        if (blob) downloadBlob(blob, `${safeName}_${label}.png`);
      }
      for (const sprite of sprites) {
        downloadBlob(sprite.pngBlob, `${safeName}_${sprite.animationName}.png`);
      }
      setStatus(`Saved ${sources.filter(([, b]) => b).length} sources + ${sprites.length} sprites`);
    } catch (err: any) {
      setStatus(err?.message ? `Bulk save failed: ${err.message}` : 'Bulk save failed');
    } finally {
      setBusy(false);
    }
  };

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

        <button className="home-menu__action is-primary" onClick={onCreateFighter}>
          <span>New Fighter</span>
          <small>Upload A Photo</small>
        </button>

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
            <p>Upload a photo to forge your first challenger.</p>
            <button className="home-menu__action is-primary" onClick={onCreateFighter}>
              <span>Forge Fighter</span>
              <small>Start The Pipeline</small>
            </button>
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
              <div className="roster-hero__actions">
                <div className="gallery-hero__status">{status}</div>
                {hasOutdatedSprites ? (
                  <button className="gallery-back" disabled={busy} onClick={() => void rebuildHd()}>
                    Rebuild HD
                  </button>
                ) : null}
                <button className="gallery-back" disabled={busy} onClick={() => void saveAll()}>
                  Save All
                </button>
                <button className="gallery-back" disabled={busy} onClick={() => void renameFighter()}>
                  Rename
                </button>
                <button className="gallery-back" disabled={busy} onClick={() => void deleteFighter()}>
                  Delete
                </button>
              </div>
            </header>

            <section className="gallery-layout">
              <div className="gallery-column--side">
                <div className="gallery-panel gallery-panel--sources">
                  <SourceViewsPanel
                    meta={meta}
                    selectedSource={selection.kind === 'source' ? selection.source : null}
                    onSelectSource={(source) => setSelection({ kind: 'source', source })}
                    regeneratingSource={retryingSource}
                    onRetry={{
                      side: () => runRetry(
                        () => retrySideView(meta.photoHash, () => {}),
                        'Retrying side view...',
                        { kind: 'source', key: 'side' },
                      ),
                      upright: () => runRetry(
                        () => retryUprightView(meta.photoHash, () => {}),
                        'Retrying upright...',
                        { kind: 'source', key: 'upright' },
                      ),
                      crouch: () => runRetry(
                        () => retryCrouchView(meta.photoHash, () => {}),
                        'Retrying crouch...',
                        { kind: 'source', key: 'crouch' },
                      ),
                    }}
                    busy={busy}
                  />

                  {introUrl ? (
                    <div className="gallery-intro-card">
                      <h4>Intro Video</h4>
                      <video src={introUrl} controls loop muted className="gallery-intro-card__video" />
                    </div>
                  ) : null}
                </div>

                <div className="gallery-panel gallery-panel--anims">
                  <h3>Animations</h3>
                  <AnimationGrid
                    sprites={sprites}
                    failedArtifacts={meta.failedAnimationArtifacts ?? null}
                    generating={retryingAnim ? new Set([retryingAnim]) : undefined}
                    selectedName={selectedAnimName}
                    onSelect={(animationName) => setSelection({ kind: 'animation', animationName })}
                  />
                  <DebugFeed />
                </div>
              </div>

              <div className="gallery-panel gallery-panel--preview">
                <div className="gallery-preview__header">
                  <div>
                    <p className="gallery-eyebrow">Preview</p>
                    <h3>
                      {selection.kind === 'source'
                        ? selection.source.toUpperCase()
                        : animLabel(selection.animationName)}
                    </h3>
                  </div>
                  {selectedAnimName ? (
                    <button
                      className="gallery-mode-toggle"
                      disabled={busy}
                      onClick={() =>
                        setSpriteMode((current) => {
                          if (current === 'sheet_refined') return selectedAnimName === 'idle' ? 'frame_sequence' : 'sheet';
                          if (current === 'frame_sequence') return 'sheet';
                          return 'sheet_refined';
                        })
                      }
                    >
                      Mode: {spriteMode === 'sheet_refined' ? 'Refined' : spriteMode === 'frame_sequence' ? 'Frames' : 'Sheet'}
                    </button>
                  ) : null}
                </div>

                <div className="gallery-preview__surface">
                  <SpritePreviewSurface
                    sourceImageUrl={selection.kind === 'source' ? previewUrl : null}
                    sprite={selection.kind === 'animation' ? previewSprite : null}
                    loading={
                      busy &&
                      ((selection.kind === 'animation' && retryingAnim !== null && selection.animationName === retryingAnim) ||
                        (selection.kind === 'source' && retryingSource !== null && selection.source === retryingSource))
                    }
                    loadingLabel={
                      retryingAnim
                        ? `Rebuilding ${animLabel(retryingAnim)}`
                        : retryingSource
                          ? `Rebuilding ${retryingSource.toUpperCase()} view`
                          : 'Loading'
                    }
                    emptyLabel={selection.kind === 'source' ? 'Missing source' : 'No preview for this animation yet'}
                  />
                </div>

                <div className="gallery-actions">
                  {previewBlob ? (
                    <button onClick={() => downloadBlob(previewBlob, `${safeName}_${selection.kind === 'source' ? selection.source : selection.animationName}.png`)}>
                      Save PNG
                    </button>
                  ) : null}
                  {selectedAnimName && sprites.some((item) => item.animationName === selectedAnimName) ? (
                    <button disabled={busy} onClick={() => void saveGif()}>
                      Save GIF
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
                          () => retryAnimation(meta.photoHash, selectedAnimName, () => {}, { spriteMode }),
                          `Retrying ${selectedAnimName} (${spriteMode === 'sheet_refined' ? 'refined' : spriteMode === 'frame_sequence' ? 'frames' : 'sheet'})...`,
                          { kind: 'animation', name: selectedAnimName },
                        )
                      }
                    >
                      Retry Animation
                    </button>
                  ) : null}
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
