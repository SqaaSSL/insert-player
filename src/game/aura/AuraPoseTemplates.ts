/** Reviewed, hash-bound pose references. Pixels are measured at alpha >= 32.
 * Coordinates are native runtime-cell pixels; roots use exclusive bottom Y.
 * Never apply these pose curves to an unknown or regenerated atlas.
 */
export interface AuraPoseTemplate {
  frameWidth: number;
  frameHeight: number;
  /** Median standing/neutral reference height, never max(all poses). */
  referenceBodyHeight: number;
  /** Zero-based indices used to measure referenceBodyHeight. */
  referenceFrameIndices: readonly number[];
  referenceRoot: Readonly<{ x: number; y: number }>;
  templateSha256: string;
  trumpSha256: string;
  frames: readonly Readonly<{ x: number; y: number; w: number; h: number }>[];
  /** Reviewed source/target remaps apply ONLY to trumpSha256, not the template. */
  trumpSourceFrameIndices?: readonly number[];
  trumpTargetFrameIndices?: readonly number[];
  referenceNotes: string;
}

/** Source: artifacts/aura-animation-canary/template-zero/<animation>/{manifest,qa}.json
 * and public/assets/aura/template-zero/<animation>.png. The PNG measurements
 * below intentionally use alpha 32, not the Trump processor report's alpha 16.
 * Trump provenance: artifacts/aura-animation-canary/donald-trump/<animation>/
 * champion/processed/report.json, runtimeAtlas.sha256.
 *
 * Desired visible pose height = shared standing body height * frame.h /
 * referenceBodyHeight. A crouch/worm is therefore short, not stretched upright.
 * Width must follow the SAME scale as height; do not match template width.
 * The reference root comes from qa.registrationTarget (baselineY + 1).
 * These are support roots: one_leg's airborne pose was already registered to
 * that baseline in the source atlas; no unrecorded airborne lift is invented.
 */
