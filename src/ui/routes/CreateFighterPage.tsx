import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CACHE_VERSION,
  getAllCachedMetas,
  getAllSpritesForHash,
  hashPhoto,
  setCachedMeta,
  type CachedMeta,
  type CachedSprite,
} from '../../services/SpriteCache.ts';
import {
  processCharacter,
  type PipelineStatus,
  type StatusCallback,
} from '../../services/CharacterPipeline.ts';
import { FighterPreviewColumn, useFighterPreview } from '../components/FighterPreviewColumn.tsx';
import { Button } from '../components/Button.tsx';
import { PipelineProgress } from '../components/PipelineProgress.tsx';
import { TurnstileChallenge } from '../components/TurnstileChallenge.tsx';
import { GenerationConsent } from '../components/LegalConsent.tsx';
import {
  animLabel,
  getSourceBlob,
  type PreviewSelection,
} from '../shared/fighterPreview.ts';
import { downloadBlob } from '../shared/downloadBlob.ts';
import { exportAnimationGif } from '../../services/GifExportService.ts';
import {
  downloadCloudFighterToLocal,
  getCloudFighter,
  prepareCloudFighterGeneration,
  syncFighterToCloud,
} from '../../services/CloudFighters.ts';
import {
  QUALITY_TIERS,
  type QualityTier,
} from '../../services/QualityTiers.ts';
import {
  authorizeGeneration,
  finishGenerationPurchase,
  getBillingProfile,
  type BillingProfile,
} from '../../services/Billing.ts';
import { captureApiRequestContext, runWithProviderSession } from '../../services/ApiClient.ts';
import { debugWarn } from '../../services/DebugLog.ts';
import { paidTiersLocked, type AuthStatus } from '../authState.ts';
import { currentGenerationLegalAttestation } from '../legal.ts';
import {
  listGenerationJobs,
  startGenerationJob,
  waitForGenerationJob,
  type GenerationJob,
} from '../../services/GenerationJobs.ts';
import { includedRookieStatus, initialCreationTier } from '../shared/rookieEntitlement.ts';

interface CreateFighterPageProps {
  authStatus: AuthStatus;
  authSessionKey: string;
  onBack: () => void;
  onComplete: (photoHash: string) => void;
  onNavigateLegal?: (route: '/legal' | '/privacy' | '/terms' | '/refunds') => void;
}

const DEFAULT_NAME = 'New Fighter';

function initialQualityTier(authStatus: AuthStatus): QualityTier {
  const requestedTier = new URLSearchParams(window.location.search).get('tier');
  return initialCreationTier(requestedTier, paidTiersLocked(authStatus));
}

function describeStage(status: PipelineStatus): string {
  switch (status.stage) {
    case 'hashing':
      return 'Hashing photo...';
    case 'cached':
      return 'Found in cache!';
    case 'converting_side_view':
      return 'Converting to fighting stance...';
    case 'converting_upright_view':
      return 'Straightening reference stance...';
    case 'converting_crouch_view':
      return 'Generating crouched stance...';
    case 'generating_sprites':
      return `Generating ${animLabel(status.animation)} (${status.current}/${status.total})`;
    case 'sprite_ready':
      return `${animLabel(status.animation)} ready`;
    case 'done':
      return 'All sprites generated!';
    case 'error':
      return `Error: ${status.message}`;
  }
}

function stageToPercent(status: PipelineStatus): number | null {
  switch (status.stage) {
    case 'hashing':
      return 0.02;
    case 'converting_side_view':
      return 0.05;
    case 'converting_upright_view':
      return 0.09;
    case 'converting_crouch_view':
      return 0.12;
    case 'cached':
    case 'done':
      return 1;
    case 'generating_sprites': {
      const share = status.total > 0 ? status.current / status.total : 0;
      return 0.15 + 0.85 * share;
    }
    case 'sprite_ready': {
      const share = status.total > 0 ? status.current / status.total : 0;
      return 0.15 + 0.85 * share;
    }
    default:
      return null;
  }
}

