import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cloneCommunityFighter,
  downloadCloudFighterToLocal,
  getCommunityFighter,
  listCommunityFighters,
  reportCommunityFighter,
  type CloudFighter,
  type CommunityReportReason,
} from '../../services/CloudFighters.ts';
import { shareCommunityFighter } from '../shared/communityShare.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import type { AuthStatus } from '../authState.ts';

interface CommunityPageProps {
  authStatus: AuthStatus;
  onBack: () => void;
  onOpenGallery: () => void;
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

function getPreviewUrl(fighter: CloudFighter): string | null {
  return fighter.sources.side ?? fighter.sources.upright ?? fighter.sources.original ?? null;
}

function formatTier(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function readFeaturedFighterId(): string | null {
  return new URLSearchParams(window.location.search).get('fighter')?.trim() || null;
}

export function CommunityPage({ authStatus, onBack, onOpenGallery }: CommunityPageProps) {
  const [fighters, setFighters] = useState<CloudFighter[]>([]);
  const [status, setStatus] = useState('Loading community roster...');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [featuredId, setFeaturedId] = useState<string | null>(() => readFeaturedFighterId());
  const [reportTarget, setReportTarget] = useState<CloudFighter | null>(null);
  const [reportReason, setReportReason] = useState<CommunityReportReason>('non_consensual_person');
  const [reportDetails, setReportDetails] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const reportReasonRef = useRef<HTMLSelectElement>(null);
  const reportDialogRef = useRef<HTMLElement>(null);
  const reportReturnFocusRef = useRef<HTMLElement | null>(null);
  const reportBusyRef = useRef(false);

  useEffect(() => {
    reportBusyRef.current = reportBusy;
  }, [reportBusy]);

  useEffect(() => {
    const load = async () => {
      try {
        const next = await listCommunityFighters();
        let resolved = next;
        let loadedFeatured = false;
        if (featuredId && !next.some((fighter) => fighter.id === featuredId)) {
          const detail = await getCommunityFighter(featuredId);
          if (detail) {
            resolved = [detail, ...next.filter((fighter) => fighter.id !== detail.id)];
            loadedFeatured = true;
          }
        }
        setFighters(resolved);
        setStatus(
          resolved.length > 0
            ? loadedFeatured ? 'Featured fighter loaded' : 'Community ready'
            : featuredId ? 'Shared fighter is no longer public' : 'No public fighters yet',
        );
      } catch (err: any) {
        setStatus(err?.message ? `Community failed: ${err.message}` : 'Community failed');
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!reportTarget) return;
    reportReasonRef.current?.focus();
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !reportBusyRef.current) {
        event.preventDefault();
        setReportTarget(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(reportDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleDialogKeys);
    return () => {
      window.removeEventListener('keydown', handleDialogKeys);
      reportReturnFocusRef.current?.focus();
      reportReturnFocusRef.current = null;
    };
  }, [reportTarget]);

  const featured = useMemo(
    () => fighters.find((fighter) => fighter.id === featuredId) ?? fighters[0] ?? null,
    [featuredId, fighters],
  );
  const featuredPreviewUrl = featured ? getPreviewUrl(featured) : null;

  const shareFighter = async (fighter: CloudFighter) => {
    const share = await shareCommunityFighter(fighter.id, fighter.name);
    setFeaturedId(fighter.id);
    window.history.replaceState({}, '', `/community?fighter=${encodeURIComponent(fighter.id)}`);
    if (share.mode === 'native') {
      setStatus(`Share sheet opened for ${fighter.name}`);
    } else if (share.mode === 'clipboard') {
      setStatus(`Share link copied for ${fighter.name}`);
    } else if (share.mode === 'cancelled') {
      setStatus(`Share cancelled for ${fighter.name}`);
    } else {
      window.prompt('Share fighter link', share.url);
      setStatus(`Share link ready for ${fighter.name}`);
    }
  };

  const addToRoster = async (fighter: CloudFighter) => {
    const apiContext = captureApiRequestContext();
    setBusyId(fighter.id);
    setStatus(`Adding ${fighter.name}...`);
    try {
      const cloned = await cloneCommunityFighter(fighter.id, apiContext);
      if (!cloned) {
        setStatus('Sign in to add fighters to your roster');
        return;
      }
      await downloadCloudFighterToLocal(cloned, apiContext);
      setStatus(`${cloned.name} added to your roster`);
      onOpenGallery();
    } catch (err: any) {
      setStatus(err?.message ? `Add failed: ${err.message}` : 'Add failed');
    } finally {
      setBusyId(null);
    }
  };

  const openReport = (fighter: CloudFighter) => {
    if (authStatus !== 'signed-in') {
      setStatus('Sign in to report a public fighter');
      return;
    }
    reportReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setReportTarget(fighter);
    setReportReason('non_consensual_person');
    setReportDetails('');
  };

  const submitReport = async () => {
    if (!reportTarget || reportBusy) return;
    const apiContext = captureApiRequestContext();
    setReportBusy(true);
    try {
      const result = await reportCommunityFighter(
        reportTarget.id,
        reportReason,
        reportDetails,
        apiContext,
      );
      if (result.status === 'signed_out') {
        setStatus('Sign in to report a public fighter');
      } else {
        setStatus(result.duplicate ? 'Your report was updated for review' : 'Report sent for review');
      }
      setReportTarget(null);
    } catch (err: any) {
      setStatus(err?.message ? `Report failed: ${err.message}` : 'Report failed');
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <div className="roster-app">
      <header className="roster-hero">
        <div>
          <p className="gallery-eyebrow">World Warriors</p>
          <h1>Community</h1>
          <p className="roster-hero__copy">
            Discover public fighters and clone them into your roster.
          </p>
        </div>
        <div className="roster-hero__actions">
          <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
          <button className="gallery-back" onClick={onBack}>
            Back
          </button>
        </div>
      </header>

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
            <p className="gallery-eyebrow">Featured Fighter</p>
            <h3>{featured.name}</h3>
            <p className="community-feature__meta">
              AI-generated · {formatTier(featured.qualityTier)} · {featured.sprites.length} anims · by {featured.owner?.name ?? 'Player'}
            </p>
          </div>
          <div className="community-feature__actions">
            <button
              className="home-menu__action is-primary"
              disabled={busyId === featured.id}
              onClick={() => void addToRoster(featured)}
            >
              <span>{busyId === featured.id ? 'Adding...' : 'Add To Roster'}</span>
              <small>Clone A Playable Copy</small>
            </button>
            <button
              className="home-menu__action"
              disabled={busyId !== null}
              onClick={() => void shareFighter(featured)}
            >
              <span>Share Link</span>
              <small>Invite A Challenger</small>
            </button>
            <button
              className="home-menu__action"
              disabled={busyId !== null || reportBusy}
              onClick={() => openReport(featured)}
            >
              <span>Report</span>
              <small>Flag For Review</small>
            </button>
          </div>
        </section>
      ) : null}

      {fighters.length === 0 ? (
        <section className="gallery-empty">
          <h2>No Public Fighters</h2>
          <p>Publish a fighter from Training Room to seed the community.</p>
        </section>
      ) : (
        <section className="roster-fighter-grid">
          {fighters.map((fighter) => {
            const previewUrl = getPreviewUrl(fighter);
            return (
              <article className="roster-fighter-card gallery-panel community-card" key={fighter.id}>
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
                  <span>AI-generated · {formatTier(fighter.qualityTier)} · {fighter.sprites.length} anims</span>
                  <span>By {fighter.owner?.name ?? 'Player'}</span>
                </div>
                <div className="roster-fighter-card__actions">
                  <button
                    className="gallery-chip is-active"
                    disabled={busyId !== null}
                    onClick={() => void addToRoster(fighter)}
                  >
                    <span>{busyId === fighter.id ? 'Adding' : 'Add'}</span>
                    <small>To Roster</small>
                  </button>
                  <button
                    className="gallery-chip"
                    disabled={busyId !== null}
                    onClick={() => void shareFighter(fighter)}
                  >
                    <span>Share</span>
                    <small>Copy Link</small>
                  </button>
                  <button
                    className="gallery-chip"
                    disabled={busyId !== null || reportBusy}
                    onClick={() => openReport(fighter)}
                  >
                    <span>Report</span>
                    <small>Flag Content</small>
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {reportTarget ? (
        <div className="community-report-backdrop">
          <section
            ref={reportDialogRef}
            className="community-report-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="community-report-title"
          >
            <div className="community-report-dialog__header">
              <div>
                <p className="gallery-eyebrow">Community Safety</p>
                <h2 id="community-report-title">Report {reportTarget.name}</h2>
              </div>
              <button
                className="community-report-dialog__close"
                type="button"
                aria-label="Close report form"
                disabled={reportBusy}
                onClick={() => setReportTarget(null)}
              >
                X
              </button>
            </div>
            <form
              className="community-report-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitReport();
              }}
            >
              <label>
                <span>Reason</span>
                <select
                  ref={reportReasonRef}
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
              <div className="community-report-form__actions">
                <button
                  className="gallery-chip"
                  type="button"
                  disabled={reportBusy}
                  onClick={() => setReportTarget(null)}
                >
                  <span>Cancel</span>
                </button>
                <button className="gallery-chip is-active" type="submit" disabled={reportBusy}>
                  <span>{reportBusy ? 'Sending...' : 'Send Report'}</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
