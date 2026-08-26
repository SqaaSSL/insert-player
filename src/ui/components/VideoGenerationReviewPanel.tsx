import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';

export interface VideoGenerationReviewView {
  status?: 'awaiting_review' | 'approved' | 'rejected';
  technicalOutcome: 'technical_pass' | 'needs_review' | 'reject';
  animationLabel: string;
  videoUrl?: string | null;
  contactSheetUrl: string;
  reportUrl?: string | null;
  proposedIndices: number[];
  sourceFrameCount: number;
  reasonCodes: string[];
  continuationAvailable?: boolean;
  fullRunRestartRequired?: boolean;
}

interface VideoGenerationReviewPanelProps {
  review: VideoGenerationReviewView;
  busy?: boolean;
  error?: string | null;
  onApprove: (selectedIndices: number[]) => void;
  onReject: () => void;
  onContinue?: () => void;
  onRestart?: () => void;
}

export function parseVideoReviewIndices(
  value: string,
  sourceFrameCount: number,
  requiredCount: number,
): number[] {
  const tokens = value.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length !== requiredCount) {
    throw new Error(`Choose exactly ${requiredCount} frame indices.`);
  }
  const indices = tokens.map((token) => Number(token));
  if (indices.some((index) => !Number.isSafeInteger(index))) {
    throw new Error('Frame indices must be whole numbers.');
  }
  if (indices.some((index) => index < 0 || index >= sourceFrameCount)) {
    throw new Error(`Frame indices must be between 0 and ${Math.max(0, sourceFrameCount - 1)}.`);
  }
  if (indices.some((index, position) => position > 0 && index <= indices[position - 1])) {
    throw new Error('Frame indices must be unique and in increasing order.');
  }
  return indices;
}

function readableReason(code: string): string {
  return code.replaceAll('_', ' ').replaceAll('-', ' ');
}

export function VideoGenerationReviewPanel({
  review,
  busy = false,
  error,
  onApprove,
  onReject,
  onContinue,
  onRestart,
}: VideoGenerationReviewPanelProps) {
  const id = useId();
  const [draftIndices, setDraftIndices] = useState(review.proposedIndices.join(', '));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraftIndices(review.proposedIndices.join(', '));
    setValidationError(null);
  }, [review.proposedIndices]);

  const proposedValue = useMemo(() => review.proposedIndices.join(', '), [review.proposedIndices]);
  const adjusted = draftIndices.trim() !== proposedValue;
  const status = review.status ?? 'awaiting_review';
  const awaitingReview = status === 'awaiting_review';
  const restartRequired = Boolean(review.fullRunRestartRequired);
  const helpId = `${id}-indices-help`;
  const errorId = `${id}-error`;

  const approve = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const indices = parseVideoReviewIndices(
        draftIndices,
        review.sourceFrameCount,
        review.proposedIndices.length,
      );
      setValidationError(null);
      onApprove(indices);
    } catch (parseError) {
      setValidationError(parseError instanceof Error ? parseError.message : 'Review the frame indices.');
    }
  };

  return (
    <section className="video-review" aria-labelledby={`${id}-title`}>
      <header className="video-review__header">
        <div>
          <p className="gallery-eyebrow">Human Review Required</p>
          <h3 id={`${id}-title`}>{review.animationLabel}</h3>
        </div>
        <span className={`video-review__status is-${restartRequired ? 'rejected' : status}`}>
          {restartRequired ? 'Restart Required' : awaitingReview ? 'Paused Safely' : status === 'approved' ? 'Approved' : 'Rejected'}
        </span>
      </header>

      <p className="video-review__intro">
        {restartRequired
          ? 'This exact review remains archived, but the complete run failed its final integrity check. Starting again creates a new complete paid Video run.'
          : awaitingReview
          ? 'The compiler has proposed a frame sequence. Nothing is promoted until you approve it.'
          : status === 'approved'
            ? 'This exact private revision is approved and promoted. Continue when you are ready for the next action.'
            : 'This video remains archived privately and will not be promoted or continued.'}
      </p>

      {review.videoUrl ? (
        <figure className="video-review__figure video-review__figure--video">
          <video
            src={review.videoUrl}
            controls
            loop
            muted
            playsInline
            preload="metadata"
            aria-label={`Generated source video for ${review.animationLabel}`}
          />
          <figcaption>Private source video · looped for inspection</figcaption>
        </figure>
      ) : null}

      <figure className="video-review__figure">
        <img
          src={review.contactSheetUrl}
          alt={`All extracted frames for ${review.animationLabel}, labelled by source index`}
        />
        <figcaption>
          Contact sheet · {review.sourceFrameCount} source frames
        </figcaption>
      </figure>

      {review.reasonCodes.length > 0 ? (
        <div className="video-review__findings">
          <strong>
            {review.technicalOutcome === 'technical_pass'
              ? 'Technical gate notes'
              : review.technicalOutcome === 'needs_review'
                ? 'Technical review required'
                : 'Technical gate rejected this selection'}
          </strong>
          <ul>
            {review.reasonCodes.map((code) => <li key={code}>{readableReason(code)}</li>)}
          </ul>
        </div>
      ) : (
        <p className={`video-review__findings${review.technicalOutcome === 'technical_pass' ? ' is-clear' : ''}`}>
          {review.technicalOutcome === 'technical_pass'
            ? 'Technical gates passed.'
            : review.technicalOutcome === 'needs_review'
              ? 'The compiler could not decide safely. Inspect the source video and every selected frame.'
              : 'This proposed selection cannot be approved unchanged. Adjust the indices or reject the video.'}
        </p>
      )}

      {awaitingReview ? <form className="video-review__form" onSubmit={approve}>
        <label htmlFor={`${id}-indices`}>Selected source indices</label>
        <input
          id={`${id}-indices`}
          type="text"
          value={draftIndices}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${helpId}${validationError || error ? ` ${errorId}` : ''}`}
          aria-invalid={Boolean(validationError || error)}
          onChange={(event) => {
            setDraftIndices(event.target.value);
            setValidationError(null);
          }}
        />
        <small id={helpId}>
          Keep {review.proposedIndices.length} unique indices in increasing order, separated by commas.
        </small>
        {validationError || error ? (
          <p id={errorId} className="video-review__error" role="alert">
            {validationError ?? error}
          </p>
        ) : null}

        <div className="video-review__actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Submitting Review...' : adjusted ? 'Approve Adjusted Frames' : 'Approve Proposed Frames'}
          </button>
          {adjusted ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraftIndices(proposedValue);
                setValidationError(null);
              }}
            >
              Reset Proposed
            </button>
          ) : null}
          <button type="button" className="is-danger" disabled={busy} onClick={onReject}>
            Reject Video
          </button>
          {review.reportUrl ? (
            <a href={review.reportUrl} target="_blank" rel="noreferrer">
              Open Technical Report
            </a>
          ) : null}
        </div>
      </form> : (
        <div className="video-review__actions">
          {status === 'approved' && !restartRequired && review.continuationAvailable && onContinue ? (
            <button type="button" disabled={busy} onClick={onContinue}>
              {busy ? 'Preparing Next Action...' : 'Continue To Next Action'}
            </button>
          ) : null}
          {restartRequired && onRestart ? (
            <button type="button" disabled={busy} onClick={onRestart}>
              {busy ? 'Preparing New Run...' : 'Start A New Complete Video Run'}
            </button>
          ) : null}
          {review.reportUrl ? (
            <a href={review.reportUrl} target="_blank" rel="noreferrer">
              Open Technical Report
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}
