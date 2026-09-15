import assert from 'node:assert/strict';
import test from 'node:test';
import { TEMPLATE_ATLAS_ANIMATION_NAMES } from '../../../src/services/TemplateAtlasContract.ts';
import { getTemplateAtlasPlans, getTemplateAtlasImage, templateInventory, pngSha256, assertTrustedTemplatePlan,
  readTemplateMaster, resolveTemplateAtlasPlan, templateAtlasImageCacheInfo } from './templates.ts';

test('frozen inventory contains exactly 131 generic masters and 184 playback poses, no identity assets/paths', () => {
  const inventory = templateInventory();
  assert.equal(inventory.identityAssetsIncluded, false);
  assert.equal(inventory.masters.length, 131); assert.equal(inventory.animations.length, 20);
  assert.equal(new Set(inventory.masters.map(master => master.sha256)).size, 131);
  assert.equal(inventory.animations.reduce((sum, animation) => sum + animation.sequence.length, 0), 184);
  assert.deepEqual(inventory.animations.map(animation => animation.name), [...TEMPLATE_ATLAS_ANIMATION_NAMES]);
  const serialized = JSON.stringify(inventory);
  assert(!serialized.includes('/Users/') && !serialized.includes('.local/') && !serialized.includes('upright-white'));
  for (const master of inventory.masters) assert.equal(readTemplateMaster(master.id).pngSha256, master.sha256);
});
test('Rookie uses the exact two frozen 10×7 templates even for a one-animation retry', async () => {
  const plans = await getTemplateAtlasPlans('rookie-two-atlas-v1', ['ko']);
  assert.deepEqual(plans.map(plan => plan.planId), ['rookie-two-atlas-v1:two-01', 'rookie-two-atlas-v1:two-02']);
  assert.deepEqual(plans.map(plan => plan.cells.length), [66, 65]);
  assert.deepEqual(plans.map(plan => plan.blankCells.length), [4, 5]);
  const hashes = ['3ab60f28fdd16f0ab31dfe9725093e6e12baa057edb1f99b664c52260d893f21', 'c502762357818175c8ad97f52bef20a36b8ad58b739225cd06ea8124cbd8cd14'];
  for (const [index, plan] of plans.entries()) {
    assert.equal(pngSha256(await getTemplateAtlasImage(plan)), hashes[index]);
    assert.deepEqual(plan.grid, { columns: 10, rows: 7 });
    assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.cells));
    assert.equal(new Set(plan.cells.map(cell => cell.placement.uniformScale)).size, 1);
  }
  const required = plans[0].animations[0].sequence;
  assert(required.some(id => plans[0].cells.some(cell => cell.masterId === id)));
  assert(required.some(id => plans[1].cells.some(cell => cell.masterId === id)));
});
test('Champion packs only exact unique poses and retains high-kick held extension sequence', async () => {
  const [plan] = await getTemplateAtlasPlans('champion-animation-sheet-v1', ['high_kick']);
  assert.equal(plan.cells.length, 9); assert.equal(plan.animations[0].sequence.length, 21);
  assert.deepEqual(plan.grid, { columns: 3, rows: 3 });
  assert.equal(plan.animations[0].sequence[9], plan.animations[0].sequence[10]);
  assert.equal(plan.animations[0].sequence[10], plan.animations[0].sequence[11]);
  assert.equal(new Set(plan.cells.map(cell => cell.placement.uniformScale)).size, 1);
  assert.equal(pngSha256(await getTemplateAtlasImage(plan)), plan.templateImageSha256);
  assert.throws(() => assertTrustedTemplatePlan(structuredClone(plan)), /private frozen assets/);
});
test('unsupported/duplicate actions and renderer versions cannot choose arbitrary local assets', async () => {
  await assert.rejects(getTemplateAtlasPlans('rookie-two-atlas-v1', ['../../photo.png']));
  await assert.rejects(getTemplateAtlasPlans('rookie-two-atlas-v1', ['idle', 'idle']));
  await assert.rejects(getTemplateAtlasPlans('legacy-v1' as never, ['idle']));
});
test('single Champion resolution is lazy but preserves the full authorized selection and fingerprint', async () => {
  const before = new Set(templateAtlasImageCacheInfo().planIds);
  const id = 'champion-animation-sheet-v1:fireball';
  const plan = await resolveTemplateAtlasPlan('champion-animation-sheet-v1', id, TEMPLATE_ATLAS_ANIMATION_NAMES);
  assert.deepEqual(templateAtlasImageCacheInfo().planIds.filter(key => !before.has(key)), [id]);
  assert.deepEqual(plan.selectedAnimationNames, [...TEMPLATE_ATLAS_ANIMATION_NAMES]);
  const [single] = await getTemplateAtlasPlans('champion-animation-sheet-v1', ['fireball']);
  const { planFingerprint: _fingerprint, ...unsigned } = single;
  const expected = { ...unsigned, selectedAnimationNames: [...TEMPLATE_ATLAS_ANIMATION_NAMES] };
  assert.equal(plan.planFingerprint, pngSha256(JSON.stringify(expected)));
  assert.equal(plan.templateImageSha256, single.templateImageSha256);
  await assert.rejects(resolveTemplateAtlasPlan('champion-animation-sheet-v1', id, ['ko']), /Unknown\/unselected/);
});
