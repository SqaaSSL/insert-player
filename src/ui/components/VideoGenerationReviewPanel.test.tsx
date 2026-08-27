import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  VideoGenerationReviewPanel,
  parseVideoReviewIndices,
} from './VideoGenerationReviewPanel';

describe('parseVideoReviewIndices', () => {
  it('accepts the exact increasing source-frame selection', () => {
    expect(parseVideoReviewIndices('0, 4, 9, 15', 20, 4)).toEqual([0, 4, 9, 15]);
  });

  it('rejects wrong counts, duplicates, ordering mistakes, and out-of-range frames', () => {
    expect(() => parseVideoReviewIndices('0, 4, 9', 20, 4)).toThrow(/exactly 4/i);
    expect(() => parseVideoReviewIndices('0, 4, 4, 9', 20, 4)).toThrow(/unique/i);
    expect(() => parseVideoReviewIndices('0, 9, 4, 12', 20, 4)).toThrow(/increasing/i);
    expect(() => parseVideoReviewIndices('0, 4, 9, 20', 20, 4)).toThrow(/between 0 and 19/i);
  });
});

describe('VideoGenerationReviewPanel', () => {
  it('renders a paused review with contact sheet, indices, findings, and decisions', () => {
    const markup = renderToStaticMarkup(
      <VideoGenerationReviewPanel
        review={{
          status: 'awaiting_review',
          technicalOutcome: 'needs_review',
          animationLabel: 'High Kick',
          videoUrl: 'blob:https://app.example/video',
          contactSheetUrl: 'https://assets.example/contact-sheet.png',
          reportUrl: 'https://assets.example/report.json',
          proposedIndices: [0, 7, 15, 23],
          sourceFrameCount: 24,
          reasonCodes: ['motion_step_review'],
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(markup).toContain('Human Review Required');
    expect(markup).toContain('Paused Safely');
    expect(markup).toContain('contact-sheet.png');
    expect(markup).toContain('<video');
    expect(markup).toContain('controls=""');
    expect(markup).toContain('value="0, 7, 15, 23"');
    expect(markup).toContain('motion step review');
    expect(markup).toContain('Approve Proposed Frames');
    expect(markup).toContain('Reject Video');
    expect(markup).toContain('Open Technical Report');
  });

  it('shows an explicit continuation only after approval', () => {
    const markup = renderToStaticMarkup(
      <VideoGenerationReviewPanel
        review={{
          status: 'approved',
          technicalOutcome: 'technical_pass',
          animationLabel: 'Walk',
          contactSheetUrl: 'blob:https://app.example/contact',
          proposedIndices: [1, 4, 7, 10],
          sourceFrameCount: 12,
          reasonCodes: [],
          continuationAvailable: true,
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    expect(markup).toContain('Approved');
    expect(markup).toContain('Continue To Next Action');
    expect(markup).not.toContain('Reject Video');
  });

  it('offers an explicit full restart after a terminal rejection', () => {
    const markup = renderToStaticMarkup(
      <VideoGenerationReviewPanel
        review={{
          status: 'rejected',
          technicalOutcome: 'reject',
          animationLabel: 'High Kick',
          contactSheetUrl: 'blob:https://app.example/contact',
          proposedIndices: [1, 4, 7, 10],
          sourceFrameCount: 12,
          reasonCodes: ['provider_motion_failed'],
          fullRunRestartRequired: true,
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRestart={vi.fn()}
      />,
    );

    expect(markup).toContain('Restart Required');
    expect(markup).toContain('Start A New Complete Video Run');
    expect(markup).not.toContain('Continue To Next Action');
  });

  it('does not call an integrity-failed approved revision complete', () => {
    const markup = renderToStaticMarkup(
      <VideoGenerationReviewPanel
        review={{
          status: 'approved',
          technicalOutcome: 'technical_pass',
          animationLabel: 'Victory',
          contactSheetUrl: 'blob:https://app.example/contact',
          proposedIndices: [1, 4, 7, 10],
          sourceFrameCount: 12,
          reasonCodes: [],
          continuationAvailable: false,
          fullRunRestartRequired: true,
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRestart={vi.fn()}
      />,
    );

    expect(markup).toContain('Restart Required');
    expect(markup).toContain('Start A New Complete Video Run');
    expect(markup).not.toContain('Continue To Next Action');
  });
});
