export const DEFAULT_JSON_BODY_LIMIT_BYTES = 64 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super('Invalid JSON request body');
    this.name = 'InvalidJsonBodyError';
  }
}

export class InvalidMultipartBodyError extends Error {
  constructor() {
    super('Invalid multipart request body');
    this.name = 'InvalidMultipartBodyError';
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get('Content-Length');
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function rejectDeclaredBodyTooLarge(request: Request, maxBytes: number): Response | null {
  const contentLength = declaredContentLength(request);
  if (contentLength !== null && contentLength > maxBytes) {
    return Response.json({ error: 'Request body is too large' }, { status: 413 });
  }
  return null;
}

export interface BoundedRequestStream {
  body: ReadableStream<Uint8Array> | null;
  didExceedLimit: () => boolean;
}

export function createBoundedRequestStream(request: Request, maxBytes: number): BoundedRequestStream {
  if (rejectDeclaredBodyTooLarge(request, maxBytes)) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) {
    return { body: null, didExceedLimit: () => false };
  }

  let totalBytes = 0;
  let exceededLimit = false;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        exceededLimit = true;
        controller.error(new RequestBodyTooLargeError());
        return;
      }
      controller.enqueue(chunk);
    },
  }));

  return { body, didExceedLimit: () => exceededLimit };
}

export async function readRequestText(request: Request, maxBytes: number): Promise<string> {
  if (rejectDeclaredBodyTooLarge(request, maxBytes)) {
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function readRequestBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (rejectDeclaredBodyTooLarge(request, maxBytes)) {
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads a request body once into memory (bounded by `maxBytes`) and returns a
 * request whose body is that byte array with a known Content-Length.
 *
 * Provider proxying previously teed the incoming network stream (one branch for
 * the durable request hash, one for the upstream fetch) and forwarded it as a
 * chunked stream. Worker-to-Worker dispatches with multi-megabyte chunked bodies
 * failed before any upstream response, so provider bodies are now buffered once
 * and sent with a fixed length.
 */
export async function bufferRequestBody(request: Request, maxBytes: number): Promise<Request> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return request;
  const bytes = await readRequestBytes(request, maxBytes);
  const headers = new Headers(request.headers);
  headers.set('Content-Length', String(bytes.byteLength));
  return new Request(request.url, { method: request.method, headers, body: bytes });
}

export async function readMultipartFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw new InvalidMultipartBodyError();
  }
  if (rejectDeclaredBodyTooLarge(request, maxBytes)) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) throw new InvalidMultipartBodyError();

  let totalBytes = 0;
  let tooLarge = false;
  const boundedBody = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        controller.error(new RequestBodyTooLargeError());
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  try {
    return await new Response(boundedBody, {
      headers: { 'Content-Type': contentType },
    }).formData();
  } catch {
    if (tooLarge) throw new RequestBodyTooLargeError();
    throw new InvalidMultipartBodyError();
  }
}

export async function readJsonBody<T extends object>(
  request: Request,
  maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<T> {
  const raw = await readRequestText(request, maxBytes);
  if (!raw.trim()) return {} as T;

  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidJsonBodyError();
    }
    return value as T;
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) throw error;
    throw new InvalidJsonBodyError();
  }
}
