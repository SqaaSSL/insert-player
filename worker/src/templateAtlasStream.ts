import { NonRetryableError } from 'cloudflare:workflows';

export interface TemplateAtlasStreamInput { planId: string; rawKey: string; sizeBytes?: number }
const encoder = new TextEncoder();
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 24 * 1024;

function base64(bytes: Uint8Array): Uint8Array {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return encoder.encode(btoa(binary));
}

/** Stream private RAWs into the existing JSON RPC without buffering the complete
 * binary + base64 + JSON + Request copies in the 128 MiB Workflow isolate. */
export function templateAtlasCompileBody(bucket: R2Bucket, fields: Record<string, unknown>,
  inputs: readonly TemplateAtlasStreamInput[]): ReadableStream<Uint8Array> {
  if ('atlases' in fields || !inputs.length || inputs.length > 2) throw new NonRetryableError('Invalid atlas stream inputs');
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const fieldsJson = JSON.stringify(fields);
    yield encoder.encode(`${fieldsJson.slice(0, -1)}${Object.keys(fields).length ? ',' : ''}"atlases":[`);
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const object = await bucket.get(input.rawKey);
      if (!object || object.size < 24 || object.size > MAX_RAW_BYTES
        || (input.sizeBytes !== undefined && object.size !== input.sizeBytes)) {
        throw new NonRetryableError('Preserved atlas RAW is missing or has changed size; refusing paid regeneration');
      }
      yield encoder.encode(`${index ? ',' : ''}{"planId":${JSON.stringify(input.planId)},"rawBase64":"`);
      const reader = object.body.getReader();
      let carry = new Uint8Array(0), bytesRead = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          if (bytesRead > object.size || bytesRead > MAX_RAW_BYTES) throw new NonRetryableError('Atlas RAW stream exceeds its verified size');
          // R2 may supply larger chunks; bound temporary base64 strings ourselves.
          for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
            const slice = value.subarray(offset, offset + CHUNK_BYTES);
            const joined = new Uint8Array(carry.length + slice.length);
            joined.set(carry); joined.set(slice, carry.length);
            const complete = joined.length - joined.length % 3;
            if (complete) yield base64(joined.subarray(0, complete));
            carry = joined.slice(complete);
          }
        }
        if (bytesRead !== object.size) throw new NonRetryableError('Atlas RAW stream ended before its verified size');
        if (carry.length) yield base64(carry);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      yield encoder.encode('"}');
    }
    yield encoder.encode(']}');
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  });
}
