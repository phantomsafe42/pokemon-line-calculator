import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeTreeSections } from '../src/ui/node_tree.js';

test('Free Calc roots and continuations form a bottom section without changing graph or entries', () => {
  const plan = {
    stateNodes: {
      root: {}, normal: {parentActionGroupId:'normal'},
      manual: {freeCalc:true,parentManualTransitionId:'manual'},
      child: {parentActionGroupId:'child'},
      replaced: {parentReplacementTransitionId:'replace'},
      second: {freeCalc:true,parentManualTransitionId:'second'}
    },
    actionGroups: {normal:{parentStateNodeId:'root'},child:{parentStateNodeId:'manual'}},
    replacementTransitions: {replace:{parentStateNodeId:'child'}},
    manualTransitions: {manual:{parentStateNodeId:'root'},second:{parentStateNodeId:'normal'}}
  };
  const entries = [
    {decisionStateNodeId:'manual',lane:0,columnKey:'turn-1'},
    {decisionStateNodeId:'root',outcomeStateNodeId:'normal',lane:2,columnKey:'turn-1'},
    {decisionStateNodeId:'manual',outcomeStateNodeId:'child',lane:0,columnKey:'turn-1'},
    {decisionStateNodeId:'child',outcomeStateNodeId:'replaced',lane:0,columnKey:'replacement-1-1'},
    {decisionStateNodeId:'normal',lane:3,columnKey:'turn-2'},
    {decisionStateNodeId:'second',lane:4,columnKey:'turn-2'}
  ];
  const original = structuredClone({plan,entries});
  const sections = nodeTreeSections(plan,entries);
  assert.deepEqual(sections.map(section=>section.id),['planned','free-calc']);
  assert.deepEqual(sections[0].entries.map(entry=>entry.lane),[0,1]);
  assert.deepEqual(sections[1].entries.map(entry=>entry.lane),[0,0,0,1]);
  assert.deepEqual(sections[1].entries.map(entry=>entry.columnKey),['turn-1','turn-1','replacement-1-1','turn-2']);
  assert.deepEqual({plan,entries},original);
});

test('normal plans have no empty Free Calc section, while standalone Free Calc drafts retain it', () => {
  const entries = [{decisionStateNodeId:'root',lane:0}];
  assert.deepEqual(nodeTreeSections({stateNodes:{root:{}}},entries).map(s=>s.id),['planned']);
  const free = nodeTreeSections({stateNodes:{root:{freeCalc:true}}},entries);
  assert.deepEqual(free.map(s=>s.id),['free-calc']);
  assert.equal(free[0].title,'Free Calc');
  assert.deepEqual(nodeTreeSections({stateNodes:{}},[]),[]);
});
