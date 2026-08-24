import { createHash } from 'node:crypto';

export const BENCHMARK_RUN_ID = 'phase0-20260822-v1';
export const BENCHMARK_SEED_REFINE = 42_001;
export const BENCHMARK_SEED_WALK = 42_002;
export const BENCHMARK_HARD_CAP_USD = 0.50;

export const WALK_MOTION = 'walking forward to the right cycle, fighting game walk';
export const HIGH_KICK_MOTION = 'powerful grounded standing roundhouse kick swinging the right leg in a high arc while the support foot stays planted, then returning to stance';

export const EXPECTED_INPUTS = {
  identity: {
    sourcePath: '.artifacts/qa/durable-rookie/side.png',
    frozenPath: 'inputs/identity.png',
    width: 768,
    height: 1400,
    sha256: '1ddbc7bf6dbc23ebc5eafff891ecb5242dfba70d78562eeef45c9316d6a6eddd',
  },
  highKickSheet: {
    sourcePath: '.artifacts/qa/durable-rookie/high_kick.png',
    width: 3072,
    height: 2048,
    sha256: '4129ad291fde9885a4d4d43420239cde2f3b62ea919d4d4b2a4abcbd8152788a',
  },
  highKickImpact: {
    frozenPath: 'inputs/high-kick-impact.png',
    sourceCrop: { x: 2304, y: 0, width: 768, height: 1024 },
    width: 768,
    height: 1024,
  },
  currentWalkBaseline: {
    sourcePath: '.artifacts/qa/durable-rookie/walk.png',
    frozenPath: 'baseline/current-walk.png',
    width: 3072,
    height: 4096,
    sha256: '0f2494a9c19eab149105cb323e1e646246bcea08d611210e9aa2b3c21ff7f62e',
  },
} as const;

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildWalkPrompt(): string {
  const promptRules = [
    'This is a grounded fighting-game walk cycle, not a run and not a hop.',
    'The body stays at the same apparent size in every frame.',
    'Keep the full body visible in each frame with no cropping and no frame-to-frame layout shifts.',
    'Every frame must stay inside its own cell with margin on the left and right. Never let the body cross a cell boundary.',
    'Each frame must contain exactly one complete character silhouette. No detached limbs, partial bodies, or torso-only frames.',
  ];

  return [
    `Generate a sprite sheet of this exact character performing: ${WALK_MOTION}.`,
    ``,
    `STRICT LAYOUT RULES:`,
    `- The image must be a single image containing a grid of EXACTLY 4 columns and 4 rows.`,
    `- That means EXACTLY 16 cells total — no more, no fewer.`,
    `- Every cell must be the same size. Every row must have exactly 4 cells.`,
    ``,
    `ANIMATION RULES:`,
    `- Frames are read left-to-right, top-to-bottom (frame 1 is top-left, frame 16 is bottom-right).`,
    `- The frames must form a smooth, sequential animation — each frame shows the next step of the motion.`,
    `- Frame 1 starts in the base stance. The motion progresses gradually through the middle frames. The final frame returns to or finishes the pose.`,
    `- The character must face right in every frame.`,
    ...promptRules.map((rule) => `- ${rule}`),
    ``,
    `FRAMING RULES (CRITICAL):`,
    `- EVERY frame MUST show the COMPLETE character from head to feet — never crop or zoom in.`,
    `- The character must be the SAME SIZE in every frame — do NOT zoom in or out between frames.`,
    `- Treat the uploaded reference image as the exact framing template. Match its camera distance, full-body crop, and overall composition; never crop closer than the reference image.`,
    `- Frame the character so they occupy roughly 84% of the cell height and at most 80% of the cell width.`,
    `- Keep the feet near the same floor line close to the bottom of every cell.`,
    `- Even for subtle animations, maintain the EXACT same camera distance and framing as the reference image.`,
    ``,
    `STYLE RULES (CRITICAL):`,
    `- Preserve the EXACT same visual style, art style, textures, colors, and level of detail from the reference image — do NOT change the aesthetic.`,
    `- Every frame must look like the same physical person from the reference, just in a different pose. Do NOT redraw as a cartoon, anime, cel-shaded, illustrative, comic, watercolour, painted, stylized, or otherwise re-interpreted version.`,
    `- Match the exact rendering technique, shading style, linework density, and photographic/painterly feel of the reference — if the reference is photorealistic, every frame must stay photorealistic; if it is painted, stay in the exact same painted style across every frame.`,
    `- Preserve the same face, hair, skin tone, outfit, and proportions faithfully across every frame. No clothing changes, no new props, no accessory drift between frames.`,
    `- Each frame shows the complete character at the same scale and vertical position.`,
    `- Pure bright green (#00FF00) background in every cell — flat, uniform, vivid green with no gradients, shadows, or ground.`,
  ].join('\n');
}

