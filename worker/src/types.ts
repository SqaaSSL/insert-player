import type { SpriteAnimationFormat } from './spriteAnimationFormat';
import type { GenerationCreationFlow } from '../../src/services/GenerationCreationFlow';
import type { VideoGenerationPolicy } from '../../src/services/VideoGenerationPolicy';

export type QualityTier = 'rookie' | 'contender' | 'champion';

type OptionalCloudflareBindings = Partial<
  Omit<Cloudflare.Env, 'DB' | 'SPRITES' | 'ENVIRONMENT' | 'CORS_ORIGIN'>
>;

export interface Env extends OptionalCloudflareBindings {
  DB: Cloudflare.Env['DB'];
  SPRITES: Cloudflare.Env['SPRITES'];
  ENVIRONMENT: Cloudflare.Env['ENVIRONMENT'];
  CORS_ORIGIN: Cloudflare.Env['CORS_ORIGIN'];
  CLERK_JWKS_URL?: string;
  CLERK_BACKEND_AUTH_BRIDGE_SECRET?: string;
  /** Optional Cloudflare Realtime TURN credentials for online versus. */
  REALTIME_TURN_KEY_ID?: string;
  REALTIME_TURN_API_TOKEN?: string;
}

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type GenerationJobReviewStatus = 'none' | 'awaiting_review' | 'approved' | 'rejected';
export type GenerationJobOperation =
  | 'fighter_generation'
  | 'fighter_upgrade'
  | 'fighter_retry_animation'
  | 'fighter_retry_source';

export interface GenerationJob {
  id: string;
  workflow_instance_id: string;
  user_id: string;
  fighter_id: string;
  charge_id: string;
  provider_session_id: string;
  tier: QualityTier;
  creation_flow: GenerationCreationFlow;
  operation: GenerationJobOperation;
  target_kind: 'animation' | 'source' | null;
  target_name: string | null;
  artifact_run_id: string | null;
  resumed_from_job_id: string | null;
  status: GenerationJobStatus;
  review_status?: GenerationJobReviewStatus;
  stage: string;
  failure_stage: string | null;
  progress_current: number;
  progress_total: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export type GenerationArtifactRunStatus =
  | 'active'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'superseded';

export interface GenerationArtifactRun {
  id: string;
  user_id: string;
  fighter_id: string;
  tier: QualityTier;
  creation_flow: GenerationCreationFlow;
  video_generation_policy: VideoGenerationPolicy | null;
  operation: GenerationJobOperation;
  target_kind: 'animation' | 'source' | null;
  target_name: string | null;
  root_job_id: string;
  original_charge_id: string | null;
  original_blob_key: string | null;
  source_manifest_json: string | null;
  generation_prompt: string | null;
  pipeline_version: number;
  status: GenerationArtifactRunStatus;
  failure_stage: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface GenerationArtifactCheckpoint {
  run_id: string;
  artifact_kind: 'source' | 'sprite';
  artifact_name: string;
  stage_index: number;
  tier: QualityTier;
  status: 'approved' | 'corrupt';
  clean_version_id: string;
  raw_version_id: string | null;
  clean_blob_key: string;
  raw_blob_key: string | null;
  clean_content_hash: string | null;
  raw_content_hash: string | null;
  frame_w: number | null;
  frame_h: number | null;
  frame_count: number | null;
  animation_format: SpriteAnimationFormat;
  processing_version: number | null;
  metadata_json: string | null;
  completed_by_job_id: string;
  created_at: string;
  verified_at: string | null;
}

export interface User {
  id: string;
  clerk_user_id: string | null;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
  plan_tier: 'free' | 'pro' | 'studio' | 'admin';
  credits_balance: number;
  free_rookie_generations_used: number;
  stripe_customer_id: string | null;
  elo_rating: number;
  wins: number;
  losses: number;
  win_streak: number;
  best_streak: number;
  total_kos: number;
  created_at: string;
  updated_at: string;
}

export interface AuthContext {
  userId: string;
  user: User;
  claims: Record<string, unknown>;
}

export interface PublicAuthContext {
  userId: string | null;
  rateLimitKey: string;
  user: User | null;
  claims: Record<string, unknown> | null;
}

export interface Fighter {
  id: string;
  owner_user_id: string;
  name: string;
  photo_hash: string;
  quality_tier: QualityTier;
  public_flag: number;
  original_blob_key: string | null;
  side_view_blob_key: string | null;
  side_view_raw_blob_key: string | null;
  upright_view_blob_key: string | null;
  upright_view_raw_blob_key: string | null;
  crouch_view_blob_key: string | null;
  crouch_view_raw_blob_key: string | null;
  created_at: string;
  updated_at: string;
}

export type FighterPersonalityId = 'balanced' | 'brawler' | 'counter' | 'zoner' | 'showboat';

export interface ArcadeFighter {
  fighter_id: string;
  slug: string;
  sort_order: number;
  challenger_line: string;
  default_personality: FighterPersonalityId;
  reference_kind: 'generated' | 'licensed';
  reference_source_url: string | null;
  reference_license: string;
  reference_credit: string;
  generation_prompt: string | null;
  status: 'draft' | 'active' | 'retired';
  created_at: string;
  updated_at: string;
}

export interface SpriteAsset {
  id: string;
  fighter_id: string;
  animation_name: string;
  quality_tier: QualityTier;
  blob_key: string;
  raw_blob_key: string | null;
  content_hash: string | null;
  raw_content_hash: string | null;
  frame_w: number;
  frame_h: number;
  frame_count: number;
  animation_format: SpriteAnimationFormat;
  processing_version: number;
  created_at: string;
}

export interface SpriteVersion extends SpriteAsset {}

export interface SourceVersion {
  id: string;
  fighter_id: string;
  kind: string;
  blob_key: string;
  content_hash: string | null;
  created_at: string;
}

export interface Stage {
  id: string;
  owner_user_id: string;
  label: string;
  kind: 'generated' | 'photo' | 'photo-direct';
  blob_key: string;
  public_flag: number;
  created_at: string;
  updated_at: string;
}

export interface Character {
  id: string;
  user_id: string;
  name: string;
  photo_hash: string;
  sprite_r2_key: string | null;
  intro_r2_key: string | null;
  side_view_r2_key: string | null;
  sprite_status: 'pending' | 'processing' | 'ready' | 'error';
  created_at: string;
}
