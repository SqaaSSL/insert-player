import { useEffect, useMemo, useState } from 'react';
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
import { cloudPreviewUrl, tierLabel } from '../shared/fighterPreview.ts';
import { Button } from '../components/Button.tsx';
import { Modal } from '../components/Modal.tsx';

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

function readFeaturedFighterId(): string | null {
  return new URLSearchParams(window.location.search).get('fighter')?.trim() || null;
}

export function CommunityPage({ authStatus, onBack, onOpenGallery }: CommunityPageProps) {
  const [fighters, setFighters] = useState<CloudFighter[]>([]);
  const [status, setStatus] = useState('Loading community roster...');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [featuredId, setFeaturedId] = useState<string | null>(() => readFeaturedFighterId());
  const [reportTarget, setReportTarget] = useState<CloudFighter | null>(null);
  const [shareLinkUrl, setShareLinkUrl] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<CommunityReportReason>('non_consensual_person');
  const [reportDetails, setReportDetails] = useState('');
  const [reportBusy, setReportBusy] = useState(false);

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

  const featured = useMemo(
    () => fighters.find((fighter) => fighter.id === featuredId) ?? fighters[0] ?? null,
    [featuredId, fighters],
  );
  const featuredPreviewUrl = featured ? cloudPreviewUrl(featured) : null;

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
      setShareLinkUrl(share.url);
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
          <h1>Community</h1>
          <p className="roster-hero__copy">
            Discover public fighters and clone them into your roster.
          </p>
        </div>
        <div className="roster-hero__actions">
          <div className="gallery-hero__status" role="status" aria-live="polite">{status}</div>
          <Button onClick={onBack}>Back</Button>
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
            <h2>Featured: {featured.name}</h2>
            <p className="community-feature__meta">
              AI-generated · {tierLabel(featured.qualityTier)} · {featured.sprites.length} anims · by {featured.owner?.name ?? 'Player'}
            </p>
          </div>
          <div className="community-feature__actions">
            <Button
              variant="primary"
              size="lg"
              disabled={busyId === featured.id}
              onClick={() => void addToRoster(featured)}
            >
              {busyId === featured.id ? 'Adding...' : 'Clone To Roster'}
            </Button>
            <Button disabled={busyId !== null} onClick={() => void shareFighter(featured)}>
              Share Link
            </Button>
            <Button
              variant="ghost"
              disabled={busyId !== null || reportBusy}
              onClick={() => openReport(featured)}
            >
              Report
            </Button>
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
                </div>
                <div className="roster-fighter-card__actions">
                  <Button
                    variant="primary"
                    disabled={busyId !== null}
                    onClick={() => void addToRoster(fighter)}
                  >
                    {busyId === fighter.id ? 'Adding...' : 'Clone To Roster'}
                  </Button>
                  <Button disabled={busyId !== null} onClick={() => void shareFighter(fighter)}>
                    Share
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busyId !== null || reportBusy}
                    onClick={() => openReport(fighter)}
                  >
                    Report
                  </Button>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {reportTarget ? (
        <Modal
          title={`Report ${reportTarget.name}`}
          onClose={() => setReportTarget(null)}
          busy={reportBusy}
        >
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
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={reportBusy}>
                {reportBusy ? 'Sending...' : 'Send Report'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {shareLinkUrl ? (
        <Modal title="Share Fighter Link" onClose={() => setShareLinkUrl(null)}>
          <p className="asf-modal__copy">Copy this link to share the fighter.</p>
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
                setStatus('Share link copied');
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