export const AURA_POSE_TEMPLATES = {
  aura_unbothered: {
    frameWidth: 192, frameHeight: 256,
    referenceBodyHeight: 219,
    referenceFrameIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    referenceRoot: { x: 96, y: 239 },
    templateSha256: 'f84fec2f440ef7ab0a9fbe9c1cc6795be4ce35d8473bb2a3d95f459634630b63',
    trumpSha256: '3e664f45b05771f2910fe19f70fb66dee3bb5098f76a4084d49afc916e38c5fd',
    frames: [
      { x: 70, y: 20, w: 70, h: 219 }, { x: 70, y: 20, w: 69, h: 219 },
      { x: 71, y: 20, w: 68, h: 219 }, { x: 71, y: 21, w: 68, h: 218 },
      { x: 62, y: 21, w: 77, h: 218 }, { x: 61, y: 22, w: 77, h: 217 },
      { x: 70, y: 20, w: 68, h: 219 }, { x: 68, y: 19, w: 72, h: 220 },
    ],
    referenceNotes: 'Median of all eight low-amplitude upright resting frames; preserves breathing and head turns.',
  },
  aura_six_seven: {
    frameWidth: 192, frameHeight: 256,
    referenceBodyHeight: 230.5,
    referenceFrameIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    referenceRoot: { x: 96, y: 239 },
    templateSha256: '75560fd3c3a404b73fc3949693f022a68c58665ac34ac10f36487289924ab8c0',
    trumpSha256: '8ad7ea66ece2ff19cea54d764aaa8e5855e7e8b302158a1e70fd1c8b2406263c',
    frames: [
      { x: 74, y: 12, w: 101, h: 227 }, { x: 75, y: 7, w: 93, h: 232 },
      { x: 73, y: 12, w: 110, h: 227 }, { x: 73, y: 7, w: 82, h: 232 },
      { x: 76, y: 10, w: 110, h: 229 }, { x: 75, y: 7, w: 93, h: 232 },
      { x: 77, y: 10, w: 110, h: 229 }, { x: 73, y: 7, w: 82, h: 232 },
    ],
    referenceNotes: 'No dedicated arms-down neutral. Median of all eight upright poses; hands remain below the head, so height is not arm reach. Preserves the reviewed alternating hand extremes and small knee/posture variation.',
  },
  aura_mog_check: {
    frameWidth: 192, frameHeight: 256,
    referenceBodyHeight: 233,
    referenceFrameIndices: [0, 1, 2, 3, 7],
    referenceRoot: { x: 96, y: 239 },
    templateSha256: '6b768923b7f64e7e60be4dc7c43bf2bc7c6d5cf7c9bfce4b6d583fbeef933774',
    trumpSha256: '696641aa3f6b83420417cc488cd0561148aa3c71487eea136cc205b98d4b6577',
    frames: [
      { x: 76, y: 6, w: 76, h: 233 }, { x: 75, y: 6, w: 77, h: 233 },
      { x: 75, y: 6, w: 76, h: 233 }, { x: 75, y: 6, w: 77, h: 233 },
      { x: 74, y: 17, w: 83, h: 222 }, { x: 70, y: 6, w: 100, h: 233 },
      { x: 63, y: 4, w: 97, h: 235 }, { x: 76, y: 7, w: 76, h: 232 },
    ],
    referenceNotes: 'Median of upright setup/recovery frames 1–4 and 8. Excludes forward-lean/large-face peaks 5–7 from the body baseline but preserves them in the pose curve; the manifest explicitly describes that exaggeration.',
  },
  aura_glide: {
    frameWidth: 192, frameHeight: 256,
    referenceBodyHeight: 223.5,
    referenceFrameIndices: [0, 7],
    referenceRoot: { x: 96, y: 239 },
    templateSha256: '6c1d1cd0de72c1e439487e3f9110011c2609cf453a27ea1fcf2a0748a9c9ca5f',
    trumpSha256: '5f8a7f8261aa0df2d951f2998797d4cea67845985abaef0ca8510ad7c8ecb716',
    frames: [
      { x: 58, y: 14, w: 81, h: 225 }, { x: 51, y: 15, w: 81, h: 224 },
      { x: 47, y: 13, w: 71, h: 226 }, { x: 56, y: 20, w: 95, h: 219 },
      { x: 49, y: 14, w: 95, h: 225 }, { x: 40, y: 18, w: 92, h: 221 },
      { x: 60, y: 16, w: 65, h: 223 }, { x: 60, y: 17, w: 70, h: 222 },
    ],
    referenceNotes: 'Median of upright entry/recovery frames 1 and 8; heel-to-toe/crossing compression in intermediate poses remains visible.',
  },
  aura_floor_worm: {
    frameWidth: 384, frameHeight: 256,
    referenceBodyHeight: 216,
    referenceFrameIndices: [0, 7],
    referenceRoot: { x: 192, y: 239 },
    templateSha256: 'aef53860a2e54aececcb5a36facc1e8daeab970a6331c2cfd8e01727afe48853',
    trumpSha256: 'eaffe8c9e19e40d0b780ccabbdce816a434c6643dd6f9e4daed10b17bce1a3d5',
    frames: [
      { x: 169, y: 24, w: 81, h: 215 }, { x: 146, y: 110, w: 155, h: 129 },
      { x: 88, y: 126, w: 192, h: 113 }, { x: 91, y: 185, w: 171, h: 54 },
      { x: 63, y: 107, w: 173, h: 132 }, { x: 89, y: 164, w: 171, h: 75 },
      { x: 99, y: 123, w: 160, h: 116 }, { x: 169, y: 22, w: 82, h: 217 },
    ],
    referenceNotes: 'Median of upright guard entry/recovery frames 1 and 8 only. Frames 2–7 are crouch/prone/wave poses (minimum ratio 0.25), never standing-height references. Target width is not an anatomy constraint: template fragments and suit/body width differ.',
  },
  aura_one_leg: {
    frameWidth: 256, frameHeight: 256,
    referenceBodyHeight: 229,
    referenceFrameIndices: [7],
    referenceRoot: { x: 128, y: 239 },
    templateSha256: '84b1ecb61ccc2ab1b7e3e43baa5e68c78c05b8959b73bff3047d048a4c93364a',
    trumpSha256: '3ab2294dadd943524c293d4aa0397096223ad43131395b6fc52a76227f04f045',
    frames: [
      { x: 103, y: 16, w: 60, h: 223 }, { x: 68, y: 23, w: 168, h: 216 },
      { x: 69, y: 45, w: 168, h: 194 }, { x: 82, y: 28, w: 158, h: 211 },
      { x: 72, y: 31, w: 156, h: 208 }, { x: 48, y: 23, w: 185, h: 216 },
      { x: 67, y: 20, w: 130, h: 219 }, { x: 101, y: 10, w: 64, h: 229 },
    ],
    trumpSourceFrameIndices: [7, 1, 2, 3, 4, 5, 6, 7],
    trumpTargetFrameIndices: [7, 1, 2, 3, 4, 5, 6, 7],
    referenceNotes: 'Frame 8 is the verified neutral in both subjects. Trump source frame 1 incorrectly already holds the ankle although template frame 1 is neutral. Reviewed Trump-only curation holds existing frame 8 in slot 1, using the SAME target reference to avoid a 223/229 neutral-size jump. Original atlas and original template frame 1 remain intact. Balance/compression/airborne limb articulation in frames 2–7 is preserved.',
  },
  aura_shrug: {
    frameWidth: 192, frameHeight: 256,
    referenceBodyHeight: 231,
    referenceFrameIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    referenceRoot: { x: 96, y: 239 },
    templateSha256: '21ab40320680793133c42a0084cd5546ce1783cb4413626e80915f8547167c62',
    trumpSha256: '93b4b95d7a983edf81b72445a36b490218a0a4e69d1bf8533939cf25fcc613af',
    frames: [
      { x: 41, y: 8, w: 121, h: 231 }, { x: 44, y: 8, w: 115, h: 231 },
      { x: 41, y: 8, w: 121, h: 231 }, { x: 43, y: 8, w: 124, h: 231 },
      { x: 41, y: 8, w: 121, h: 231 }, { x: 44, y: 8, w: 115, h: 231 },
      { x: 41, y: 8, w: 121, h: 231 }, { x: 43, y: 8, w: 124, h: 231 },
    ],
    referenceNotes: 'All eight frames upright with arms below head; median height is 231. Optional opponent reaction, not a routine-completeness requirement.',
  },
} as const satisfies Record<string, AuraPoseTemplate>;

export type CalibratedAuraAnimationName = keyof typeof AURA_POSE_TEMPLATES;
