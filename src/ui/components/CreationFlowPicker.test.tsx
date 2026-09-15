import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreationFlowPicker } from './CreationFlowPicker';

describe('CreationFlowPicker', () => {
  it.each(['original', 'video'] as const)('renders no DOM by default for the %s legacy flow', (value) => {
    const onChange = vi.fn();
    const markup = renderToStaticMarkup(
      <CreationFlowPicker name="hidden-creation-flow" value={value} onChange={onChange} />,
    );

    expect(markup).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders no DOM when internal review is explicitly disabled', () => {
    expect(renderToStaticMarkup(
      <CreationFlowPicker name="hidden-creation-flow" value="original" onChange={vi.fn()} internalReview={false} />,
    )).toBe('');
  });

  it('uses native radios and preserves the selected flow in opted-in internal review', () => {
    const markup = renderToStaticMarkup(
      <CreationFlowPicker
        name="fighter-creation-flow"
        value="original"
        onChange={vi.fn()}
        internalReview
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
        internalReview
      />,
    );

    expect(markup).toContain('creation-flow-picker is-compact');
    expect(markup).toMatch(/<input[^>]+disabled=""[^>]+value="video"/);
    expect(markup).toContain('Sign in to try Video.');
    expect(markup).toContain('aria-describedby=');
  });
});
