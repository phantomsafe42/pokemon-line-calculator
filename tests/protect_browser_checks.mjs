import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizePlayerCollection, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';

export async function checkProtectOutcomes({ page, evaluate, delay, dataset }) {
  await evaluate(page, `(() => {
    if (document.getElementById('progression-dialog').open)
      document.querySelector('#progression-dialog button[value="no"]').click();
  })()`);
  const wait = async (expression, label) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(page, expression)) return; await delay(50); }
    throw new Error(label);
  };
  const trainer = dataset.trainerGroups().flatMap(group => group.trainers).find(entry => {
    try { return normalizeTrainerRoster(entry.id, null, dataset).length >= 3 && !entry.playerPartnerBinding && !entry.encounter; }
    catch { return false; }
  });
  const players = normalizePlayerCollection({ party: ['squirtle', 'bulbasaur', 'charmander'].map((speciesId, i) => ({
    speciesId, uniqueKey: `protect-${i}`, level: 50, nature: 'Hardy', ability: 'Pressure',
    ivs: { hp:31, atk:31, def:31, spa:31, spd:31, spe:31 }, moves: ['tackle', 'protect', 'detect']
  })) }, dataset);
  for (const format of ['singles', 'doubles', 'triples', 'rotation']) {
    const enemies = normalizeTrainerRoster(trainer.id, null, dataset).map(mon => ({ ...mon, moves: [{ moveId: 'tackle', maxPp: 35 }] }));
    const plan = createPlanDocument({ name: `Protect text ${format}`, dataset, trainerId: trainer.id,
      playerCombatants: players, enemyCombatants: enemies, battleFormat: format });
    await evaluate(page, `(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(JSON.stringify(plan))}], 'protect.json', { type:'application/json' }));
      const input = document.getElementById('import-plan'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles:true }));
    })()`);
    await wait(`(() => {
      if (document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
      return document.getElementById('plan-toolbar-label').textContent === ${JSON.stringify(plan.name)};
    })()`, 'Protect import');
    const count = ['singles', 'rotation'].includes(format) ? 1 : format === 'doubles' ? 2 : 3;
    for (const side of ['player', 'enemy']) for (let slot = 0; slot < count; slot++) {
      const name = side === 'player' ? (slot === 1 ? 'Detect' : 'Protect') : 'Tackle';
      await evaluate(page, `(() => {
        const card = document.querySelector('#${side}-action-panel .combatant-card[data-action-slot="${slot}"]');
        [...card.querySelectorAll('.move-button')].find(button => button.querySelector('strong')?.textContent === '${name}').click();
      })()`);
    }
    await wait(`!document.getElementById('commit-turn').disabled && /Protected/.test(document.getElementById('preview-outcomes').textContent)`, 'Protect preview');
    const read = () => evaluate(page, `[...document.querySelectorAll('#preview-outcomes .event-line')].map(line => line.textContent)`);
    const lines = await read();
    assert.equal(lines.filter(line => /^(Protect|Detect) · Protected$/.test(line)).length, count);
    assert.equal(lines.some(line => / · protect$/.test(line)), false, JSON.stringify(lines));
    assert.ok(lines.some(line => /Tackle · Blocked by Protect$/.test(line)), JSON.stringify(lines));
    await evaluate(page, `(() => {
      const row = [...document.querySelectorAll('#preview-outcomes .outcome-action')].find(row => /^Protect · Protected$/.test(row.textContent));
      row.dispatchEvent(new PointerEvent('pointerover', { bubbles:true, pointerType:'mouse' }));
    })()`);
    assert.equal(await evaluate(page, `document.querySelectorAll('.event-preview-layer').length`), 2);
    await evaluate(page, `document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
    if (format === 'doubles') {
      await evaluate(page, `document.getElementById('preview-outcomes').scrollIntoView({ block:'center' })`);
      await delay(100);
      assert.equal(await evaluate(page, `!!document.querySelector('dialog[open]')`), false);
      const shot = await page.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
      await fs.writeFile(new URL('../.codex-tmp/protect-outcomes.png', import.meta.url), Buffer.from(shot.data, 'base64'));
    }
    await evaluate(page, `document.getElementById('commit-turn').click()`);
    await delay(100);
    // Revisit the saved first turn: historical event rendering uses the same filter.
    await wait(`!!document.querySelector('#node-tree .node-button[data-kind="committed"]')`, 'Protect turn committed');
    await evaluate(page, `document.querySelector('#node-tree .node-button[data-kind="committed"]').click()`);
    await wait(`/Protected/.test(document.getElementById('preview-outcomes').textContent)`, 'Saved Protect outcome');
    assert.deepEqual(await read(), lines);
    console.log(JSON.stringify({ status:'protect-outcomes-browser-valid', format, lines }));
  }
}
