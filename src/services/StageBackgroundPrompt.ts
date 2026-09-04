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

export const STAGE_GAMEPLAY_CLEARANCE_PROMPT_MARKER = 'GAMEPLAY CLEARANCE V2: HARD REQUIREMENT:';

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
      "- Preserve the location's recognizable layout, architecture, floor lines, horizon, camera perspective, and major props only when they do not obstruct the fight plane.",
      '- Reinterpret the place into polished stylized 2D fighting-game background art, not a raw photo.',
      '- Do NOT ignore the supplied scene and replace it with a generic stage.',
      '- If the original photo does not show enough walkable foreground, extend the same location naturally toward the camera so the arena has a proper playable floor.',
      '- Before changing any object, inspect whether it actually intrudes into the reserved fight plane or fighter silhouettes. If the gameplay space is already clear, preserve the original geometry and prop placement.',
      '- Edit only the minimum set of objects that genuinely obstruct gameplay. Do not move, remove, or simplify objects that are already outside or behind the collision-free fight space.',
      '- Relocate, push into the distance, flatten, or remove only a source prop that intrudes into the playable foreground. Gameplay clearance is more important than literal placement for that obstructing prop.',
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
    STAGE_GAMEPLAY_CLEARANCE_PROMPT_MARKER,
    '- Reserve the entire lower 38% of the image, from the left edge to the right edge, as one continuous unobstructed fight plane.',
    '- This reserved fight plane may contain only flat ground texture, painted floor markings, and shadows. Nothing may rise vertically from it.',
    '- No signs, signposts, poles, bins, bollards, railings, barriers, furniture, vehicles, plants, canopies, people, or other props may occupy or overlap this lower fight plane.',
    '- Imagine two full-height fighters centered at 30% and 70% of the image width, with feet at 88% of the image height and bodies extending upward to 30%. Their silhouettes and the movement space between them must overlap only open floor and distant background.',
    '- Put all decorative objects, landmarks, and signage behind the fighters, above the reserved fight plane, or near the far edges where they cannot intersect either fighter.',
    '- Do not empty, redesign, or rearrange a scene that already satisfies these clearance rules. Apart from the requested art-style transformation, preserve it as closely as possible.',
    '- When source accuracy conflicts with fighter clearance, make the smallest possible change to the obstructing object while keeping the location recognizable.',
    '',
    'COMPOSITION RULES:',
    '- Produce a single widescreen 16:9 arena background.',
    '- Side-on camera suitable for a 2D fighting game match.',
    '- Leave the center lane visually readable for two fighters standing, jumping, and moving toward either edge.',
    '- The reserved lower area must read as continuous playable floor, ground, dock, street, platform, or arena surface from left to right.',
    '- Include a clear floor or ground plane along the bottom of the image with enough visible depth below the fighters.',
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
