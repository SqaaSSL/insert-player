import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getAllCachedMetas,
  getAllCachedStageBackgrounds,
  getAllSpritesForHash,
  getActiveSpriteCacheScope,
  getCachedMeta,
  getCachedIntro,
  setCachedMeta,
  setCloudPlayableSpriteRefs,
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
  upgradeFighter,
  SPRITE_PROCESSING_VERSION,
} from '../../services/CharacterPipeline.ts';
import { clearDebugLog, debugWarn } from '../../services/DebugLog.ts';
import { exportAnimationGif } from '../../services/GifExportService.ts';
import { AnimationGrid } from '../components/AnimationGrid.tsx';
import { Button } from '../components/Button.tsx';
import { TierBadge } from '../components/TierBadge.tsx';
import { Modal, ConfirmDialog } from '../components/Modal.tsx';
import { GalleryFighterList } from '../components/GalleryFighterList.tsx';
import { SourceViewsPanel } from '../components/SourceViewsPanel.tsx';
import { SpritePreviewSurface } from '../components/SpritePreviewSurface.tsx';
import { DebugFeed } from '../components/DebugFeed.tsx';
import {
  animLabel,
  defaultSourceForMeta,
  getSourceBlob,
  tierLabel,
  type PreviewSelection,
  type PreviewSpriteLike,
  type SourceKey,
} from '../shared/fighterPreview.ts';
import {
  ensureGalleryArcadeFighterReady,
  findCachedArcadeMeta,
} from '../shared/galleryArcadeRoster.ts';
import {
  arcadeRosterFighterIds,
  galleryFighterIndexForSelection,
  isGlobalRosterMeta,
  markArcadeManagedMetas,
  visibleGalleryMetas,
} from '../shared/arcadeRosterIdentity.ts';
import { useObjectUrl } from '../shared/useObjectUrl.ts';
import { downloadBlob } from '../shared/downloadBlob.ts';
import { shareCommunityFighter } from '../shared/communityShare.ts';
import {
  arcadeFighterPhotoHash,
  deleteCloudFighter,
  downloadArcadeFighterToLocal,
  downloadArcadeSpriteRawToLocal,
  downloadCloudFighterToLocal,
  formatCloudRosterSyncStatus,
  getCloudFighter,
  listArcadeFighters,
  renameCloudFighter,
  setCloudFighterPublic,
  syncCloudFightersToLocal,
  syncFighterToCloud,
  type CloudFighter,
} from '../../services/CloudFighters.ts';
import {
  QUALITY_TIERS,
  SOURCE_RETRY_CREDIT_COST,
  animationRetryCreditCost,
  type GenerationBillingOperation,
  type QualityTier,
} from '../../services/QualityTiers.ts';
import { authorizeGeneration, finishGenerationPurchase } from '../../services/Billing.ts';
import {
  captureApiRequestContext,
  runWithProviderSession,
  type ApiRequestContext,
} from '../../services/ApiClient.ts';
import { checkoutStatusMessage, consumeCheckoutStatus } from '../shared/checkoutStatus.ts';
import { GenerationConsent } from '../components/LegalConsent.tsx';
import { VideoGenerationReviewGate } from '../components/VideoGenerationReviewGate.tsx';
import { currentGenerationLegalAttestation } from '../legal.ts';
import {
  listGenerationJobs,
  startGenerationJob,
  waitForGenerationJob,
  type GenerationJob,
} from '../../services/GenerationJobs.ts';
import type { AuthStatus } from '../authState.ts';
import {
  assertCreationFlowAcknowledged,
  creationFlowForResume,
  isVideoResumableJob,
  isVideoReviewOrRestartJob,
} from '../shared/creationFlow.ts';

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

function tierIndex(tier: QualityTier): number {
  return QUALITY_TIERS.findIndex((item) => item.id === tier);
}

interface GalleryPageProps {
  authStatus: AuthStatus;
  authSessionKey: string;
  onBack: () => void;
  onCreateFighter: () => void;
  onNavigateLegal?: (route: '/legal' | '/privacy' | '/terms' | '/refunds') => void;
}

type RetryTarget = { kind: 'source'; key: SourceKey } | { kind: 'animation'; name: string };

function retryTargetForJob(job: GenerationJob): RetryTarget | null {
  if (job.operation === 'fighter_retry_animation' && job.targetKind === 'animation' && job.targetName) {
    return { kind: 'animation', name: job.targetName };
  }
  if (
    job.operation === 'fighter_retry_source' &&
    job.targetKind === 'source' &&
    (job.targetName === 'side' || job.targetName === 'upright' || job.targetName === 'crouch')
  ) {
    return { kind: 'source', key: job.targetName };
  }
  return null;
}

