export interface Env {
  DB: D1Database;
  SPRITES: R2Bucket;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  LUDO_API_KEY: string;
  FREEPIK_API_KEY: string;
  JWT_SECRET: string;
  CORS_ORIGIN: string;
}

export interface User {
  id: string;
  display_name: string;
  avatar_url: string | null;
  oauth_provider: string;
  oauth_id: string;
  elo_rating: number;
  wins: number;
  losses: number;
  win_streak: number;
  best_streak: number;
  total_kos: number;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
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

export interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

export interface GoogleUserInfo {
  sub: string;
  name: string;
  picture: string;
  email: string;
}
