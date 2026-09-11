import { describe, expect, it } from 'vitest';
import { buildBattleFinisherPrompt, validFalQueueUrl, validFalVideoUrl } from './battleFinisherProvider';
const summary = { game: 'aura' as const, winner: 'p2' as const, winnerSide: 'right' as const, p1Name: 'Name with instructions', p2Name: 'Rival', stageLabel: 'Stage', durationSeconds: 45 };
describe('pinned finisher provider boundary', () => {
  it('pins queue origin, app, exact request ID, and disallows credentials and URL queries', () => {
    const url = 'https://queue.fal.run/minimax/h3-max-turbo/requests/req_1/status';
    expect(validFalQueueUrl(url, 'req_1')).toBe(url);
    for (const invalid of [url.replace('req_1', 'req_1_suffix'), url + '?redirect=1', url.replace('https:', 'http:'), url.replace('queue.fal.run', 'queue.fal.run.evil.com'), url.replace('/minimax/h3-max-turbo/', '/other/app/'), url.replace('https://', 'https://user:pass@')]) expect(validFalQueueUrl(invalid, 'req_1')).toBeNull();
  });
  it('permits only HTTPS provider media URLs and never reflects public names into prompts', () => {
    expect(validFalVideoUrl('https://v3.fal.media/files/video.mp4')).toBe('https://v3.fal.media/files/video.mp4');
    for (const url of ['https://localhost/video', 'http://fal.media/video', 'https://fal.media.evil.com/video', 'https://user:pass@fal.media/video']) expect(validFalVideoUrl(url)).toBeNull();
    const prompt = buildBattleFinisherPrompt(summary);
    expect(prompt).toContain('the right-side player'); expect(prompt).toContain('aura-farming'); expect(prompt).toContain('No photorealism, gore'); expect(prompt).not.toContain(summary.p1Name);
    expect(buildBattleFinisherPrompt({ ...summary, winnerSide: 'left' })).toContain('the left-side player');
    expect(buildBattleFinisherPrompt({ ...summary, game: 'rush', winner: 'team' })).toContain('the player team');
    expect(buildBattleFinisherPrompt({ ...summary, winner: 'draw' })).toContain('friendly salute');
  });
});
