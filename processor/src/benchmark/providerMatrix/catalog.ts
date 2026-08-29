import { createHash } from 'node:crypto';
import type {
  AnimationId,
  AnimationTopology,
  BenchmarkNode,
  GenerationNode,
  ReferenceBinding,
  ReferenceRole,
  RendererId,
  RendererSpec,
  StrategyId,
  StrategyPlan,
} from './contract.ts';

export const PROVIDER_MATRIX_RUN_ID = 'trump-provider-strategy-matrix-20260824-v2';
export const PROVIDER_MATRIX_STAGE1_ID = 'trump-provider-strategy-matrix-20260824-v1:klein-9b:previous-delta:high_kick';
export const PROVIDER_MATRIX_STAGE1_HARD_CAP_USD = 0.07;
export const PROVIDER_MATRIX_CLEANUP_GUARD_USD = 0.001;
export const PROVIDER_MATRIX_SEED_BASE = 2026082400;

export interface ProviderMatrixPaidApproval {
  id: string;
  rendererId: RendererId;
  strategyId: StrategyId;
  animationId: AnimationId;
  maxCostUsd: number;
  maxThroughFrame: number;
  status: 'approved' | 'closed';
  reason: string;
}

export const PROVIDER_MATRIX_PAID_APPROVALS: readonly ProviderMatrixPaidApproval[] = [
  {
    id: PROVIDER_MATRIX_STAGE1_ID,
    rendererId: 'klein-9b',
    strategyId: 'previous-delta',
    animationId: 'high_kick',
    maxCostUsd: 0.069,
    maxThroughFrame: 2,
    status: 'closed',
    reason: 'F2 failed the temporal-progression gate; F3 was deliberately not submitted.',
  },
];