export function buildHighKickRefinePrompt(): string {
  const motionSummary = HIGH_KICK_MOTION.replace(/\s+/g, ' ').trim().slice(0, 160);
  return [
    `Render a single high-fidelity full-resolution image of the pose shown in IMAGE 2, preserving the identity and visual style from IMAGE 1.`,
    ``,
    `CONTEXT:`,
    `- This is one frame of a classic 2D fighting-game "high_kick" animation (${motionSummary}).`,
    `- IMAGE 2 is a lower-resolution reference showing the EXACT pose to replicate at this frame.`,
    `- IMAGE 1 is the canonical identity, outfit, and visual style anchor.`,
    ``,
    `POSE RULE (CRITICAL):`,
    `- Replicate the EXACT pose, silhouette, and framing from IMAGE 2. Same limb positions, same stance, same facing direction, same center of mass, same feet placement.`,
    `- Do NOT reinterpret, smooth, "correct", or alter the pose in any way — render it as-is, just at higher resolution.`,
    `- Do NOT add motion blur, speed lines, trails, or "in-between" interpolation. This is a single static frame.`,
    ``,
    `STYLE LOCK (CRITICAL):`,
    `- Preserve the EXACT same visual style, art style, textures, colors, and level of detail from IMAGE 1 — do NOT change the aesthetic.`,
    `- The output must look like the same physical person from IMAGE 1. Do NOT redraw as a cartoon, anime, cel-shaded, illustrative, comic, watercolour, painted, stylized, or otherwise re-interpreted version.`,
    `- Match the exact rendering technique, shading style, linework density, and photographic/painterly feel of IMAGE 1 — if IMAGE 1 is photorealistic, stay photorealistic; if it is painted, stay in the exact same painted style.`,
    `- Preserve the same face, hair, skin tone, outfit, and proportions faithfully. No clothing changes, no new props, no accessory drift.`,
    ``,
    `FRAMING RULES:`,
    `- Show the COMPLETE character from head to feet. No cropping.`,
    `- The character should occupy roughly the same proportion of the frame as in IMAGE 2. Centered horizontally, feet near the bottom.`,
    ``,
    `OUTPUT RULES:`,
    `- Return exactly one image with pure bright green (#00FF00) background — flat, uniform, vivid green, no gradients, shadows, or ground.`,
    `- No text, no UI, no grids, no multiple frames. Just the single pose at high fidelity.`,
  ].join('\n');
}

export type BenchmarkPlan = 'A' | 'B';
export type BenchmarkAdapter = 'gemini' | 'fal';

export interface BenchmarkRequestSpec {
  id: string;
  plan: BenchmarkPlan;
  hypothesis: string;
  supplier: string;
  distributor: string;
  model: string;
  adapter: BenchmarkAdapter;
  endpoint: string;
  secretName: 'GEMINI_API_KEY' | 'FAL_API_KEY';
  promptPath: 'prompts/walk.txt' | 'prompts/high-kick-refine.txt';
  promptSha256: string;
  references: Array<'identity' | 'high-kick-impact'>;
  output: {
    requestedWidth: number;
    requestedHeight: number;
    normalizeWidth?: number;
    normalizeHeight?: number;
    format: 'png' | 'provider-default';
  };
  seed: number;
  estimatedFixedUsd: number;
  inputReserveUsd: number;
  guardedMaxUsd: number;
  automaticRetries: 0;
  payloadTemplate: Record<string, unknown>;
  pricingSource: string;
  apiSource: string;
}

const IDENTITY_PLACEHOLDER = '{{IDENTITY_PNG_DATA_URI}}';
const IDENTITY_BASE64_PLACEHOLDER = '{{IDENTITY_PNG_BASE64}}';
const POSE_PLACEHOLDER = '{{HIGH_KICK_IMPACT_PNG_DATA_URI}}';
const POSE_BASE64_PLACEHOLDER = '{{HIGH_KICK_IMPACT_PNG_BASE64}}';
const WALK_PROMPT_PLACEHOLDER = '{{PROMPT_FROM:prompts/walk.txt}}';
const REFINE_PROMPT_PLACEHOLDER = '{{PROMPT_FROM:prompts/high-kick-refine.txt}}';

