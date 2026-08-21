import { useEffect, useMemo, useState } from 'react';
import {
  CACHE_VERSION,
  getAllCachedMetas,
  getAllSpritesForHash,
  setCachedMeta,
  type CachedMeta,
  type CachedSprite,
} from '../../services/SpriteCache.ts';
import {
  processCharacter,
  type PipelineStatus,
  type StatusCallback,
} from '../../services/CharacterPipeline.ts';
import { AnimationGrid } from '../components/AnimationGrid.tsx';
import { SourceViewsPanel } from '../components/SourceViewsPanel.tsx';
import { SpritePreviewSurface } from '../components/SpritePreviewSurface.tsx';
import { DebugFeed } from '../components/DebugFeed.tsx';
import { PipelineProgress } from '../components/PipelineProgress.tsx';
import { TurnstileChallenge } from '../components/TurnstileChallenge.tsx';
import { GenerationConsent } from '../components/LegalConsent.tsx';
import {
  animLabel,
  getSourceBlob,
  type PreviewSelection,
  type PreviewSpriteLike,
} from '../shared/fighterPreview.ts';
import { useObjectUrl } from '../shared/useObjectUrl.ts';
import { downloadBlob } from '../shared/downloadBlob.ts';
import { exportAnimationGif } from '../../services/GifExportService.ts';
import { syncFighterToCloud } from '../../services/CloudFighters.ts';
import { QUALITY_TIERS, type QualityTier } from '../../services/QualityTiers.ts';
import { authorizeGeneration, finishGenerationPurchase } from '../../services/Billing.ts';
import { captureApiRequestContext, runWithProviderSession } from '../../services/ApiClient.ts';
import { debugWarn } from '../../services/DebugLog.ts';
import { paidTiersLocked, type AuthStatus } from '../authState.ts';
import { currentGenerationLegalAttestation } from '../legal.ts';

interface CreateFighterPageProps {
  authStatus: AuthStatus;
  onBack: () => void;
  onComplete: (photoHash: string) => void;
}

const DEFAULT_NAME = 'New Fighter';

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
    case 'converting_side_view_polling':
      return `Waiting for task ${status.taskId.slice(0, 8)}...`;
    case 'preparing_base':
      return 'Preparing base image...';
    case 'falling_back':
      return `Falling back: ${status.reason.slice(0, 80)}`;
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
    case 'preparing_base':
      return 0.15;
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

export function CreateFighterPage({ authStatus, onBack, onComplete }: CreateFighterPageProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(DEFAULT_NAME);
  const [tier, setTier] = useState<QualityTier>(() => paidTiersLocked(authStatus) ? 'rookie' : 'contender');

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
  const lockPaidTiers = paidTiersLocked(authStatus);
  const requiresTurnstile = authStatus === 'signed-out' && tier === 'rookie';
  const turnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();
  const turnstileReady = !requiresTurnstile || Boolean(turnstileToken);

  useEffect(() => {
    if (lockPaidTiers && tier !== 'rookie') {
      setTier('rookie');
    }
  }, [lockPaidTiers, tier]);

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

  async function start() {
    if (!file || running || !turnstileReady || !legalAccepted) return;
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
        } catch (refundErr: any) {
          debugWarn('[Billing] Failed to release generation purchase:', refundErr?.message ?? refundErr);
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

  const selectedAnimName = selection.kind === 'animation' ? selection.animationName : null;

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

  const previewSourceBlob = selection.kind === 'source' ? getSourceBlob(meta, selection.source) : null;
  const previewSourceUrl = useObjectUrl(previewSourceBlob);

  const previewBlob = selection.kind === 'source' ? previewSourceBlob : previewSprite?.blob ?? null;
  const safeName = (name.trim() || DEFAULT_NAME).replace(/[^a-z0-9]/gi, '_');
  const cachedSelectedSprite = selectedAnimName
    ? sprites.find((item) => item.animationName === selectedAnimName)
    : null;

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
            <p className="gallery-eyebrow">New Fighter</p>
            <h1>Forge A Challenger</h1>
            <p className="roster-hero__copy">
              Upload a photo and name your fighter. The AI handles the rest.
            </p>
          </div>
          <div className="roster-hero__actions">
            <button className="gallery-back" onClick={onBack}>
              Back
            </button>
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
                  <small>{locked ? `${item.priceLabel} · Sign in` : `${item.priceLabel} · ${item.estimatedTime}`}</small>
                  <em>{locked ? 'Sign in to unlock paid quality.' : item.pitch}</em>
                </button>
              );
            })}
          </div>
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
          />
          {error ? <p className="create-intro__error" role="alert">{error}</p> : null}
          <button
            className="home-menu__action is-primary"
            disabled={!file || !name.trim() || running || !turnstileReady || !legalAccepted}
            onClick={() => void start()}
          >
            <span>{running ? 'Authorizing...' : 'Start Forging'}</span>
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
            <button className="gallery-back" onClick={() => void saveAll()}>
              Save All
            </button>
          ) : null}
          <button
            className="gallery-back"
            disabled={running}
            onClick={done && photoHash ? () => onComplete(photoHash) : onBack}
          >
            {done ? 'Open In Gallery' : running ? 'Running...' : 'Back'}
          </button>
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
            <button onClick={retry} disabled={running || !turnstileReady}>
              Retry Pipeline
            </button>
          </div>
        </div>
      ) : null}

      <section className="gallery-layout">
        <div className="gallery-column--side">
          <div className="gallery-panel gallery-panel--sources">
            <SourceViewsPanel
              meta={meta}
              selectedSource={selection.kind === 'source' ? selection.source : null}
              onSelectSource={(source) => setSelection({ kind: 'source', source })}
            />
          </div>

          <div className="gallery-panel gallery-panel--anims">
            <h3>Animations</h3>
            <AnimationGrid
              sprites={sprites}
              failedArtifacts={meta?.failedAnimationArtifacts ?? null}
              generating={generating}
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
          </div>
          <div className="gallery-preview__surface">
            <SpritePreviewSurface
              sourceImageUrl={selection.kind === 'source' ? previewSourceUrl : null}
              sprite={selection.kind === 'animation' ? previewSprite : null}
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
            />
          </div>

          {previewBlob || cachedSelectedSprite || previewSprite?.rawBlob ? (
            <div className="gallery-actions">
              {previewBlob ? (
                <button
                  onClick={() =>
                    downloadBlob(
                      previewBlob,
                      `${safeName}_${selection.kind === 'source' ? selection.source : selection.animationName}.png`,
                    )
                  }
                >
                  Save PNG
                </button>
              ) : null}
              {cachedSelectedSprite ? (
                <button onClick={() => void saveGif()}>Save GIF</button>
              ) : null}
              {previewSprite?.rawBlob ? (
                <button
                  onClick={() =>
                    downloadBlob(previewSprite.rawBlob!, `${safeName}_${selectedAnimName}_RAW.png`)
                  }
                >
                  Save RAW
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </section>
  );
}
