# Official Arcade photo sources

The official Arcade roster uses real, reusable photographs as identity references. The photographs are private generation inputs and are not shipped to the browser. Their exact post-crop/post-conversion SHA-256 hashes and generation prompts live in [`roster-2026.json`](./roster-2026.json).

## Rules

- Keep approved inputs in `.arcade-sources/<slug>.png`.
- Keep the operational copy private and content-addressed at `official-roster-inputs/<slug>/<sha256>.png` in the target environment's R2 bucket. The browser and public asset routes must never expose this prefix.
- Do not replace a photograph without reviewing its source, license, attribution, and personality/publicity-right implications.
- Keep the approved photograph attached to Gemini when generating the canonical side view. Upright, crouch, and Champion frames must remain reference-guided from that identity chain; a blocked reference fails closed and never falls back to a text-only face.
- Keep the longest image edge at or below 2048 px and the file below the Worker upload limit of 12 MiB.
- Run `npm run arcade:seed -- --all --dry-run` after every source change. The seeder verifies PNG format, upload size, and the manifest hash.
- CI operators can restore an approved input without moving it through chat or repository history with `npm run arcade:sources -- --target=production --slug=<fighter>`; the command refuses any R2 object whose bytes do not match the manifest hash.
- A reusable photo license covers the photograph. It does not grant endorsement or eliminate rights associated with depicting the person. The resulting fighters remain clearly disclosed, unofficial AI-generated parody.

## Launch roster

| Fighter | Photograph | License | Attribution |
| --- | --- | --- | --- |
| Donald Trump | [Official portrait](https://commons.wikimedia.org/wiki/File:January_2025_Official_Presidential_Portrait_of_Donald_J._Trump.jpg) | Public domain, dedicated by the author | Daniel Torok, 2025 |
| Lamine Yamal | [France v Spain portrait](https://commons.wikimedia.org/wiki/File:Lamine_Yamal_France_v_Spain_7.24.26-142_(cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Bryan Berlin / WikiPortraits, 2026 |
| Ibai Llanos | [Ibai Llanos 2025](https://commons.wikimedia.org/wiki/File:Ibai_Llanos_2025_-_2.png) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | Movistar KOI VODS, 2025 |
| Aitana | [Aitana GHD](https://commons.wikimedia.org/wiki/File:Aitana_GHD.jpg) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | Juli Carné Martorell, 2018 |
| Rosalía | [Rosalía portrait](https://commons.wikimedia.org/wiki/File:Rosalia_2019-portrait.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Pedro J Pacheco, 2019 |
| Bad Bunny | [Bad Bunny portrait](https://commons.wikimedia.org/wiki/File:Bad_Bunny_2019_by_Glenn_Francis_(cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Glenn Francis / PacificProDigital.com, 2019 |
| MrBeast | [MrBeast 2025](https://commons.wikimedia.org/wiki/File:Mrbeast_in_2025_4.jpg) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | 小Lin说, 2025 |
| IShowSpeed | [Chinatown portrait](https://commons.wikimedia.org/wiki/File:IShowSpeed_at_Chinatown_(Portrait)_02.jpg) | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0) | Chin Yu Chu, 2024 |
| Elon Musk | [Elon Musk portrait](https://commons.wikimedia.org/wiki/File:Elon_Musk_(3x4_close_cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Gage Skidmore, 2025 |
| Cristiano Ronaldo | [Croatia v Portugal portrait](https://commons.wikimedia.org/wiki/File:Cristiano_Ronaldo_Croatia_v_Portugal_2_July_2026-154(cropped).jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) | Bryan Berlin / WikiPortraits, 2026 |
| Javier Milei | [Official portrait](https://commons.wikimedia.org/wiki/File:Retrato_oficial_del_Presidente_Javier_(cropped).jpeg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) | Gobierno Argentino / Argentina.gob.ar, 2024 |
| Lionel Messi | [New England v Miami portrait](https://commons.wikimedia.org/wiki/File:Lionel_Messi_NE_Revolution_Inter_Miami_7.9.25-043_(cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Bryan Berlin / WikiPortraits, 2025 |
| Perro Sanxe / Pedro Sánchez | [Pedro Sánchez with Ursula von der Leyen](https://commons.wikimedia.org/wiki/File:Pedro_S%C3%A1nchez_with_Ursula_von_der_Leyen_-_2025_(P-067042).jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) | European Union, 2026; source image dated 2025 |

## Publication

The legal page exposes the corresponding source and license links. Never publish the original source bundle as a public static asset; the app publishes only the transformed fighter assets and the required attribution.

## Seeding

Use an active Clerk admin session for long Champion jobs. Keep the production Clerk secret and admin user ID only in the local process environment:

```bash
ASF_ARCADE_CLERK_SECRET_KEY=... \
ASF_ARCADE_ADMIN_CLERK_USER_ID=... \
npm run arcade:seed -- --slug=donald-trump --confirm-production
```

The seeder asks Clerk for short-lived session tokens and refreshes them during polling. It never writes or prints those credentials. A pre-minted `ASF_ARCADE_ADMIN_JWT` remains available for short runs, but it must have at least five minutes left. Generate one fighter as a draft, inspect all canonical views and animations, and only then rerun with `--activate` or continue to the next fighter.

When an incomplete draft must be regenerated after a rejected pipeline, use `--restart-draft` with exactly one slug. Fighter identity is content-addressed by the approved photo hash, so this deliberately restarts the full three-source and eleven-animation Workflow on the same private draft. Existing source and sprite artifacts remain immutable in `source_versions` and `sprite_versions`; the command never activates the result, so visual QA is still mandatory.
