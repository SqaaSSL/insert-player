import { describe, expect, it } from 'vitest';
import { selectiveCompositionOptions } from './compose-casual-selective-repair.mjs';
const hash = 'a'.repeat(64);
describe('Casual selective composition boundary', () => {
  it('requires exact native review input and defaults to offline candidate output only', () => {
    expect(() => selectiveCompositionOptions([])).toThrow();
    expect(() => selectiveCompositionOptions(['--review=/tmp/review.json'])).toThrow(/native review SHA/);
    expect(selectiveCompositionOptions(['--review=/tmp/review.json', `--review-sha256=${hash}`])).toMatchObject({ apply: false });
    expect(() => selectiveCompositionOptions(['--review=/tmp/review.json', `--review-sha256=${hash}`, '--force'])).toThrow();
  });
  it('requires separate review of the whole composed sheet set before applying', () => {
    const args = ['--review=/tmp/review.json', `--review-sha256=${hash}`, '--apply', '--confirm=casual-selective-frame-repair-v1'];
    expect(() => selectiveCompositionOptions(args)).toThrow(/sheet-set hash/);
    expect(selectiveCompositionOptions([...args, `--sheets-reviewed=${hash}`])).toMatchObject({ apply: true, sheetsReviewed: hash });
  });
});
