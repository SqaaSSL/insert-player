export interface GeminiStageBackgroundPromptRequest {
  stageLabel: string;
  stageBlurb: string;
  fighterOneName?: string;
  fighterTwoName?: string;
  fighterOneStyle?: string;
  fighterTwoStyle?: string;
  sourceImage?: { data: string; mime: string };
  sourceMode?: 'inspire' | 'transform-scene';
  referenceImages?: { data: string; mime: string }[];
}

export function buildGeminiStageBackgroundPrompt(
  req: GeminiStageBackgroundPromptRequest,
): string {
  const prompt: string[] = [
    'Create a dramatic arcade fighting game stage background for a versus match.',
    `Theme: ${req.stageLabel}. ${req.stageBlurb}`,
  ];

  if (req.fighterOneName && req.fighterTwoName && req.fighterOneStyle && req.fighterTwoStyle) {
    prompt.push(
      `Fighter one: ${req.fighterOneName} (${req.fighterOneStyle}).`,
      `Fighter two: ${req.fighterTwoName} (${req.fighterTwoStyle}).`,
    );
  }

  prompt.push('');

  if (req.sourceImage && req.sourceMode === 'transform-scene') {
    prompt.push(
      'SOURCE IMAGE RULES:',
      '- The uploaded image is the actual place to transform into the arena.',
      "- Preserve the location's recognizable layout, architecture, major props, floor lines, horizon, and camera perspective.",
      '- Reinterpret the place into polished stylized 2D fighting-game background art, not a raw photo.',
      '- Do NOT ignore the supplied scene and replace it with a generic stage.',
      '- If the original photo does not show enough walkable foreground, extend the same location naturally toward the camera so the arena has a proper playable floor.',
      '- Remove or simplify any visible people so the final scene contains no foreground characters.',
      '',
    );
  }

  if (req.referenceImages?.length) {
    prompt.push(
      'REFERENCE USAGE RULES:',
      '- Use any extra reference photos only to borrow color palette, fashion cues, attitude, and world-building inspiration.',
      '- Do NOT place the referenced people or any fighters in the scene.',
      '',
    );
  }

  prompt.push(
    'COMPOSITION RULES:',
    '- Produce a single widescreen 16:9 arena background.',
    '- Side-on camera suitable for a 2D fighting game match.',
    '- Leave the center lane visually readable for two fighters standing and moving.',
    '- The lower 25-35% of the image must read as continuous playable floor, ground, dock, street, platform, or arena surface from left to right.',
    '- Include a clear floor or ground plane along the bottom of the image with enough visible depth below the fighters.',
    '- Keep the middle-lower lane free of blocking props so the fighters do not look cramped or cut off.',
    '- Rich layered background depth, strong atmosphere, and cinematic lighting.',
    '- No text, no logos, no UI, no watermarks, no speech bubbles.',
    '- No foreground characters, no crowd close-ups blocking the arena.',
    '',
    'STYLE RULES:',
    '- High-quality stylized game art with bold silhouettes and readable background shapes.',
    '- The stage should feel handcrafted, viral, and slightly exaggerated rather than generic concept art.',
  );

  return prompt.join('\n');
}
