import { useEffect, useRef, useState } from 'react';
import {
  listCommunityModerationReports,
  updateCommunityModerationReport,
  type CommunityModerationReport,
  type ModerationStatus,
} from '../../services/CommunityModeration.ts';
import { captureApiRequestContext } from '../../services/ApiClient.ts';
import { Button } from '../components/Button.tsx';
import { ConfirmDialog } from '../components/Modal.tsx';

interface ModerationPageProps {
  onBack: () => void;
}

type ModerationLoadState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'empty' }
  | { phase: 'signed-out' }
  | { phase: 'forbidden' }
  | { phase: 'error'; message: string };

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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function isCurrentModerationRequest(
  requestEpoch: number,
  currentEpoch: number,
  requestFilter: ModerationStatus,
  currentFilter: ModerationStatus,
): boolean {
  return requestEpoch === currentEpoch && requestFilter === currentFilter;
}

function moderationStatusMessage(state: ModerationLoadState, reportCount: number): string {
  if (state.phase === 'loading') return 'Loading moderation queue...';
  if (state.phase === 'signed-out') return 'Moderator sign-in required';
  if (state.phase === 'forbidden') return 'Moderator access required';
  if (state.phase === 'error') return state.message;
  if (state.phase === 'empty') return 'Queue clear';
  return reportCount === 1 ? '1 report' : `${reportCount} reports`;
}

