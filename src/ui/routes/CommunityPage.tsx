import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cloneCommunityFighter,
  downloadCloudFighterToLocal,
  getCommunityFighter,
  listCommunityFighters,
  listOwnedCommunityFighterIds,
  reportCommunityFighter,
  type CommunityReportReason,
} from '../../services/CloudFighters.ts';
import { shareCommunityFighter } from '../shared/communityShare.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import type { AuthStatus } from '../authState.ts';
import { cloudPreviewUrl, tierLabel } from '../shared/fighterPreview.ts';
import {
  communityOwnershipActionsPaused,
  markOwnedCommunityFighters,
  resolveFeaturedCommunityFighter,
  type CommunityFighterView,
} from '../shared/communityState.ts';
import { Button } from '../components/Button.tsx';
import { Modal } from '../components/Modal.tsx';
import { StatusMessage } from '../components/StatusMessage.tsx';

interface CommunityPageProps {
  authStatus: AuthStatus;
  onBack: () => void;
  onOpenGallery: () => void;
}

type CommunityLoadState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'empty' }
  | { phase: 'not-found' }
  | { phase: 'error'; message: string };

interface CommunityOperation {
  kind: 'clone' | 'share' | 'report';
  fighterId: string;
}

const REPORT_REASONS: Array<{ value: CommunityReportReason; label: string }> = [
  { value: 'non_consensual_person', label: 'Person shown without consent' },
  { value: 'sexual_content', label: 'Sexual content' },
  { value: 'hate_or_harassment', label: 'Hate or harassment' },
  { value: 'graphic_violence', label: 'Graphic violence' },
  { value: 'copyright_or_trademark', label: 'Copyright or trademark' },
  { value: 'personal_information', label: 'Personal information' },
  { value: 'spam', label: 'Spam or misleading content' },
  { value: 'other', label: 'Something else' },
];

