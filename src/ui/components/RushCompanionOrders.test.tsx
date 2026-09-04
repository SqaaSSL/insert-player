import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RushCompanionOrders } from './RushCompanionOrders.tsx';

describe('RushCompanionOrders', () => {
  it('makes the three universal CPU postures explicit', () => {
    const markup = renderToStaticMarkup(
      <RushCompanionOrders value="cover" onChange={vi.fn()} />,
    );
    expect(markup).toContain('CPU ORDER');
    expect(markup).toContain('FOLLOW');
    expect(markup).toContain('PRESS');
    expect(markup).toContain('COVER');
    expect(markup).toContain('aria-pressed="true"');
  });
});
