export type SourceGenerationOperation = 'repose' | 'upright' | 'crouch';

export type SourceGenerationStrategy =
  | 'reference-photo'
  | 'official-text-side'
  | 'official-reference-upright'
  | 'official-reference-crouch';

export function sourceGenerationStrategy(
  operation: SourceGenerationOperation,
  generationPrompt: string | undefined,
): SourceGenerationStrategy {
  if (!generationPrompt?.trim()) return 'reference-photo';
  if (operation === 'repose') return 'official-text-side';
  if (operation === 'upright') return 'official-reference-upright';
  return 'official-reference-crouch';
}
