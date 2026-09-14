import { useEffect, useMemo, useState } from 'react';
import {
  adjustVideoSpriteReview,
  approveVideoSpriteReview,
  getVideoSpriteReview,
  getVideoSpriteReviewAsset,
  rejectVideoSpriteReview,
  videoSpriteReasonCodes,
  type VideoSpriteReview,
} from '../../services/VideoSpriteReview';
import { captureApiRequestContext } from '../../services/ApiClient';
import { useObjectUrl } from '../shared/useObjectUrl';
import { videoReviewDecisionNeedsConsent } from '../shared/creationFlow';
import { VideoGenerationReviewPanel } from './VideoGenerationReviewPanel';

interface VideoGenerationReviewGateProps {
  jobId: string;
  disabled?: boolean;
  fullRunRestartRequired?: boolean;
  generationConsentAccepted?: boolean;
  onGenerationConsentRequiredChange?: (required: boolean) => void;
  onContinue: (review: VideoSpriteReview) => void | Promise<void>;
  onFinalApproval: (review: VideoSpriteReview) => void | Promise<void>;
  onRejected?: (review: VideoSpriteReview) => void | Promise<void>;
  onCreateNew?: () => void;
}

function actionLabel(action: string): string {
  return action.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sameIndices(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function VideoGenerationReviewGate({
  jobId,
  disabled = false,
  fullRunRestartRequired = false,
  generationConsentAccepted = false,
  onGenerationConsentRequiredChange,
  onContinue,
  onFinalApproval,
  onRejected,
  onCreateNew,
}: VideoGenerationReviewGateProps) {
  const [review, setReview] = useState<VideoSpriteReview | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [contactSheetBlob, setContactSheetBlob] = useState<Blob | null>(null);
  const [reportBlob, setReportBlob] = useState<Blob | null>(null);
  const [reasonCodes, setReasonCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewReloadSignal, setReviewReloadSignal] = useState(0);
  const [mediaReloadSignal, setMediaReloadSignal] = useState(0);
  const videoUrl = useObjectUrl(videoBlob);
  const contactSheetUrl = useObjectUrl(contactSheetBlob);
  const reportUrl = useObjectUrl(reportBlob);
  const generationConsentRequired = videoReviewDecisionNeedsConsent(
    review,
    fullRunRestartRequired,
  );

  useEffect(() => {
    onGenerationConsentRequiredChange?.(generationConsentRequired);
  }, [generationConsentRequired, onGenerationConsentRequiredChange]);

  useEffect(() => {
    let disposed = false;
    const context = captureApiRequestContext();
    setReview(null);
    setError(null);
    void getVideoSpriteReview(jobId, context).then((next) => {
      if (!disposed) setReview(next);
    }).catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : 'Video review could not be loaded');
    });
    return () => { disposed = true; };
  }, [jobId, reviewReloadSignal]);

  useEffect(() => {
    if (!review) return;
    let disposed = false;
    const context = captureApiRequestContext();
    setVideoBlob(null);
    setContactSheetBlob(null);
    setReportBlob(null);
    setReasonCodes([]);
    setError(null);
    void Promise.all([
      getVideoSpriteReviewAsset(review.assets.video, context),
      getVideoSpriteReviewAsset(review.assets.contactSheet, context),
      getVideoSpriteReviewAsset(review.assets.report, context),
    ]).then(async ([video, contactSheet, report]) => {
      const parsedReport = await report.text().then((value) => JSON.parse(value) as unknown);
      if (disposed) return;
      setVideoBlob(video);
      setContactSheetBlob(contactSheet);
      setReportBlob(report);
      setReasonCodes(videoSpriteReasonCodes(parsedReport));
    }).catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : 'Private review media could not be loaded');
    });
    return () => { disposed = true; };
  }, [mediaReloadSignal, review?.jobId, review?.revision]);

  const assetsReady = Boolean(videoUrl && contactSheetUrl && reportUrl);
  const view = useMemo(() => review && contactSheetUrl ? {
    status: review.status,
    technicalOutcome: review.technicalOutcome,
    animationLabel: actionLabel(review.action),
    videoUrl,
    contactSheetUrl,
    reportUrl,
    proposedIndices: review.pendingAdjustmentIndices ?? review.selectedVideoIndices,
    sourceFrameCount: review.sourceFrameCount,
    reasonCodes,
    continuationAvailable: review.continuationAvailable,
    fullRunRestartRequired: review.fullRunRestartRequired,
  } : null, [contactSheetUrl, reasonCodes, reportUrl, review, videoUrl]);

  const approve = async (selectedIndices: number[]) => {
    if (!review || busy || !assetsReady) return;
    setBusy(true);
    setError(null);
    const context = captureApiRequestContext();
    try {
      const exactRevision = review.pendingAdjustmentIndices === null &&
        sameIndices(selectedIndices, review.selectedVideoIndices)
        ? review
        : await adjustVideoSpriteReview(review, selectedIndices, context);
      if (exactRevision.status !== 'awaiting_review') {
        throw new Error('The adjusted revision is no longer awaiting review');
      }
      const approved = await approveVideoSpriteReview(exactRevision, context);
      setReview(approved);
      if (!approved.continuationAvailable && !approved.fullRunRestartRequired) {
        await onFinalApproval(approved);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Video review could not be approved');
      try {
        setReview(await getVideoSpriteReview(jobId, context));
      } catch {
        // Keep the actionable decision error while the user reloads explicitly.
      }
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!review || busy || !assetsReady) return;
    const reason = window.prompt(
      'Why does this video not work? It will be archived and no new provider call will be made.',
      '',
    );
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      const rejected = await rejectVideoSpriteReview(review, reason, captureApiRequestContext());
      setReview(rejected);
      await onRejected?.(rejected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Video review could not be rejected');
    } finally {
      setBusy(false);
    }
  };

  const syncFinalFighter = async () => {
    if (!review || busy || review.status !== 'approved' || review.continuationAvailable) return;
    setBusy(true);
    setError(null);
    try {
      await onFinalApproval(review);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approved fighter could not be synced');
    } finally {
      setBusy(false);
    }
  };

  if (!review || !view) {
    if (!review && fullRunRestartRequired) {
      return (
        <section className="video-review" aria-live="polite">
          <header className="video-review__header">
            <div>
              <p className="gallery-eyebrow">Video Run Ended</p>
              <h3>Saved in your gallery</h3>
            </div>
            <span className="video-review__status is-rejected">Archived</span>
          </header>
          <p className="video-review__intro">
            This older creation option is no longer available. Your saved versions are safe. Create a new Rookie or Champion.
          </p>
          {onCreateNew ? <div className="video-review__actions">
            <button type="button" disabled={disabled} onClick={onCreateNew}>Create A New Character</button>
          </div> : null}
        </section>
      );
    }
    return (
      <section className="video-review" aria-live="polite">
        <p className="gallery-eyebrow">Human Review Required</p>
        <p className={error ? 'video-review__error' : 'video-review__intro'}>
          {error ?? 'Loading the private video and deterministic frame report...'}
        </p>
        {error ? (
          <div className="video-review__actions">
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => {
                setError(null);
                if (review) setMediaReloadSignal((current) => current + 1);
                else setReviewReloadSignal((current) => current + 1);
              }}
            >
              {review ? 'Retry Review Media' : 'Retry Review Check'}
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <VideoGenerationReviewPanel
      review={view}
      busy={
        disabled ||
        busy ||
        !assetsReady ||
        (generationConsentRequired && !generationConsentAccepted)
      }
      error={error}
      onApprove={(indices) => { void approve(indices); }}
      onReject={() => { void reject(); }}
      onContinue={() => { void onContinue(review); }}
      onFinalSync={() => { void syncFinalFighter(); }}
      onCreateNew={onCreateNew}
    />
  );
}
