export const ARCADE_PROMPT_PROFILES = Object.freeze({
  canonical: 'canonical-v1',
  xaiRealisticAdult: 'xai-realistic-adult-v1',
  xaiIdentityPoseTransfer: 'xai-identity-pose-transfer-v1',
  xaiCanonicalMotionTransfer: 'xai-canonical-motion-transfer-v1',
});

export const ARCADE_MOTION_TRANSFER_SPECS = Object.freeze({
  high_punch: Object.freeze({
    animation: 'high_punch',
    promptLabel: 'standing high-punch impact',
    anatomyContract: 'Keep both feet visible and planted, the rear guarding hand near the face, the punching arm extended without shoulder dislocation, and the torso balanced behind the strike.',
  }),
  high_kick: Object.freeze({
    animation: 'high_kick',
    promptLabel: 'high-kick impact',
    anatomyContract: 'The support foot must remain planted and the kicking leg must be fully visible.',
  }),
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

function buildXaiIdentityPoseTransferPrompt(fighter) {
  const requirements = fighterSpecificRequirements(fighter);
  return [
    'REFERENCE ROLES — KEEP THEM STRICTLY SEPARATE:',
    'IMAGE 1 is the POSE, COMPOSITION, AND RENDERING MASTER only. Match its canvas framing, camera distance, perspective, full-body placement, facing direction, joint positions, stance, hand placement, foot placement, silhouette scale, lighting language, material finish, edge treatment, and plain background as closely as possible. Do not copy this person\'s identity.',
    'IMAGE 2 is the IDENTITY AND PHYSIQUE ANCHOR only. Preserve this person\'s facial geometry, hair, skin tone, apparent age, distinguishing features, and natural body build. Do not copy the portrait crop, camera distance, head scale, or shoulder crop from IMAGE 2.',
    '',
    'IDENTITY TRANSFER:',
    'Replace the person in IMAGE 1 with the person from IMAGE 2 while retaining the pose and shot geometry of IMAGE 1. Never blend the two faces. Remove every identity trait from IMAGE 1, including its face, hair, apparent age, skin tone, body build, and distinctive features. The output must be immediately recognizable as IMAGE 2 and must not resemble IMAGE 1.',
    '',
    'ANATOMY AND STYLE:',
    'Keep the natural adult proportions and grounded semi-realistic 3D fighting-game roster finish demonstrated by IMAGE 1. Keep stylization in lighting, materials, silhouette clarity, and game-ready contrast only; never stylize anatomy, head size, apparent age, or identity. No oversized head, shortened limbs, mascot proportions, toy proportions, caricature, anime, cel shading, or chibi styling. Keep both arms, both hands, both legs, and both feet complete and anatomically coherent.',
    '',
    'TARGET CHARACTER, WARDROBE, AND BACKGROUND:',
    requirements,
    '',
    'FINAL PRIORITY ORDER:',
    '1) Identity and physique from IMAGE 2. 2) Pose, camera, framing, proportions, and rendering finish from IMAGE 1. 3) Wardrobe and target-specific details from the written requirements. Do not retain logos, clothing details, jewelry, or accessories from either reference unless the written requirements explicitly request them.',
  ].join('\n');
}

function xaiMotionTransferSpec(animation = 'high_kick') {
  const spec = ARCADE_MOTION_TRANSFER_SPECS[animation];
  if (!spec) throw new Error(`Unsupported Arcade motion transfer: ${String(animation)}.`);
  return spec;
}

function buildXaiCanonicalMotionTransferPrompt(fighter, animation) {
  const motion = xaiMotionTransferSpec(animation);
  const staticRequirements = fighterSpecificRequirements(fighter);
  const requirements = staticRequirements.replace(
    /Show the complete figure head-to-toe in [^,]+,\s*3\/4 view facing right,/i,
    `Show the complete figure head-to-toe in the exact ${motion.promptLabel} pose from IMAGE 1, 3/4 view facing right,`,
  );
  if (requirements === staticRequirements) {
    throw new Error(`Arcade motion prompt could not replace the static pose for ${fighter?.slug ?? 'unknown fighter'}.`);
  }
  return [
    'REFERENCE ROLES — KEEP ALL THREE STRICTLY SEPARATE:',
    'IMAGE 1 is the MOTION POSE AND COMPOSITION MASTER only. Match its canvas framing, camera, facing direction, full-body placement, silhouette scale, torso angle, joint positions, balance, hand placement, and foot placement as closely as possible. Do not copy this person\'s identity, hair, physique, clothes, colors, materials, or rendering style.',
    'IMAGE 2 is the APPROVED CANONICAL CHARACTER AND RENDERING MASTER. Preserve this exact character\'s face, hair, apparent age, body build, outfit design, palette, materials, proportions, lighting language, game-art finish, and edge treatment. Repose this character; do not redesign it.',
    'IMAGE 3 is the REAL IDENTITY SAFEGUARD only. Use it to keep the face and distinguishing features recognizable as the real person. Do not copy its portrait crop, camera, pose, clothes, background, or photographic rendering.',
    '',
    'MOTION TRANSFER:',
    `Place the exact character from IMAGE 2 into the exact ${motion.promptLabel} pose from IMAGE 1. Never blend the people or faces. Remove every identity, wardrobe, and rendering trait from IMAGE 1. Use IMAGE 3 only to correct identity drift in IMAGE 2. The result must look like the same canonical character from IMAGE 2 captured at a different animation frame.`,
    '',
    'CONSISTENCY AND ANATOMY:',
    `Preserve canonical head scale, limb lengths, body volume, clothing construction, colors, materials, and facial geometry from IMAGE 2. Keep both arms, both hands, both legs, and both feet complete and anatomically coherent. ${motion.anatomyContract} No oversized head, shortened limbs, caricature, mascot proportions, anime, chibi, cel shading, motion blur, duplicated limbs, extra fingers, or fused joints.`,
    '',
    'TARGET CHARACTER, WARDROBE, AND BACKGROUND:',
    requirements,
    '',
    'OUTPUT CONTRACT:',
    'Return exactly one full-body animation frame, not a sprite sheet, contact sheet, sequence, or collage. Preserve the IMAGE 1 composition and the IMAGE 2 character. Keep the background pure bright green (#00FF00), flat and uniform, with no shadows, floor, gradients, text, logos, badges, emblems, or brand-like symbols.',
    '',
    'FINAL PRIORITY ORDER:',
    '1) Exact pose and composition from IMAGE 1. 2) Exact canonical character, outfit, proportions, and rendering from IMAGE 2. 3) Real facial identity from IMAGE 3. Never allow one reference to overwrite another reference\'s assigned role.',
  ].join('\n');
}

export function buildArcadeProviderPrompt({
  fighter,
  promptProfile = ARCADE_PROMPT_PROFILES.canonical,
  motionAnimation,
}) {
  if (promptProfile === ARCADE_PROMPT_PROFILES.canonical) return canonicalPrompt(fighter);
  if (promptProfile === ARCADE_PROMPT_PROFILES.xaiRealisticAdult) {
    return buildXaiRealisticAdultPrompt(fighter);
  }
  if (promptProfile === ARCADE_PROMPT_PROFILES.xaiIdentityPoseTransfer) {
    return buildXaiIdentityPoseTransferPrompt(fighter);
  }
  if (promptProfile === ARCADE_PROMPT_PROFILES.xaiCanonicalMotionTransfer) {
    return buildXaiCanonicalMotionTransferPrompt(fighter, motionAnimation);
  }
  throw new Error(`Unsupported Arcade prompt profile: ${String(promptProfile)}.`);
}
