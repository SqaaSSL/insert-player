import { describe, expect, it } from 'vitest';
import { koCompositionOptions } from './compose-casual-ko.mjs';
const hash = 'a'.repeat(64);
describe('offline KO composition boundary', () => {
  it('requires the exact reviewed eight-frame selection before reading source media', () => {
    expect(() => koCompositionOptions([])).toThrow();
    expect(() => koCompositionOptions(['--review=/tmp/review.json'])).toThrow(/selection SHA/);
    expect(koCompositionOptions(['--review=/tmp/review.json', `--review-sha256=${hash}`])).toMatchObject({ apply: false, reviewSha256: hash });
    expect(() => koCompositionOptions(['--review=/tmp/review.json', `--review-sha256=${hash}`, '--force'])).toThrow();
  });
  it('requires a second review of the exact composed raw and processed sheets before a manifest write', () => {
    const args = ['--review=/tmp/review.json', `--review-sha256=${hash}`, '--apply', '--confirm=casual-ko-completion-v1'];
    expect(() => koCompositionOptions(args)).toThrow(/assembled/);
    expect(() => koCompositionOptions([...args, `--processed-reviewed=${hash}`])).toThrow(/assembled/);
    expect(koCompositionOptions([...args, `--processed-reviewed=${hash}`, `--raw-reviewed=${hash}`])).toMatchObject({ apply: true });
  });
});
