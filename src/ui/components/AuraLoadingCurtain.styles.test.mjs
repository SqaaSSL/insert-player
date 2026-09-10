import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const block = selector => css.slice(css.indexOf(`${selector} {`)).split('}')[0];

describe('Aura loading curtain presentation', () => {
  it('mirrors only the right upright portrait, not names or both fighters', () => {
    const upright = block('.aura-loader__fighters .is-upright .fight-loader__figure-img');
    expect(upright).toContain('object-contain object-bottom');
    expect(upright).not.toContain('scale-x-100');
    expect(block('.aura-loader__fighters .fight-loader__fighter--p2.is-upright .fight-loader__figure-img'))
      .toContain('@apply -scale-x-100;');
    expect(block('.aura-loader__fighters .fight-loader__fighter-name')).not.toContain('scale-x');
  });

  it.each(['.aura-loader__cast', '.aura-loader__briefing', '.aura-loader__stage-art img'])
    ('finishes %s within the one-second opening handoff', selector => {
      expect(block(selector)).toContain('transform_950ms_cubic-bezier(0.76,0,0.24,1),opacity_650ms_ease-out');
    });

  it('retains the short reduced-motion transition', () => {
    const ruleIndex = css.indexOf('.fight-loader.is-aura .aura-loader__cast,');
    const reduced = css.slice(
      css.lastIndexOf('@media (prefers-reduced-motion: reduce)', ruleIndex),
      css.indexOf('}', ruleIndex) + 1,
    );
    expect(reduced).toContain('.fight-loader.is-aura .aura-loader__cast,');
    expect(reduced).toContain('.fight-loader.is-aura .aura-loader__briefing,');
    expect(reduced).toContain('.fight-loader.is-aura .aura-loader__stage-art img { @apply duration-150; }');
  });
});
