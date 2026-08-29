import { createHash } from 'node:crypto';

export const TRUMP_PROD_FLOW_RUN_ID = 'trump-prod-flow-all-renderers-20260823-v1';
export const TRUMP_PROD_FLOW_CONFIRMATION = TRUMP_PROD_FLOW_RUN_ID;
export const TRUMP_PROD_FLOW_HARD_CAP_USD = 2.05;
export const TRUMP_PROD_FLOW_MAX_SUBMISSIONS = 60;
export const TRUMP_PROD_FLOW_SEEDS = {
  source: 2026082301,
  scaffold: 2026082302,
  frames: [2026082310, 2026082311, 2026082312, 2026082313],
} as const;

export type TrumpRendererId =
  | 'gemini-flash'
  | 'klein-4b'
  | 'klein-9b'
  | 'flux2-pro'
  | 'flux2-flash'
  | 'seedream-4';

export type TrumpAdapter = 'gemini' | 'fal';

export interface TrumpRenderer {
  id: TrumpRendererId;
  label: string;
  adapter: TrumpAdapter;
  model: string;
  endpoint: string;
  guardedSourceUsd: number;
  guardedScaffoldUsd: number;
  guardedFrameUsd: number;
  pricingSource: string;
}

export const TRUMP_RENDERERS: TrumpRenderer[] = [
  {
    id: 'gemini-flash',
    label: 'Gemini 3.1 Flash Image',
    adapter: 'gemini',
    model: 'gemini-3.1-flash-image',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent',
    guardedSourceUsd: 0.077,
    guardedScaffoldUsd: 0.077,
    guardedFrameUsd: 0.077,
    pricingSource: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  {
    id: 'klein-4b',
    label: 'FLUX.2 Klein 4B via fal',
    adapter: 'fal',
    model: 'fal-ai/flux-2/klein/4b/edit',
    endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/4b/edit',
    guardedSourceUsd: 0.105,
    guardedScaffoldUsd: 0.105,
    guardedFrameUsd: 0.03,
    pricingSource: 'https://fal.ai/models/fal-ai/flux-2/klein/4b/edit',
  },
  {
    id: 'klein-9b',
    label: 'FLUX.2 Klein 9B via fal',
    adapter: 'fal',
    model: 'fal-ai/flux-2/klein/9b/edit',
    endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/9b/edit',
    guardedSourceUsd: 0.059,
    guardedScaffoldUsd: 0.059,
    guardedFrameUsd: 0.033,
    pricingSource: 'https://fal.ai/models/fal-ai/flux-2/klein/9b/edit',
  },
  {
    id: 'flux2-pro',
    label: 'FLUX.2 Pro via fal',
    adapter: 'fal',
    model: 'fal-ai/flux-2-pro/edit',
    endpoint: 'https://queue.fal.run/fal-ai/flux-2-pro/edit',
    guardedSourceUsd: 0.21,
    guardedScaffoldUsd: 0.21,
    guardedFrameUsd: 0.06,
    pricingSource: 'https://fal.ai/models/fal-ai/flux-2-pro/edit',
  },
  {
    id: 'flux2-flash',
    label: 'FLUX.2 Flash via fal',
    adapter: 'fal',
    model: 'fal-ai/flux-2/flash/edit',
    endpoint: 'https://queue.fal.run/fal-ai/flux-2/flash/edit',
    guardedSourceUsd: 0.02,
    guardedScaffoldUsd: 0.02,
    guardedFrameUsd: 0.02,
    pricingSource: 'https://fal.ai/models/fal-ai/flux-2/flash/edit',
  },
  {
    id: 'seedream-4',
    label: 'Seedream 4 via fal',
    adapter: 'fal',
    model: 'fal-ai/bytedance/seedream/v4/edit',
    endpoint: 'https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit',
    guardedSourceUsd: 0.03,
    guardedScaffoldUsd: 0.03,
    guardedFrameUsd: 0.03,
    pricingSource: 'https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit',
  },
];

export const TRUMP_COMMON_GUARDS = {
  cleanupPerFrameUsd: 0.0005,
} as const;

export function guardedBudgetUsd(): number {
  const frames = TRUMP_RENDERERS.reduce(
    (total, renderer) => total + renderer.guardedSourceUsd + renderer.guardedScaffoldUsd + renderer.guardedFrameUsd * 4,
    0,
  );
  return Number((
    frames +
    TRUMP_COMMON_GUARDS.cleanupPerFrameUsd * TRUMP_RENDERERS.length * 4
  ).toFixed(6));
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildTrumpSourcePrompt(): string {
  return [
    'This is a benign, non-deceptive artistic transformation of a licensed public-domain portrait into a clearly synthetic fighting-game avatar.',
    'Using IMAGE 1 as the exact identity and surface-appearance reference, create the same adult person as a premium realistic 2.5D full-body arcade fighter.',
    'Preserve recognizable facial structure, apparent age, swept light-blond hair and individual hair texture, natural skin texture and tone, navy suit fabric, white shirt, light blue tie, lapel pin, and polished black shoes without caricature or exaggeration.',
    'Show exactly one complete adult from head to shoe soles in a neutral three-quarter fighting guard facing right, fists raised, both feet visible and planted, with realistic anatomy.',
    'The output has one head, one torso, two shoulders, exactly two arms ending in two hands, and exactly two legs ending in two feet.',
    'Do not depict a real event, political message, endorsement, campaign material, podium, flag, slogan, logo, prop, documentary scene, or additional person.',
    'No cartoon, anime, cel shading, comic outlines, flat illustration, plastic skin, or exaggerated proportions.',
    'Use a perfectly flat, uniform pure chroma green #00FF00 background with no floor line, shadow, gradient, texture, or scenery.',
  ].join(' ');
}

export function buildTrumpHighKickScaffoldPrompt(): string {
  return [
    'Create one 2 by 2 sprite-sheet image containing exactly four equal cells of this exact character performing the outward half of a grounded standing high kick.',
    'IMAGE 1 is the canonical full-body identity, outfit, texture, scale, and style anchor. Use no other person or anatomy.',
    'Read cells left-to-right, top-to-bottom.',
    'CELL 1: neutral ready guard before the attack; both legs point downward and both feet are planted; this cell is not a kick.',
    'CELL 2: initial compact knee chamber; one support foot planted and exactly one raised knee bent; no extension yet.',
    'CELL 3: advanced higher chamber with the same single support leg; the kicking leg begins to open but is not at impact.',
    'CELL 4: fully extended high side-kick impact; one planted support leg and exactly one straight kicking leg.',
    'Every cell contains exactly one complete connected adult body with one head, one torso, two shoulders, exactly two arms and two hands, and exactly two legs and two feet.',
    'Never duplicate, branch, merge, hide, crop, trail, or blur a limb. Never add a third arm, hand, leg, or shoe.',
    'Keep the character facing right, at the same camera distance and body scale in all four cells, with the full body visible and green margin around it.',
    'Preserve the exact face, hair, natural skin detail, navy suit, white shirt, light blue tie, lapel pin, black shoes, materials, lighting, and premium realistic 2.5D style from IMAGE 1.',
    'The entire background of every cell is perfectly flat uniform pure #00FF00 with no floor, shadow, gradient, grid lines, labels, text, or scenery.',
    'Return exactly one image containing the 2 by 2 sheet and nothing else.',
  ].join(' ');
}

const FRAME_CONTRACTS = [
  'This is the neutral guard before the attack, not a kick. Both legs point down and both feet are fully planted. Both arms are flexed in guard; there is no hanging or extra arm.',
  'This is the initial chamber, not impact. Exactly one support leg is planted and exactly one raised leg has a bent knee. Both arms remain in the guard shown in the base cell.',
  'This is the advanced high chamber, not impact. Exactly one support leg is planted and exactly one raised kicking leg remains bent while beginning to open. Copy both arm positions from the base cell.',
  'This is the single fully extended high-kick impact. Exactly one support leg is planted and exactly one kicking leg is straight and extended. Copy the two arm positions from the base cell; never add a hanging third arm.',
] as const;

function sharedFrameRules(frameIndex: number): string[] {
  return [
    FRAME_CONTRACTS[frameIndex],
    'The final image contains exactly one complete connected adult person: one head, one torso, two shoulders, exactly two arms ending in exactly two hands, and exactly two legs ending in exactly two feet.',
    'Show the full body from hair to shoe soles, facing right, at the exact scale, framing, floor contact, and connected silhouette of the pose cell.',
    'Preserve natural pores, hair strands, suit weave, shirt and tie texture; no caricature, plastic smoothing, anatomy drift, extra person, motion blur, trail, text, or scenery.',
    'Return exactly one image on perfectly flat uniform pure #00FF00 with no floor line, shadow, gradient, or texture.',
  ];
}

export function buildTrumpRefinePrompt(rendererId: TrumpRendererId, frameIndex: number): string {
  if (frameIndex < 0 || frameIndex > 3) throw new Error(`Invalid frame index ${frameIndex}`);
  const common = sharedFrameRules(frameIndex);
  if (rendererId === 'gemini-flash') {
    return [
      'This is a benign, non-deceptive transformation of a licensed public-domain portrait into a synthetic fighting-game frame.',
      'IMAGE 1 is the unaltered original portrait. Use it only for exact identity and visible surface appearance: facial structure, apparent age, hairline and individual hair texture, natural skin texture, navy suit fabric, white shirt, light blue tie, and lapel pin.',
      'IMAGE 2 is a Trump-specific pose cell generated by the production-style scaffold. It is the only body, pose, silhouette, framing, scale, limb-placement, and floor-contact template.',
      'Both images show the same single target person. Do not combine or composite their bodies. Render IMAGE 2 at high fidelity while transferring only identity and surface appearance from IMAGE 1.',
      ...common,
    ].join(' ');
  }

  const lead = rendererId === 'klein-4b'
    ? 'Edit IMAGE 1 in place. Keep its exact one-person silhouette, pose, limb positions, framing, and floor contact. Change only face, hair, skin texture, and clothing surface details to match IMAGE 2.'
    : rendererId === 'klein-9b'
      ? 'Edit the person already present in IMAGE 1; do not generate a second body. IMAGE 1 is the sole structural template. Transfer only identity and photographic surface detail from IMAGE 2.'
      : rendererId === 'flux2-pro'
        ? 'Use IMAGE 1 as the base image and preserve its complete single-body geometry exactly. Re-render only identity and surface appearance from IMAGE 2.'
        : rendererId === 'flux2-flash'
          ? 'Edit IMAGE 1 in place. Keep its one-person pose and connected silhouette exactly. Transfer only face, hair, skin, and clothing texture from IMAGE 2.'
          : 'The FIRST input image is the base image to edit and the only source of body geometry, pose, silhouette, framing, and floor contact. The SECOND input image is only an identity and texture reference.';

  return [
    lead,
    'IMAGE 1 must contribute all body geometry. IMAGE 2 must not contribute its portrait crop, shoulders, body pose, background, or additional anatomy.',
    'Transfer from IMAGE 2 only the recognizable facial geometry, apparent age, natural skin texture, swept light-blond hair strands, navy suit fabric, white shirt, light blue tie, and lapel pin.',
    ...common,
  ].join(' ');
}

export function benchmarkFingerprint(): string {
  return sha256Text(JSON.stringify({
    runId: TRUMP_PROD_FLOW_RUN_ID,
    hardCapUsd: TRUMP_PROD_FLOW_HARD_CAP_USD,
    maxSubmissions: TRUMP_PROD_FLOW_MAX_SUBMISSIONS,
    seeds: TRUMP_PROD_FLOW_SEEDS,
    renderers: TRUMP_RENDERERS,
    prompts: {
      source: buildTrumpSourcePrompt(),
      scaffold: buildTrumpHighKickScaffoldPrompt(),
      refine: Object.fromEntries(TRUMP_RENDERERS.map((renderer) => [
        renderer.id,
        [0, 1, 2, 3].map((frame) => buildTrumpRefinePrompt(renderer.id, frame)),
      ])),
    },
  }));
}

export function validateTrumpProdFlowPlan(): void {
  if (TRUMP_RENDERERS.length !== 6) throw new Error('Expected exactly six frozen renderers.');
  if (guardedBudgetUsd() > TRUMP_PROD_FLOW_HARD_CAP_USD) {
    throw new Error(`Guarded budget ${guardedBudgetUsd()} exceeds hard cap ${TRUMP_PROD_FLOW_HARD_CAP_USD}.`);
  }
  const plannedSubmissions = TRUMP_RENDERERS.length * (1 + 1 + 4 + 4);
  if (plannedSubmissions !== TRUMP_PROD_FLOW_MAX_SUBMISSIONS) {
    throw new Error(`Expected ${TRUMP_PROD_FLOW_MAX_SUBMISSIONS} submissions, got ${plannedSubmissions}.`);
  }
}
