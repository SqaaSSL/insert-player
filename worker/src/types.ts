export type QualityTier = 'rookie' | 'contender' | 'champion';

export interface Env {
  DB: D1Database;
  SPRITES: R2Bucket;
  ENVIRONMENT: string;
  CORS_ORIGIN: string;
  CLERK_ISSUER?: string;
  CLERK_JWKS_URL?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  CLERK_WEBHOOK_SIGNING_SECRET?: string;
  ANONYMIZATION_SECRET?: string;
  LUDO_API_KEY?: string;
  FREEPIK_API_KEY?: string;
  GEMINI_API_KEY?: string;
  RUNWAY_API_KEY?: string;
  FAL_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_ACCOUNT_ID?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_VERSUS?: string;
  STRIPE_PRICE_ARCADE?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_REQUIRED?: string;
  TURNSTILE_ACTION?: string;
  TURNSTILE_HOSTNAMES?: string;
  ANONYMOUS_ROOKIE_ENABLED?: string;
  PROVIDER_MONTHLY_BUDGET_USD_CENTS?: string;
  GEMINI_SPEND_RATE_LIMIT_USD_CENTS?: string;
  PUBLIC_APP_NAME?: string;
  PUBLIC_APP_SHORT_NAME?: string;
  PUBLIC_SOCIAL_CARD_PATH?: string;
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
