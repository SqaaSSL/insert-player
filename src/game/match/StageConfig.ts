export type ClassicStageThemeId =
  | 'dojo'
  | 'neon-rooftop'
  | 'sunset-pier'
  | 'moonlit-garden'
  | 'subway-platform';

export type SignatureStageThemeId =
  | 'executive-rumble'
  | 'mars-incorporated'
  | 'tablao-3000'
  | 'la-jaula-304';

export type StageThemeId = ClassicStageThemeId | SignatureStageThemeId;

export interface StageTheme {
  id: StageThemeId;
  label: string;
  blurb: string;
  assetPath?: string;
  signatureForArcadeSlug?: string;
}

export const CLASSIC_STAGE_THEMES: StageTheme[] = [
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

export const SIGNATURE_STAGE_THEMES: StageTheme[] = [
  {
    id: 'executive-rumble',
    label: 'EXECUTIVE RUMBLE',
    blurb: 'White House lawn, press lights, and executive-order chaos.',
    assetPath: '/assets/stages/signature/executive-rumble-v2.png',
    signatureForArcadeSlug: 'donald-trump',
  },
  {
    id: 'mars-incorporated',
    label: 'MARS INCORPORATED',
    blurb: 'Red dust, launch hardware, and a hostile corporate frontier.',
    assetPath: '/assets/stages/signature/mars-incorporated-v1.png',
    signatureForArcadeSlug: 'elon-musk',
  },
  {
    id: 'tablao-3000',
    label: 'TABLAO 3000',
    blurb: 'Flamenco heat, workshop steel, and roses under red curtains.',
    assetPath: '/assets/stages/signature/tablao-3000-v1.png',
    signatureForArcadeSlug: 'rosalia',
  },
  {
    id: 'la-jaula-304',
    label: 'LA JAULA 304',
    blurb: 'A caged neighborhood pitch glowing at Mediterranean golden hour.',
    assetPath: '/assets/stages/signature/la-jaula-304-v1.png',
    signatureForArcadeSlug: 'lamine-yamal',
  },
];

export const STAGE_THEMES: StageTheme[] = [
  ...CLASSIC_STAGE_THEMES,
  ...SIGNATURE_STAGE_THEMES,
];

export interface ResolveRosterStageThemeInput {
  manualStageId?: StageThemeId | null;
  hasCustomPhotoStage?: boolean;
  p1ArcadeSlug?: string | null;
  p2ArcadeSlug?: string | null;
}

export function getStageTheme(id?: StageThemeId | null): StageTheme {
  return STAGE_THEMES.find((stage) => stage.id === id) ?? STAGE_THEMES[0];
}

export function getSignatureStageThemeIdForArcadeSlug(
  arcadeSlug?: string | null,
): SignatureStageThemeId | null {
  if (!arcadeSlug) return null;
  const stage = SIGNATURE_STAGE_THEMES.find(
    (entry) => entry.signatureForArcadeSlug === arcadeSlug,
  );
  return (stage?.id as SignatureStageThemeId | undefined) ?? null;
}

export function resolveAutoSignatureStageThemeId(
  p1ArcadeSlug?: string | null,
  p2ArcadeSlug?: string | null,
): SignatureStageThemeId | null {
  return getSignatureStageThemeIdForArcadeSlug(p2ArcadeSlug)
    ?? getSignatureStageThemeIdForArcadeSlug(p1ArcadeSlug);
}

export function resolveRosterStageThemeId({
  manualStageId,
  hasCustomPhotoStage = false,
  p1ArcadeSlug,
  p2ArcadeSlug,
}: ResolveRosterStageThemeInput): StageThemeId | undefined {
  if (hasCustomPhotoStage) return undefined;
  if (manualStageId) return manualStageId;
  return resolveAutoSignatureStageThemeId(p1ArcadeSlug, p2ArcadeSlug) ?? undefined;
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

export function pickStageThemeIdFromSeed(seed: number): ClassicStageThemeId {
  const idx = Math.abs(seed >>> 0) % CLASSIC_STAGE_THEMES.length;
  return CLASSIC_STAGE_THEMES[idx].id as ClassicStageThemeId;
}
