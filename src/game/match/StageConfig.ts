export type StageThemeId =
  | 'dojo'
  | 'neon-rooftop'
  | 'sunset-pier'
  | 'moonlit-garden'
  | 'subway-platform';

export interface StageTheme {
  id: StageThemeId;
  label: string;
  blurb: string;
}

export const STAGE_THEMES: StageTheme[] = [
  {
    id: 'dojo',
    label: 'DOJO AT DUSK',
    blurb: 'Lanterns, clouds, and old-school tournament energy.',
  },
  {
    id: 'neon-rooftop',
    label: 'NEON ROOFTOP',
    blurb: 'City lights, billboards, and midnight hype.',
  },
  {
    id: 'sunset-pier',
    label: 'SUNSET PIER',
    blurb: 'Warm skies, ocean shimmer, and postcard drama.',
  },
  {
    id: 'moonlit-garden',
    label: 'MOONLIT GARDEN',
    blurb: 'Moon glow, drifting mist, and quiet menace.',
  },
  {
    id: 'subway-platform',
    label: 'SUBWAY PLATFORM',
    blurb: 'Fluorescent grime, rails, and last-train tension.',
  },
];

export function getStageTheme(id?: StageThemeId | null): StageTheme {
  return STAGE_THEMES.find((stage) => stage.id === id) ?? STAGE_THEMES[0];
}

export function nextStageThemeId(current?: StageThemeId | null): StageThemeId | null {
  if (!current) return STAGE_THEMES[0].id;
  const idx = STAGE_THEMES.findIndex((stage) => stage.id === current);
  if (idx < 0) return STAGE_THEMES[0].id;
  if (idx === STAGE_THEMES.length - 1) return null;
  return STAGE_THEMES[idx + 1].id;
}

export function getStageChoiceLabel(id?: StageThemeId | null): string {
  return id ? getStageTheme(id).label : 'AUTO';
}

export function getStageChoiceBlurb(id?: StageThemeId | null): string {
  return id ? getStageTheme(id).blurb : 'Let the matchup choose the arena.';
}

export function pickStageThemeIdFromSeed(seed: number): StageThemeId {
  const idx = Math.abs(seed >>> 0) % STAGE_THEMES.length;
  return STAGE_THEMES[idx].id;
}
