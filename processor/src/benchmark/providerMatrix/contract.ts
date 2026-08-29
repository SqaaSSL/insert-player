export type RendererId =
  | 'gemini-flash'
  | 'gemini-pro'
  | 'klein-4b'
  | 'klein-9b'
  | 'flux2-pro'
  | 'flux2-flash'
  | 'seedream-4';

export type ProviderAdapterId = 'gemini-inline' | 'fal-queue';

export type StrategyId =
  | 'direct-sheet'
  | 'sheet-independent'
  | 'canonical-independent'
  | 'previous-delta'
  | 'canonical-previous'
  | 'previous-pose';

export type AnimationId =
  | 'idle'
  | 'walk'
  | 'high_punch'
  | 'high_kick'
  | 'low_punch'
  | 'low_kick'
  | 'jump'
  | 'crouch'
  | 'hit'
  | 'ko'
  | 'victory';

export type ReferenceRole = 'canonical' | 'pose-cell' | 'previous-frame';

export interface RendererSpec {
  id: RendererId;
  label: string;
  adapter: ProviderAdapterId;
  model: string;
  endpoint: string;
  maximumReferences: number;
  editableImageMustBeFirst: boolean;
  supportsSeed: boolean;
  guardsUsd: {
    directSheet: number;
    oneReferenceFrame: number;
    twoReferenceFrame: number;
  };
  observedUsd?: {
    oneReferenceFrame?: number;
    twoReferenceFrame?: number;
  };
}

export interface AnimationTopology {
  id: AnimationId;
  base: 'standing' | 'crouched' | 'standing-to-crouched';
  frameCount: number;
  uniqueFrameCount: number;
  grid: { columns: number; rows: number };
  playbackOrder: readonly number[];
  hybridAnchors: readonly number[];
  phases: readonly string[];
}

export interface ReferenceBinding {
  role: ReferenceRole;
  source: 'frozen-canonical' | 'frozen-pose-cell' | 'generated-frame';
  frameIndex?: number;
}

export interface GenerationNode {
  id: string;
  rendererId: RendererId;
  strategyId: StrategyId;
  animationId: AnimationId;
  kind: 'generate-sheet' | 'generate-frame';
  frameIndex?: number;
  dependsOn: readonly string[];
  references: readonly ReferenceBinding[];
  prompt: string;
  seed: number;
  width: number;
  height: number;
  guardedMaxUsd: number;
}

export interface CleanupNode {
  id: string;
  rendererId: RendererId;
  strategyId: StrategyId;
  animationId: AnimationId;
  kind: 'cleanup';
  frameIndex: number;
  dependsOn: readonly string[];
  guardedMaxUsd: number;
}

export type BenchmarkNode = GenerationNode | CleanupNode;

export interface StrategyPlan {
  rendererId: RendererId;
  strategyId: StrategyId;
  animationId: AnimationId;
  nodes: readonly BenchmarkNode[];
  guardedBudgetUsd: number;
  maxPaidSubmissions: number;
}
