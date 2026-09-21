import test from 'node:test';
import assert from 'node:assert/strict';
import { fixturePlan } from './helpers.mjs';
import { savedDraftSnapshot, savedDraftIsCurrent } from '../src/cache/saved_drafts.js';

test('A saved unchanged line and read-only navigation need no destructive prompt', () => {
  const {plan}=fixturePlan();
  const editor={cursorStateNodeId:plan.initialStateNodeId,actionDraft:{player:[{}],enemy:[{}]}};
  const saved=savedDraftSnapshot(plan,editor);
  assert.equal(savedDraftIsCurrent(saved,plan,editor),true);
  assert.equal(savedDraftIsCurrent(saved,plan,{...editor,cursorStateNodeId:'view-another-node'}),true);
  assert.equal(savedDraftIsCurrent(null,plan,editor),false);
  for(const change of [p=>p.name+=' renamed',p=>p.stateNodes[p.initialStateNodeId].notes='Unsaved note',
    p=>p.combatants[Object.keys(p.combatants)[0]].level++,p=>p.documentRevision++]) {
    const edited=structuredClone(plan);change(edited);
    assert.equal(savedDraftIsCurrent(saved,edited,editor),false);
  }
});

test('Uncommitted move and outcome changes are protected independently of plan revisions', () => {
  const {plan}=fixturePlan();
  const editor={cursorStateNodeId:plan.initialStateNodeId,actionDraft:{player:[{moveId:'tackle'}],enemy:[{}]},selectedPreviewOutcomeId:'normal'};
  const saved=savedDraftSnapshot(plan,editor);
  assert.equal(savedDraftIsCurrent(saved,plan,editor,true),true);
  const changed=structuredClone(editor);changed.actionDraft.player[0].moveId='protect';
  assert.equal(savedDraftIsCurrent(saved,plan,changed,true),false);
  assert.equal(savedDraftIsCurrent(saved,plan,{...editor,selectedPreviewOutcomeId:'critical'},true),false);
  assert.equal(savedDraftIsCurrent(saved,plan,{...editor,cursorStateNodeId:'another-node'},true),false);
  assert.equal(savedDraftIsCurrent(saved,plan,structuredClone(editor),true),true,'Reverted selection matches its saved value');
});