export function ModerationPage({ onBack }: ModerationPageProps) {
  const [filter, setFilter] = useState<ModerationStatus>('open');
  const [reports, setReports] = useState<CommunityModerationReport[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<ModerationLoadState>({ phase: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = useState<CommunityModerationReport | null>(null);
  const requestEpoch = useRef(0);
  const activeFilter = useRef(filter);
  activeFilter.current = filter;

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    const apiContext = captureApiRequestContext();
    setReports([]);
    setNotes({});
    setRemovalTarget(null);
    setNotice(null);
    setActionError(null);
    setLoadState({ phase: 'loading' });

    void listCommunityModerationReports(filter, apiContext)
      .then((result) => {
        if (!isCurrentModerationRequest(epoch, requestEpoch.current, filter, activeFilter.current)) return;
        if (result.access === 'signed_out') {
          setReports([]);
          setLoadState({ phase: 'signed-out' });
          return;
        }
        if (result.access === 'forbidden') {
          setReports([]);
          setLoadState({ phase: 'forbidden' });
          return;
        }
        setReports(result.reports);
        setLoadState({ phase: result.reports.length > 0 ? 'ready' : 'empty' });
      })
      .catch((error) => {
        if (!isCurrentModerationRequest(epoch, requestEpoch.current, filter, activeFilter.current)) return;
        setReports([]);
        setLoadState({
          phase: 'error',
          message: `Moderation queue unavailable. ${errorMessage(error, 'Try again.')}`,
        });
      });
    return () => {
      if (requestEpoch.current === epoch) requestEpoch.current += 1;
    };
  }, [filter, loadAttempt]);

  const reviewReport = async (
    report: CommunityModerationReport,
    nextStatus: 'reviewing' | 'dismissed' | 'actioned',
    unpublishFighter = false,
  ) => {
    if (busyId) return;
    const note = notes[report.id]?.trim() ?? '';
    if ((nextStatus === 'dismissed' || nextStatus === 'actioned') && !note) {
      setActionError('Add a moderation note before closing the report.');
      return;
    }

    const operationEpoch = requestEpoch.current;
    const operationFilter = filter;
    setBusyId(report.id);
    setNotice(`Updating ${report.fighterName}...`);
    setActionError(null);
    try {
      const updated = await updateCommunityModerationReport(
        report.id,
        nextStatus,
        note,
        unpublishFighter,
        captureApiRequestContext(),
      );
      if (!isCurrentModerationRequest(
        operationEpoch,
        requestEpoch.current,
        operationFilter,
        activeFilter.current,
      )) return;
      setReports((current) => current.filter((item) => item.id !== report.id));
      setNotes((current) => {
        const next = { ...current };
        delete next[report.id];
        return next;
      });
      if (reports.length <= 1) setLoadState({ phase: 'empty' });
      if (unpublishFighter) setRemovalTarget(null);
      setNotice(
        unpublishFighter
          ? `${updated.fighterName} removed from the community`
          : `Report moved to ${updated.status}`,
      );
    } catch (error) {
      if (!isCurrentModerationRequest(
        operationEpoch,
        requestEpoch.current,
        operationFilter,
        activeFilter.current,
      )) return;
      setActionError(`Moderation update failed. ${errorMessage(error, 'Try again.')}`);
    } finally {
      setBusyId(null);
    }
  };

  const closeActioned = (report: CommunityModerationReport) => {
    if (busyId) return;
    if (report.fighterPublic) {
      setActionError(null);
      setRemovalTarget(report);
      return;
    }
    void reviewReport(report, 'actioned', false);
  };

  const controlsLocked = busyId !== null || removalTarget !== null;
  const status = actionError ?? notice ?? moderationStatusMessage(loadState, reports.length);
  const statusIsError = Boolean(actionError) || loadState.phase === 'error';

  return (
    <div className="moderation-app">
      <header className="roster-hero">
        <div>
          <h1>Moderation</h1>
          <p className="roster-hero__copy">Review player reports and record each community decision.</p>
        </div>
        <div className="roster-hero__actions">
          <div
            className="gallery-hero__status"
            role={statusIsError ? 'alert' : 'status'}
            aria-live="polite"
          >
            {status}
          </div>
          <Button disabled={busyId !== null} onClick={onBack}>Back</Button>
        </div>
      </header>

      <div className="moderation-tabs" role="group" aria-label="Report status filter">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={`gallery-tab${filter === option.value ? ' is-active' : ''}`}
            type="button"
            aria-pressed={filter === option.value}
            disabled={controlsLocked}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loadState.phase === 'loading' ? (
        <section className="gallery-empty moderation-empty" role="status" aria-busy="true">
          <h2>Loading Reports</h2>
          <p>Fetching the {filter} moderation queue...</p>
        </section>
      ) : null}

      {loadState.phase === 'signed-out' ? (
        <section className="gallery-empty moderation-empty" role="alert">
          <h2>Moderator Sign-In Required</h2>
          <p>Sign in with a moderator account, then reopen this queue.</p>
        </section>
      ) : null}

      {loadState.phase === 'forbidden' ? (
        <section className="gallery-empty moderation-empty" role="alert">
          <h2>Moderator Access Required</h2>
          <p>Your account cannot review community reports.</p>
        </section>
      ) : null}

      {loadState.phase === 'error' ? (
        <section className="gallery-empty moderation-empty" role="alert">
          <h2>Queue Unavailable</h2>
          <p>{loadState.message}</p>
          <Button variant="primary" onClick={() => setLoadAttempt((current) => current + 1)}>
            Retry Queue
          </Button>
        </section>
      ) : null}

      {loadState.phase === 'empty' ? (
        <section className="gallery-empty moderation-empty">
          <h2>No {filter} reports</h2>
          <p>The selected moderation queue is clear.</p>
        </section>
      ) : null}

      {loadState.phase === 'ready' ? (
        <section className="moderation-list" aria-live="polite" aria-busy={busyId !== null}>
          {reports.map((report) => {
            const note = notes[report.id] ?? report.moderationNote ?? '';
            const busy = busyId === report.id;
            return (
              <article className="moderation-report" key={report.id}>
                <header className="moderation-report__header">
                  <div>
                    <h2>{report.fighterName}</h2>
                    <span className="asf-badge moderation-report__reason">
                      {REASON_LABELS[report.reason] ?? report.reason}
                    </span>
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
                    disabled={controlsLocked}
                    placeholder="Record the evidence and decision."
                    onChange={(event) => setNotes((current) => ({ ...current, [report.id]: event.target.value }))}
                  />
                </label>

                <div className="moderation-report__actions">
                  {report.status === 'open' ? (
                    <Button disabled={controlsLocked} onClick={() => void reviewReport(report, 'reviewing')}>
                      {busy ? 'Updating...' : 'Start Review'}
                    </Button>
                  ) : null}
                  {report.status !== 'dismissed' && report.status !== 'actioned' ? (
                    <Button
                      variant="ghost"
                      disabled={controlsLocked || !note.trim()}
                      onClick={() => void reviewReport(report, 'dismissed')}
                    >
                      Dismiss Report
                    </Button>
                  ) : null}
                  {report.status !== 'dismissed' && report.status !== 'actioned' ? (
                    <Button
                      variant={report.fighterPublic ? 'danger' : 'primary'}
                      disabled={controlsLocked || !note.trim()}
                      onClick={() => closeActioned(report)}
                    >
                      {report.fighterPublic ? 'Remove Fighter' : 'Close Actioned'}
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      ) : null}

      {removalTarget ? (
        <ConfirmDialog
          title={`Remove ${removalTarget.fighterName}`}
          confirmLabel="Remove Fighter"
          confirmVariant="danger"
          busy={busyId === removalTarget.id}
          onCancel={() => setRemovalTarget(null)}
          onConfirm={() => void reviewReport(removalTarget, 'actioned', true)}
        >
          {actionError ? <p className="moderation-dialog-error" role="alert">{actionError}</p> : null}
          Remove {removalTarget.fighterName} from the public community? The owner keeps their
          private fighter; only the public listing is taken down.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
