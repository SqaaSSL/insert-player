import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Node-only stylesheet fixture; keep filesystem types out of the browser TS project.
describe('Aura control alignment', () => {
  it.each([
    ['.aura-game-toolbar .aura-touch-controls {', 1024, [404, 476, 548, 620]],
    ['.game-shell.is-aura.is-portrait .aura-touch-controls {', 576, [123, 233, 343, 453]],
  ])('keeps the CSS row centered under each note column: %s', (selector, width, expected) => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf(selector)).split('}')[0];
    const left = Number(block.match(/left-\[([\d.]+)%\]/)?.[1]) / 100;
    const rowWidth = Number(block.match(/w-\[([\d.]+)%\]/)?.[1]) / 100;
    expected.forEach((center, lane) => {
      expect(width * (left + rowWidth * (lane + 0.5) / 4)).toBeCloseTo(center, 4);
    });
    expect(css).toContain('.aura-game-toolbar .aura-touch-controls__lane { @apply mx-0.5 min-h-11; }');
  });
});
