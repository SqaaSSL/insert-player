import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TurnstileChallenge } from './TurnstileChallenge';

describe('TurnstileChallenge', () => {
  it('renders the standard response field for server verification tooling', () => {
    const html = renderToStaticMarkup(
      <TurnstileChallenge
        siteKey="site-key"
        resetSignal={0}
        onTokenChange={() => undefined}
      />,
    );

    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="cf-turnstile-response"');
    expect(html).toContain('value=""');
  });
});
