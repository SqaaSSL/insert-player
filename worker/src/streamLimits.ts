export class ResponseBodyTooLargeError extends Error {
  constructor() {
    super('Upstream response body is too large');
    this.name = 'ResponseBodyTooLargeError';
  }
}

export function createBoundedByteStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let totalBytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        controller.error(new ResponseBodyTooLargeError());
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}
