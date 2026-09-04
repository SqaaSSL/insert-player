import { readJsonBody } from './requestBody';
import type { Env } from './types';

const CAPTURE_BODY_LIMIT_BYTES = 8 * 1024;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const STREET_VIEW_STATIC_URL = 'https://maps.googleapis.com/maps/api/streetview';
const SUPPORTED_CAPTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface StreetViewCaptureBody {
  panoId?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  heading?: unknown;
  pitch?: unknown;
  fov?: unknown;
}

interface StreetViewCapture {
  panoId: string;
  latitude: number;
  longitude: number;
  heading: number;
  pitch: number;
  fov: number;
}

export async function captureStreetViewImage(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const serverKey = env.GOOGLE_MAPS_SERVER_KEY?.trim();
  if (!serverKey) {
    return Response.json(
      { error: 'Street View capture is not configured.' },
      { status: 503 },
    );
  }

  const body = await readJsonBody<StreetViewCaptureBody>(request, CAPTURE_BODY_LIMIT_BYTES);
  const capture = validateCapture(body);
  if (capture instanceof Response) return capture;

  const upstreamUrl = new URL(STREET_VIEW_STATIC_URL);
  upstreamUrl.searchParams.set('size', '640x360');
  upstreamUrl.searchParams.set('scale', '2');
  upstreamUrl.searchParams.set('pano', capture.panoId);
  upstreamUrl.searchParams.set('heading', String(capture.heading));
  upstreamUrl.searchParams.set('pitch', String(capture.pitch));
  upstreamUrl.searchParams.set('fov', String(capture.fov));
  upstreamUrl.searchParams.set('return_error_code', 'true');
  upstreamUrl.searchParams.set('key', serverKey);

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl.toString(), {
      method: 'GET',
      // Google may route Street View imagery through a regional image host.
      // The request origin is fixed above, so following that redirect does not
      // create a user-controlled redirect or SSRF path.
      redirect: 'follow',
    });
  } catch {
    return Response.json({ error: 'Street View is temporarily unavailable.' }, { status: 502 });
  }

  // The Maps JavaScript API can expose legacy/user-contributed panorama IDs
  // that Street View Static rejects even though the panorama is available by
  // its exact coordinates. Preserve exact pano selection whenever possible,
  // then fall back to the validated panorama position for those photospheres.
  if (upstream.status === 404) {
    const locationUrl = new URL(upstreamUrl);
    locationUrl.searchParams.delete('pano');
    locationUrl.searchParams.set('location', `${capture.latitude},${capture.longitude}`);
    locationUrl.searchParams.set('radius', '25');
    try {
      upstream = await fetchImpl(locationUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
      });
    } catch {
      return Response.json({ error: 'Street View is temporarily unavailable.' }, { status: 502 });
    }
  }

  if (!upstream.ok) {
    const status = upstream.status === 404 ? 404 : upstream.status === 429 ? 429 : 502;
    const error = upstream.status === 404
      ? 'This panorama is no longer available. Choose another blue Street View line.'
      : upstream.status === 429
        ? 'Street View capture quota has been reached. Try again later.'
        : 'Google could not capture this Street View image.';
    return Response.json({ error }, { status });
  }

  const contentType = upstream.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!SUPPORTED_CAPTURE_TYPES.has(contentType)) {
    return Response.json({ error: 'Google returned an unexpected capture response.' }, { status: 502 });
  }
  const declaredLength = Number(upstream.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTURE_BYTES) {
    return Response.json({ error: 'Street View capture exceeded the supported size.' }, { status: 502 });
  }
  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTURE_BYTES) {
    return Response.json({ error: 'Street View returned an invalid capture.' }, { status: 502 });
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function validateCapture(body: StreetViewCaptureBody): StreetViewCapture | Response {
  const panoId = typeof body.panoId === 'string' ? body.panoId.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(panoId)) {
    return Response.json({ error: 'Invalid Street View panorama.' }, { status: 400 });
  }
  if (!numberInRange(body.latitude, -90, 90) || !numberInRange(body.longitude, -180, 180)) {
    return Response.json({ error: 'Invalid Street View position.' }, { status: 400 });
  }
  if (!numberInRange(body.heading, 0, 360)) {
    return Response.json({ error: 'Invalid Street View heading.' }, { status: 400 });
  }
  if (!numberInRange(body.pitch, -90, 90)) {
    return Response.json({ error: 'Invalid Street View pitch.' }, { status: 400 });
  }
  if (!numberInRange(body.fov, 10, 120)) {
    return Response.json({ error: 'Invalid Street View field of view.' }, { status: 400 });
  }
  return {
    panoId,
    latitude: Number(body.latitude),
    longitude: Number(body.longitude),
    heading: round(Number(body.heading)),
    pitch: round(Number(body.pitch)),
    fov: round(Number(body.fov)),
  };
}

function numberInRange(value: unknown, min: number, max: number): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
