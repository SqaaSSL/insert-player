import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StageScoutPage } from './StageScoutPage.tsx';

describe('Stage Scout Crew mission', () => {
  it('preserves the Stage Scout UI while making the single Crew slot explicit', () => {
    const markup = renderToStaticMarkup(
      <StageScoutPage
        crew={{ id: 'org_alpha', name: 'Alpha Crew' }}
        onBack={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(markup).toContain('stage-scout');
    expect(markup).toContain('Crew Home Stage · One Included');
    expect(markup).toContain("Choose Alpha Crew&#x27;s Stage");
    expect(markup).toContain('Decide together');
    expect(markup).toContain('bar, park, pitch, or corner');
  });
});
