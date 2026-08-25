export const ARCADE_PROMPT_PROFILES = Object.freeze({
  canonical: 'canonical-v1',
  xaiRealisticAdult: 'xai-realistic-adult-v1',
});

const FIGHTER_DETAILS_MARKER = 'Supplement the reference with these design details:';
const TERMINAL_STYLE_NEGATIVES = /\s+Not cartoon,[^.]*documentary photography\.\s*$/i;

function canonicalPrompt(fighter) {
  const prompt = fighter?.referencePrompt?.trim() ?? '';
  if (prompt.length < 180) {
    throw new Error(`Arcade provider prompt is incomplete for ${fighter?.slug ?? 'unknown fighter'}.`);
  }
  return prompt;
}

function fighterSpecificRequirements(fighter) {
  const prompt = canonicalPrompt(fighter);
  const markerIndex = prompt.indexOf(FIGHTER_DETAILS_MARKER);
  if (markerIndex < 0) {
    throw new Error(`Arcade prompt structure is unsupported for ${fighter.slug}.`);
  }
  return prompt.slice(markerIndex).replace(TERMINAL_STYLE_NEGATIVES, '').trim();
}

function buildXaiRealisticAdultPrompt(fighter) {
  const requirements = fighterSpecificRequirements(fighter);
  return [
    'INPUT REFERENCE ROLE:',
    'The supplied image is a close facial identity reference. Use it only to preserve the real person\'s facial geometry, hair, skin tone, apparent age, and distinguishing features. Do not copy the portrait crop, camera distance, head scale, shoulder crop, or composition from the input.',
    '',
    'TARGET RENDER:',
    'Create a head-to-toe studio character render of the same adult as premium semi-realistic 3D fighting-game roster art. The finish should feel like modern high-end game key art: recognizably the real person, cleanly art-directed, modeled and rendered rather than photographed. Limit stylization to controlled lighting, material polish, silhouette clarity, and game-ready contrast; never stylize anatomy, head size, apparent age, or identity. Use dimensional skin, individual hair strands, tailored fabric, leather, and restrained cinematic shading. Preserve the face faithfully and without exaggerating any signature feature.',
    '',
    'ANATOMY AND CAMERA:',
    'Use natural adult human anatomy with a standing height of approximately 7.5 heads; the head occupies about 13 percent of total body height. Use a normal adult neck, shoulder width, torso length, arm length, hand size, hip width, leg length, and shoe size. Keep both arms and both legs anatomically complete and clearly separated. Frame the full body vertically with comfortable margin above the hair and below the shoes. Use an eye-level 70-85 mm equivalent camera with minimal perspective distortion and no foreshortening.',
    '',
    'VISUAL FINISH:',
    'Use faithful facial planes, natural eye size, subtle skin texture and age detail, physically based material cues, a crisp silhouette, and a serious grounded presence. Maintain normal adult proportions. Avoid cartoon and caricature conventions: no oversized head, shortened limbs, mascot proportions, toy proportions, exaggerated facial features, comic outlines, flat-color regions, anime, cel shading, or chibi styling.',
    '',
    'CHARACTER, WARDROBE, POSE, AND BACKGROUND REQUIREMENTS:',
    requirements,
  ].join('\n');
}

export function buildArcadeProviderPrompt({ fighter, promptProfile = ARCADE_PROMPT_PROFILES.canonical }) {
  if (promptProfile === ARCADE_PROMPT_PROFILES.canonical) return canonicalPrompt(fighter);
  if (promptProfile === ARCADE_PROMPT_PROFILES.xaiRealisticAdult) {
    return buildXaiRealisticAdultPrompt(fighter);
  }
  throw new Error(`Unsupported Arcade prompt profile: ${String(promptProfile)}.`);
}
