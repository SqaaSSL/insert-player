# Official Arcade photo sources

The official Arcade roster uses real, reusable photographs as identity references. The photographs are private generation inputs and are not shipped to the browser. Their exact post-crop/post-conversion SHA-256 hashes and generation prompts live in [`roster-2026.json`](./roster-2026.json).

## Rules

- Keep approved inputs in `.arcade-sources/<slug>.png`.
- Do not replace a photograph without reviewing its source, license, attribution, and personality/publicity-right implications.
- Keep the longest image edge at or below 2048 px and the file below the Worker upload limit of 12 MiB.
- Run `npm run arcade:seed -- --all --dry-run` after every source change. The seeder verifies PNG format, upload size, and the manifest hash.
- A reusable photo license covers the photograph. It does not grant endorsement or eliminate rights associated with depicting the person. The resulting fighters remain clearly disclosed, unofficial AI-generated parody.

## Launch roster

| Fighter | Photograph | License | Attribution |
| --- | --- | --- | --- |
| Donald Trump | [Official portrait](https://commons.wikimedia.org/wiki/File:January_2025_Official_Presidential_Portrait_of_Donald_J._Trump.jpg) | Public domain, US federal government work | Daniel Torok / The White House, 2025 |
| Lamine Yamal | [France v Spain portrait](https://commons.wikimedia.org/wiki/File:Lamine_Yamal_France_v_Spain_7.24.26-142_(cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Bryan Berlin / WikiPortraits, 2026 |
| Ibai Llanos | [Ibai Llanos 2025](https://commons.wikimedia.org/wiki/File:Ibai_Llanos_2025_-_2.png) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | Movistar KOI VODS, 2025 |
| Aitana | [Aitana GHD](https://commons.wikimedia.org/wiki/File:Aitana_GHD.jpg) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | Juli Carné Martorell, 2018 |
| Rosalía | [Rosalía portrait](https://commons.wikimedia.org/wiki/File:Rosalia_2019-portrait.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Pedro J Pacheco, 2019 |
| Bad Bunny | [Bad Bunny portrait](https://commons.wikimedia.org/wiki/File:Bad_Bunny_2019_by_Glenn_Francis_(cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Glenn Francis / PacificProDigital.com, 2019 |
| MrBeast | [MrBeast 2025](https://commons.wikimedia.org/wiki/File:Mrbeast_in_2025_4.jpg) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | 小Lin说, 2025 |
| IShowSpeed | [Chinatown portrait](https://commons.wikimedia.org/wiki/File:IShowSpeed_at_Chinatown_(Portrait)_02.jpg) | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0) | Chin Yu Chu, 2024 |
| Elon Musk | [Elon Musk portrait](https://commons.wikimedia.org/wiki/File:Elon_Musk_(3x4_close_cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Gage Skidmore, 2025 |
| Cristiano Ronaldo | [Croatia v Portugal portrait](https://commons.wikimedia.org/wiki/File:Cristiano_Ronaldo_Croatia_v_Portugal_2_July_2026-154(cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Bryan Berlin / WikiPortraits, 2026 |
| Javier Milei | [Official portrait](https://commons.wikimedia.org/wiki/File:Retrato_oficial_del_Presidente_Javier_(cropped).jpeg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) | Gobierno Argentino / Argentina.gob.ar, 2024 |
| Lionel Messi | [New England v Miami portrait](https://commons.wikimedia.org/wiki/File:Lionel_Messi_NE_Revolution_Inter_Miami_7.9.25-043_(cropped).jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0) | Bryan Berlin / WikiPortraits, 2025 |
| Perro Sanxe / Pedro Sánchez | [Pedro Sánchez with Ursula von der Leyen](https://commons.wikimedia.org/wiki/File:Pedro_S%C3%A1nchez_with_Ursula_von_der_Leyen_-_2025_(P-067042).jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0) | European Union, 2026; source image dated 2025 |

## Publication

The legal page exposes the corresponding source and license links. Never publish the original source bundle as a public static asset; the app publishes only the transformed fighter assets and the required attribution.
