import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import { getTemplateAtlasPlans, getTemplateAtlasImage, pngSha256, TEMPLATE_REGISTRATION } from './templates.ts';
import { compileTemplateAtlas, assembleTemplateAtlasAnimation, assembleTemplateAtlasHqAnimation, inspectCompiledCell, cropNative,
  packPlaybackFrames, clearTemplateAtlasCompilerCache, templateAtlasCompilerCacheInfo } from './compiler.ts';

test('native crops and playback packing do not rescale pixels and repeated holds are byte-identical', () => {
  const raw = { width: 8, height: 8, data: Buffer.from(Array.from({ length: 8 * 8 * 4 }, (_, index) => index % 251)) };
  const original = Buffer.from(raw.data), frame = cropNative(raw, { x: 2, y: 1, width: 3, height: 4 });
  assert.deepEqual(raw.data, original);
  for (let y = 0; y < 4; y++) assert.deepEqual(frame.data.subarray(y * 12, (y + 1) * 12), raw.data.subarray(((y + 1) * 8 + 2) * 4, ((y + 1) * 8 + 5) * 4));
  const packed = PNG.sync.read(packPlaybackFrames([frame.data, frame.data, frame.data], 3, 4).png);
  for (const x of [0, 3, 6]) assert.deepEqual(cropNative(packed, { x, y: 0, width: 3, height: 4 }).data, frame.data);
});
test('foreground entering required frame border fails; no body-fit masks the error', () => {
  const width = 20, height = 20, data = Buffer.alloc(width * height * 4), prior = new Uint8Array(width * height);
  for (let y = 5; y < 15; y++) for (let x = 0; x < 8; x++) { data[(y * width + x) * 4 + 3] = 255; prior[y * width + x] = 255; }
  const qa = inspectCompiledCell('synthetic', data, prior, width, height, { scale: 1, translateX: 0, translateY: 0 }, { ambiguousWhiteComponents: 0, removedWhiteComponents: 0 });
  assert(qa.failures.includes('foreground_touches_cell_border'));
  assert.equal(qa.silhouetteIou, 1);
});
test('wrong dimensions and untrusted layouts fail before compilation', async () => {
  const [plan] = await getTemplateAtlasPlans('rookie-two-atlas-v1', ['idle']);
  const small = PNG.sync.write({ width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, 255) } as PNG);
  await assert.rejects(compileTemplateAtlas(small, plan), /4096/);
  await assert.rejects(compileTemplateAtlas(small, structuredClone(plan)), /private frozen assets/);
  const truncated = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(truncated);
  truncated.writeUInt32BE(4096, 16); truncated.writeUInt32BE(4096, 20);
  await assert.rejects(compileTemplateAtlas(truncated, plan), {
    code: 'template_atlas_qa_failed',
    message: 'Preserved RAW atlas is not a decodable PNG; no regeneration attempted',
  });
});
test('Champion template control compiles fixed geometry, distinct RAW/alpha HQ and exact expanded holds', async () => {
  clearTemplateAtlasCompilerCache();
  const plans = await getTemplateAtlasPlans('champion-animation-sheet-v1', ['high_kick']);
  const raw = await getTemplateAtlasImage(plans[0]), originalHash = pngSha256(raw);
  const compiled = await compileTemplateAtlas(raw, plans[0]);
  assert.equal(compiled.qa.passed, true); assert.equal(compiled.frames.length, 9);
  for (const frame of compiled.frames) {
    assert.equal(frame.qa.rgbChannelChanges, 0);
    const data = PNG.sync.read(frame.png).data, rawData = PNG.sync.read(frame.rawPng).data;
    assert.equal(pngSha256(data), frame.rgbaSha256); assert.equal(pngSha256(rawData), frame.rawRgbaSha256);
    for (let i = 0; i < data.length; i += 4) {
      assert.equal(data[i], rawData[i]); assert.equal(data[i + 1], rawData[i + 1]); assert.equal(data[i + 2], rawData[i + 2]);
    }
  }
  assert.equal(await compileTemplateAtlas(raw, plans[0]), compiled, 'Repeated assembly must reuse validated native mattes');
  assert.equal(templateAtlasCompilerCacheInfo().entries, 1);
  const output = await assembleTemplateAtlasAnimation(plans, [compiled], 'high_kick');
  assert.equal(output.frameCount, 21); assert.equal(output.originY, TEMPLATE_REGISTRATION.originY);
  assert.equal(output.animationFormat, 'template-atlas-v1'); assert.equal(output.processingVersion, 6);
  assert.notEqual(output.hqSha256, output.rawHqSha256);
  assert.equal(pngSha256(raw), originalHash);
  const atlas = PNG.sync.read(output.runtimePng);
  const getFrame = (index: number) => cropNative(atlas, { x: index % output.columns * 384, y: Math.floor(index / output.columns) * 512, width: 384, height: 512 }).data;
  assert.deepEqual(getFrame(9), getFrame(10)); assert.deepEqual(getFrame(10), getFrame(11));
  assert.deepEqual(output.sequence, plans[0].animations[0].sequence);
  const hqOnly = await assembleTemplateAtlasHqAnimation(plans, [compiled], 'high_kick');
  assert.deepEqual(hqOnly.hqPng, output.hqPng); assert.deepEqual(hqOnly.rawHqPng, output.rawHqPng);
  assert.equal('runtimePng' in hqOnly, false, 'RPC never allocates an unused runtime sheet');
  assert(templateAtlasCompilerCacheInfo().bytes < compiled.frames.reduce((sum, frame) => sum + frame.width * frame.height * 8, 0));
  await assert.rejects(assembleTemplateAtlasAnimation(plans, [], 'high_kick'), /Missing/);
});
test('declared trailing blank art is ignored by index, while required cells stay strict', async () => {
  clearTemplateAtlasCompilerCache();
  const plans = await getTemplateAtlasPlans('champion-animation-sheet-v1', ['low_punch']);
  const plan = plans[0]; assert.equal(plan.blankCells.length, 1);
  const raw = PNG.sync.read(await getTemplateAtlasImage(plan));
  const blank = plan.blankCells[0].rect;
  for (let y = blank.y + 40; y < blank.y + 110; y++) for (let x = blank.x + 40; x < blank.x + 110; x++) raw.data.set([20, 40, 60, 255], (y * raw.width + x) * 4);
  const bytes = PNG.sync.write(raw), result = await compileTemplateAtlas(bytes, plan);
  assert(result.qa.passed); assert(result.qa.blankCells[0].unexpectedForeground);
  assert(result.qa.warnings.some(warning => warning.includes('excluded by its declared index')));
  assert.equal(result.frames.length, plan.cells.length);
  assert(result.frames.every(frame => plan.cells.some(cell => cell.masterId === frame.masterId)));
  // Identical added artwork moved onto the border of a required cell is NOT ignored.
  const required = plan.cells[0].rect;
  for (let y = required.y; y < required.y + 60; y++) for (let x = required.x; x < required.x + 60; x++) raw.data.set([20, 40, 60, 255], (y * raw.width + x) * 4);
  await assert.rejects(compileTemplateAtlas(PNG.sync.write(raw), plan), error => {
    assert((error as { qa?: { failures: string[] } }).qa?.failures.some(failure => failure.includes('foreground_touches_cell_border')));
    return true;
  });
});