function readFeaturedFighterId(): string | null {
  return new URLSearchParams(window.location.search).get('fighter')?.trim() || null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function loadStatusMessage(state: CommunityLoadState, fighterCount: number): string {
  if (state.phase === 'loading') return 'Loading community roster...';
  if (state.phase === 'error') return state.message;
  if (state.phase === 'not-found') return 'Shared fighter not found';
  if (state.phase === 'empty') return 'No public fighters yet';
  return fighterCount === 1 ? '1 public fighter ready' : `${fighterCount} public fighters ready`;
}

export function CommunityPage({ authStatus, onBack, onOpenGallery }: CommunityPageProps) {
  const [fighters, setFighters] = useState<CommunityFighterView[]>([]);
  const [loadState, setLoadState] = useState<CommunityLoadState>({ phase: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [ownershipKnown, setOwnershipKnown] = useState(authStatus !== 'signed-in');
  const [notice, setNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<CommunityOperation | null>(null);
  const [featuredId, setFeaturedId] = useState<string | null>(() => readFeaturedFighterId());
  const [reportTarget, setReportTarget] = useState<CommunityFighterView | null>(null);
  const [shareLinkUrl, setShareLinkUrl] = useState<string | null>(null);
  const [shareLinkError, setShareLinkError] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<CommunityReportReason>('non_consensual_person');
  const [reportDetails, setReportDetails] = useState('');
  const [reportError, setReportError] = useState<string | null>(null);
  const requestEpoch = useRef(0);

  useEffect(() => {
    const syncFeaturedDeepLink = () => {
      const nextFeaturedId = readFeaturedFighterId();
      if (nextFeaturedId === featuredId) return;
      setFeaturedId(nextFeaturedId);
      setLoadAttempt((current) => current + 1);
    };
    window.addEventListener('popstate', syncFeaturedDeepLink);
    return () => window.removeEventListener('popstate', syncFeaturedDeepLink);
  }, [featuredId]);

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    const apiContext = captureApiRequestContext();
    setLoadState({ phase: 'loading' });
    setFighters([]);
    setOwnershipKnown(authStatus !== 'signed-in');
    setNotice(null);

    const load = async () => {
      try {
        const [publicFighters, ownedResult] = await Promise.all([
          listCommunityFighters(apiContext),
          authStatus === 'signed-in'
            ? listOwnedCommunityFighterIds(apiContext)
              .then((fighterIds) => ({ fighterIds, known: true }))
              .catch(() => ({ fighterIds: [], known: false }))
            : Promise.resolve({ fighterIds: [], known: true }),
        ]);
        if (requestEpoch.current !== epoch) return;

        setOwnershipKnown(ownedResult.known);
        if (!ownedResult.known) {
          setNotice('Community ready. Roster ownership could not be verified, so clone and report actions are paused.');
        }
        const ownedIds = new Set(ownedResult.fighterIds);
        let resolved = markOwnedCommunityFighters(publicFighters, ownedIds);
        if (featuredId && !resolved.some((fighter) => fighter.id === featuredId)) {
          const detail = await getCommunityFighter(featuredId, apiContext);
          if (requestEpoch.current !== epoch) return;
          if (!detail) {
            setFighters(resolved);
            setLoadState({ phase: 'not-found' });
            return;
          }
          resolved = [
            ...markOwnedCommunityFighters([detail], ownedIds),
            ...resolved.filter((fighter) => fighter.id !== detail.id),
          ];
        }

        setFighters(resolved);
        setLoadState({ phase: resolved.length > 0 ? 'ready' : 'empty' });
      } catch (error) {
        if (requestEpoch.current !== epoch) return;
        setFighters([]);
        setLoadState({
          phase: 'error',
          message: `Community roster unavailable. ${errorMessage(error, 'Check your connection and try again.')}`,
        });
      }
    };
    void load();
    return () => {
      if (requestEpoch.current === epoch) requestEpoch.current += 1;
    };
  }, [authStatus, loadAttempt]);

  const featured = useMemo(
    () => resolveFeaturedCommunityFighter(fighters, featuredId),
    [featuredId, fighters],
  );
  const featuredPreviewUrl = featured ? cloudPreviewUrl(featured) : null;
  const isBusy = operation !== null;
  const ownershipUnavailable = communityOwnershipActionsPaused(
    authStatus === 'signed-in',
    ownershipKnown,
  );
  const reportBusy = operation?.kind === 'report';
  const headerStatus = notice ?? loadStatusMessage(loadState, fighters.length);

  const shareFighter = async (fighter: CommunityFighterView) => {
    if (operation) return;
    setOperation({ kind: 'share', fighterId: fighter.id });
    setNotice(`Preparing a share link for ${fighter.name}...`);
    try {
      const share = await shareCommunityFighter(fighter.id, fighter.name);
      setFeaturedId(fighter.id);
      window.history.replaceState(
        window.history.state,
        '',
        `/community?fighter=${encodeURIComponent(fighter.id)}`,
      );
      if (share.mode === 'native') {
        setNotice(`Share sheet opened for ${fighter.name}`);
      } else if (share.mode === 'clipboard') {
        setNotice(`Share link copied for ${fighter.name}`);
      } else if (share.mode === 'cancelled') {
        setNotice(`Share cancelled for ${fighter.name}`);
      } else {
        setShareLinkError(null);
        setShareLinkUrl(share.url);
        setNotice(`Share link ready for ${fighter.name}`);
      }
    } catch (error) {
      setNotice(`Share failed. ${errorMessage(error, 'Try again.')}`);
    } finally {
      setOperation(null);
    }
  };

  const addToRoster = async (fighter: CommunityFighterView) => {
    if (operation) return;
    if (fighter.isOwned) {
      onOpenGallery();
      return;
    }
    const apiContext = captureApiRequestContext();
    setOperation({ kind: 'clone', fighterId: fighter.id });
    setNotice(`Adding ${fighter.name} to your roster...`);
    try {
      const result = await cloneCommunityFighter(fighter.id, apiContext);
      if (!result) {
        setNotice('Sign in to add fighters to your roster');
        return;
      }
      await downloadCloudFighterToLocal(result.fighter, apiContext);
      setFighters((current) => current.map((item) => (
        item.id === fighter.id ? { ...item, isOwned: true } : item
      )));
      setNotice(
        result.cloned
          ? `${result.fighter.name} added to your roster`
          : `${result.fighter.name} was already in your roster and is now up to date`,
      );
      onOpenGallery();
    } catch (error) {
      setNotice(`Add failed. ${errorMessage(error, 'Try again.')}`);
    } finally {
      setOperation(null);
    }
  };

  const openReport = (fighter: CommunityFighterView) => {
    if (operation) return;
    if (fighter.isOwned) {
      setNotice('You cannot report your own fighter. Manage it from Roster Lab.');
      return;
    }
    if (authStatus !== 'signed-in') {
      setNotice('Sign in to report a public fighter');
      return;
    }
    setReportTarget(fighter);
    setReportReason('non_consensual_person');
    setReportDetails('');
    setReportError(null);
  };

  const submitReport = async () => {
    if (!reportTarget || operation) return;
    const apiContext = captureApiRequestContext();
    setOperation({ kind: 'report', fighterId: reportTarget.id });
    setReportError(null);
    try {
      const result = await reportCommunityFighter(
        reportTarget.id,
        reportReason,
        reportDetails,
        apiContext,
      );
      if (result.status === 'signed_out') {
        setReportError('Your session expired. Sign in again, then resend the report.');
        return;
      }
      setNotice(result.duplicate ? 'Your report was updated for review' : 'Report sent for review');
      setReportTarget(null);
    } catch (error) {
      setReportError(`We could not send this report. ${errorMessage(error, 'Try again.')}`);
    } finally {
      setOperation(null);
    }
  };

  const fighterActions = (fighter: CommunityFighterView, featuredCard = false) => (
    <>
      <Button
        variant="primary"
        size={featuredCard ? 'lg' : 'md'}
        disabled={isBusy || ownershipUnavailable}
        onClick={() => void addToRoster(fighter)}
      >
        {operation?.kind === 'clone' && operation.fighterId === fighter.id
          ? 'Adding...'
          : ownershipUnavailable
            ? 'Roster Check Unavailable'
            : fighter.isOwned ? 'Open In Roster' : 'Clone To Roster'}
      </Button>
      <Button disabled={isBusy} onClick={() => void shareFighter(fighter)}>
        {operation?.kind === 'share' && operation.fighterId === fighter.id ? 'Sharing...' : 'Share'}
      </Button>
      {!fighter.isOwned ? (
        <Button
          variant="ghost"
          disabled={isBusy || ownershipUnavailable}
          onClick={() => openReport(fighter)}
        >
          {ownershipUnavailable ? 'Report Unavailable' : 'Report'}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="roster-app">
      <header className="roster-hero">
        <div>
          <h1>Community</h1>
          <p className="roster-hero__copy">
            Discover public fighters and clone them into your roster.
          </p>
        </div>
        <div className="roster-hero__actions">
          <div
            className="gallery-hero__status"
            role={loadState.phase === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {headerStatus}
          </div>
          <Button onClick={onBack}>Back</Button>
        </div>
      </header>

      {loadState.phase === 'loading' ? (
        <section className="gallery-empty community-route-state" role="status" aria-busy="true">
          <h2>Loading Fighters</h2>
          <p>Fetching the public roster...</p>
        </section>
      ) : null}

      {loadState.phase === 'error' ? (
        <section className="gallery-empty community-route-state" role="alert">
          <h2>Community Unavailable</h2>
          <p>{loadState.message}</p>
          <Button variant="primary" onClick={() => setLoadAttempt((current) => current + 1)}>
            Retry Community
          </Button>
        </section>
      ) : null}

      {loadState.phase === 'not-found' ? (
        <section className="gallery-empty community-route-state" role="alert">
          <h2>Fighter Not Found</h2>
          <p>This shared fighter is no longer public. You can still browse the current roster below.</p>
        </section>
      ) : null}

      {featured ? (
        <section className="gallery-panel community-feature">
          <div className="community-feature__preview">
            {featuredPreviewUrl ? (
              <img
                src={featuredPreviewUrl}
                alt={`${featured.name}, AI-generated playable fighter`}
                className="community-feature__image"
              />
            ) : (
              <div className="gallery-preview__empty">No preview</div>
            )}
          </div>
          <div>
            <h2>Featured: {featured.name}</h2>
            <p className="community-feature__meta">
              AI-generated · {tierLabel(featured.qualityTier)} · {featured.sprites.length} anims · by {featured.owner?.name ?? 'Player'}
            </p>
            {featured.isOwned ? <span className="asf-badge community-owned-badge">In your roster</span> : null}
          </div>
          <div className="community-feature__actions">
            {fighterActions(featured, true)}
          </div>
        </section>
      ) : null}

      {loadState.phase === 'empty' ? (
        <section className="gallery-empty community-route-state">
          <h2>No Public Fighters</h2>
          <p>Publish a fighter from Roster Lab to seed the community.</p>
        </section>
      ) : null}

      {(loadState.phase === 'ready' || loadState.phase === 'not-found') && fighters.length > 0 ? (
        <section className="roster-fighter-grid" aria-label="Community fighters">
          {fighters.map((fighter) => {
            const previewUrl = cloudPreviewUrl(fighter);
            return (
              <article className="roster-fighter-card community-card" key={fighter.id}>
                <div className="roster-fighter-card__surface">
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt={`${fighter.name}, AI-generated playable fighter`}
                      className="roster-fighter-card__image"
                    />
                  ) : (
                    <div className="gallery-preview__empty">No preview</div>
                  )}
                </div>
                <div className="roster-fighter-card__meta">
                  <strong>{fighter.name}</strong>
                  <span>AI-generated · {tierLabel(fighter.qualityTier)} · {fighter.sprites.length} anims</span>
                  <span>By {fighter.owner?.name ?? 'Player'}</span>
                  {fighter.isOwned ? <span className="asf-badge community-owned-badge">In your roster</span> : null}
                </div>
                <div className="roster-fighter-card__actions">
                  {fighterActions(fighter)}
                </div>
              </article>
            );
          })}
        </section>
      ) : null}

      {reportTarget ? (
        <Modal
          title={`Report ${reportTarget.name}`}
          onClose={() => {
            if (!reportBusy) setReportTarget(null);
          }}
          busy={reportBusy}
        >
          <form
            className="community-report-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitReport();
            }}
          >
            {reportError ? <StatusMessage severity="error">{reportError}</StatusMessage> : null}
            <label>
              <span>Reason</span>
              <select
                value={reportReason}
                disabled={reportBusy}
                onChange={(event) => setReportReason(event.target.value as CommunityReportReason)}
              >
                {REPORT_REASONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Details <small>Optional</small></span>
              <textarea
                value={reportDetails}
                maxLength={500}
                rows={4}
                disabled={reportBusy}
                placeholder="Add context that will help us review this fighter."
                onChange={(event) => setReportDetails(event.target.value)}
              />
            </label>
            <div className="asf-modal__actions">
              <Button disabled={reportBusy} onClick={() => setReportTarget(null)}>
                Keep Browsing
              </Button>
              <Button variant="primary" type="submit" disabled={reportBusy}>
                {reportBusy ? 'Sending...' : 'Send Report'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {shareLinkUrl ? (
        <Modal
          title="Share Fighter Link"
          onClose={() => {
            setShareLinkError(null);
            setShareLinkUrl(null);
          }}
        >
          <p className="asf-modal__copy">Copy this link to share the fighter.</p>
          <input
            className="asf-modal__link"
            type="text"
            readOnly
            value={shareLinkUrl}
            onFocus={(event) => event.target.select()}
          />
          {shareLinkError ? <StatusMessage severity="error">{shareLinkError}</StatusMessage> : null}
          <div className="asf-modal__actions">
            <Button onClick={() => {
              setShareLinkError(null);
              setShareLinkUrl(null);
            }}>Close</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!navigator.clipboard?.writeText) {
                  setShareLinkError('Automatic copy is unavailable. Select the link above and copy it manually.');
                  return;
                }
                void navigator.clipboard.writeText(shareLinkUrl).then(() => {
                  setShareLinkError(null);
                  setShareLinkUrl(null);
                  setNotice('Share link copied');
                }).catch(() => {
                  setShareLinkError('The link could not be copied. Select it above and copy it manually.');
                });
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