export function GalleryPage({ authStatus, authSessionKey, onBack, onCreateFighter, onNavigateLegal }: GalleryPageProps) {
  const [activeTab, setActiveTab] = useState<'characters' | 'stages'>('characters');
  const [metas, setMetas] = useState<CachedMeta[]>([]);
  const [arcadeFighters, setArcadeFighters] = useState<CloudFighter[]>([]);
  const [arcadeState, setArcadeState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [cloudSyncPending, setCloudSyncPending] = useState(true);
  const [loadingArcadeId, setLoadingArcadeId] = useState<string | null>(null);
  const [stages, setStages] = useState<CachedStageBackground[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentStageIndex, setCurrentStageIndex] = useState(0);
  const [sprites, setSprites] = useState<CachedSprite[]>([]);
  const [intro, setIntro] = useState<CachedIntro | null>(null);
  const [selection, setSelection] = useState<PreviewSelection>({ kind: 'source', source: 'original' });
  const [status, setStatus] = useState<string>('Loading fighters...');
  const [busy, setBusy] = useState(false);
  const [retryingTarget, setRetryingTarget] = useState<RetryTarget | null>(null);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [pendingUpgradeTier, setPendingUpgradeTier] = useState<QualityTier | null>(null);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    variant?: 'primary' | 'danger';
    onConfirm: () => void;
  } | null>(null);
  const [renameRequest, setRenameRequest] = useState<{ kind: 'fighter' | 'stage'; current: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [shareLinkUrl, setShareLinkUrl] = useState<string | null>(null);
  const generationJobAbortRef = useRef<AbortController | null>(null);
  const assetLoadRequestRef = useRef(0);
  const selectedPhotoHashRef = useRef<string | null>(null);
  const hqPreviewRequestsRef = useRef(new Set<string>());
  const [recoveryJob, setRecoveryJob] = useState<GenerationJob | null>(null);
  const [resumableJobs, setResumableJobs] = useState<GenerationJob[]>([]);
  const [videoReviewJobs, setVideoReviewJobs] = useState<GenerationJob[]>([]);

  const meta = metas[currentIndex] ?? null;
  const globalFighterIds = useMemo(
    () => arcadeRosterFighterIds(metas, arcadeFighters),
    [arcadeFighters, metas],
  );
  const isArcadeFighter = isGlobalRosterMeta(meta, globalFighterIds);
  const ownerActionsReady = !isArcadeFighter && !cloudSyncPending;
  const pendingUpgrade = QUALITY_TIERS.find((tier) => tier.id === pendingUpgradeTier) ?? null;

  const reconcileCurrentFighterIndex = (fighters: CachedMeta[]) => {
    setCurrentIndex((current) => {
      const selectedPhotoHash = selectedPhotoHashRef.current;
      const nextIndex = galleryFighterIndexForSelection(fighters, selectedPhotoHash, current);
      if (!selectedPhotoHash) {
        selectedPhotoHashRef.current = fighters[nextIndex]?.photoHash ?? null;
      }
      return nextIndex;
    });
  };

  useEffect(() => () => {
    generationJobAbortRef.current?.abort();
    generationJobAbortRef.current = null;
  }, []);

  useEffect(() => {
    const apiContext = captureApiRequestContext();
    const ownerScope = getActiveSpriteCacheScope();
    let cancelled = false;
    setRecoveryJob(null);
    setResumableJobs([]);
    setVideoReviewJobs([]);
    setPendingUpgradeTier(null);
    setPublishConfirmOpen(false);
    setConfirmRequest(null);
    setRenameRequest(null);
    setShareLinkUrl(null);
    selectedPhotoHashRef.current = null;
    setArcadeState('loading');
    setCloudSyncPending(true);
    const load = async () => {
      const checkoutStatus = consumeCheckoutStatus();
      const checkoutMessage = checkoutStatus ? checkoutStatusMessage(checkoutStatus) : null;
      let cloudImported = 0;
      let cloudUpdated = 0;
      let cloudDrafts = 0;
      let cloudFailed = 0;
      let activeCloudJob: Awaited<ReturnType<typeof listGenerationJobs>>[number] | null = null;
      let resumableCloudJobs: GenerationJob[] = [];
      let reviewCloudJobs: GenerationJob[] = [];
      let arcadeFailed = false;
      const [initialMetas, initialStages, globalRoster] = await Promise.all([
        getAllCachedMetas(ownerScope),
        getAllCachedStageBackgrounds(ownerScope),
        listArcadeFighters().catch((err: any) => {
          arcadeFailed = true;
          debugWarn('[Gallery] Global roster unavailable:', err?.message ?? err);
          return [];
        }),
      ]);
      const initiallyMarked = markArcadeManagedMetas(initialMetas, globalRoster);
      let all = initiallyMarked.metas;
      let allStages = initialStages;
      if (!cancelled) {
        const initialVisibleMetas = visibleGalleryMetas(
          all.filter((item) => item.version === CACHE_VERSION && item.status === 'ready'),
          globalRoster,
        ).sort((a, b) => b.createdAt - a.createdAt);
        const initialVisibleStages = initialStages
          .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
          .sort((a, b) => b.createdAt - a.createdAt);
        setMetas(initialVisibleMetas);
        setStages(initialVisibleStages);
        setArcadeFighters(globalRoster);
        setArcadeState(arcadeFailed ? 'unavailable' : 'ready');
        reconcileCurrentFighterIndex(initialVisibleMetas);
        setCurrentStageIndex((current) => Math.min(current, Math.max(0, initialVisibleStages.length - 1)));
      }
      if (initiallyMarked.changed.length > 0) {
        try {
          await Promise.all(initiallyMarked.changed.map((item) => setCachedMeta(item, ownerScope)));
        } catch (err: any) {
          debugWarn('[Gallery] Global roster identity could not be persisted:', err?.message ?? err);
        }
      }
      try {
        const [cloudSync, generationJobs] = await Promise.all([
          syncCloudFightersToLocal(all, apiContext),
          authStatus === 'signed-in' ? listGenerationJobs(apiContext) : Promise.resolve([]),
        ]);
        activeCloudJob = generationJobs.find((job) => job.status === 'queued' || job.status === 'running') ?? null;
        reviewCloudJobs = generationJobs.filter(isVideoReviewOrRestartJob);
        resumableCloudJobs = generationJobs.filter((job) => (
          isVideoResumableJob(job) || (
            (job.status === 'failed' || job.status === 'cancelled') &&
            job.resumable && job.operation !== 'fighter_generation'
          )
        ));
        setRecoveryJob(activeCloudJob);
        setResumableJobs(resumableCloudJobs);
        setVideoReviewJobs(reviewCloudJobs);
        cloudFailed = cloudSync.failed;
        cloudDrafts = cloudSync.drafts;
        cloudImported = cloudSync.imported;
        cloudUpdated = cloudSync.updated;
        const recoverableVideoFighterIds = new Set([
          ...(activeCloudJob?.creationFlow === 'video' ? [activeCloudJob] : []),
          ...reviewCloudJobs,
          ...resumableCloudJobs.filter((job) => job.creationFlow === 'video'),
        ].map((job) => job.fighterId));
        for (const fighterId of recoverableVideoFighterIds) {
          const fighter = await getCloudFighter(fighterId, apiContext);
          if (!fighter?.photoHash) continue;
          await downloadCloudFighterToLocal(fighter, apiContext, {
            includeArchivedVersions: false,
            includeRawAssets: false,
            allowIncomplete: true,
          });
        }
      } catch (err: any) {
        if (cancelled) return;
        debugWarn('[Gallery] Cloud import skipped:', err?.message ?? err);
      }
      if (cancelled) return;
      [all, allStages] = await Promise.all([
        getAllCachedMetas(ownerScope),
        getAllCachedStageBackgrounds(ownerScope),
      ]);
      if (cancelled) return;
      const finallyMarked = markArcadeManagedMetas(all, globalRoster);
      all = finallyMarked.metas;
      if (finallyMarked.changed.length > 0) {
        try {
          await Promise.all(finallyMarked.changed.map((item) => setCachedMeta(item, ownerScope)));
        } catch (err: any) {
          debugWarn('[Gallery] Global roster identity could not be persisted:', err?.message ?? err);
        }
      }
      if (cancelled) return;
      const visibleVideoFighterIds = new Set([
        ...(activeCloudJob?.creationFlow === 'video' ? [activeCloudJob] : []),
        ...reviewCloudJobs,
        ...resumableCloudJobs.filter((job) => job.creationFlow === 'video'),
      ].map((job) => job.fighterId));
      const filtered = visibleGalleryMetas(
        all.filter((item) => item.version === CACHE_VERSION && (
          item.status === 'ready' || (
            Boolean(item.cloudFighterId) && visibleVideoFighterIds.has(item.cloudFighterId as string)
          )
        )),
        globalRoster,
      ).sort((a, b) => b.createdAt - a.createdAt);
      const filteredStages = allStages
        .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
        .sort((a, b) => b.createdAt - a.createdAt);
      setMetas(filtered);
      setStages(filteredStages);
      reconcileCurrentFighterIndex(filtered);
      setCurrentStageIndex((current) => Math.min(current, Math.max(0, filteredStages.length - 1)));
      const cloudSyncStatus = formatCloudRosterSyncStatus({
        imported: cloudImported,
        updated: cloudUpdated,
        drafts: cloudDrafts,
        failed: cloudFailed,
      });
      setStatus(
        checkoutMessage ??
        (activeCloudJob
          ? `${tierLabel(activeCloudJob.tier)} forge continues safely in the cloud (${activeCloudJob.progressCurrent}/${activeCloudJob.progressTotal})`
          : reviewCloudJobs.some((job) => job.reviewStatus === 'awaiting_review')
            ? 'A video action is paused safely for your review'
          : resumableCloudJobs.length > 0
            ? 'Paid generation work is preserved and ready to resume'
          : cloudSyncStatus ??
          (arcadeFailed
            ? 'Your archive is ready; the global roster could not be loaded'
            : filtered.length > 0 || filteredStages.length > 0 || globalRoster.length > 0
            ? 'Ready'
            : 'No fighters or stages yet')),
      );
      setCloudSyncPending(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [authSessionKey, authStatus]);

  useEffect(() => {
    const requestId = ++assetLoadRequestRef.current;
    if (!meta) {
      setSprites([]);
      setIntro(null);
      return;
    }
    setSprites([]);
    setIntro(null);
    const load = async () => {
      const [nextSprites, nextIntro] = await Promise.all([
        getAllSpritesForHash(meta.photoHash),
        getCachedIntro(meta.photoHash),
      ]);
      if (assetLoadRequestRef.current !== requestId) return;
      setSprites(nextSprites);
      setIntro(nextIntro);
    };
    void load();
    return () => {
      if (assetLoadRequestRef.current === requestId) assetLoadRequestRef.current += 1;
    };
  }, [meta?.photoHash]);

  useEffect(() => {
    setLegalAccepted(false);
  }, [meta?.photoHash]);

  useEffect(() => {
    if (!meta) return;
    setSelection({ kind: 'source', source: defaultSourceForMeta(meta) });
  }, [meta?.photoHash]);

  const previewSprite = useMemo<PreviewSpriteLike | null>(() => {
    if (!meta || selection.kind !== 'animation') return null;
    const cached = sprites.find((item) => item.animationName === selection.animationName);
    if (cached) {
      return {
        blob: cached.pngBlob,
        rawBlob: cached.rawPngBlob,
        animationName: cached.animationName,
        animationFormat: cached.animationFormat,
        frameWidth: cached.frameWidth,
        frameHeight: cached.frameHeight,
        frameCount: cached.frameCount,
        rawFrameWidth: cached.rawFrameWidth,
        rawFrameHeight: cached.rawFrameHeight,
        rawFrameCount: cached.rawFrameCount,
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

  useEffect(() => {
    if (!meta || !isArcadeFighter || selection.kind !== 'animation') return;
    const cached = sprites.find((item) => item.animationName === selection.animationName);
    if (!cached || cached.rawPngBlob) return;
    const fighter = arcadeFighters.find((item) => item.id === meta.cloudFighterId);
    const remote = fighter?.sprites.find((item) => item.animationName === selection.animationName);
    if (!fighter || !remote?.rawUrl) return;

    const requestKey = `${fighter.id}:${selection.animationName}`;
    if (hqPreviewRequestsRef.current.has(requestKey)) return;
    hqPreviewRequestsRef.current.add(requestKey);
    const ownerScope = getActiveSpriteCacheScope();
    const photoHash = meta.photoHash;
    const apiContext = captureApiRequestContext();
    void downloadArcadeSpriteRawToLocal(fighter, selection.animationName, apiContext)
      .then(async (updated) => {
        if (!updated || getActiveSpriteCacheScope() !== ownerScope) return;
        if (selectedPhotoHashRef.current !== photoHash) return;
        setSprites(await getAllSpritesForHash(photoHash, ownerScope));
      })
      .catch((error: any) => {
        debugWarn('[Gallery] HQ Arcade preview skipped:', error?.message ?? error);
      })
      .finally(() => {
        hqPreviewRequestsRef.current.delete(requestKey);
      });
  }, [arcadeFighters, isArcadeFighter, meta, selection, sprites]);

  const previewSourceBlob = useMemo(() => {
    if (!meta || selection.kind !== 'source') return null;
    if (isArcadeFighter && selection.source === 'original') return null;
    return getSourceBlob(meta, selection.source);
  }, [isArcadeFighter, meta, selection]);

  const previewBlob = selection.kind === 'source'
    ? previewSourceBlob
    : previewSprite?.blob ?? null;
  const previewUrl = useObjectUrl(selection.kind === 'source' ? previewSourceBlob : null);
  const introUrl = useObjectUrl(getPrimaryIntroBlob(intro));
  const currentStage = stages[currentStageIndex] ?? null;
  const stagePreviewUrl = useObjectUrl(currentStage?.pngBlob ?? null);

  const safeName = (meta?.characterName || 'fighter').replace(/[^a-z0-9]/gi, '_');
  const selectedAnimName = selection.kind === 'animation' ? selection.animationName : null;
  const currentTier: QualityTier = meta?.qualityTier ?? 'contender';
  const currentAnimationRetryCost = animationRetryCreditCost(currentTier);
  const upgradeOptions = QUALITY_TIERS.filter((item) => tierIndex(item.id) > tierIndex(currentTier));
  const resumableJob = meta?.cloudFighterId
    ? resumableJobs.find((job) => job.fighterId === meta.cloudFighterId) ?? null
    : null;
  const videoReviewJob = meta?.cloudFighterId
    ? videoReviewJobs.find((job) => job.fighterId === meta.cloudFighterId) ?? null
    : null;
  const hasGlobalRoster = arcadeFighters.length > 0;
  const characterEmptyMessage = hasGlobalRoster
    ? 'Choose a global fighter to load it, or forge your own challenger.'
    : status && status !== 'No fighters or stages yet'
      ? status
      : 'Upload a photo to forge your first challenger.';

  useEffect(() => {
  }, [meta?.photoHash, selectedAnimName]);

  const refreshCurrent = async (
    preferredPhotoHash = meta?.photoHash ?? null,
    ownerScope = getActiveSpriteCacheScope(),
  ) => {
    const currentPhotoHash = preferredPhotoHash;
    if (currentPhotoHash) selectedPhotoHashRef.current = currentPhotoHash;
    assetLoadRequestRef.current += 1;
    const [all, allStages, nextSprites, nextIntro] = await Promise.all([
      getAllCachedMetas(ownerScope),
      getAllCachedStageBackgrounds(ownerScope),
      currentPhotoHash ? getAllSpritesForHash(currentPhotoHash, ownerScope) : Promise.resolve([]),
      currentPhotoHash ? getCachedIntro(currentPhotoHash, ownerScope) : Promise.resolve(null),
    ]);
    if (getActiveSpriteCacheScope() !== ownerScope) {
      throw new Error('Fighter cache session changed while loading');
    }
    assetLoadRequestRef.current += 1;
    const filtered = visibleGalleryMetas(
      all.filter((item) => item.version === CACHE_VERSION && item.status === 'ready'),
      arcadeFighters,
    ).sort((a, b) => b.createdAt - a.createdAt);
    const filteredStages = allStages
      .filter((stage) => stage.kind === 'photo' || stage.kind === 'photo-direct')
      .sort((a, b) => b.createdAt - a.createdAt);
    setMetas(filtered);
    setStages(filteredStages);
    reconcileCurrentFighterIndex(filtered);
    setCurrentStageIndex((current) => Math.min(current, Math.max(0, filteredStages.length - 1)));
    setSprites(nextSprites);
    setIntro(nextIntro);
  };

  const selectCachedFighter = (selectedMeta: CachedMeta) => {
    const index = metas.findIndex((item) => item.photoHash === selectedMeta.photoHash);
    if (index < 0) return;
    selectedPhotoHashRef.current = selectedMeta.photoHash;
    assetLoadRequestRef.current += 1;
    setSprites([]);
    setIntro(null);
    setCurrentIndex(index);
    setSelection({ kind: 'source', source: defaultSourceForMeta(selectedMeta) });
  };

  const selectArcadeFighter = async (fighter: CloudFighter) => {
    const ownerScope = getActiveSpriteCacheScope();
    const cached = findCachedArcadeMeta(metas, fighter);
    if (busy) return;
    selectedPhotoHashRef.current = arcadeFighterPhotoHash(fighter);
    if (cached) selectCachedFighter(cached);

    setBusy(true);
    setLoadingArcadeId(fighter.id);
    setStatus(cached
      ? `Checking ${fighter.name} for global roster updates...`
      : `Loading ${fighter.name} from the global roster...`);
    let downloadedReady = false;
    try {
      const apiContext = captureApiRequestContext();
      const prepared = await ensureGalleryArcadeFighterReady(fighter, {
        download: (candidate) => downloadArcadeFighterToLocal(candidate, apiContext, {
          includeHighResolutionAssets: false,
        }),
        getMeta: (hash) => getCachedMeta(hash, ownerScope),
      });
      downloadedReady = true;
      await refreshCurrent(prepared.photoHash, ownerScope);
      setSelection({ kind: 'source', source: 'side' });
      setStatus(`${fighter.name} is ready from the global roster`);
    } catch (err: any) {
      if (!downloadedReady && cached?.photoHash === arcadeFighterPhotoHash(fighter)) {
        try {
          await setCachedMeta(cached, ownerScope);
          await setCloudPlayableSpriteRefs(
            cached.photoHash,
            cached.cloudPlayableSpriteRefs ?? {},
            ownerScope,
          );
          await refreshCurrent(cached.photoHash, ownerScope);
        } catch (restoreError: any) {
          debugWarn('[Gallery] Saved global cache restore skipped:', restoreError?.message ?? restoreError);
        }
      }
      const detail = err?.message ? `: ${err.message}` : '';
      if (getActiveSpriteCacheScope() === ownerScope) {
        setStatus(cached
          ? `${fighter.name} is available from saved assets; update check failed${detail}`
          : `Global fighter could not be loaded${detail}`);
      }
    } finally {
      setLoadingArcadeId(null);
      setBusy(false);
    }
  };

  const monitorCloudGenerationJob = async (
    initial: GenerationJob,
    apiContext: ApiRequestContext,
    signal: AbortSignal,
  ): Promise<GenerationJob> => {
    const target = retryTargetForJob(initial);
    setRetryingTarget(target);
    const completed = await waitForGenerationJob(initial.id, {
      context: apiContext,
      signal,
      onUpdate: (next) => {
        const nextTarget = retryTargetForJob(next);
        setRetryingTarget(nextTarget);
        const label = nextTarget?.kind === 'animation'
          ? animLabel(nextTarget.name)
          : nextTarget?.kind === 'source'
            ? `${nextTarget.key} source`
            : tierLabel(next.tier);
        setStatus(`${label} continues safely in the cloud (${next.progressCurrent}/${next.progressTotal})`);
      },
      onConnectionIssue: () => {
        setStatus('Connection lost. The cloud job is still running; reconnecting...');
      },
    });
    if (completed.status !== 'succeeded') {
      if (completed.creationFlow === 'video' && completed.fullRunRestartRequired) {
        setVideoReviewJobs((current) => [
          completed,
          ...current.filter((job) => job.fighterId !== completed.fighterId),
        ]);
        setResumableJobs((current) => (
          current.filter((job) => job.artifactRunId !== completed.artifactRunId)
        ));
        setStatus('The Video run ended safely. Start a new complete run when you are ready.');
        return completed;
      }
      if (completed.resumable) {
        setResumableJobs((current) => [
          completed,
          ...current.filter((job) => job.artifactRunId !== completed.artifactRunId),
        ]);
      }
      throw new Error(completed.errorMessage ?? 'Generation stopped; review the job details or contact support.');
    }
    if (completed.creationFlow === 'video' && completed.reviewStatus === 'awaiting_review') {
      setVideoReviewJobs((current) => [
        completed,
        ...current.filter((job) => job.fighterId !== completed.fighterId),
      ]);
      setResumableJobs((current) => (
        current.filter((job) => job.artifactRunId !== completed.artifactRunId)
      ));
      setStatus(`${animLabel(completed.targetName ?? 'video')} is paused safely for review`);
      return completed;
    }
    setResumableJobs((current) => (
      current.filter((job) => job.artifactRunId !== completed.artifactRunId)
    ));
    const cloud = await getCloudFighter(completed.fighterId, apiContext);
    if (!cloud?.photoHash) throw new Error('Completed cloud fighter could not be loaded');
    await downloadCloudFighterToLocal(cloud, apiContext);
    await refreshCurrent(cloud.photoHash);
    return completed;
  };

  useEffect(() => {
    if (!recoveryJob) return;
    let disposed = false;
    const apiContext = captureApiRequestContext();
    const controller = new AbortController();
    generationJobAbortRef.current?.abort();
    generationJobAbortRef.current = controller;
    setBusy(true);

    void monitorCloudGenerationJob(recoveryJob, apiContext, controller.signal)
      .then((completed) => {
        if (!disposed) {
          setStatus(
            completed.creationFlow === 'video' && completed.fullRunRestartRequired
              ? 'The Video run ended safely. Start a new complete run when you are ready.'
              : completed.creationFlow === 'video' && completed.reviewStatus === 'awaiting_review'
              ? 'A video action is paused safely for your review'
              : completed.targetName ? 'Done and synced' : `${tierLabel(completed.tier)} cloud forge synced`,
          );
        }
      })
      .catch((err: any) => {
        if (!disposed && !(err instanceof DOMException && err.name === 'AbortError')) {
          setStatus(err?.message ? `Cloud generation failed: ${err.message}` : 'Cloud generation failed');
        }
      })
      .finally(() => {
        if (!disposed) {
          setBusy(false);
          setRetryingTarget(null);
          setRecoveryJob(null);
        }
      });

    return () => {
      disposed = true;
      controller.abort();
      if (generationJobAbortRef.current === controller) generationJobAbortRef.current = null;
    };
  }, [recoveryJob?.id]);

  const resumeCloudGeneration = async (failedJob: GenerationJob) => {
    if (cloudSyncPending) return;
    if (!legalAccepted) {
      setStatus('Accept the generation terms to resume preserved work');
      return;
    }
    clearDebugLog();
    setBusy(true);
    setStatus(`Restoring ${failedJob.preservedArtifactCount} completed stages without charging credits...`);
    const apiContext = captureApiRequestContext();
    let purchaseId: string | undefined;
    let backendOwnsPurchase = false;
    try {
      const creationFlow = creationFlowForResume(failedJob.creationFlow);
      const authorization = await authorizeGeneration(
        failedJob.tier,
        failedJob.operation,
        failedJob.fighterId,
        null,
        currentGenerationLegalAttestation(),
        apiContext,
        failedJob.id,
        creationFlow,
      );
      if (
        !authorization.authorized ||
        authorization.mode !== 'continuation' ||
        !authorization.purchaseId ||
        !authorization.providerSessionId
      ) {
        throw new Error(authorization.error ?? 'Preserved generation could not be resumed');
      }
      purchaseId = authorization.purchaseId;
      assertCreationFlowAcknowledged(creationFlow, authorization.creationFlow);
      const job = await startGenerationJob({
        fighterId: failedJob.fighterId,
        purchaseId: authorization.purchaseId,
        providerSessionId: authorization.providerSessionId,
        creationFlow,
        targetKind: failedJob.targetKind ?? undefined,
        targetName: failedJob.targetName ?? undefined,
      }, apiContext);
      backendOwnsPurchase = true;
      const controller = new AbortController();
      generationJobAbortRef.current?.abort();
      generationJobAbortRef.current = controller;
      const completed = await monitorCloudGenerationJob(job, apiContext, controller.signal);
      setStatus(completed.targetName ? 'Done and synced' : `${tierLabel(completed.tier)} upgrade synced`);
    } catch (err: any) {
      if (purchaseId && !backendOwnsPurchase) {
        try {
          await finishGenerationPurchase(purchaseId, false, failedJob.fighterId, apiContext);
        } catch (releaseErr: any) {
          debugWarn('[Billing] Failed to release resume authorization:', releaseErr?.message ?? releaseErr);
        }
      }
      setStatus(err?.message ? `Resume failed: ${err.message}` : 'Resume failed');
    } finally {
      setBusy(false);
      setRetryingTarget(null);
    }
  };

  const continueApprovedVideoJob = async (approvedJob: GenerationJob) => {
    if (cloudSyncPending) return;
    if (!legalAccepted) {
      setStatus('Accept the generation terms to continue the video flow');
      return;
    }
    setBusy(true);
    setStatus('Preparing the next video action without charging more credits...');
    const apiContext = captureApiRequestContext();
    let purchaseId: string | undefined;
    let backendOwnsPurchase = false;
    try {
      const authorization = await authorizeGeneration(
        approvedJob.tier,
        approvedJob.operation,
        approvedJob.fighterId,
        null,
        currentGenerationLegalAttestation(),
        apiContext,
        approvedJob.id,
        'video',
      );
      if (
        !authorization.authorized || authorization.mode !== 'continuation' ||
        !authorization.purchaseId || !authorization.providerSessionId
      ) {
        throw new Error(authorization.error ?? 'The next video action could not be authorized');
      }
      purchaseId = authorization.purchaseId;
      assertCreationFlowAcknowledged('video', authorization.creationFlow);
      const nextJob = await startGenerationJob({
        fighterId: approvedJob.fighterId,
        purchaseId: authorization.purchaseId,
        providerSessionId: authorization.providerSessionId,
        creationFlow: 'video',
      }, apiContext);
      backendOwnsPurchase = true;
      setVideoReviewJobs((current) => current.filter((job) => job.id !== approvedJob.id));
      const controller = new AbortController();
      generationJobAbortRef.current?.abort();
      generationJobAbortRef.current = controller;
      await monitorCloudGenerationJob(nextJob, apiContext, controller.signal);
    } catch (cause) {
      if (purchaseId && !backendOwnsPurchase) {
        try {
          await finishGenerationPurchase(purchaseId, false, approvedJob.fighterId, apiContext);
        } catch (settlementError: any) {
          debugWarn(
            '[Billing] Video continuation could not be released:',
            settlementError?.message ?? settlementError,
          );
        }
      }
      setStatus(cause instanceof Error ? `Video continuation failed: ${cause.message}` : 'Video continuation failed');
    } finally {
      setBusy(false);
      setRetryingTarget(null);
    }
  };

  const restartRejectedVideoRun = (rejectedJob: GenerationJob) => {
    if (cloudSyncPending) return;
    if (!legalAccepted) {
      setStatus('Accept the generation terms to start a new complete Video run');
      return;
    }
    const creditCost = QUALITY_TIERS.find((item) => item.id === rejectedJob.tier)?.creditCost ?? 18;
    setConfirmRequest({
      title: 'New Complete Video Run',
      body: `Start a new complete Video run for ${creditCost} credits? The rejected run stays archived and will not be reused.`,
      confirmLabel: `Start Run · ${creditCost} credits`,
      variant: 'primary',
      onConfirm: () => {
        setConfirmRequest(null);
        void executeRestartRejectedVideoRun(rejectedJob);
      },
    });
  };

  const executeRestartRejectedVideoRun = async (rejectedJob: GenerationJob) => {
    setBusy(true);
    setStatus('Preparing a new complete Video run...');
    const apiContext = captureApiRequestContext();
    let purchaseId: string | undefined;
    let backendOwnsPurchase = false;
    try {
      const authorization = await authorizeGeneration(
        rejectedJob.tier,
        'fighter_generation',
        rejectedJob.fighterId,
        null,
        currentGenerationLegalAttestation(),
        apiContext,
        null,
        'video',
      );
      if (!authorization.authorized || !authorization.purchaseId || !authorization.providerSessionId) {
        throw new Error(authorization.error ?? 'A new complete Video run could not be authorized');
      }
      purchaseId = authorization.purchaseId;
      assertCreationFlowAcknowledged('video', authorization.creationFlow);
      const nextJob = await startGenerationJob({
        fighterId: rejectedJob.fighterId,
        purchaseId: authorization.purchaseId,
        providerSessionId: authorization.providerSessionId,
        creationFlow: 'video',
      }, apiContext);
      backendOwnsPurchase = true;
      setVideoReviewJobs((current) => current.filter((job) => job.id !== rejectedJob.id));
      const controller = new AbortController();
      generationJobAbortRef.current?.abort();
      generationJobAbortRef.current = controller;
      await monitorCloudGenerationJob(nextJob, apiContext, controller.signal);
    } catch (cause) {
      if (purchaseId && !backendOwnsPurchase) {
        try {
          await finishGenerationPurchase(purchaseId, false, rejectedJob.fighterId, apiContext);
        } catch (settlementError: any) {
          debugWarn(
            '[Billing] New Video run reservation could not be released:',
            settlementError?.message ?? settlementError,
          );
        }
      }
      setStatus(cause instanceof Error ? `New Video run failed: ${cause.message}` : 'New Video run failed');
    } finally {
      setBusy(false);
      setRetryingTarget(null);
    }
  };

  const finishApprovedVideoFighter = async (approvedJob: GenerationJob) => {
    if (cloudSyncPending) return;
    setBusy(true);
    setStatus('All video actions approved. Syncing your private fighter...');
    const apiContext = captureApiRequestContext();
    try {
      const cloud = await getCloudFighter(approvedJob.fighterId, apiContext);
      if (!cloud?.photoHash) throw new Error('Approved cloud fighter could not be loaded');
      await downloadCloudFighterToLocal(cloud, apiContext);
      await refreshCurrent(cloud.photoHash);
      setVideoReviewJobs((current) => current.filter((job) => job.fighterId !== approvedJob.fighterId));
      setStatus('All video actions approved, private, and synced');
    } catch (cause) {
      setStatus(cause instanceof Error ? `Approved fighter sync failed: ${cause.message}` : 'Approved fighter sync failed');
    } finally {
      setBusy(false);
    }
  };

  const runRetry = (
    action: (context: ApiRequestContext) => Promise<void>,
    nextStatus: string,
    target: RetryTarget,
    operation: GenerationBillingOperation,
    creditCost: number,
  ) => {
    if (!meta || !ownerActionsReady) return;
    if (!legalAccepted) {
      setStatus('Accept the generation terms to continue');
      return;
    }
    const retryLabel = target.kind === 'animation' ? animLabel(target.name) : `${target.key} source`;
    const creditLabel = creditCost === 1 ? 'credit' : 'credits';
    setConfirmRequest({
      title: `Regenerate ${retryLabel}`,
      body: `Regenerate ${retryLabel} for ${creditCost} ${creditLabel}? Existing versions will be kept.`,
      confirmLabel: `Regenerate · ${creditCost} ${creditLabel}`,
      variant: 'primary',
      onConfirm: () => {
        setConfirmRequest(null);
        void executeRetry(action, nextStatus, target, operation);
      },
    });
  };

  const executeRetry = async (
    action: (context: ApiRequestContext) => Promise<void>,
    nextStatus: string,
    target: RetryTarget,
    operation: GenerationBillingOperation,
  ) => {
    if (!meta || !ownerActionsReady) return;
    clearDebugLog();
    setBusy(true);
    setRetryingTarget(target);
    setStatus(nextStatus);
    let purchaseId: string | undefined;
    let purchaseCommitted = false;
    let backendOwnsPurchase = false;
    let generatedLocally = false;
    const apiContext = captureApiRequestContext();
    try {
      let fighterId = meta.cloudFighterId ?? null;
      if (authStatus === 'signed-in' && !fighterId) {
        const sync = await syncFighterToCloud(meta, sprites, intro, apiContext);
        if (sync.status !== 'synced' || !sync.fighterId) {
          throw new Error(sync.message ?? 'Sync this fighter before retrying');
        }
        fighterId = sync.fighterId;
      }
      const authorization = await authorizeGeneration(
        currentTier,
        operation,
        fighterId,
        null,
        currentGenerationLegalAttestation(),
        apiContext,
        null,
        'original',
      );
      if (!authorization.authorized) {
        throw new Error(authorization.error ?? 'Generation not authorized');
      }
      purchaseId = authorization.purchaseId;
      assertCreationFlowAcknowledged('original', authorization.creationFlow);
      if (
        authStatus === 'signed-in' &&
        fighterId &&
        authorization.purchaseId &&
        authorization.providerSessionId
      ) {
        const job = await startGenerationJob({
          fighterId,
          purchaseId: authorization.purchaseId,
          providerSessionId: authorization.providerSessionId,
          creationFlow: 'original',
          targetKind: target.kind,
          targetName: target.kind === 'animation' ? target.name : target.key,
        }, apiContext);
        backendOwnsPurchase = true;
        const controller = new AbortController();
        generationJobAbortRef.current?.abort();
        generationJobAbortRef.current = controller;
        const completed = await monitorCloudGenerationJob(job, apiContext, controller.signal);
        setStatus(
          completed.creationFlow === 'video' && completed.reviewStatus === 'awaiting_review'
            ? 'A video action is paused safely for your review'
            : 'Done and synced',
        );
        return;
      }
      await runWithProviderSession(authorization.providerSessionId, action, apiContext);
      generatedLocally = true;
      await finishGenerationPurchase(purchaseId, true, meta.cloudFighterId ?? null, apiContext);
      purchaseCommitted = true;
      const [updatedMeta, updatedSprites] = await Promise.all([
        getCachedMeta(meta.photoHash),
        getAllSpritesForHash(meta.photoHash),
      ]);
      if (!updatedMeta) throw new Error('Regenerated fighter could not be reloaded');
      const sync = await syncFighterToCloud(updatedMeta, updatedSprites, intro, apiContext);
      if (sync.status !== 'synced') {
        throw new Error(sync.message ?? 'cloud sync did not complete');
      }
      await refreshCurrent();
      setStatus('Done and synced');
    } catch (err: any) {
      if (purchaseId && !purchaseCommitted && !backendOwnsPurchase) {
        try {
          await finishGenerationPurchase(purchaseId, false, meta?.cloudFighterId ?? null, apiContext);
        } catch (releaseErr: any) {
          debugWarn('[Billing] Failed to release retry purchase:', releaseErr?.message ?? releaseErr);
        }
      }
      await refreshCurrent();
      const detail = err?.message ? String(err.message) : 'unknown error';
      setStatus(generatedLocally
        ? `Generated locally; cloud sync failed: ${detail}`
        : `Failed: ${detail}`);
    } finally {
      setBusy(false);
      setRetryingTarget(null);
    }
  };

  const retryingAnim = retryingTarget?.kind === 'animation' ? retryingTarget.name : null;
  const retryingSource = retryingTarget?.kind === 'source' ? retryingTarget.key : null;

  const hasOutdatedSprites = sprites.some((sprite) => (sprite.processingVersion ?? 0) < SPRITE_PROCESSING_VERSION);

  const renameFighter = () => {
    if (!meta || !ownerActionsReady) return;
    setRenameDraft(meta.characterName);
    setRenameRequest({ kind: 'fighter', current: meta.characterName });
  };

  const executeRenameFighter = async (nextName: string) => {
    if (!meta || !ownerActionsReady) return;
    if (!nextName.trim() || nextName.trim() === meta.characterName) return;
    const trimmedName = nextName.trim();
    setBusy(true);
    setStatus('Renaming...');
    const apiContext = captureApiRequestContext();
    try {
      await renameCharacter(meta.photoHash, trimmedName);
      let cloudRenamed = false;
      if (meta.cloudFighterId) {
        const updated = await renameCloudFighter(meta.cloudFighterId, trimmedName, apiContext);
        cloudRenamed = Boolean(updated);
      }
      await refreshCurrent();
      setStatus(meta.cloudFighterId && !cloudRenamed ? 'Fighter renamed locally; cloud update skipped' : 'Fighter renamed');
    } catch (err: any) {
      setStatus(err?.message ? `Rename failed: ${err.message}` : 'Rename failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteFighter = () => {
    if (!meta || !ownerActionsReady) return;
    setConfirmRequest({
      title: `Delete ${meta.characterName}`,
      body: `Delete "${meta.characterName}"? This wipes sprites, intro video, and metadata. Cannot be undone.`,
      confirmLabel: 'Delete Fighter',
      variant: 'danger',
      onConfirm: () => {
        setConfirmRequest(null);
        void executeDeleteFighter();
      },
    });
  };

  const executeDeleteFighter = async () => {
    if (!meta || !ownerActionsReady) return;
    const removedHash = meta.photoHash;
    setBusy(true);
    setStatus(`Deleting ${meta.characterName}...`);
    const apiContext = captureApiRequestContext();
    try {
      let cloudDeleteStatus: 'synced' | 'signed_out' | 'failed' | null = null;
      if (meta.cloudFighterId) {
        const cloudDelete = await deleteCloudFighter(meta.cloudFighterId, apiContext);
        cloudDeleteStatus = cloudDelete.status;
        if (cloudDelete.status === 'failed') {
          throw new Error(cloudDelete.message ?? 'Cloud delete failed');
        }
      }
      await deleteCharacter(removedHash);
      const nextMetas = metas.filter((item) => item.photoHash !== removedHash);
      setMetas(nextMetas);
      const nextIndex = Math.min(currentIndex, Math.max(0, nextMetas.length - 1));
      selectedPhotoHashRef.current = nextMetas[nextIndex]?.photoHash ?? null;
      setCurrentIndex(nextIndex);
      setSprites([]);
      setIntro(null);
      setSelection({ kind: 'source', source: 'original' });
      setStatus(
        cloudDeleteStatus === 'signed_out'
          ? 'Fighter deleted locally; sign in to delete cloud copy'
          : nextMetas.length > 0 ? 'Fighter deleted' : 'No fighters left',
      );
    } catch (err: any) {
      setStatus(err?.message ? `Delete failed: ${err.message}` : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const rebuildHd = () => {
    if (!meta || !ownerActionsReady) return;
    setConfirmRequest({
      title: 'Rebuild HD',
      body: `Rebuild all sprites for "${meta.characterName}" at HD resolution for free? Animations without a cached raw blob will be skipped.`,
      confirmLabel: 'Rebuild HD · Free',
      variant: 'primary',
      onConfirm: () => {
        setConfirmRequest(null);
        void executeRebuildHd();
      },
    });
  };

  const executeRebuildHd = async () => {
    if (!meta || !ownerActionsReady) return;
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
        ...(!isArcadeFighter
          ? [['original', meta.originalPhotoBlob] as [string, Blob | null | undefined]]
          : []),
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

  const syncCloud = async () => {
    if (!meta || !ownerActionsReady) return;
    setBusy(true);
    setStatus('Syncing cloud roster...');
    const apiContext = captureApiRequestContext();
    try {
      const result = await syncFighterToCloud(meta, sprites, intro, apiContext);
      if (result.status === 'synced') {
        setStatus('Cloud synced');
        await refreshCurrent();
      } else if (result.status === 'signed_out') {
        setStatus('Sign in to sync across devices');
      } else {
        setStatus(result.message ? `Cloud sync failed: ${result.message}` : 'Cloud sync failed');
      }
    } catch (err: any) {
      setStatus(err?.message ? `Cloud sync failed: ${err.message}` : 'Cloud sync failed');
    } finally {
      setBusy(false);
    }
  };

  const togglePublic = async () => {
    if (!meta || !ownerActionsReady) return;
    setBusy(true);
    const nextPublic = !meta.cloudPublic;
    setStatus(nextPublic ? 'Publishing fighter...' : 'Making fighter private...');
    const apiContext = captureApiRequestContext();
    try {
      let fighterId = meta.cloudFighterId ?? null;
      if (!fighterId) {
        const sync = await syncFighterToCloud(meta, sprites, intro, apiContext);
        if (sync.status !== 'synced' || !sync.fighterId) {
          setStatus(sync.status === 'signed_out' ? 'Sign in to publish fighters' : `Publish failed: ${sync.message ?? 'cloud sync failed'}`);
          return;
        }
        fighterId = sync.fighterId;
      }
      const updated = await setCloudFighterPublic(fighterId, nextPublic, apiContext);
      if (!updated) {
        setStatus('Sign in to publish fighters');
        return;
      }
      const latestMeta = await getCachedMeta(meta.photoHash);
      if (latestMeta) {
        latestMeta.cloudFighterId = updated.id;
        latestMeta.cloudPublic = updated.public;
        latestMeta.updatedAt = Date.now();
        await setCachedMeta(latestMeta);
      }
      await refreshCurrent();
      setStatus(updated.public ? 'Published to Community' : 'Private again');
    } catch (err: any) {
      setStatus(err?.message ? `Publish failed: ${err.message}` : 'Publish failed');
    } finally {
      setBusy(false);
    }
  };

  const sharePublishedFighter = async () => {
    if (!ownerActionsReady) return;
    if (!meta?.cloudFighterId) {
      setStatus('Sync cloud before sharing this fighter');
      return;
    }
    const share = await shareCommunityFighter(meta.cloudFighterId, meta.characterName);
    if (share.mode === 'native') {
      setStatus('Community share sheet opened');
    } else if (share.mode === 'clipboard') {
      setStatus('Community share link copied');
    } else if (share.mode === 'cancelled') {
      setStatus('Community share cancelled');
    } else {
      setShareLinkUrl(share.url);
      setStatus('Community share link ready');
    }
  };

  const upgradeToTier = async (toTier: QualityTier) => {
    if (!meta || !ownerActionsReady || !legalAccepted) return;
    const tier = QUALITY_TIERS.find((item) => item.id === toTier);
    if (!tier) return;
    clearDebugLog();
    setBusy(true);
    setStatus(`Upgrading to ${tier.label}...`);
    let purchaseId: string | undefined;
    let purchaseCommitted = false;
    let backendOwnsPurchase = false;
    const apiContext = captureApiRequestContext();
    try {
      let fighterId = meta.cloudFighterId ?? null;
      if (authStatus === 'signed-in' && !fighterId) {
        const sync = await syncFighterToCloud(meta, sprites, intro, apiContext);
        if (sync.status !== 'synced' || !sync.fighterId) {
          throw new Error(sync.message ?? 'Sync this fighter before upgrading');
        }
        fighterId = sync.fighterId;
      }
      const authorization = await authorizeGeneration(
        toTier,
        'fighter_upgrade',
        fighterId,
        null,
        currentGenerationLegalAttestation(),
        apiContext,
      );
      if (!authorization.authorized) {
        throw new Error(authorization.error ?? 'Upgrade not authorized');
      }
      purchaseId = authorization.purchaseId;
      if (
        authStatus === 'signed-in' &&
        fighterId &&
        authorization.purchaseId &&
        authorization.providerSessionId
      ) {
        const job = await startGenerationJob({
          fighterId,
          purchaseId: authorization.purchaseId,
          providerSessionId: authorization.providerSessionId,
        }, apiContext);
        backendOwnsPurchase = true;
        setStatus(`${tierLabel(job.tier)} forge running in the cloud (${job.progressCurrent}/${job.progressTotal})...`);
        const controller = new AbortController();
        generationJobAbortRef.current?.abort();
        generationJobAbortRef.current = controller;
        const completed = await waitForGenerationJob(job.id, {
          context: apiContext,
          signal: controller.signal,
          onUpdate: (next) => {
            const animation = next.stage.startsWith('sprite:')
              ? next.stage.slice('sprite:'.length)
              : null;
            setRetryingTarget(animation ? { kind: 'animation', name: animation } : null);
            setStatus(
              animation
                ? `Upgrading ${animLabel(animation)} (${next.progressCurrent}/${next.progressTotal})...`
                : `${tierLabel(next.tier)} forge ${next.stage} (${next.progressCurrent}/${next.progressTotal})...`,
            );
          },
          onConnectionIssue: () => {
            setStatus('Connection lost. The cloud upgrade is still running; reconnecting...');
          },
        });
        if (completed.status !== 'succeeded') {
          throw new Error(completed.errorMessage ?? 'Upgrade stopped; review the job details or contact support.');
        }
        const cloud = await getCloudFighter(fighterId, apiContext);
        if (!cloud) throw new Error('Completed cloud fighter could not be loaded');
        await downloadCloudFighterToLocal(cloud, apiContext);
        await refreshCurrent();
        setStatus(`${tierLabel(completed.tier)} upgrade synced`);
        return;
      }
      await runWithProviderSession(
        authorization.providerSessionId,
        (providerContext) => upgradeFighter(meta.photoHash, toTier, (progress) => {
          if (progress.stage === 'generating_sprites') {
            setStatus(`Upgrading ${progress.animation} (${progress.current}/${progress.total})...`);
            setRetryingTarget({ kind: 'animation', name: progress.animation });
          }
          if (progress.stage === 'sprite_ready') {
            setRetryingTarget(null);
          }
        }, providerContext),
        apiContext,
      );
      await finishGenerationPurchase(purchaseId, true, meta.cloudFighterId ?? null, apiContext);
      purchaseCommitted = true;
      const [updatedMeta, updatedSprites] = await Promise.all([
        getCachedMeta(meta.photoHash),
        getAllSpritesForHash(meta.photoHash),
      ]);
      if (updatedMeta) {
        const sync = await syncFighterToCloud(updatedMeta, updatedSprites, intro, apiContext);
        if (sync.status === 'synced') {
          await finishGenerationPurchase(purchaseId, true, sync.fighterId ?? meta.cloudFighterId ?? null, apiContext);
        }
      }
      await refreshCurrent();
      setStatus(`${tier.label} upgrade synced`);
    } catch (err: any) {
      if (purchaseId && !purchaseCommitted && !backendOwnsPurchase) {
        try {
          await finishGenerationPurchase(purchaseId, false, meta.cloudFighterId ?? null, apiContext);
        } catch (releaseErr: any) {
          debugWarn('[Billing] Failed to release upgrade purchase:', releaseErr?.message ?? releaseErr);
        }
      }
      await refreshCurrent();
      setStatus(err?.message ? `Upgrade failed: ${err.message}` : 'Upgrade failed');
    } finally {
      setBusy(false);
      setRetryingTarget(null);
    }
  };

  const renameStage = () => {
    if (!currentStage) return;
    setRenameDraft(currentStage.label ?? 'PHOTO STAGE');
    setRenameRequest({ kind: 'stage', current: currentStage.label ?? 'PHOTO STAGE' });
  };

  const executeRenameStage = async (nextName: string) => {
    if (!currentStage) return;
    if (!nextName.trim()) return;
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

  const deleteStage = () => {
    if (!currentStage) return;
    setConfirmRequest({
      title: 'Delete Stage',
      body: `Delete stage "${currentStage.label ?? 'PHOTO STAGE'}"?`,
      confirmLabel: 'Delete Stage',
      variant: 'danger',
      onConfirm: () => {
        setConfirmRequest(null);
        void executeDeleteStage();
      },
    });
  };

  const executeDeleteStage = async () => {
    if (!currentStage) return;
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
          <h1>Training Room</h1>
          <Button onClick={onBack}>Back</Button>
        </div>

        <div className="gallery-tab-row">
          <button
            type="button"
            className={`gallery-tab${activeTab === 'characters' ? ' is-active' : ''}`}
            aria-pressed={activeTab === 'characters'}
            onClick={() => setActiveTab('characters')}
          >
            Characters
          </button>
          <button
            type="button"
            className={`gallery-tab${activeTab === 'stages' ? ' is-active' : ''}`}
            aria-pressed={activeTab === 'stages'}
            onClick={() => setActiveTab('stages')}
          >
            Stages
          </button>
        </div>

        <button type="button" className="home-menu__action is-primary" onClick={onCreateFighter}>
          <span>New Fighter</span>
          <small>Upload A Photo</small>
        </button>

        {activeTab === 'characters' ? (
          <GalleryFighterList
            metas={metas}
            arcadeFighters={arcadeFighters}
            selectedPhotoHash={meta?.photoHash ?? null}
            loadingArcadeId={loadingArcadeId}
            disabled={busy || arcadeState === 'loading'}
            arcadeState={arcadeState}
            onSelectMeta={selectCachedFighter}
            onSelectArcade={(fighter) => void selectArcadeFighter(fighter)}
          />
        ) : (
          <div className="gallery-sidebar__list">
            {stages.map((stage, index) => (
              <button
                type="button"
                key={stage.stageKey}
                className={`gallery-fighter-card${index === currentStageIndex ? ' is-active' : ''}`}
                aria-pressed={index === currentStageIndex}
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
            <h2>{hasGlobalRoster ? 'Choose a Fighter' : 'No Fighters Yet'}</h2>
            <p>{characterEmptyMessage}</p>
            {hasGlobalRoster && status !== 'Ready' ? (
              <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
            ) : null}
            <button type="button" className="home-menu__action is-primary" onClick={onCreateFighter}>
              <span>Forge Fighter</span>
              <small>Start The Pipeline</small>
            </button>
          </section>
        ) : (
          <>
            <header className="gallery-hero">
              <div>
                <h2>
                  {meta.characterName}
                  <TierBadge tier={currentTier} className="gallery-hero__badge" />
                </h2>
                <p className="gallery-hero__meta">
                  {isArcadeFighter
                    ? `Global roster · ${meta.animationsReady.length} animations ready`
                    : `Your fighter · Status ${meta.status} · Created ${formatDate(meta.createdAt)}`}
                </p>
              </div>
              <div className="roster-hero__actions">
                <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
                <div className="asf-toolbar">
                  {ownerActionsReady && resumableJob ? (
                    <Button
                      disabled={busy || !legalAccepted}
                      onClick={() => void resumeCloudGeneration(resumableJob)}
                    >
                      Resume Preserved Work · Free
                    </Button>
                  ) : null}
                  {ownerActionsReady ? upgradeOptions.map((tier, index) => (
                    <Button
                      key={tier.id}
                      variant={index === 0 ? 'primary' : 'secondary'}
                      disabled={busy || !legalAccepted}
                      onClick={() => setPendingUpgradeTier(tier.id)}
                    >
                      Upgrade to {tier.label} · {tier.priceLabel}
                    </Button>
                  )) : null}
                  {ownerActionsReady && hasOutdatedSprites ? (
                    <Button disabled={busy} onClick={() => rebuildHd()}>
                      Rebuild HD · Free
                    </Button>
                  ) : null}
                  {ownerActionsReady ? (
                    <>
                      <Button disabled={busy} onClick={() => void syncCloud()}>
                        Sync Cloud
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          if (meta.cloudPublic) void togglePublic();
                          else setPublishConfirmOpen(true);
                        }}
                      >
                        {meta.cloudPublic ? 'Unpublish' : 'Publish'}
                      </Button>
                      {meta.cloudPublic && meta.cloudFighterId ? (
                        <Button variant="ghost" disabled={busy} onClick={() => void sharePublishedFighter()}>
                          Share Link
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  <Button variant="ghost" disabled={busy} onClick={() => void saveAll()}>
                    Save All
                  </Button>
                  {ownerActionsReady ? (
                    <>
                      <Button variant="ghost" disabled={busy} onClick={() => renameFighter()}>
                        Rename
                      </Button>
                      <Button variant="danger" disabled={busy} onClick={() => deleteFighter()}>
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </header>

            {!isArcadeFighter ? (
              <GenerationConsent
                checked={legalAccepted}
                disabled={busy}
                onChange={setLegalAccepted}
                onNavigate={onNavigateLegal}
              />
            ) : null}

            {ownerActionsReady && videoReviewJob ? (
              <VideoGenerationReviewGate
                jobId={videoReviewJob.id}
                disabled={busy}
                fullRunRestartRequired={videoReviewJob.fullRunRestartRequired}
                onContinue={() => continueApprovedVideoJob(videoReviewJob)}
                onFinalApproval={() => finishApprovedVideoFighter(videoReviewJob)}
                onRestart={() => restartRejectedVideoRun(videoReviewJob)}
                onRejected={() => {
                  setStatus('Video rejected. It remains private and no additional provider call was made.');
                }}
              />
            ) : null}

            <section className="gallery-layout">
              <div className="gallery-column--side">
                <div className="gallery-panel gallery-panel--sources">
                  <SourceViewsPanel
                    meta={meta}
                    selectedSource={selection.kind === 'source' ? selection.source : null}
                    onSelectSource={(source) => setSelection({ kind: 'source', source })}
                    regeneratingSource={retryingSource}
                    retryCreditCost={SOURCE_RETRY_CREDIT_COST}
                    onRetry={!ownerActionsReady ? undefined : {
                      side: () => runRetry(
                        (context) => retrySideView(meta.photoHash, () => {}, context),
                        'Retrying side view...',
                        { kind: 'source', key: 'side' },
                        'fighter_retry_source',
                        SOURCE_RETRY_CREDIT_COST,
                      ),
                      upright: () => runRetry(
                        (context) => retryUprightView(meta.photoHash, () => {}, context),
                        'Retrying upright...',
                        { kind: 'source', key: 'upright' },
                        'fighter_retry_source',
                        SOURCE_RETRY_CREDIT_COST,
                      ),
                      crouch: () => runRetry(
                        (context) => retryCrouchView(meta.photoHash, () => {}, context),
                        'Retrying crouch...',
                        { kind: 'source', key: 'crouch' },
                        'fighter_retry_source',
                        SOURCE_RETRY_CREDIT_COST,
                      ),
                    }}
                    busy={busy || !legalAccepted}
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
                  {!isArcadeFighter ? <DebugFeed /> : null}
                </div>
              </div>

              <div className="gallery-panel gallery-panel--preview">
                <div className="gallery-preview__header">
                  <div>
                    <h3>
                      {selection.kind === 'source'
                        ? selection.source === 'original' && isArcadeFighter
                          ? 'PRIVATE REFERENCE'
                          : selection.source.toUpperCase()
                        : animLabel(selection.animationName)}
                    </h3>
                  </div>
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
                    emptyLabel={selection.kind === 'source'
                      ? selection.source === 'original' && isArcadeFighter
                        ? 'Original reference is private'
                        : 'Missing source'
                      : 'No preview for this animation yet'}
                  />
                </div>

                <div className="gallery-actions">
                  {previewBlob ? (
                    <button type="button" onClick={() => downloadBlob(previewBlob, `${safeName}_${selection.kind === 'source' ? selection.source : selection.animationName}.png`)}>
                      Save PNG
                    </button>
                  ) : null}
                  {selectedAnimName && sprites.some((item) => item.animationName === selectedAnimName) ? (
                    <button type="button" disabled={busy} onClick={() => void saveGif()}>
                      Save GIF
                    </button>
                  ) : null}
                  {previewSprite?.rawBlob && !isArcadeFighter ? (
                    <button type="button" onClick={() => downloadBlob(previewSprite.rawBlob!, `${safeName}_${selectedAnimName}_RAW.png`)}>
                      Save RAW
                    </button>
                  ) : null}
                  {selectedAnimName && ownerActionsReady ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runRetry(
                          (context) => retryAnimation(meta.photoHash, selectedAnimName, () => {}, {
                            tier: currentTier,
                            apiContext: context,
                          }),
                          `Retrying ${selectedAnimName} (${tierLabel(currentTier)})...`,
                          { kind: 'animation', name: selectedAnimName },
                          'fighter_retry_animation',
                          currentAnimationRetryCost,
                        )
                      }
                    >
                      Retry Animation ·{' '}
                      {currentAnimationRetryCost}{' '}
                      {currentAnimationRetryCost === 1 ? 'credit' : 'credits'}
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
                <h2>{(currentStage.label ?? 'PHOTO STAGE').toUpperCase()}</h2>
                <p className="gallery-hero__meta">
                  Stage {currentStageIndex + 1} of {stages.length} · Created {formatDate(currentStage.createdAt)} · Kind {currentStage.kind ?? 'photo'}
                </p>
              </div>
              <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
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
                  <button type="button" disabled={!currentStage.pngBlob} onClick={() => downloadBlob(currentStage.pngBlob, `${((currentStage.label ?? 'photo_stage').toLowerCase().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')) || 'photo_stage'}.png`)}>
                    Save PNG
                  </button>
                  <button type="button" disabled={busy} onClick={() => renameStage()}>
                    Rename
                  </button>
                  <button type="button" disabled={busy} onClick={() => deleteStage()}>
                    Delete
                  </button>
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      {pendingUpgrade ? (
        <ConfirmDialog
          title={`Upgrade to ${pendingUpgrade.label}`}
          confirmLabel={`Regenerate for ${pendingUpgrade.priceLabel}`}
          confirmVariant="primary"
          onCancel={() => setPendingUpgradeTier(null)}
          onConfirm={() => {
            const tier = pendingUpgrade.id;
            setPendingUpgradeTier(null);
            void upgradeToTier(tier);
          }}
        >
          Regenerate all 11 animations at {pendingUpgrade.label} quality. This costs{' '}
          {pendingUpgrade.priceLabel} and takes about {pendingUpgrade.estimatedTime}. Existing
          animations are kept in cache and remain accessible.
        </ConfirmDialog>
      ) : null}

      {publishConfirmOpen && meta ? (
        <ConfirmDialog
          title={`Publish ${meta.characterName}?`}
          confirmLabel="Publish Fighter"
          cancelLabel="Keep Private"
          confirmVariant="primary"
          onCancel={() => setPublishConfirmOpen(false)}
          onConfirm={() => {
            setPublishConfirmOpen(false);
            void togglePublic();
          }}
        >
          This makes the fighter name, tier, clean generated source views, and playable
          animations public under the neutral author label Player. Your account name, email,
          Clerk profile photo, original photo, RAW intermediates, private hashes, and
          generation history stay private. You can unpublish at any time.
        </ConfirmDialog>
      ) : null}

      {confirmRequest ? (
        <ConfirmDialog
          title={confirmRequest.title}
          confirmLabel={confirmRequest.confirmLabel}
          confirmVariant={confirmRequest.variant ?? 'primary'}
          onCancel={() => setConfirmRequest(null)}
          onConfirm={confirmRequest.onConfirm}
        >
          {confirmRequest.body}
        </ConfirmDialog>
      ) : null}

      {renameRequest ? (
        <Modal
          title={renameRequest.kind === 'fighter' ? 'Rename Fighter' : 'Rename Stage'}
          onClose={() => setRenameRequest(null)}
        >
          <form
            className="asf-modal__form"
            onSubmit={(event) => {
              event.preventDefault();
              const request = renameRequest;
              setRenameRequest(null);
              if (request.kind === 'fighter') void executeRenameFighter(renameDraft);
              else void executeRenameStage(renameDraft);
            }}
          >
            <label className="create-form__field">
              <span>{renameRequest.kind === 'fighter' ? 'Fighter Name' : 'Stage Name'}</span>
              <input
                type="text"
                value={renameDraft}
                maxLength={48}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
            </label>
            <div className="asf-modal__actions">
              <Button onClick={() => setRenameRequest(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={!renameDraft.trim()}>
                Save Name
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {shareLinkUrl ? (
        <Modal title="Share Fighter Link" onClose={() => setShareLinkUrl(null)}>
          <p className="asf-modal__copy">Copy this link to share the published fighter.</p>
          <input
            className="asf-modal__link"
            type="text"
            readOnly
            value={shareLinkUrl}
            onFocus={(event) => event.target.select()}
          />
          <div className="asf-modal__actions">
            <Button onClick={() => setShareLinkUrl(null)}>Close</Button>
            <Button
              variant="primary"
              onClick={() => {
                void navigator.clipboard?.writeText(shareLinkUrl).catch(() => {});
                setShareLinkUrl(null);
                setStatus('Community share link copied');
              }}
            >
              Copy Link
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