function geminiPayloadTemplate(options: { plan: BenchmarkPlan; imageSize: '1K' | '4K' }): Record<string, unknown> {
  const isWalk = options.plan === 'A';
  const parts: Record<string, unknown>[] = [
    { inlineData: { mimeType: 'image/png', data: IDENTITY_BASE64_PLACEHOLDER } },
  ];
  if (!isWalk) {
    parts.push({ inlineData: { mimeType: 'image/png', data: POSE_BASE64_PLACEHOLDER } });
  }
  parts.push({ text: isWalk ? WALK_PROMPT_PLACEHOLDER : REFINE_PROMPT_PLACEHOLDER });

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      seed: isWalk ? BENCHMARK_SEED_WALK : BENCHMARK_SEED_REFINE,
      imageConfig: {
        aspectRatio: '3:4',
        imageSize: options.imageSize,
      },
    },
  };
}

function falFluxPayloadTemplate(model: 'klein' | 'pro' | 'flash'): Record<string, unknown> {
  const common = {
    prompt: REFINE_PROMPT_PLACEHOLDER,
    image_urls: [IDENTITY_PLACEHOLDER, POSE_PLACEHOLDER],
    image_size: { width: 864, height: 1152 },
    seed: BENCHMARK_SEED_REFINE,
    sync_mode: false,
    enable_safety_checker: true,
    output_format: 'png',
  };

  if (model === 'klein') {
    return { ...common, num_inference_steps: 4, num_images: 1 };
  }
  if (model === 'pro') {
    return { ...common, safety_tolerance: '2' };
  }
  return {
    ...common,
    guidance_scale: 2.5,
    num_images: 1,
    enable_prompt_expansion: false,
  };
}

function seedreamPayloadTemplate(): Record<string, unknown> {
  return {
    prompt: REFINE_PROMPT_PLACEHOLDER,
    image_urls: [IDENTITY_PLACEHOLDER, POSE_PLACEHOLDER],
    image_size: { width: 864, height: 1152 },
    num_images: 1,
    max_images: 1,
    seed: BENCHMARK_SEED_REFINE,
    sync_mode: false,
    enable_safety_checker: true,
    enhance_prompt_mode: 'standard',
  };
}

