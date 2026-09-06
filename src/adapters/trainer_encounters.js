// Consume explicit encounter relationships; never pair adjacent names/order rows.
export function installTrainerEncounters(index, groupsDocument, profileId) {
  const byMember = new Map(); const syntheticIds = new Set();
  for (const group of Object.values(groupsDocument?.records || {})) {
    if (group.consumerActivation?.plc === false) continue;
    if (!['double', 'doubles', 'tag', 'multi-trainer'].includes(group.battleFormat)) continue;
    if (!Array.isArray(group.enemyTrainerIds) || group.enemyTrainerIds.length !== 2) throw new Error(`Invalid paired encounter ${group.id}`);
    if (group.partyPolicy && group.partyPolicy !== 'per-trainer') throw new Error(`Unsupported party policy for ${group.id}`);
    const ids = group.enemySlotTrainerIds || group.enemyTrainerIds;
    const trainers = ids.map(id => index.get(id));
    if (trainers.some(trainer => !trainer)) throw new Error(`Missing trainer in ${group.id}`);
    if (trainers.some(trainer => trainer.mechanicsVariants?.length)) throw new Error(`Encounter ${group.id} requires explicit participant variants`);
    const paired = structuredClone(trainers[0]);
    Object.assign(paired, { id: group.id, displayName: trainers.map(trainer => trainer.displayName || trainer.name).join(' & '),
      consumerTrainerId: null, finalRomTrainerId: null, finalRomTrainerIds: [],
      encounter: structuredClone(group), team: [] });
    for (let row = 0; row < Math.max(...trainers.map(trainer => trainer.team.length)); row++) {
      trainers.forEach((trainer, ownerSlot) => {
        if (!trainer.team[row]) return;
        paired.team.push({ ...structuredClone(trainer.team[row]), slot: paired.team.length + 1,
          ownerTrainerId: trainer.id, ownerPartySlot: trainer.team[row].slot ?? row + 1, ownerSlot,
          ownerConsumerTrainerId: trainer.consumerTrainerId ?? null });
      });
    }
    paired.battleProfiles = { ...paired.battleProfiles, [profileId]: { ...paired.battleProfiles?.[profileId], format: 'double', formatSource: `trainer-battle-groups:${group.id}` } };
    index.set(group.id, paired); syntheticIds.add(group.id);
    for (const id of ids) {
      if (byMember.has(id)) throw new Error(`Trainer ${id} has ambiguous encounter membership`);
      byMember.set(id, paired);
    }
  }
  return { byMember, syntheticIds };
}

export function encounterNavigation(groups, encounters) {
  const seen = new Set();
  return groups.map(group => ({ ...group, trainers: group.trainers.flatMap(trainer => {
    if (encounters.syntheticIds.has(trainer.id)) return [];
    const paired = encounters.byMember.get(trainer.id);
    if (!paired || paired.encounter.formatChoice === 'single-or-double') return [trainer];
    // Older source groups establish the pair, but not the field-trigger choice.
    // Keep the member selections until that classification is explicitly supplied.
    if (!paired.encounter.formatChoice) {
      if (seen.has(paired.id)) return [trainer];
      seen.add(paired.id); return [paired, trainer];
    }
    if (seen.has(paired.id)) return [];
    seen.add(paired.id); return [paired];
  }) })).filter(group => group.trainers.length);
}
