-- Promote the reviewed replacement without deleting the legacy fighter or its history.
-- The replacement keeps its technical slug so existing asset and provenance pointers remain stable.
UPDATE arcade_fighters
SET status = 'retired', sort_order = 14, updated_at = datetime('now')
WHERE slug = 'rosalia'
  AND status = 'active'
  AND EXISTS (
    SELECT 1
    FROM arcade_fighters replacement
    WHERE replacement.slug = 'rosalia-v2'
      AND replacement.status = 'active'
  );

UPDATE fighters
SET public_flag = 0, updated_at = datetime('now')
WHERE public_flag <> 0
  AND id IN (
    SELECT legacy.fighter_id
    FROM arcade_fighters legacy
    WHERE legacy.slug = 'rosalia'
      AND legacy.status = 'retired'
  )
  AND EXISTS (
    SELECT 1
    FROM arcade_fighters replacement
    WHERE replacement.slug = 'rosalia-v2'
      AND replacement.status = 'active'
  );

UPDATE arcade_fighters
SET sort_order = 5, updated_at = datetime('now')
WHERE slug = 'rosalia-v2'
  AND status = 'active'
  AND sort_order <> 5;

UPDATE fighters
SET name = 'Rosalía', public_flag = 1, updated_at = datetime('now')
WHERE id IN (
    SELECT replacement.fighter_id
    FROM arcade_fighters replacement
    WHERE replacement.slug = 'rosalia-v2'
      AND replacement.status = 'active'
  )
  AND (name <> 'Rosalía' OR public_flag <> 1);
