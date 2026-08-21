import { useEffect, useState } from 'react';
import {
  listCommunityModerationReports,
  updateCommunityModerationReport,
  type CommunityModerationReport,
  type ModerationStatus,
} from '../../services/CommunityModeration.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';

interface ModerationPageProps {
  onBack: () => void;
}

const STATUS_OPTIONS: Array<{ value: ModerationStatus; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'actioned', label: 'Actioned' },
];

const REASON_LABELS: Record<string, string> = {
  non_consensual_person: 'Person shown without consent',
  sexual_content: 'Sexual content',
  hate_or_harassment: 'Hate or harassment',
  graphic_violence: 'Graphic violence',
  copyright_or_trademark: 'Copyright or trademark',
  personal_information: 'Personal information',
  spam: 'Spam or misleading content',
  other: 'Something else',
};

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

export function ModerationPage({ onBack }: ModerationPageProps) {
  const [filter, setFilter] = useState<ModerationStatus>('open');
  const [reports, setReports] = useState<CommunityModerationReport[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading moderation queue...');

  useEffect(() => {
    const apiContext = captureApiRequestContext();
    let cancelled = false;
    setStatus('Loading moderation queue...');
    void listCommunityModerationReports(filter, apiContext)
      .then((result) => {
        if (cancelled) return;
        setReports(result.reports);
        if (result.access === 'signed_out') {
          setStatus('Sign in with a moderator account');
        } else if (result.access === 'forbidden') {
          setStatus('Moderator access required');
        } else {
          setStatus(result.reports.length === 1 ? '1 report' : `${result.reports.length} reports`);
        }
      })
      .catch((error: any) => {
        if (!cancelled) setStatus(error?.message ?? 'Moderation queue failed');
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const reviewReport = async (
    report: CommunityModerationReport,
    nextStatus: 'reviewing' | 'dismissed' | 'actioned',
    unpublishFighter = false,
  ) => {
    const note = notes[report.id]?.trim() ?? '';
    if ((nextStatus === 'dismissed' || nextStatus === 'actioned') && !note) {
      setStatus('Add a moderation note before closing the report');
      return;
    }
    if (unpublishFighter && !window.confirm(`Remove ${report.fighterName} from the public community?`)) return;

    setBusyId(report.id);
    setStatus(`Updating ${report.fighterName}...`);
    try {
      const updated = await updateCommunityModerationReport(
        report.id,
        nextStatus,
        note,
        unpublishFighter,
        captureApiRequestContext(),
      );
      setReports((current) => current.filter((item) => item.id !== report.id));
      setNotes((current) => {
        const next = { ...current };
        delete next[report.id];
        return next;
      });
      setStatus(
        unpublishFighter
          ? `${updated.fighterName} removed from the community`
          : `Report moved to ${updated.status}`,
      );
    } catch (error: any) {
      setStatus(error?.message ?? 'Moderation update failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="moderation-app">
      <header className="roster-hero">
        <div>
          <p className="gallery-eyebrow">Operations</p>
          <h1>Moderation</h1>
          <p className="roster-hero__copy">Review player reports and make deliberate community decisions.</p>
        </div>
        <div className="roster-hero__actions">
          <div className="gallery-hero__status" aria-live="polite">{status}</div>
          <button className="gallery-back" onClick={onBack}>Back</button>
        </div>
      </header>

      <div className="moderation-tabs" role="tablist" aria-label="Report status">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={`gallery-tab${filter === option.value ? ' is-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {reports.length === 0 ? (
        <section className="gallery-empty moderation-empty">
          <h2>No {filter} reports</h2>
          <p>The selected moderation queue is clear.</p>
        </section>
      ) : (
        <section className="moderation-list" aria-live="polite">
          {reports.map((report) => {
            const note = notes[report.id] ?? report.moderationNote ?? '';
            const busy = busyId === report.id;
            return (
              <article className="moderation-report" key={report.id}>
                <header className="moderation-report__header">
                  <div>
                    <p className="gallery-eyebrow">{REASON_LABELS[report.reason] ?? report.reason}</p>
                    <h2>{report.fighterName}</h2>
                  </div>
                  <div className="moderation-report__state">
                    <strong>{report.status}</strong>
                    <span>{report.fighterPublic ? 'Public' : report.fighterExists ? 'Unpublished' : 'Deleted'}</span>
                  </div>
                </header>

                <div className="moderation-report__body">
                  <p>{report.details ?? 'No additional details supplied.'}</p>
                  <dl>
                    <div><dt>Owner</dt><dd>{report.ownerName}</dd></div>
                    <div><dt>Reports</dt><dd>{report.submissionCount}</dd></div>
                    <div><dt>Updated</dt><dd>{formatTimestamp(report.updatedAt)}</dd></div>
                  </dl>
                </div>

                <label className="moderation-report__note">
                  <span>Moderator note</span>
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={note}
                    disabled={busy}
                    placeholder="Record the evidence and decision."
                    onChange={(event) => setNotes((current) => ({ ...current, [report.id]: event.target.value }))}
                  />
                </label>

                <div className="moderation-report__actions">
                  {report.status === 'open' ? (
                    <button
                      className="gallery-chip"
                      type="button"
                      disabled={busy}
                      onClick={() => void reviewReport(report, 'reviewing')}
                    >
                      <span>Start Review</span>
                    </button>
                  ) : null}
                  {report.status !== 'dismissed' && report.status !== 'actioned' ? (
                    <button
                      className="gallery-chip"
                      type="button"
                      disabled={busy || !note.trim()}
                      onClick={() => void reviewReport(report, 'dismissed')}
                    >
                      <span>Dismiss</span>
                    </button>
                  ) : null}
                  {report.status !== 'dismissed' && report.status !== 'actioned' ? (
                    <button
                      className="gallery-chip is-active"
                      type="button"
                      disabled={busy || !note.trim()}
                      onClick={() => void reviewReport(report, 'actioned', report.fighterPublic)}
                    >
                      <span>{report.fighterPublic ? 'Remove Fighter' : 'Close Actioned'}</span>
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
