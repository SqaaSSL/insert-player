import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VideoGenerationReviewGate } from './VideoGenerationReviewGate';

describe('retired Video creation archive', () => {
  it('offers a new character even when no review candidate exists and no new generation consent is given', () => {
    const markup = renderToStaticMarkup(<VideoGenerationReviewGate
      jobId="old-terminal-job"
      fullRunRestartRequired
      generationConsentAccepted={false}
      onContinue={vi.fn()}
      onFinalApproval={vi.fn()}
      onCreateNew={vi.fn()}
    />);
    expect(markup).toContain('Archived');
    expect(markup).toContain('Your saved versions are safe');
    expect(markup).toContain('Create A New Character');
    expect(markup).not.toContain('Start A New Complete Video Run');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('Accept Terms');
  });
});
