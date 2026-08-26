import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreationFlowPicker } from './CreationFlowPicker';

describe('CreationFlowPicker', () => {
  it('uses native radios and keeps Original selected by default', () => {
    const markup = renderToStaticMarkup(
      <CreationFlowPicker
        name="fighter-creation-flow"
        value="original"
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain('<fieldset class="creation-flow-picker">');
    expect(markup).toContain('<legend>Creation flow</legend>');
    expect(markup).toContain('name="fighter-creation-flow"');
    expect(markup).toMatch(/<input[^>]+checked=""[^>]+value="original"/);
    expect(markup).toContain('value="video"');
    expect(markup).toContain('Experimental');
  });

  it('explains and disables Video when the cloud flow is unavailable', () => {
    const markup = renderToStaticMarkup(
      <CreationFlowPicker
        name="retry-creation-flow"
        value="original"
        onChange={vi.fn()}
        videoAvailable={false}
        videoUnavailableReason="Sign in to try Video."
        compact
      />,
    );

    expect(markup).toContain('creation-flow-picker is-compact');
    expect(markup).toMatch(/<input[^>]+disabled=""[^>]+value="video"/);
    expect(markup).toContain('Sign in to try Video.');
    expect(markup).toContain('aria-describedby=');
  });
});
