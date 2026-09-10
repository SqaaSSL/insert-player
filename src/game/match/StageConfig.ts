import { GROUND_Y } from '../constants.ts';

// Kept only so an already-running legacy scene can still render safely. These
// procedural placeholders are not part of the selectable or random stage catalog.
export type LegacyProceduralStageThemeId =
  | 'dojo'
  | 'neon-rooftop'
  | 'sunset-pier'
  | 'moonlit-garden'
  | 'subway-platform';

export type SignatureStageThemeId =
  | 'insert-player-arena'
  | 'executive-rumble'
  | 'mars-incorporated'
  | 'tablao-3000'
  | 'la-jaula-304'
  | 'side-street';

export const DEFAULT_AURA_STAGE_ID = 'aura-plaza-v3' as const;
export const AURA_PLAZA_ASSET_PATH = '/assets/stages/aura/aura-plaza-v3.webp';

export type AuraStageThemeId = 'aura-plaza' | 'aura-plaza-v2' | typeof DEFAULT_AURA_STAGE_ID;
export type StageThemeId = LegacyProceduralStageThemeId | SignatureStageThemeId | AuraStageThemeId;
export type StageMode = 'fight' | 'rush' | 'aura';

export interface StageTheme {
  id: StageThemeId;
  label: string;
  blurb: string;
  assetPath?: string;
  /** Existing stages are Fight-only unless they opt into another mode. */
  modes?: readonly StageMode[];
  /** Retained for saved matches/challenges, but absent from new stage selections. */
  hiddenFromSelection?: boolean;
  /** A full authored horizontal route, never a repeated Fight backdrop. */
  rushAssetPath?: string;
  /** Fight-plane calibration for this exact authored plate. */
  fightFloorY?: number;
  fighterRenderScale?: number;
  fighterRenderYOffset?: number;
  /** Authored performer foot line as a fraction of the Aura source plate height. */
  auraFloorRatio?: number;
  signatureForArcadeSlug?: string;
}

export const SIGNATURE_STAGE_THEMES: StageTheme[] = [
  {
    id: 'insert-player-arena',
    label: 'INSERT PLAYER ARENA',
    blurb: 'Red corner, blue corner, main-event lights, and a rain-slick tournament floor.',
    assetPath: '/assets/stages/signature/insert-player-arena-pipeline-v1.png',
  },
  {
    id: 'executive-rumble',
    label: 'EXECUTIVE RUMBLE',
    blurb: 'White House lawn, press lights, and executive-order chaos.',
    assetPath: '/assets/stages/signature/executive-rumble-pipeline-v1.png',
    signatureForArcadeSlug: 'donald-trump',
  },
  {
    id: 'mars-incorporated',
    label: 'MARS INCORPORATED',
    blurb: 'Red dust, launch hardware, and a hostile corporate frontier.',
    assetPath: '/assets/stages/signature/mars-incorporated-pipeline-v1.png',
    signatureForArcadeSlug: 'elon-musk',
  },
  {
    id: 'tablao-3000',
    label: 'TABLAO 3000',
    blurb: 'Flamenco heat, workshop steel, and roses under red curtains.',
    assetPath: '/assets/stages/signature/tablao-3000-pipeline-v1.png',
    signatureForArcadeSlug: 'rosalia-v2',
  },
  {
    id: 'la-jaula-304',
    label: 'LA JAULA 304',
    blurb: 'From Mediterranean golden hour to a floodlit neighborhood lockdown.',
    assetPath: '/assets/rush/la-jaula-304/la-jaula-304-fight-v2.webp',
    rushAssetPath: '/assets/rush/la-jaula-304/la-jaula-304-route-v1.webp',
    modes: ['fight', 'rush'],
    fightFloorY: 480,
    fighterRenderScale: 1.03,
    fighterRenderYOffset: 0,
    signatureForArcadeSlug: 'lamine-yamal',
  },
  {
    id: 'side-street',
    label: 'SIDE STREET',
    blurb: 'Golden-hour workshops open into a four-screen industrial night run.',
    assetPath: '/assets/rush/side-street/side-street-fight-v1.webp',
    rushAssetPath: '/assets/rush/side-street/side-street-route-v1.webp',
    modes: ['fight', 'rush'],
    fightFloorY: 480,
    fighterRenderScale: 1.03,
    fighterRenderYOffset: 0,
  },
];

