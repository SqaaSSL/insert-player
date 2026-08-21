import { describe, expect, it } from 'vitest';
import {
  InvalidMultipartBodyError,
  InvalidJsonBodyError,
  createBoundedRequestStream,
  readJsonBody,
  readMultipartFormData,
  readRequestBytes,
  readRequestText,
  rejectDeclaredBodyTooLarge,
  RequestBodyTooLargeError,
} from './requestBody';

describe('bounded Worker request bodies', () => {
  it('parses a small JSON object', async () => {
    const request = new Request('https://api.example.test/body', {
      method: 'POST',
      body: JSON.stringify({ tier: 'rookie' }),
    });

    await expect(readJsonBody<{ tier: string }>(request, 1024)).resolves.toEqual({ tier: 'rookie' });
  });

  it('rejects invalid or non-object JSON', async () => {
    const invalid = new Request('https://api.example.test/body', { method: 'POST', body: '{' });
    const array = new Request('https://api.example.test/body', { method: 'POST', body: '[]' });

    await expect(readJsonBody(invalid, 1024)).rejects.toBeInstanceOf(InvalidJsonBodyError);
    await expect(readJsonBody(array, 1024)).rejects.toBeInstanceOf(InvalidJsonBodyError);
  });

  it('rejects declared and streamed bodies over the route limit', async () => {
    const declared = new Request('https://api.example.test/body', {
      method: 'POST',
      headers: { 'Content-Length': '2048' },
      body: 'small',
    });
    const streamed = new Request('https://api.example.test/body', {
      method: 'POST',
      body: 'x'.repeat(2048),
    });

    expect(rejectDeclaredBodyTooLarge(declared, 1024)?.status).toBe(413);
    await expect(readRequestText(streamed, 1024)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('parses multipart only after reading it through the byte cap', async () => {
    const formData = new FormData();
    formData.set('kind', 'side');
    formData.set('file', new File(['small'], 'side.png', { type: 'image/png' }));
    const request = new Request('https://api.example.test/body', {
      method: 'POST',
      body: formData,
    });

    const parsed = await readMultipartFormData(request, 1024);

    expect(parsed.get('kind')).toBe('side');
    expect(parsed.get('file')).toBeInstanceOf(File);
  });

  it('rejects chunked multipart bytes over the cap before parsing', async () => {
    const request = () => {
      const formData = new FormData();
      formData.set('file', new File(['x'.repeat(2048)], 'large.png', { type: 'image/png' }));
      const multipartRequest = new Request('https://api.example.test/body', {
        method: 'POST',
        body: formData,
      });
      multipartRequest.headers.delete('Content-Length');
      return multipartRequest;
    };

    await expect(readRequestBytes(request(), 1024)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    await expect(readMultipartFormData(request(), 1024)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('stops a forwarded request stream when a chunk crosses the cap', async () => {
    const request = new Request('https://api.example.test/body', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const bounded = createBoundedRequestStream(request, 8);

    await expect(new Response(bounded.body).arrayBuffer()).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(bounded.didExceedLimit()).toBe(true);
  });

  it('rejects malformed or non-multipart bodies as client errors', async () => {
    const wrongType = new Request('https://api.example.test/body', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const malformed = new Request('https://api.example.test/body', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=missing' },
      body: 'not-a-multipart-body',
    });

    await expect(readMultipartFormData(wrongType, 1024)).rejects.toBeInstanceOf(InvalidMultipartBodyError);
    await expect(readMultipartFormData(malformed, 1024)).rejects.toBeInstanceOf(InvalidMultipartBodyError);
  });
});
