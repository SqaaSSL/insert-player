import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TrialGameChoice } from './TrialGameChoice.tsx';

vi.mock('./GameplayEntryPreview.tsx', () => ({ GameplayEntryPreview: () => <div>preview</div> }));

describe('TrialGameChoice with a game picked on the home page', () => {
  it('lists the picked game first as the only primary action', () => {
    const html = renderToStaticMarkup(<TrialGameChoice onPlay={vi.fn()} preferred="fight" />);
    expect(html.indexOf('Try Fight')).toBeLessThan(html.indexOf('Try Aura'));
    expect(html.match(/asf-btn--primary/g)).toHaveLength(1);
    expect(html).toContain('is-preferred');
  });
  it('keeps Aura and Fight as equals without a pick', () => {
    const html = renderToStaticMarkup(<TrialGameChoice onPlay={vi.fn()} />);
    expect(html.indexOf('Try Aura')).toBeLessThan(html.indexOf('Try Fight'));
    expect(html.match(/asf-btn--primary/g)).toHaveLength(2);
  });
});