function describeDurableJob(job: GenerationJob): string {
  if (job.status === 'queued') return 'Queued safely in the cloud...';
  if (job.status === 'succeeded') return 'Generation complete. Syncing this device...';
  if (job.status === 'failed' || job.status === 'cancelled') {
    return job.errorMessage ?? 'Generation stopped; review the job details or contact support.';
  }
  if (job.stage === 'initializing') return 'Starting cloud forge...';
  if (job.stage === 'source:side') return 'Side reference ready';
  if (job.stage === 'source:upright') return 'Upright reference ready';
  if (job.stage === 'source:crouch') return 'Crouch reference ready';
  if (job.stage.startsWith('sprite:')) {
    return `${animLabel(job.stage.slice('sprite:'.length))} ready (${job.progressCurrent}/${job.progressTotal})`;
  }
  return 'Forging safely in the cloud...';
}

export function CreateFighterPage({ authStatus, authSessionKey, onBack, onComplete, onNavigateLegal }: CreateFighterPageProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(DEFAULT_NAME);
  const [tier, setTier] = useState<QualityTier>(() => initialQualityTier(authStatus));

  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [percent, setPercent] = useState(0);
  const [stageText, setStageText] = useState('Ready to forge.');

  const [photoHash, setPhotoHash] = useState<string | null>(null);
  const [meta, setMeta] = useState<CachedMeta | null>(null);
  const [sprites, setSprites] = useState<CachedSprite[]>([]);
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<PreviewSelection>({ kind: 'source', source: 'original' });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [billingProfile, setBillingProfile] = useState<BillingProfile | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(authStatus !== 'signed-in');
  const pollingAbortRef = useRef<AbortController | null>(null);
  const lockPaidTiers = paidTiersLocked(authStatus);
  const requiresTurnstile = authStatus === 'signed-out' && tier === 'rookie';
  const turnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();
  const turnstileReady = !requiresTurnstile || Boolean(turnstileToken);

  useEffect(() => {
    if (lockPaidTiers && tier !== 'rookie') {
      setTier('rookie');
    }
  }, [lockPaidTiers, tier]);

  useEffect(() => {
    if (authStatus !== 'signed-in') {
      setBillingProfile(null);
      return;
    }

    let cancelled = false;
    const apiContext = captureApiRequestContext();
    void getBillingProfile(apiContext).then((profile) => {
      if (!cancelled) setBillingProfile(profile);
    });
    return () => { cancelled = true; };
  }, [authSessionKey, authStatus]);

  useEffect(() => () => {
    pollingAbortRef.current?.abort();
    pollingAbortRef.current = null;
  }, []);

  useEffect(() => {
    if (authStatus !== 'signed-in') {
      setRecoveryReady(true);
      return;
    }

    let disposed = false;
    const apiContext = captureApiRequestContext();
    const controller = new AbortController();
    pollingAbortRef.current?.abort();
    pollingAbortRef.current = controller;
    setRecoveryReady(false);

    void (async () => {
      try {
        const jobs = await listGenerationJobs(apiContext);
        if (disposed) return;
        const active = jobs.find((job) => (
          job.operation === 'fighter_generation' &&
          (job.status === 'queued' || job.status === 'running')
        ));
        if (!active) {
          setRecoveryReady(true);
          return;
        }
        const fighter = await getCloudFighter(active.fighterId, apiContext);
        if (disposed) return;
        if (fighter) {
          setName(fighter.name);
          setPhotoHash(fighter.photoHash ?? null);
          if (fighter.photoHash) {
            await downloadCloudFighterToLocal(fighter, apiContext, {
              includeArchivedVersions: false,
              includeRawAssets: false,
              allowIncomplete: true,
            });
            await refreshFromCache(fighter.photoHash);
          }
        }
        setTier(active.tier);
        setStarted(true);
        setRunning(true);
        setDone(false);
        setError(null);
        applyDurableJob(active);
        const completed = await monitorDurableJob(active, apiContext, controller.signal);
        if (disposed) return;
        await finishDurableJob(completed, apiContext);
      } catch (err: any) {
        if (disposed || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err?.message ? String(err.message) : 'Could not reconnect to cloud generation');
        setStageText('Cloud generation status is temporarily unavailable.');
      } finally {
        if (!disposed) {
          setRunning(false);
          setRecoveryReady(true);
        }
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (pollingAbortRef.current === controller) pollingAbortRef.current = null;
    };
  }, [authStatus]);

  async function refreshFromCache(hash: string): Promise<{ meta: CachedMeta | null; sprites: CachedSprite[] }> {
    const [allMetas, nextSprites] = await Promise.all([
      getAllCachedMetas(),
      getAllSpritesForHash(hash),
    ]);
    const nextMeta = allMetas.find((item) => item.photoHash === hash && item.version === CACHE_VERSION) ?? null;
    setMeta(nextMeta);
    setSprites(nextSprites);
    return { meta: nextMeta, sprites: nextSprites };
  }

  const handleStatus: StatusCallback = (status) => {
    const nextStage = describeStage(status);
    setStageText(nextStage);
    const nextPercent = stageToPercent(status);
    if (nextPercent !== null) setPercent(nextPercent);

    switch (status.stage) {
      case 'cached':
      case 'sprite_ready':
      case 'done':
        setPhotoHash(status.photoHash);
        void refreshFromCache(status.photoHash);
        break;
      case 'generating_sprites':
        setGenerating((current) => {
          if (current.has(status.animation)) return current;
          const next = new Set(current);
          next.add(status.animation);
          return next;
        });
        break;
    }

    if (status.stage === 'sprite_ready') {
      setGenerating((current) => {
        if (!current.has(status.animation)) return current;
        const next = new Set(current);
        next.delete(status.animation);
        return next;
      });
    }

    if (status.stage === 'error') {
      setError(status.message);
    }
  };

  function applyDurableJob(job: GenerationJob): void {
    setStageText(describeDurableJob(job));
    setPercent(job.progressTotal > 0 ? job.progressCurrent / job.progressTotal : 0);
    if (job.stage.startsWith('sprite:') && job.status === 'running') {
      setGenerating(new Set([job.stage.slice('sprite:'.length)]));
    } else {
      setGenerating(new Set());
    }
  }

  async function monitorDurableJob(
    initial: GenerationJob,
    apiContext: ReturnType<typeof captureApiRequestContext>,
    signal: AbortSignal,
  ): Promise<GenerationJob> {
    applyDurableJob(initial);
    if (initial.status === 'succeeded' || initial.status === 'failed' || initial.status === 'cancelled') {
      return initial;
    }
    return waitForGenerationJob(initial.id, {
      context: apiContext,
      signal,
      onUpdate: applyDurableJob,
      onConnectionIssue: () => {
        setStageText('Connection lost. The cloud forge is still running; reconnecting...');
      },
    });
  }

  async function finishDurableJob(
    job: GenerationJob,
    apiContext: ReturnType<typeof captureApiRequestContext>,
  ): Promise<void> {
    if (job.status !== 'succeeded') {
      throw new Error(job.errorMessage ?? 'Generation stopped; review the job details or contact support.');
    }
    setStageText('Generation complete. Downloading your private fighter...');
    const fighter = await getCloudFighter(job.fighterId, apiContext);
    if (!fighter?.photoHash) throw new Error('Completed fighter could not be loaded from the cloud');
    await downloadCloudFighterToLocal(fighter, apiContext);
    setName(fighter.name);
    setTier(fighter.qualityTier);
    setPhotoHash(fighter.photoHash);
    await refreshFromCache(fighter.photoHash);
    setPercent(1);
    setDone(true);
    setGenerating(new Set());
    setStageText('All sprites generated, private, and synced!');
  }

  async function startDurable(apiContext: ReturnType<typeof captureApiRequestContext>): Promise<void> {
    if (!file) return;
    setStarted(true);
    setStageText('Preparing your private cloud fighter...');
    const hash = await hashPhoto(file);
    setPhotoHash(hash);
    const fighterName = name.trim() || DEFAULT_NAME;
    const prepared = await prepareCloudFighterGeneration({
      name: fighterName,
      photoHash: hash,
      originalPhoto: file,
    }, apiContext);
    await downloadCloudFighterToLocal(prepared.fighter, apiContext, {
      includeArchivedVersions: false,
      includeRawAssets: false,
      allowIncomplete: true,
    });
    await refreshFromCache(hash);
    const authorization = await authorizeGeneration(
      tier,
      'fighter_generation',
      prepared.fighter.id,
      null,
      currentGenerationLegalAttestation(),
      apiContext,
    );
    if (!authorization.authorized || !authorization.purchaseId || !authorization.providerSessionId) {
      throw new Error(authorization.error ?? 'Generation not authorized');
    }
    setStageText('Handing the forge to the cloud...');
    let job: GenerationJob;
    try {
      job = await startGenerationJob({
        fighterId: prepared.fighter.id,
        purchaseId: authorization.purchaseId,
        providerSessionId: authorization.providerSessionId,
      }, apiContext);
    } catch (error) {
      try {
        await finishGenerationPurchase(
          authorization.purchaseId,
          false,
          prepared.fighter.id,
          apiContext,
        );
      } catch (settlementError: any) {
        debugWarn(
          '[Billing] Backend job ownership could not be confirmed during cleanup:',
          settlementError?.message ?? settlementError,
        );
      }
      throw error;
    }
    const controller = new AbortController();
    pollingAbortRef.current?.abort();
    pollingAbortRef.current = controller;
    const completed = await monitorDurableJob(job, apiContext, controller.signal);
    await finishDurableJob(completed, apiContext);
  }

  async function start() {
    if (!file || running || !turnstileReady || !legalAccepted || !recoveryReady) return;
    setRunning(true);
    setDone(false);
    setError(null);
    setPercent(0);
    setStageText('Starting pipeline...');
    setGenerating(new Set());
    let purchaseId: string | undefined;
    let purchaseCommitted = false;
    const apiContext = captureApiRequestContext();
    try {
      if (authStatus === 'signed-in') {
        await startDurable(apiContext);
        return;
      }
      let authorization;
      try {
        authorization = await authorizeGeneration(
          tier,
          'fighter_generation',
          null,
          requiresTurnstile ? turnstileToken : null,
          currentGenerationLegalAttestation(),
          apiContext,
        );
      } finally {
        if (requiresTurnstile) {
          setTurnstileToken(null);
          setTurnstileResetSignal((current) => current + 1);
        }
      }
      if (!authorization.authorized) {
        throw new Error(authorization.error ?? 'Generation not authorized');
      }
      setStarted(true);
      purchaseId = authorization.purchaseId;
      const hash = await runWithProviderSession(
        authorization.providerSessionId,
        (providerContext) => processCharacter(file, handleStatus, name.trim() || DEFAULT_NAME, {
          tier,
          apiContext: providerContext,
        }),
        apiContext,
      );
      setPhotoHash(hash);
      const cached = await refreshFromCache(hash);
      if (purchaseId && cached.meta) {
        cached.meta.pendingGenerationPurchaseId = purchaseId;
        cached.meta.updatedAt = Date.now();
        await setCachedMeta(cached.meta);
      }
      setPercent(1);
      setDone(true);
      await finishGenerationPurchase(purchaseId, true, null, apiContext);
      purchaseCommitted = true;
      setStageText('All sprites generated. Syncing cloud roster...');
      if (cached.meta) {
        try {
          const cloud = await syncFighterToCloud(cached.meta, cached.sprites, null, apiContext);
          if (cloud.status === 'synced') {
            setStageText(cloud.message ?? 'All sprites generated and synced!');
          } else if (cloud.status === 'signed_out') {
            setStageText('All sprites generated locally. Sign in to sync across devices.');
          } else {
            setStageText(`All sprites generated locally. Cloud sync failed: ${cloud.message ?? 'unknown error'}`);
          }
        } catch (syncErr: any) {
          setStageText(`All sprites generated locally. Cloud sync failed: ${syncErr?.message ?? 'unknown error'}`);
        }
      } else {
        setStageText('All sprites generated locally.');
      }
      setGenerating(new Set());
    } catch (err: any) {
      if (purchaseId && !purchaseCommitted) {
        try {
          await finishGenerationPurchase(purchaseId, false, null, apiContext);
        } catch (releaseErr: any) {
          debugWarn('[Billing] Failed to release generation purchase:', releaseErr?.message ?? releaseErr);
        }
      }
      const message = err?.message ? String(err.message) : 'Pipeline failed';
      setError(message);
      setStageText(`Error: ${message.slice(0, 120)}`);
    } finally {
      setRunning(false);
    }
  }

  function retry() {
    if (!file) return;
    setError(null);
    void start();
  }

  function choosePhotoAgain() {
    setStarted(false);
    setDone(false);
    setError(null);
    setStageText('');
    setPercent(0);
    setPhotoHash(null);
    setMeta(null);
    setSprites([]);
    setGenerating(new Set());
    setSelection({ kind: 'source', source: 'original' });
    setLegalAccepted(false);
  }

  const selectedAnimName = selection.kind === 'animation' ? selection.animationName : null;

  const { previewSprite, previewSourceBlob } = useFighterPreview(meta, sprites, selection);
  const safeName = (name.trim() || DEFAULT_NAME).replace(/[^a-z0-9]/gi, '_');
  const cachedSelectedSprite = selectedAnimName
    ? sprites.find((item) => item.animationName === selectedAnimName)
    : null;
  const rookieStatus = includedRookieStatus(authStatus, billingProfile);
  const startLabel = tier === 'rookie' && rookieStatus === 'included'
    ? 'Create Free Rookie'
    : `Create ${QUALITY_TIERS.find((item) => item.id === tier)?.label ?? 'Fighter'}`;

  const saveGif = async () => {
    if (!cachedSelectedSprite || !selectedAnimName) return;
    setStageText(`Encoding ${selectedAnimName}.gif...`);
    try {
      const gif = await exportAnimationGif(cachedSelectedSprite, selectedAnimName);
      downloadBlob(gif, `${safeName}_${selectedAnimName}.gif`);
      setStageText('GIF saved');
    } catch (err: any) {
      setStageText(err?.message ? `GIF failed: ${err.message}` : 'GIF failed');
    }
  };

  const saveAll = async () => {
    if (!meta) return;
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
  };

  if (!started) {
    return (
      <section className="create-app">
        <header className="roster-hero">
          <div>
            <h1>Make Yourself Playable</h1>
            <p className="roster-hero__copy">
              Upload one photo. We build a fighter you can take straight into Arcade Mode.
            </p>
          </div>
          <div className="roster-hero__actions">
            <Button onClick={onBack}>Back</Button>
          </div>
        </header>

        <div className="create-intro">
          <label className="create-form__field">
            <span>Fighter Name</span>
            <input
              type="text"
              value={name}
              maxLength={48}
              onChange={(event) => setName(event.target.value)}
              placeholder={DEFAULT_NAME}
            />
          </label>
          <label className="create-form__field">
            <span>Source Photo</span>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className="tier-picker" role="radiogroup" aria-label="Quality tier">
            {QUALITY_TIERS.map((item) => {
              const locked = lockPaidTiers && item.id !== 'rookie';
              const priceLabel = item.id !== 'rookie'
                ? item.priceLabel
                : rookieStatus === 'included'
                  ? 'Included'
                  : rookieStatus === 'credits'
                    ? item.priceLabel
                    : 'Checking account';
              const pitch = item.id === 'rookie' && rookieStatus === 'included'
                ? authStatus === 'signed-out'
                  ? 'Your first playable fighter is free after a quick human check.'
                  : 'Your first playable fighter is included with your account.'
                : item.pitch;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`tier-picker__option${tier === item.id ? ' is-active' : ''}`}
                  role="radio"
                  aria-checked={tier === item.id}
                  disabled={locked}
                  onClick={() => setTier(item.id)}
                >
                  <span>{item.label}</span>
                  <small>{locked ? `${item.priceLabel} · Sign in` : `${priceLabel} · ${item.estimatedTime}`}</small>
                  <em>{locked ? 'Sign in to unlock paid quality.' : pitch}</em>
                </button>
              );
            })}
          </div>
          <p className="tier-picker__note">
            Source views are always generated at premium quality. Animation fidelity and detail scale with the tier.
          </p>
          {requiresTurnstile ? (
            <TurnstileChallenge
              siteKey={turnstileSiteKey}
              resetSignal={turnstileResetSignal}
              onTokenChange={setTurnstileToken}
            />
          ) : null}
          <GenerationConsent
            checked={legalAccepted}
            disabled={running}
            onChange={setLegalAccepted}
            onNavigate={onNavigateLegal}
          />
          {error ? <p className="create-intro__error" role="alert">{error}</p> : null}
          <button
            className="home-menu__action is-primary"
            disabled={!file || !name.trim() || running || !turnstileReady || !legalAccepted || !recoveryReady}
            onClick={() => void start()}
          >
            <span>{!recoveryReady ? 'Checking Cloud...' : running ? 'Authorizing...' : startLabel}</span>
            <small>{file ? file.name : 'Pick a photo to continue'}</small>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="create-app">
      <header className="roster-hero">
        <div>
          <p className="gallery-eyebrow">{done ? 'Ready' : error ? 'Failed' : 'Forging'}</p>
          <h1>{(name.trim() || DEFAULT_NAME).toUpperCase()}</h1>
          <p className="roster-hero__copy">{stageText}</p>
        </div>
        <div className="roster-hero__actions">
          <div className="gallery-hero__status" role="status" aria-live="polite">
            {Math.round(percent * 100)}%
          </div>
          {done && meta ? (
            <Button variant="ghost" onClick={() => void saveAll()}>Save All</Button>
          ) : null}
          <Button
            variant={done ? 'primary' : 'secondary'}
            disabled={running && authStatus !== 'signed-in'}
            onClick={done && photoHash ? () => onComplete(photoHash) : onBack}
          >
            {done ? 'Open In Gallery' : running && authStatus !== 'signed-in' ? 'Running...' : 'Back'}
          </Button>
        </div>
      </header>

      <PipelineProgress percent={percent} />

      {error ? (
        <div className="create-error" role="alert">
          <strong>{error}</strong>
          {requiresTurnstile ? (
            <TurnstileChallenge
              siteKey={turnstileSiteKey}
              resetSignal={turnstileResetSignal}
              onTokenChange={setTurnstileToken}
            />
          ) : null}
          <div className="gallery-actions">
            {file ? (
              <button onClick={retry} disabled={running || !turnstileReady}>
                Retry Pipeline
              </button>
            ) : (
              <button onClick={choosePhotoAgain} disabled={running}>
                Choose Photo Again
              </button>
            )}
          </div>
        </div>
      ) : null}

      <FighterPreviewColumn
        meta={meta}
        sprites={sprites}
        selection={selection}
        onSelectionChange={setSelection}
        generating={generating}
        loading={
          running &&
          (selection.kind === 'source'
            ? !previewSourceBlob
            : !previewSprite || generating.has(selection.animationName))
        }
        loadingLabel={
          selection.kind === 'animation'
            ? `Generating ${animLabel(selection.animationName)}`
            : 'Generating'
        }
        emptyLabel={selection.kind === 'source' ? 'Missing source' : 'Waiting for pipeline'}
        safeName={safeName}
        onSaveGif={() => void saveGif()}
      />
    </section>
  );
}
