function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertOfficialArcadeContract(fighter) {
  // New Champion packs retain the canonical contender id. Legacy champion
  // assets keep their original provenance; a public pack cannot mix tiers.
  assert(
    fighter?.qualityTier === 'contender' || fighter?.qualityTier === 'champion',
    'Official Arcade exposed a non-Champion fighter',
  );
  assert(
    Array.isArray(fighter.sprites)
      && fighter.sprites.every((sprite) => sprite?.qualityTier === fighter.qualityTier),
    'Official Arcade exposed a mixed or invalid quality pack',
  );
  const reference = fighter.arcade?.reference;
  assert(
    reference && typeof reference.license === 'string' && reference.license.trim()
      && typeof reference.credit === 'string' && reference.credit.trim(),
    'Official Arcade fighter is missing public reference attribution',
  );
  // Matches the publication contract: generated artwork has no licensed-photo
  // URL. Its generation prompt remains private, while licence/credit are public.
  assert(
    (reference.kind === 'licensed' && /^https:\/\//.test(reference.sourceUrl ?? ''))
      || (reference.kind === 'generated' && reference.sourceUrl === null),
    'Official Arcade fighter has invalid public reference provenance',
  );
}