export function buildBenchmarkRequests(): BenchmarkRequestSpec[] {
  const walkPromptSha256 = sha256Text(buildWalkPrompt());
  const refinePromptSha256 = sha256Text(buildHighKickRefinePrompt());
  const geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent';

  return [
    {
      id: 'plan-a-gemini-walk-4k',
      plan: 'A',
      hypothesis: 'One 4K 4x4 WALK sheet may preserve enough per-cell detail to avoid per-frame refinement.',
      supplier: 'Google',
      distributor: 'Google Gemini API',
      model: 'gemini-3.1-flash-image',
      adapter: 'gemini',
      endpoint: geminiEndpoint,
      secretName: 'GEMINI_API_KEY',
      promptPath: 'prompts/walk.txt',
      promptSha256: walkPromptSha256,
      references: ['identity'],
      output: { requestedWidth: 3584, requestedHeight: 4800, format: 'provider-default' },
      seed: BENCHMARK_SEED_WALK,
      estimatedFixedUsd: 0.151,
      inputReserveUsd: 0.010,
      guardedMaxUsd: 0.161,
      automaticRetries: 0,
      payloadTemplate: geminiPayloadTemplate({ plan: 'A', imageSize: '4K' }),
      pricingSource: 'https://ai.google.dev/gemini-api/docs/pricing',
      apiSource: 'https://ai.google.dev/gemini-api/docs/generate-content/image-generation',
    },
    {
      id: 'plan-b-gemini-flash-control',
      plan: 'B',
      hypothesis: 'Current Gemini Flash renderer control for the unchanged two-reference refine architecture.',
      supplier: 'Google',
      distributor: 'Google Gemini API',
      model: 'gemini-3.1-flash-image',
      adapter: 'gemini',
      endpoint: geminiEndpoint,
      secretName: 'GEMINI_API_KEY',
      promptPath: 'prompts/high-kick-refine.txt',
      promptSha256: refinePromptSha256,
      references: ['identity', 'high-kick-impact'],
      output: { requestedWidth: 896, requestedHeight: 1200, normalizeWidth: 768, normalizeHeight: 1024, format: 'provider-default' },
      seed: BENCHMARK_SEED_REFINE,
      estimatedFixedUsd: 0.067,
      inputReserveUsd: 0.010,
      guardedMaxUsd: 0.077,
      automaticRetries: 0,
      payloadTemplate: geminiPayloadTemplate({ plan: 'B', imageSize: '1K' }),
      pricingSource: 'https://ai.google.dev/gemini-api/docs/pricing',
      apiSource: 'https://ai.google.dev/gemini-api/docs/generate-content/image-generation',
    },
    {
      id: 'plan-b-bfl-klein-4b-via-fal',
      plan: 'B',
      hypothesis: 'BFL Klein 4B may lower cost per usable refined frame.',
      supplier: 'Black Forest Labs',
      distributor: 'fal',
      model: 'fal-ai/flux-2/klein/4b/edit',
      adapter: 'fal',
      endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/4b/edit',
      secretName: 'FAL_API_KEY',
      promptPath: 'prompts/high-kick-refine.txt',
      promptSha256: refinePromptSha256,
      references: ['identity', 'high-kick-impact'],
      output: { requestedWidth: 864, requestedHeight: 1152, normalizeWidth: 768, normalizeHeight: 1024, format: 'png' },
      seed: BENCHMARK_SEED_REFINE,
      estimatedFixedUsd: 0.027,
      inputReserveUsd: 0,
      guardedMaxUsd: 0.030,
      automaticRetries: 0,
      payloadTemplate: falFluxPayloadTemplate('klein'),
      pricingSource: 'https://fal.ai/models/fal-ai/flux-2/klein/4b/edit',
      apiSource: 'https://fal.ai/models/fal-ai/flux-2/klein/4b/edit/api',
    },
    {
      id: 'plan-b-bfl-klein-9b-via-fal',
      plan: 'B',
      hypothesis: 'BFL Klein 9B may offer a better price/identity balance than the control.',
      supplier: 'Black Forest Labs',
      distributor: 'fal',
      model: 'fal-ai/flux-2/klein/9b/edit',
      adapter: 'fal',
      endpoint: 'https://queue.fal.run/fal-ai/flux-2/klein/9b/edit',
      secretName: 'FAL_API_KEY',
      promptPath: 'prompts/high-kick-refine.txt',
      promptSha256: refinePromptSha256,
      references: ['identity', 'high-kick-impact'],
      output: { requestedWidth: 864, requestedHeight: 1152, normalizeWidth: 768, normalizeHeight: 1024, format: 'png' },
      seed: BENCHMARK_SEED_REFINE,
      estimatedFixedUsd: 0.033,
      inputReserveUsd: 0,
      guardedMaxUsd: 0.033,
      automaticRetries: 0,
      payloadTemplate: falFluxPayloadTemplate('klein'),
      pricingSource: 'https://fal.ai/models/fal-ai/flux-2/klein/9b/edit',
      apiSource: 'https://fal.ai/models/fal-ai/flux-2/klein/9b/edit/api',
    },
    {
      id: 'plan-b-bfl-pro-via-fal',
      plan: 'B',
      hypothesis: 'BFL FLUX.2 Pro may approach current quality at a lower request price.',
      supplier: 'Black Forest Labs',
      distributor: 'fal',
      model: 'fal-ai/flux-2-pro/edit',
      adapter: 'fal',
      endpoint: 'https://queue.fal.run/fal-ai/flux-2-pro/edit',
      secretName: 'FAL_API_KEY',
      promptPath: 'prompts/high-kick-refine.txt',
      promptSha256: refinePromptSha256,
      references: ['identity', 'high-kick-impact'],
      output: { requestedWidth: 864, requestedHeight: 1152, normalizeWidth: 768, normalizeHeight: 1024, format: 'png' },
      seed: BENCHMARK_SEED_REFINE,
      estimatedFixedUsd: 0.060,
      inputReserveUsd: 0,
      guardedMaxUsd: 0.060,
      automaticRetries: 0,
      payloadTemplate: falFluxPayloadTemplate('pro'),
      pricingSource: 'https://fal.ai/models/fal-ai/flux-2-pro/edit',
      apiSource: 'https://fal.ai/models/fal-ai/flux-2-pro/edit/api',
    },
    {
      id: 'plan-b-flux2-flash-via-fal',
      plan: 'B',
      hypothesis: 'fal FLUX.2 Flash may be the cheapest usable renderer for individual frames.',
      supplier: 'Black Forest Labs / fal',
      distributor: 'fal',
      model: 'fal-ai/flux-2/flash/edit',
      adapter: 'fal',
      endpoint: 'https://queue.fal.run/fal-ai/flux-2/flash/edit',
      secretName: 'FAL_API_KEY',
      promptPath: 'prompts/high-kick-refine.txt',
      promptSha256: refinePromptSha256,
      references: ['identity', 'high-kick-impact'],
      output: { requestedWidth: 864, requestedHeight: 1152, normalizeWidth: 768, normalizeHeight: 1024, format: 'png' },
      seed: BENCHMARK_SEED_REFINE,
      estimatedFixedUsd: 0.015,
      inputReserveUsd: 0,
      guardedMaxUsd: 0.050,
      automaticRetries: 0,
      payloadTemplate: falFluxPayloadTemplate('flash'),
      pricingSource: 'https://fal.ai/models/fal-ai/flux-2/flash/edit',
      apiSource: 'https://fal.ai/models/fal-ai/flux-2/flash/edit/api',
    },
    {
      id: 'plan-b-seedream-4-via-fal',
      plan: 'B',
      hypothesis: 'Seedream 4 may preserve identity and exact pose at a lower fixed output price.',
      supplier: 'ByteDance',
      distributor: 'fal',
      model: 'fal-ai/bytedance/seedream/v4/edit',
      adapter: 'fal',
      endpoint: 'https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit',
      secretName: 'FAL_API_KEY',
      promptPath: 'prompts/high-kick-refine.txt',
      promptSha256: refinePromptSha256,
      references: ['identity', 'high-kick-impact'],
      output: { requestedWidth: 864, requestedHeight: 1152, normalizeWidth: 768, normalizeHeight: 1024, format: 'provider-default' },
      seed: BENCHMARK_SEED_REFINE,
      estimatedFixedUsd: 0.030,
      inputReserveUsd: 0,
      guardedMaxUsd: 0.030,
      automaticRetries: 0,
      payloadTemplate: seedreamPayloadTemplate(),
      pricingSource: 'https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit',
      apiSource: 'https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit/api',
    },
  ];
}

