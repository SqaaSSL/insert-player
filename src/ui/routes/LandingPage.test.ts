import { describe, expect, it } from 'vitest';
import { LANDING_STORIES } from './LandingPage.tsx';

describe('LANDING_STORIES', () => {
  it('keeps each photo, fighter, and gameplay loop in one complete story', () => {
    expect(LANDING_STORIES).toHaveLength(2);

    for (const story of LANDING_STORIES) {
      expect(story.photo).toMatch(/^\/assets\//);
      expect(story.fighter).toMatch(/^\/assets\//);
      expect(story.fightVideo).toMatch(/^\/assets\//);
      expect(story.fightPoster).toMatch(/^\/assets\//);
    }

    expect(new Set(LANDING_STORIES.map((story) => story.photo)).size).toBe(LANDING_STORIES.length);
    expect(new Set(LANDING_STORIES.map((story) => story.fighter)).size).toBe(LANDING_STORIES.length);
    expect(new Set(LANDING_STORIES.map((story) => story.fightVideo)).size).toBe(LANDING_STORIES.length);
  });
});