export const FROZEN_INPUTS = {
  original: {
    path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/inputs/original-licensed-photo.png',
    width: 1583,
    height: 2048,
    sha256: 'b8cdec38c5a7e8042acd2a095336a2a5b3255bf8771aedf7634860129af4c476',
    sentToTemporalRenderers: false,
  },
  canonicalRaw: {
    path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/outputs/klein-9b/source/raw.png',
    width: 864,
    height: 1152,
    sha256: 'ec8ea596fa208bc59e71868c89be49c68134d700cfa0f72ce7bffbd4e694dd09',
    lineage: 'Generated once by Klein 9B from the frozen original portrait; reused by every strategy/model.',
  },
  canonicalClean: {
    path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/outputs/klein-9b/source/clean.png',
    width: 864,
    height: 1152,
    sha256: '15ceb68ce7794ffc1018f8420fb7b424692d60780de05cdfbb498578cef6b7d0',
  },
  scaffold: {
    path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/outputs/klein-9b/scaffold/raw.png',
    width: 864,
    height: 1152,
    sha256: '560a72798e8b5b0c028e4bc5a9e366282ab6f92e79f0414f17b0bf6ce7498968',
  },
  poseCells: [
    { path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/outputs/klein-9b/scaffold/cells/frame-00.png', width: 432, height: 576, sha256: '17c85dfddc4510f4f2fa6d583ac055b07be7c5e53bae09bb9f13a33f8ad1f730' },
    { path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/outputs/klein-9b/scaffold/cells/frame-01.png', width: 432, height: 576, sha256: '43621bdde0b148c00d3e087e10f1edc68aa532e91b9ab7aaa991e6f8ec8930d3' },
    { path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/outputs/klein-9b/scaffold/cells/frame-02.png', width: 432, height: 576, sha256: '2129f22285beca5e890745ac5ee95e83d117b3b05c0350c08d4b91be036533fc' },
    { path: '.qa/provider-benchmark/trump-prod-flow-all-renderers-20260823-v1/outputs/klein-9b/scaffold/cells/frame-03.png', width: 432, height: 576, sha256: 'dd18ffa1fc28929e550d0b3399dff67dfe409d09c417f7fa5e8c0c34cee41951' },
  ],
} as const;

export const RENDERERS: readonly RendererSpec[] = [
  {
    id: 'gemini-flash', label: 'Gemini 3.1 Flash Image', adapter: 'gemini-inline',
    model: 'gemini-3.1-flash-image', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent',
    maximumReferences: 14, editableImageMustBeFirst: false, supportsSeed: true,
    guardsUsd: { directSheet: 0.08, oneReferenceFrame: 0.08, twoReferenceFrame: 0.08 },
  },
  {
    id: 'gemini-pro', label: 'Gemini 3 Pro Image', adapter: 'gemini-inline',
    model: 'gemini-3-pro-image', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
    maximumReferences: 14, editableImageMustBeFirst: false, supportsSeed: true,
    guardsUsd: { directSheet: 0.15, oneReferenceFrame: 0.15, twoReferenceFrame: 0.15 },
  },
  {
    id: 'klein-4b', label: 'FLUX.2 Klein 4B via fal', adapter: 'fal-queue',
    model: 'fal-ai/flux-2/klein/4b/edit', endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/4b/edit',
    maximumReferences: 4, editableImageMustBeFirst: true, supportsSeed: true,
    guardsUsd: { directSheet: 0.105, oneReferenceFrame: 0.03, twoReferenceFrame: 0.03 },
    observedUsd: { oneReferenceFrame: 0.009492188, twoReferenceFrame: 0.009492188 },
  },
  {
    id: 'klein-9b', label: 'FLUX.2 Klein 9B via fal', adapter: 'fal-queue',
    model: 'fal-ai/flux-2/klein/9b/edit', endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/9b/edit',
    maximumReferences: 4, editableImageMustBeFirst: true, supportsSeed: true,
    guardsUsd: { directSheet: 0.059, oneReferenceFrame: 0.022, twoReferenceFrame: 0.033 },
    observedUsd: { oneReferenceFrame: 0.021441406, twoReferenceFrame: 0.032441406 },
  },
  {
    id: 'flux2-pro', label: 'FLUX.2 Pro via fal', adapter: 'fal-queue',
    model: 'fal-ai/flux-2-pro/edit', endpoint: 'https://queue.fal.run/fal-ai/flux-2-pro/edit',
    maximumReferences: 8, editableImageMustBeFirst: true, supportsSeed: true,
    guardsUsd: { directSheet: 0.21, oneReferenceFrame: 0.06, twoReferenceFrame: 0.06 },
    observedUsd: { oneReferenceFrame: 0.045, twoReferenceFrame: 0.06 },
  },
  {
    id: 'flux2-flash', label: 'FLUX.2 Flash via fal', adapter: 'fal-queue',
    model: 'fal-ai/flux-2/flash/edit', endpoint: 'https://queue.fal.run/fal-ai/flux-2/flash/edit',
    maximumReferences: 4, editableImageMustBeFirst: true, supportsSeed: true,
    guardsUsd: { directSheet: 0.03, oneReferenceFrame: 0.02, twoReferenceFrame: 0.02 },
    observedUsd: { oneReferenceFrame: 0.01, twoReferenceFrame: 0.015 },
  },
  {
    id: 'seedream-4', label: 'Seedream 4 via fal', adapter: 'fal-queue',
    model: 'fal-ai/bytedance/seedream/v4/edit', endpoint: 'https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit',
    maximumReferences: 10, editableImageMustBeFirst: true, supportsSeed: true,
    guardsUsd: { directSheet: 0.03, oneReferenceFrame: 0.03, twoReferenceFrame: 0.03 },
    observedUsd: { oneReferenceFrame: 0.03, twoReferenceFrame: 0.03 },
  },
] as const;

const ATTACK_PLAYBACK = [0, 1, 2, 3, 2, 1, 0] as const;

export const ANIMATIONS: Record<AnimationId, AnimationTopology> = {
  idle: { id: 'idle', base: 'standing', frameCount: 8, uniqueFrameCount: 8, grid: { columns: 4, rows: 2 }, playbackOrder: [0, 1, 2, 3, 4, 5, 6, 7], hybridAnchors: [0, 4], phases: ['neutral guard', 'tiny inhale and torso rise', 'slightly fuller inhale', 'begin exhale', 'lowest relaxed breathing point', 'rise back toward neutral', 'almost neutral', 'nearly identical to frame 0 for loop closure'] },
  walk: { id: 'walk', base: 'standing', frameCount: 16, uniqueFrameCount: 16, grid: { columns: 4, rows: 4 }, playbackOrder: Array.from({ length: 16 }, (_, index) => index), hybridAnchors: [0, 4, 8, 12], phases: ['right heel contact, left toe behind', 'weight loads onto right leg', 'left toe leaves floor', 'left leg swings forward', 'left leg passes support leg', 'left foot reaches forward', 'left heel descends', 'near left-foot contact', 'left heel contact, right toe behind', 'weight loads onto left leg', 'right toe leaves floor', 'right leg swings forward', 'right leg passes support leg', 'right foot reaches forward', 'right heel descends', 'near right-foot contact, closing into frame 0'] },
  high_punch: { id: 'high_punch', base: 'standing', frameCount: 7, uniqueFrameCount: 4, grid: { columns: 4, rows: 2 }, playbackOrder: ATTACK_PLAYBACK, hybridAnchors: [0], phases: ['neutral standing guard', 'lead shoulder rotates and elbow starts extending', 'lead arm mostly extended', 'full grounded jab impact'] },
  high_kick: { id: 'high_kick', base: 'standing', frameCount: 7, uniqueFrameCount: 4, grid: { columns: 4, rows: 2 }, playbackOrder: ATTACK_PLAYBACK, hybridAnchors: [0], phases: ['neutral standing guard with both feet planted', 'compact chamber of the leg on the viewer-right side', 'advanced high chamber: the same knee is visibly higher, the thigh angles farther upward, and the lower leg is partially open toward viewer-right', 'the same leg fully extends toward viewer-right into high-kick impact'] },
  low_punch: { id: 'low_punch', base: 'crouched', frameCount: 7, uniqueFrameCount: 4, grid: { columns: 4, rows: 2 }, playbackOrder: ATTACK_PLAYBACK, hybridAnchors: [0], phases: ['extreme crouch guard', 'shoulder drives forward and elbow starts extending', 'arm mostly extended while hips remain low', 'full low jab impact without standing up'] },
  low_kick: { id: 'low_kick', base: 'crouched', frameCount: 7, uniqueFrameCount: 4, grid: { columns: 4, rows: 2 }, playbackOrder: ATTACK_PLAYBACK, hybridAnchors: [0], phases: ['extreme crouch guard', 'weight transfers to the support leg', 'the same kicking leg sweeps outward low', 'full grounded low-sweep impact'] },
  jump: { id: 'jump', base: 'standing', frameCount: 4, uniqueFrameCount: 4, grid: { columns: 4, rows: 1 }, playbackOrder: [0, 1, 2, 3], hybridAnchors: [0, 3], phases: ['compressed grounded anticipation', 'lift-off pose', 'compact airborne apex', 'grounded landing recovery'] },
  crouch: { id: 'crouch', base: 'standing-to-crouched', frameCount: 4, uniqueFrameCount: 4, grid: { columns: 4, rows: 1 }, playbackOrder: [0, 1, 2, 3], hybridAnchors: [0, 3], phases: ['standing guard', 'knees bend and hips begin dropping', 'deep compressed transition', 'extreme canonical crouch'] },
  hit: { id: 'hit', base: 'standing', frameCount: 4, uniqueFrameCount: 4, grid: { columns: 4, rows: 1 }, playbackOrder: [0, 1, 2, 3], hybridAnchors: [0, 3], phases: ['initial grounded impact', 'strong recoil', 'off-balance stagger', 'grounded recovery toward guard'] },
  ko: { id: 'ko', base: 'standing', frameCount: 8, uniqueFrameCount: 8, grid: { columns: 4, rows: 2 }, playbackOrder: [0, 1, 2, 3, 4, 5, 6, 7], hybridAnchors: [0, 4, 7], phases: ['upright impact', 'head and torso recoil', 'balance breaks backward', 'knees buckle during descent', 'compact near-ground pose', 'ground contact', 'body settles', 'final compact knocked-out hold'] },
  victory: { id: 'victory', base: 'standing', frameCount: 8, uniqueFrameCount: 8, grid: { columns: 4, rows: 2 }, playbackOrder: [0, 1, 2, 3, 4, 5, 6, 7], hybridAnchors: [0, 4, 7], phases: ['neutral guard', 'recognition of victory', 'chest rises and fist begins lifting', 'strong celebratory pump', 'peak triumph', 'settling from peak', 'proud champion pose', 'final champion hold'] },
};

export const STRATEGIES: Record<StrategyId, { label: string; temporalDependency: string; referenceRoles: readonly ReferenceRole[] }> = {
  'direct-sheet': { label: 'Direct multi-cell sheet (Rookie frontier)', temporalDependency: 'none', referenceRoles: ['canonical'] },
  'sheet-independent': { label: 'Common scaffold cells, independent refines', temporalDependency: 'none-between-frames', referenceRoles: ['canonical', 'pose-cell'] },
  'canonical-independent': { label: 'Independent absolute pose from canonical', temporalDependency: 'none-between-frames', referenceRoles: ['canonical'] },
  'previous-delta': { label: 'Previous frame plus delta', temporalDependency: 'previous-frame', referenceRoles: ['previous-frame'] },
  'canonical-previous': { label: 'Previous frame re-anchored by canonical', temporalDependency: 'previous-frame', referenceRoles: ['canonical', 'previous-frame'] },
  'previous-pose': { label: 'Previous frame guided by target pose cell', temporalDependency: 'previous-frame', referenceRoles: ['previous-frame', 'pose-cell'] },
};

const COMMON_INVARIANTS = [
  'exactly one complete connected adult fighter',
  'one head, one torso, exactly two arms and two hands, exactly two legs and two feet',
  'same recognizable face, swept blond hair, navy suit, light blue tie, materials and fine texture',
  'same camera, scale, floor line and viewer-right facing direction',
  'complete body visible with green margin; no crop, extra person, detached limb, blur or trail',
  'perfectly flat uniform pure #00FF00 background with no floor, shadow, grid, text or scenery',
] as const;

function renderer(rendererId: RendererId): RendererSpec {
  const value = RENDERERS.find((candidate) => candidate.id === rendererId);
  if (!value) throw new Error(`Unknown renderer ${rendererId}`);
  return value;
}

function phaseDelta(topology: AnimationTopology, frameIndex: number): string {
  if (frameIndex <= 0) return `hold ${topology.phases[0]}`;
  if (topology.id === 'high_kick') {
    return [
      '',
      'keep the leg on the viewer-left side planted and lift only the leg on the viewer-right side into a clearly readable compact bent-knee chamber',
      'keep the same support leg planted and make a clear, substantial progression from the chamber: lift the already raised knee visibly higher, rotate that thigh farther upward, and open the same lower leg toward viewer-right so the foot moves clearly outward; do not return an unchanged or near-identical chamber',
      'keep the same support leg planted and extend only that already raised leg fully toward viewer-right into the impact apex, with the kicking foot at its farthest point; do not retain the bent-knee chamber',
    ][frameIndex];
  }
  return `move only as needed from ${topology.phases[frameIndex - 1]} to ${topology.phases[frameIndex]}`;
}

function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

function sequenceContext(topology: AnimationTopology, frameIndex: number): string[] {
  const previousIndex = Math.max(0, frameIndex - 1);
  const nextIndex = frameIndex + 1;
  const orderedMotion = topology.phases
    .map((phase, index) => `F${index} = ${phase}`)
    .join('; ');
  const playback = topology.playbackOrder.map((index) => `F${index}`).join(' -> ');
  const lines = [
    'ANIMATION TRAJECTORY — context only; never render multiple poses or a sprite sheet.',
    `${topology.id.toUpperCase()} is an ordered motion with ${topology.uniqueFrameCount} unique key poses, F0 through F${topology.uniqueFrameCount - 1}.`,
    `Full ordered motion, for context only: ${orderedMotion}.`,
    `Final playback order: ${playback}.`,
    `REQUESTED OUTPUT: generate only F${frameIndex}, the ${ordinal(frameIndex + 1)} unique key pose out of ${topology.uniqueFrameCount}.`,
    `PREVIOUS INPUT PHASE F${previousIndex}: ${topology.phases[previousIndex]}.`,
    `CURRENT TARGET F${frameIndex}: ${topology.phases[frameIndex]}.`,
  ];
  if (nextIndex < topology.uniqueFrameCount) {
    lines.push(`NEXT PHASE F${nextIndex} — trajectory context only, do not render it yet: ${topology.phases[nextIndex]}.`);
  } else if (topology.id === 'idle' || topology.id === 'walk') {
    lines.push(`NEXT PLAYBACK PHASE is F0 for loop closure — context only. Render F${frameIndex}, not F0.`);
  } else if (topology.playbackOrder.indexOf(frameIndex) < topology.playbackOrder.length - 1) {
    const nextPlaybackIndex = topology.playbackOrder[topology.playbackOrder.indexOf(frameIndex) + 1];
    lines.push(`F${frameIndex} is the terminal generated apex. Playback later reverses locally to the already generated F${nextPlaybackIndex}; do not render recovery now.`);
  } else {
    lines.push(`There is no next generated phase. F${frameIndex} is the terminal pose; complete it without inventing another pose.`);
  }
  return lines;
}

function referenceLegend(rendererSpec: RendererSpec, references: readonly ReferenceBinding[]): string[] {
  return references.map((binding, index) => {
    const image = `IMAGE ${index + 1}`;
    if (binding.role === 'canonical') return `${image} is the immutable identity, outfit, material, camera, scale and facing anchor.`;
    if (binding.role === 'pose-cell') return `${image} is a pose target only. It contributes geometry for this phase, never another person or alternate identity.`;
    return `${image} is the previous raw accepted frame and the editable base for temporal continuity.`;
  }).concat(rendererSpec.adapter === 'fal-queue'
    ? ['The first image is the editable base image for this provider. Do not composite the reference bodies.']
    : ['Treat the image roles literally and do not fuse reference bodies.']);
}

export function orderedReferences(rendererId: RendererId, strategyId: StrategyId, frameIndex: number): ReferenceBinding[] {
  const rendererSpec = renderer(rendererId);
  const roles = STRATEGIES[strategyId].referenceRoles;
  const bindings = roles.map((role): ReferenceBinding => {
    if (role === 'canonical') return { role, source: 'frozen-canonical' };
    if (role === 'pose-cell') return { role, source: 'frozen-pose-cell', frameIndex };
    return { role, source: 'generated-frame', frameIndex: frameIndex - 1 };
  });
  if (!rendererSpec.editableImageMustBeFirst || bindings.length < 2) return bindings;
  const editableRole: ReferenceRole = strategyId === 'sheet-independent'
    ? 'pose-cell'
    : strategyId === 'previous-pose' || strategyId === 'canonical-previous'
      ? 'previous-frame'
      : bindings[0].role;
  return [...bindings].sort((left, right) => Number(right.role === editableRole) - Number(left.role === editableRole));
}

export function buildProviderPrompt(
  rendererId: RendererId,
  strategyId: StrategyId,
  animationId: AnimationId,
  frameIndex?: number,
): string {
  const rendererSpec = renderer(rendererId);
  const topology = ANIMATIONS[animationId];
  if (strategyId === 'direct-sheet') {
    const layout = directSheetLayout(topology);
    return [
      `Create exactly ${topology.uniqueFrameCount} ordered cells in a ${layout.columns} by ${layout.rows} sprite sheet.`,
      'IMAGE 1 is the only character, appearance, style, camera and scale reference.',
      `Render these phases left-to-right, top-to-bottom: ${topology.phases.map((phase, index) => `F${index}: ${phase}`).join('; ')}.`,
      ...COMMON_INVARIANTS,
      'Return one sprite-sheet image and nothing else.',
    ].join(' ');
  }
  if (frameIndex === undefined || frameIndex < 0 || frameIndex >= topology.uniqueFrameCount) {
    throw new Error(`Invalid ${animationId} frame ${String(frameIndex)}`);
  }
  const references = orderedReferences(rendererId, strategyId, frameIndex);
  const sequential = strategyId === 'previous-delta'
    || strategyId === 'canonical-previous'
    || strategyId === 'previous-pose';
  const lines = [
    ...referenceLegend(rendererSpec, references),
    ...(sequential ? sequenceContext(topology, frameIndex) : []),
  ];
  if (strategyId === 'sheet-independent') {
    lines.push('Render the pose target as exactly one fighter while transferring appearance only from the canonical anchor. Do not combine their anatomies.');
  } else if (strategyId === 'canonical-independent') {
    lines.push(`Edit the canonical fighter directly into this absolute pose: ${topology.phases[frameIndex]}.`);
  } else if (strategyId === 'previous-delta') {
    lines.push(`Edit the previous-frame reference in place. Preserve identity, outfit, texture, camera, scale and background, but not the previous pose. Make an anatomically plausible and clearly readable progression from F${frameIndex - 1} to F${frameIndex}: ${phaseDelta(topology, frameIndex)}. Do not copy or return F${frameIndex - 1}.`);
  } else if (strategyId === 'canonical-previous') {
    lines.push(`Edit the previous-frame reference in place and use the canonical only to correct identity, outfit and texture drift. Preserve appearance, but not the previous pose. Make an anatomically plausible and clearly readable progression from F${frameIndex - 1} to F${frameIndex}: ${phaseDelta(topology, frameIndex)}. Do not copy or return F${frameIndex - 1}.`);
  } else {
    lines.push(`Edit the previous-frame reference in place toward the pose target. Preserve appearance, but not the previous pose. Make an anatomically plausible and clearly readable progression from F${frameIndex - 1} to F${frameIndex}: ${phaseDelta(topology, frameIndex)}. Do not copy or return F${frameIndex - 1}. The target must not introduce a second body.`);
  }
  lines.push(`The resulting absolute phase is: ${topology.phases[frameIndex]}.`);
  lines.push(...COMMON_INVARIANTS);
  lines.push('Return exactly one full-body frame, not a sheet.');
  return lines.join(' ');
}

function generationGuard(rendererSpec: RendererSpec, references: number, directSheet: boolean): number {
  if (directSheet) return rendererSpec.guardsUsd.directSheet;
  return references === 1 ? rendererSpec.guardsUsd.oneReferenceFrame : rendererSpec.guardsUsd.twoReferenceFrame;
}

export function directSheetLayout(topology: AnimationTopology): {
  columns: number;
  rows: number;
  width: number;
  height: number;
} {
  if (topology.uniqueFrameCount === 4) return { columns: 2, rows: 2, width: 1728, height: 2304 };
  if (topology.uniqueFrameCount === 8) return { columns: 4, rows: 2, width: 2432, height: 1632 };
  if (topology.uniqueFrameCount === 16) return { columns: 4, rows: 4, width: 1728, height: 2304 };
  throw new Error(`No frozen direct-sheet layout for ${topology.uniqueFrameCount} unique frames.`);
}

function generationNode(
  rendererId: RendererId,
  strategyId: StrategyId,
  animationId: AnimationId,
  frameIndex?: number,
): GenerationNode {
  const rendererSpec = renderer(rendererId);
  const directSheet = strategyId === 'direct-sheet';
  const directLayout = directSheet ? directSheetLayout(ANIMATIONS[animationId]) : null;
  const references: ReferenceBinding[] = directSheet
    ? [{ role: 'canonical', source: 'frozen-canonical' }]
    : orderedReferences(rendererId, strategyId, frameIndex as number);
  const previous = references.find((reference) => reference.role === 'previous-frame');
  return {
    id: `${rendererId}:${strategyId}:${animationId}:${directSheet ? 'sheet' : `frame-${frameIndex}`}`,
    rendererId,
    strategyId,
    animationId,
    kind: directSheet ? 'generate-sheet' : 'generate-frame',
    frameIndex,
    dependsOn: previous ? [`${rendererId}:${strategyId}:${animationId}:frame-${previous.frameIndex}`] : [],
    references,
    prompt: buildProviderPrompt(rendererId, strategyId, animationId, frameIndex),
    seed: PROVIDER_MATRIX_SEED_BASE + (frameIndex ?? 0),
    width: directLayout?.width ?? 864,
    height: directLayout?.height ?? 1152,
    guardedMaxUsd: generationGuard(rendererSpec, references.length, directSheet),
  };
}

export function buildStrategyPlan(rendererId: RendererId, strategyId: StrategyId, animationId: AnimationId): StrategyPlan {
  const topology = ANIMATIONS[animationId];
  const nodes: BenchmarkNode[] = [];
  if (strategyId === 'direct-sheet') {
    nodes.push(generationNode(rendererId, strategyId, animationId));
  } else {
    // F0 is the same frozen canonical branch point. Only F1..Fn are paid.
    for (let frameIndex = 1; frameIndex < topology.uniqueFrameCount; frameIndex += 1) {
      const generation = generationNode(rendererId, strategyId, animationId, frameIndex);
      nodes.push(generation, {
        id: `${generation.id}:cleanup`, rendererId, strategyId, animationId, kind: 'cleanup', frameIndex,
        dependsOn: [generation.id], guardedMaxUsd: PROVIDER_MATRIX_CLEANUP_GUARD_USD,
      });
    }
  }
  const guardedBudgetUsd = Number(nodes.reduce((sum, node) => sum + node.guardedMaxUsd, 0).toFixed(6));
  return { rendererId, strategyId, animationId, nodes, guardedBudgetUsd, maxPaidSubmissions: nodes.length };
}

export function planFingerprint(plan: StrategyPlan): string {
  return createHash('sha256').update(JSON.stringify({
    runId: PROVIDER_MATRIX_RUN_ID,
    plan,
    renderer: renderer(plan.rendererId),
    topology: ANIMATIONS[plan.animationId],
    frozenInputs: FROZEN_INPUTS,
    retryPolicy: 0,
    fallbackPolicy: 'none',
  })).digest('hex');
}

export function validateStrategyPlan(plan: StrategyPlan): void {
  const rendererSpec = renderer(plan.rendererId);
  const ids = new Set(plan.nodes.map((node) => node.id));
  if (ids.size !== plan.nodes.length) throw new Error('Plan contains duplicate node ids.');
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency) && !dependency.endsWith(':frame-0')) throw new Error(`Missing dependency ${dependency}`);
    }
    if (node.kind !== 'cleanup' && node.references.length > rendererSpec.maximumReferences) {
      throw new Error(`${rendererSpec.id} cannot accept ${node.references.length} references.`);
    }
  }
  if (plan.rendererId === 'klein-9b' && plan.strategyId === 'previous-delta' && plan.animationId === 'high_kick') {
    if (plan.guardedBudgetUsd !== 0.069 || plan.maxPaidSubmissions !== 6) {
      throw new Error(`Stage 1 contract changed: ${plan.guardedBudgetUsd}/${plan.maxPaidSubmissions}`);
    }
    if (plan.guardedBudgetUsd > PROVIDER_MATRIX_STAGE1_HARD_CAP_USD) {
      throw new Error('Stage 1 exceeds its hard cap.');
    }
  }
}
