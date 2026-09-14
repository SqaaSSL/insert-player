import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasRuntime } from '../../processor/src/canvasRuntime';
import { apiFetch } from './ApiClient';
import { geminiRefineSpriteFrame } from './GeminiApi';

vi.mock('./ApiClient', async importOriginal => ({
  ...await importOriginal<typeof import('./ApiClient')>(), apiFetch: vi.fn(),
}));
installCanvasRuntime();
function fixture(color: string, height = 70): string {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 96;
  const context = canvas.getContext('2d')!; context.fillStyle = '#00ff00'; context.fillRect(0, 0, 64, 96);
  context.fillStyle = color; context.fillRect(20, 90 - height, 24, height);
  return canvas.toDataURL('image/png').split(',')[1];
}
const identity = fixture('#4444bb'); const pose = fixture('#bb4444'); const refined = fixture('#777777');
const response = (data: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }] }));
const fetchMock = vi.mocked(apiFetch);
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockImplementation(async () => response(refined)); });

describe('normal product sprite refinement', () => {
  it('restores the exact pose without sending a competing canonical stance, with the same Flash model', async () => {
    await expect(geminiRefineSpriteFrame(identity, pose, 'low_kick', 'extend a low kick', 3, 4,
      undefined, 'gemini-3.1-flash-image')).resolves.toBe(refined);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('/gemini-3.1-flash-image:generateContent');
    const body = bodies()[0];
    expect(body.contents[0].parts.filter((part: { inlineData?: unknown }) => part.inlineData)).toEqual([
      { inlineData: { mimeType: 'image/png', data: pose } },
    ]);
    expect(body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '2:3' } });
    const prompt = body.contents[0].parts.at(-1).text;
    expect(prompt).toContain('IMAGE 1 is the image to edit');
    expect(prompt).not.toContain('IMAGE 2');
    expect(prompt).toContain('exactly ONE person');
    expect(prompt).toContain('Preserve the existing gesture');
    expect(prompt).toContain('Do not recolor clothing');
    expect(prompt).not.toContain('low_kick');
    expect(prompt).not.toContain('extend a low kick');
  });

  it('keeps the reference roles on the existing safety retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })));
    await geminiRefineSpriteFrame(identity, pose, 'low_kick', 'extend a low kick', 3, 4);
    expect(bodies()).toHaveLength(2);
    for (const body of bodies()) {
      expect(body.contents[0].parts[0].inlineData.data).toBe(pose);
      expect(body.contents[0].parts.filter((part: { inlineData?: unknown }) => part.inlineData)).toHaveLength(1);
      expect(body.generationConfig.imageConfig.aspectRatio).toBe('2:3');
    }
    expect(bodies()[1].contents[0].parts.at(-1).text).toContain('The character MUST be wearing');
  });

  it('retains the actual portrait pose canvas for a horizontal KO body and ignores the action description', async () => {
    const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 1024;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 768, 1024);
    ctx.fillStyle = '#777777'; ctx.fillRect(80, 770, 580, 180);
    const lyingPose = canvas.toDataURL('image/png').split(',')[1];
    fetchMock.mockImplementation(async () => response(lyingPose));
    await geminiRefineSpriteFrame(identity, lyingPose, 'ko', 'fall from standing and finish lying down', 5, 8);
    const body = bodies()[0];
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('3:4');
    expect(body.contents[0].parts[0].inlineData.data).toBe(lyingPose);
    expect(body.contents[0].parts.at(-1).text).not.toContain('fall from standing');
  });

  it('rejects two invalid refinements instead of returning the lower-resolution pose as Champion', async () => {
    fetchMock.mockImplementation(async () => response(fixture('#777777', 12)));
    await expect(geminiRefineSpriteFrame(identity, pose, 'low_kick', 'extend a low kick', 3, 4))
      .rejects.toThrow('refusing a base-cell fallback');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1].contents[0].parts.at(-1).text).toContain('SIZE LOCK');
  });

  it('rejects an invalid frame before any provider call', async () => {
    await expect(geminiRefineSpriteFrame(identity, pose, 'walk', 'walk', 16, 16)).rejects.toThrow('frame index');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
