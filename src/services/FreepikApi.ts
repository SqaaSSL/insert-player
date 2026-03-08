const FREEPIK_BASE = '/proxy/freepik';

export interface KontextProRequest {
  prompt: string;
  input_image?: string;
  guidance?: number;
  steps?: number;
  aspect_ratio?: string;
  safety_tolerance?: number;
  output_format?: 'jpeg' | 'png';
  prompt_upsampling?: boolean;
}

export interface KontextTaskResponse {
  data: {
    task_id: string;
    status: 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    generated?: string[];
  };
}

async function freepikKontextProCreate(req: KontextProRequest): Promise<string> {
  const res = await fetch(`${FREEPIK_BASE}/v1/ai/text-to-image/flux-kontext-pro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kontext Pro create failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json: KontextTaskResponse = await res.json();
  return json.data.task_id;
}

async function freepikKontextProPoll(taskId: string, maxWaitMs = 120_000): Promise<string[]> {
  const start = Date.now();
  const pollInterval = 3000;

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${FREEPIK_BASE}/v1/ai/text-to-image/flux-kontext-pro/${taskId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`Kontext Pro poll ${res.status}:`, body.slice(0, 200));
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    const json: KontextTaskResponse = await res.json();
    console.log(`[KontextPro] task ${taskId} status: ${json.data.status}`);

    if (json.data.status === 'COMPLETED') {
      if (!json.data.generated?.length) {
        throw new Error('Kontext Pro completed but returned no images');
      }
      return json.data.generated;
    }

    if (json.data.status === 'FAILED') {
      throw new Error('Kontext Pro task failed');
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Kontext Pro timed out after ${maxWaitMs / 1000}s`);
}

async function uploadTempImage(base64: string): Promise<string> {
  const res = await fetch('/proxy/upload-temp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64 }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Temp upload failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.url;
}

export async function freepikImageToFightingStance(
  imageBase64: string,
): Promise<string> {
  const resized = await resizeImageForApi(imageBase64);

  console.log('[FreepikApi] Uploading temp image for Kontext Pro...');
  const publicUrl = await uploadTempImage(resized);
  console.log(`[FreepikApi] Temp URL: ${publicUrl}`);

  console.log('[FreepikApi] Creating Kontext Pro task...');
  const taskId = await freepikKontextProCreate({
    prompt: 'Keep the EXACT same person with identical face, hair, skin tone, clothing, colors, and proportions. Repose them in a 3/4 view facing right, similar to a classic Street Fighter character select pose. Upper body slightly angled toward the camera, fighting stance with fists raised. Full body visible from head to feet, clean solid-color background. Preserve all facial features and identity faithfully.',
    input_image: publicUrl,
    guidance: 7,
    steps: 50,
    aspect_ratio: 'square_1_1',
    safety_tolerance: 6,
    output_format: 'png',
    prompt_upsampling: false,
  });
  console.log(`[FreepikApi] Task created: ${taskId}, polling...`);

  const urls = await freepikKontextProPoll(taskId);
  return urls[0];
}

const MAX_DIMENSION = 1024;
const MAX_BASE64_BYTES = 4 * 1024 * 1024;

export async function resizeImageForApi(base64: string): Promise<string> {
  const dataUrl = `data:image/png;base64,${base64}`;
  const img = await loadImg(dataUrl);

  const needsResize = img.width > MAX_DIMENSION || img.height > MAX_DIMENSION || base64.length > MAX_BASE64_BYTES;
  if (!needsResize) return base64;

  const scale = Math.min(MAX_DIMENSION / img.width, MAX_DIMENSION / img.height, 1);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);

  let quality = 0.85;
  let result = canvas.toDataURL('image/jpeg', quality).split(',')[1];

  while (result.length > MAX_BASE64_BYTES && quality > 0.3) {
    quality -= 0.15;
    result = canvas.toDataURL('image/jpeg', quality).split(',')[1];
  }

  console.log(`[resize] ${img.width}x${img.height} → ${w}x${h}, base64: ${(base64.length / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB`);
  return result;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ─── Background Removal ──────────────────────────────────────────────

interface BgRemoveResponse {
  data: {
    attributes: {
      image: {
        url: string;
        original: string;
        high_resolution: string;
        preview: string;
      };
    };
  };
}

export async function freepikRemoveBackground(imageBase64: string): Promise<string> {
  const resized = await resizeImageForApi(imageBase64);
  const publicUrl = await uploadTempImage(resized);

  console.log('[FreepikApi] Removing background via API...');
  const formData = new FormData();
  formData.append('image_url', publicUrl);

  const res = await fetch(`${FREEPIK_BASE}/v1/ai/beta/remove-background`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Freepik bg-remove failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json: BgRemoveResponse = await res.json();
  const resultUrl = json.data?.attributes?.image?.high_resolution || json.data?.attributes?.image?.url;
  if (!resultUrl) throw new Error('Freepik bg-remove returned no image URL');

  console.log(`[FreepikApi] Background removed, fetching result...`);
  const resultBase64 = await urlToBase64(resultUrl);
  return resultBase64;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function urlToBase64(url: string): Promise<string> {
  const proxied = `/proxy/image?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxied);
  const blob = await res.blob();
  return blobToBase64(blob);
}
