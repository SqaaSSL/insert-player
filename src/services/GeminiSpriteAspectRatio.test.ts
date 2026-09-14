import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './ApiClient';
import { geminiReposeDetailed, geminiSpriteScaffoldAspectRatio, geminiSpriteSheet } from './GeminiApi';

vi.mock('./ApiClient', async importOriginal => ({
  ...await importOriginal<typeof import('./ApiClient')>(),
  apiFetch: vi.fn(),
}));
const fetchMock = vi.mocked(apiFetch);
const rejectRequest = () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'offline request inspection', status: 'INVALID_ARGUMENT' } }), { status: 400 }));
const requestBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockImplementation(rejectRequest); });

describe('Gemini native sprite-scaffold aspect ratio', () => {
  it.each([
    [4, 2, '3:2'], // Idle and victory: four portrait cells across two rows.
    [4, 4, '3:4'], // Walk.
    [2, 2, '3:4'], // Four unique attack/movement poses.
    [3, 2, '5:4'], // Six Aura poses; closest supported shape to9:8.
    [2, 4, '9:16'], // KO; wider cells than the ordinary3:4 portrait cell.
  ])('chooses a supported ratio for a %ix%i grid', (columns, rows, ratio) => {
    expect(geminiSpriteScaffoldAspectRatio(columns, rows)).toBe(ratio);
  });

  it('rejects malformed grids before constructing a provider request', () => {
    for (const [columns, rows] of [[0, 2], [2, -1], [1.5, 2], [2, Number.NaN]]) {
      expect(() => geminiSpriteScaffoldAspectRatio(columns, rows)).toThrow('positive integer');
    }
  });

  it.each([
    ['idle', 8, '3:2'], ['walk', 16, '3:4'], ['high_punch', 7, '3:4'],
    ['aura_six_seven', 6, '5:4'], ['ko', 8, '9:16'],
  ])('sends native imageConfig for actual %s scaffolds without changing resolution or model', async (animation, frames, ratio) => {
    await expect(geminiSpriteSheet('reference-image', animation, 'test motion', frames)).rejects.toThrow('offline request inspection');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('/gemini-3.1-flash-image:generateContent');
    expect(requestBodies()[0].generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio } });
    expect(requestBodies()[0].contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/png', data: 'reference-image' });
  });

  it('keeps the native ratio on the existing safety retry as well as the initial scaffold', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })));
    await expect(geminiSpriteSheet('reference-image', 'idle', 'test motion', 8)).rejects.toThrow('offline request inspection');
    const bodies = requestBodies(); expect(bodies).toHaveLength(2);
    expect(bodies.map(body => body.generationConfig)).toEqual([
      { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:2' } },
      { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:2' } },
    ]);
    expect(bodies[1].contents[0].parts.at(-1).text).toContain('The character must be fully clothed');
  });

  it('leaves source-image generationConfig unchanged', async () => {
    await expect(geminiReposeDetailed('source-portrait')).rejects.toThrow('offline request inspection');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('/gemini-3-pro-image:generateContent');
    expect(requestBodies()[0].generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] });
  });
});
