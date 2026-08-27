import { describe, expect, it } from 'vitest';
import { normalizeRoute } from './App';

describe('App route normalization', () => {
  it('preserves valid direct routes', () => {
    expect(normalizeRoute('/fight', '')).toBe('/fight');
    expect(normalizeRoute('/roster/vs/', '')).toBe('/roster/vs');
  });

  it('falls back to the menu for unknown paths', () => {
    expect(normalizeRoute('/not-a-route', '')).toBe('/menu');
    expect(normalizeRoute('/', '#/community')).toBe('/community');
  });
});
