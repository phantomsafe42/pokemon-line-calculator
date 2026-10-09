import assert from 'node:assert/strict';
import { normalizePlayerCollection, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';

export async function checkNodeTreeScroll({ page, evaluate, delay, dataset }) {
  const trainer = dataset.trainerGroups().flatMap(group => group.trainers).find(row => {
    try { return normalizeTrainerRoster(row.id, null, dataset).length >= 2 && !row.playerPartnerBinding && !row.encounter; }
    catch { return false; }
  });
  assert.ok(trainer, 'a released trainer with a reserve');
  const stats = value => Object.fromEntries(['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(key => [key, value]));
  const players = normalizePlayerCollection({ party: ['squirtle', 'bulbasaur'].map((speciesId, index) => ({
    uniqueKey: `tree-scroll-${index}`, speciesId, level: 30, nature: 'Hardy', ability: 'Pressure',
    ivs: stats(31), evs: stats(0), moves: ['tackle', 'protect']
  })) }, dataset);
  const plan = createPlanDocument({ name: 'Tree scroll fixture', dataset, trainerId: trainer.id,
    playerCombatants: players, enemyCombatants: normalizeTrainerRoster(trainer.id, null, dataset),
    battleFormat: 'singles', planningMode: 'sandbox' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(page, `(() => {
    if (!document.getElementById('game-dialog').open) document.getElementById('new-game').click();
  })()`);
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await evaluate(page, `(() => {
      if (document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
      return document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]:not(:disabled)') !== null;
    })()`)) break;
    if (attempt === 159) throw new Error('VW2R game picker did not open');
    await delay(100);
  }
  await evaluate(page, `document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click()`);
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await evaluate(page, `(() => {
      if (document.getElementById('starter-dialog').open) document.querySelector('[data-starter-id="snivy"]').click();
      return document.getElementById('current-game-name').textContent.includes('Volt White 2 Redux')
        && document.getElementById('trainer-select').options.length > 1
        && !document.getElementById('game-dialog').open && !document.getElementById('starter-dialog').open;
    })()`)) break;
    if (attempt === 159) {
      const diagnostic = await evaluate(page, `({status:document.getElementById('app-status').textContent,
        gameDialog:document.getElementById('game-dialog').open,
        starterDialog:document.getElementById('starter-dialog').open,
        game:document.getElementById('current-game-name').textContent})`);
      throw new Error(`VW2R did not finish loading: ${JSON.stringify(diagnostic)}`);
    }
    await delay(100);
  }
  await evaluate(page, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(JSON.stringify(plan))}], 'tree-scroll.json', {type:'application/json'}));
    const input = document.getElementById('import-plan'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await evaluate(page, `(() => {
      if (document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
      return document.getElementById('plan-toolbar-label').textContent === 'Tree scroll fixture'
        && document.querySelectorAll('#node-tree .node-button[data-kind="draft"]').length === 1;
    })()`)) break;
    if (attempt === 159) {
      const diagnostic = await evaluate(page, `({label:document.getElementById('plan-toolbar-label').textContent,
        committed:document.querySelectorAll('#node-tree .node-button[data-kind="committed"]').length,
        status:document.getElementById('app-status').textContent,
        dialog:document.getElementById('destructive-dialog').open})`);
      throw new Error(`Tree scroll fixture did not load: ${JSON.stringify(diagnostic)}`);
    }
    await delay(100);
  }
  await evaluate(page, `(() => {
    for (const side of ['player', 'enemy']) {
      const control = document.querySelector('[data-free-calc-control="'+side+'-0-Move 1"]');
      control.value = 'protect';
      control.dispatchEvent(new Event('change', {bubbles:true}));
    }
  })()`);
  for (let turn = 1; turn <= 3; turn++) {
    await evaluate(page, `(() => {
      for (const side of ['player', 'enemy']) {
        const button = document.querySelector('[data-side="'+side+'"][data-action-slot="0"] .move-button');
        if (button.getAttribute('aria-pressed') !== 'true') button.click();
      }
    })()`);
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(page, `!document.getElementById('commit-turn').disabled`)) break;
      if (attempt === 159) throw new Error(`Turn ${turn} preview did not become ready`);
      await delay(100);
    }
    await evaluate(page, `document.getElementById('commit-turn').click()`);
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(page, `document.querySelectorAll('#node-tree .node-button[data-kind="committed"]').length === ${turn}`)) break;
      if (attempt === 159) throw new Error(`Turn ${turn} did not commit`);
      await delay(100);
    }
  }
  await evaluate(page, `document.getElementById('plc-tab').click()`);
  const result = await evaluate(page, `(() => {
    const tree = () => document.querySelector('#node-tree [data-tree-section="planned"] .node-tree-branches');
    const before = tree();
    const clientWidth = before.clientWidth, scrollWidth = before.scrollWidth;
    const maxScroll = scrollWidth - clientWidth;
    before.scrollLeft = Math.min(180, maxScroll);
    const scrolled = before.scrollLeft;
    [...before.querySelectorAll('.node-button[data-kind="committed"]')].at(-1)?.click();
    const afterCommitted = tree().scrollLeft;
    tree().scrollLeft = maxScroll - 40;
    const scrolledDraft = tree().scrollLeft;
    tree().querySelector('.node-button[data-kind="draft"]')?.click();
    return {maxScroll, clientWidth, scrollWidth,
      viewport:innerWidth, workspaceHidden:document.getElementById('battle-workspace').hidden,
      sections:document.querySelectorAll('#node-tree .node-tree-section').length,
      scrolled, afterCommitted, scrolledDraft, afterDraft:tree().scrollLeft};
  })()`);
  assert.ok(result.maxScroll > 180, `The tree must overflow horizontally: ${JSON.stringify(result)}`);
  assert.equal(result.scrolled, 180);
  assert.equal(result.afterCommitted, result.scrolled, 'committed node click keeps the scroll position');
  assert.ok(result.scrolledDraft > result.scrolled, 'draft check uses a farther scroll position');
  assert.equal(result.afterDraft, result.scrolledDraft, 'draft node click keeps the scroll position');
  console.log(JSON.stringify({status:'node-tree-scroll-valid',...result}));
}
