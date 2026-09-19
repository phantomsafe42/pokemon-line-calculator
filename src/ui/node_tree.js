import { stateLineage } from '../core/graph.js';

// Presentation only: manual states and their continuations belong together,
// even when a later resolved state no longer carries the Free Calc marker.
export function nodeTreeSections(plan, entries) {
  const sections = [
    { id: 'planned', title: '', entries: [] },
    { id: 'free-calc', title: 'Free Calc', entries: [] }
  ];
  for (const entry of entries) {
    const id = entry.outcomeStateNodeId || entry.decisionStateNodeId;
    const manual = plan.game?.planningMode !== 'sandbox' && stateLineage(plan, id).some(stateId => plan.stateNodes[stateId]?.freeCalc);
    sections[manual ? 1 : 0].entries.push(entry);
  }
  return sections.filter(section => section.entries.length).map(section => {
    const lanes = [...new Set(section.entries.map(entry => entry.lane))].sort((a,b) => a-b);
    const laneMap = new Map(lanes.map((lane,index) => [lane,index]));
    return { ...section, entries: section.entries.map(entry => ({ ...entry, lane: laneMap.get(entry.lane) })) };
  });
}