// Keep the established Fight catalog and its seeded ordering stable. Dedicated
// Aura stages do not become combat arenas simply by joining the global catalog.
export const AURA_STAGE_THEMES: StageTheme[] = [
  {
    id: DEFAULT_AURA_STAGE_ID,
    label: 'AURA PLAZA',
    blurb: 'Step into the circle: a crowd up close, worlds beyond, and two players competing for all the Aura.',
    assetPath: AURA_PLAZA_ASSET_PATH,
    modes: ['aura'],
    auraFloorRatio: 0.82,
  },
  {
    id: 'aura-plaza-v2',
    label: 'AURA PLAZA',
    blurb: 'Step into the circle: a crowd up close, worlds beyond, and two players competing for all the Aura.',
    assetPath: '/assets/stages/aura/aura-plaza-v2.webp',
    modes: ['aura'],
    hiddenFromSelection: true,
    auraFloorRatio: 0.82,
  },
  {
    id: 'aura-plaza',
    label: 'AURA PLAZA',
    blurb: 'Step into the circle: a crowd up close, worlds beyond, and two players competing for all the Aura.',
    assetPath: '/assets/stages/aura/aura-plaza-v1.webp',
    modes: ['aura'],
    hiddenFromSelection: true,
    auraFloorRatio: 0.82,
  },
];

export const STAGE_THEMES: StageTheme[] = [...SIGNATURE_STAGE_THEMES, ...AURA_STAGE_THEMES];

export interface ResolveRosterStageThemeInput {
  mode?: StageMode;
  manualStageId?: StageThemeId | null;
  hasCustomPhotoStage?: boolean;
  p1ArcadeSlug?: string | null;
  p2ArcadeSlug?: string | null;
}

export function getStageTheme(id?: StageThemeId | null): StageTheme {
  return STAGE_THEMES.find((stage) => stage.id === id) ?? STAGE_THEMES[0];
}

export interface FightStageCalibration {
  floorY: number;
  fighterScale: number;
  fighterYOffset: number;
}

export function getFightStageCalibration(
  stageId?: StageThemeId | null,
  customStage = false,
): FightStageCalibration {
  if (customStage) {
    return { floorY: GROUND_Y + 18, fighterScale: 1.2, fighterYOffset: 18 };
  }
  const stage = getStageTheme(stageId);
  const floorY = stage.fightFloorY ?? GROUND_Y;
  return {
    floorY,
    fighterScale: stage.fighterRenderScale ?? 1.03,
    fighterYOffset: stage.fighterRenderYOffset ?? floorY - GROUND_Y,
  };
}

export function stageSupportsMode(stageId: StageThemeId, mode: StageMode): boolean {
  const stage = getStageTheme(stageId);
  const modes = stage.modes ?? ['fight'];
  return mode === 'aura' ? modes.includes('aura') || modes.includes('fight') : modes.includes(mode);
}

export function getStageThemesForMode(mode: StageMode): StageTheme[] {
  return STAGE_THEMES.filter((stage) => !stage.hiddenFromSelection && stageSupportsMode(stage.id, mode));
}

export function getDefaultStageThemeIdForMode(mode: StageMode): StageThemeId {
  if (mode === 'aura') return DEFAULT_AURA_STAGE_ID;
  if (mode === 'rush' && stageSupportsMode('side-street', 'rush')) return 'side-street';
  return getStageThemesForMode(mode)[0]?.id ?? STAGE_THEMES[0].id;
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
  mode,
  manualStageId,
  hasCustomPhotoStage = false,
  p1ArcadeSlug,
  p2ArcadeSlug,
}: ResolveRosterStageThemeInput): StageThemeId | undefined {
  if (hasCustomPhotoStage) return undefined;
  if (manualStageId) return manualStageId;
  if (mode === 'aura') return DEFAULT_AURA_STAGE_ID;
  return resolveAutoSignatureStageThemeId(p1ArcadeSlug, p2ArcadeSlug) ?? undefined;
}

export function nextStageThemeId(current?: StageThemeId | null, mode: StageMode = 'fight'): StageThemeId | null {
  const stages = getStageThemesForMode(mode);
  if (!current) return stages[0].id;
  const idx = stages.findIndex((stage) => stage.id === current);
  if (idx < 0) return stages[0].id;
  if (idx === stages.length - 1) return null;
  return stages[idx + 1].id;
}

export function getStageChoiceLabel(id?: StageThemeId | null): string {
  return id ? getStageTheme(id).label : 'AUTO';
}

export function getStageChoiceBlurb(id?: StageThemeId | null): string {
  return id ? getStageTheme(id).blurb : 'Let the matchup choose the arena.';
}

export function pickStageThemeIdFromSeed(seed: number): SignatureStageThemeId {
  const idx = Math.abs(seed >>> 0) % SIGNATURE_STAGE_THEMES.length;
  return SIGNATURE_STAGE_THEMES[idx].id as SignatureStageThemeId;
}
