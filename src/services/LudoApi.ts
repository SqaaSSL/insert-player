const LUDO_BASE = '/proxy/ludo';

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
  };
}

export interface AnimateSpriteRequest {
  motion_prompt: string;
  initial_image: string; // URL or base64
  final_image?: string;
  loop?: boolean;
  crop?: boolean;
  frames?: 4 | 9 | 16 | 25 | 36 | 49 | 64;
  frame_size?: 32 | 64 | 96 | 128 | 192 | 256 | 384 | 0;
  margin_ratio_mode?: 'auto' | 'manual' | 'none';
  margin_ratio?: number;
  image_type?: 'sprite' | 'sprite-vfx' | 'ui_asset';
  model?: 'standard' | 'new';
  duration?: 1.2 | 1.5 | 2 | 2.5 | 3 | 4;
  augment_prompt?: boolean;
  gif?: boolean;
  individual_frames?: boolean;
  request_id?: string;
}

export interface AnimateSpriteResponse {
  spritesheet_url: string;
  video_url: string;
  num_frames: number;
  duration: number;
  request_id?: string;
  created_at: number;
}

export interface GeneratePoseRequest {
  image: string; // URL or base64
  pose: string;
  description?: string;
  n?: number;
  augment_prompt?: boolean;
  request_id?: string;
}

export interface GeneratePoseResponse {
  url: string;
  pose: string;
  description: string;
  motion_prompt: string;
}

export interface CreateImageRequest {
  image_type: 'sprite';
  prompt: string;
  art_style?: string;
  perspective?: string;
  aspect_ratio?: string;
  n?: number;
  augment_prompt?: boolean;
  request_id?: string;
}

export interface CreateImageResponse {
  url: string;
  request_id?: string;
  created_at: number;
}

export async function ludoAnimateSprite(req: AnimateSpriteRequest): Promise<AnimateSpriteResponse> {
  const res = await fetch(`${LUDO_BASE}/assets/sprite/animate`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ludo animateSprite failed (${res.status}): ${err}`);
  }
  return res.json();
}

export async function ludoGeneratePose(req: GeneratePoseRequest): Promise<GeneratePoseResponse[]> {
  const res = await fetch(`${LUDO_BASE}/assets/sprite/pose`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ludo generatePose failed (${res.status}): ${err}`);
  }
  return res.json();
}

export async function ludoCreateImage(req: CreateImageRequest): Promise<CreateImageResponse[]> {
  const res = await fetch(`${LUDO_BASE}/assets/image`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ludo createImage failed (${res.status}): ${err}`);
  }
  return res.json();
}

export async function ludoValidateKey(): Promise<boolean> {
  try {
    const res = await fetch(`${LUDO_BASE}/auth/validate-api-key`, {
      headers: headers(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ludoGetSpriteResults(requestId?: string): Promise<any[]> {
  const url = new URL(`${LUDO_BASE}/assets/sprites/results`);
  if (requestId) url.searchParams.set('request_id', requestId);
  const res = await fetch(url.toString(), { headers: headers() });
  if (!res.ok) throw new Error(`Ludo getResults failed: ${res.status}`);
  return res.json();
}

export async function ludoListAnimationPresets(): Promise<any> {
  const res = await fetch(`${LUDO_BASE}/assets/sprite/animation-presets`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Ludo listPresets failed: ${res.status}`);
  return res.json();
}