export interface BudgetSummary {
  planAFixedUsd: number;
  planAGuardedUsd: number;
  planBFixedUsd: number;
  planBGuardedUsd: number;
  combinedFixedUsd: number;
  combinedGuardedUsd: number;
  hardCapUsd: number;
  maxPaidSubmissions: number;
}

function sumMoney(values: number[]): number {
  return Number(values.reduce((sum, value) => sum + value, 0).toFixed(6));
}

export function buildBudgetSummary(requests = buildBenchmarkRequests()): BudgetSummary {
  const planA = requests.filter((request) => request.plan === 'A');
  const planB = requests.filter((request) => request.plan === 'B');
  return {
    planAFixedUsd: sumMoney(planA.map((request) => request.estimatedFixedUsd)),
    planAGuardedUsd: sumMoney(planA.map((request) => request.guardedMaxUsd)),
    planBFixedUsd: sumMoney(planB.map((request) => request.estimatedFixedUsd)),
    planBGuardedUsd: sumMoney(planB.map((request) => request.guardedMaxUsd)),
    combinedFixedUsd: sumMoney(requests.map((request) => request.estimatedFixedUsd)),
    combinedGuardedUsd: sumMoney(requests.map((request) => request.guardedMaxUsd)),
    hardCapUsd: BENCHMARK_HARD_CAP_USD,
    maxPaidSubmissions: requests.length,
  };
}

export function benchmarkPlanFingerprint(requests = buildBenchmarkRequests()): string {
  return sha256Text(JSON.stringify({
    runId: BENCHMARK_RUN_ID,
    inputs: EXPECTED_INPUTS,
    requests,
    budget: buildBudgetSummary(requests),
  }));
}

export function validateBenchmarkPlan(requests = buildBenchmarkRequests()): void {
  const budget = buildBudgetSummary(requests);
  const planA = requests.filter((request) => request.plan === 'A');
  const planB = requests.filter((request) => request.plan === 'B');

  if (planA.length !== 1 || planB.length !== 6 || requests.length !== 7) {
    throw new Error('The approved benchmark must contain exactly 1 Plan A and 6 Plan B submissions.');
  }
  if (requests.some((request) => request.automaticRetries !== 0)) {
    throw new Error('Automatic retries are forbidden for paid benchmark submissions.');
  }
  if (budget.planAGuardedUsd > 0.20 || budget.planBGuardedUsd > 0.30) {
    throw new Error('A plan-level guarded budget exceeds its approved limit.');
  }
  if (budget.combinedGuardedUsd > BENCHMARK_HARD_CAP_USD) {
    throw new Error('The guarded benchmark total exceeds the approved USD 0.50 cap.');
  }
  if (new Set(requests.map((request) => request.id)).size !== requests.length) {
    throw new Error('Benchmark request ids must be unique.');
  }
  if (requests.some((request) => request.plan === 'B' && request.promptSha256 !== sha256Text(buildHighKickRefinePrompt()))) {
    throw new Error('Every Plan B renderer must receive the exact same refine prompt.');
  }
}
