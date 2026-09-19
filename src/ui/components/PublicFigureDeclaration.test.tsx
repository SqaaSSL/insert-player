import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PublicFigureDeclaration } from './PublicFigureDeclaration.tsx';

describe('public-figure self-declaration', () => {
  function render(value: boolean | null, disabled = false) {
    return renderToStaticMarkup(<PublicFigureDeclaration value={value} disabled={disabled} onChange={vi.fn()} />);
  }

  it('asks a required explicit question with neither answer selected', () => {
    const html = render(null);
    expect(html).toContain('<legend>Is this a famous person?</legend>');
    expect(html.match(/name="fighter-public-figure"/g)).toHaveLength(2);
    expect(html.match(/required=""/g)).toHaveLength(2);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('aria-describedby="creation-identity-help"');
    expect(html).not.toContain('Famous people may not generate');
  });

  it('warns before generation without promising acceptance, refunds, or provider routing', () => {
    const html = render(true);
    expect(html).toMatch(/checked=""[^>]*value="true"/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Famous people may not generate');
    expect(html).toContain('A result is not guaranteed.');
    expect(html).toContain('Any credits in your quote');
    expect(html).toContain('not automatically restored');
    expect(html).toContain('permission requirements below still apply');
    expect(html).not.toMatch(/Grok|Gemini|automatically switch|recognized|detected/);
  });

  it('hides the warning after No and never assumes permission from that answer', () => {
    const html = render(false);
    expect(html).toMatch(/checked=""[^>]*value="false"/);
    expect(html).not.toContain('Famous people may not generate');
    expect(html).not.toContain('permission confirmed');
  });

  it('disables the whole radio group when the form is busy', () => {
    expect(render(true, true)).toMatch(/<fieldset[^>]*disabled=""/);
  });
});
