ALTER TABLE arcade_fighters
ADD COLUMN generation_prompt TEXT
CHECK (
  generation_prompt IS NULL
  OR length(generation_prompt) BETWEEN 180 AND 3000
);
