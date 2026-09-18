// Consume explicit encounter relationships; never pair adjacent names/order rows.
export function installTrainerEncounters(index, groupsDocument, profileId) {
  const byMember = new Map(); const syntheticIds = new Set();
  const choicesByMember = new Map();
  const bindingsById = new Map();
  const partnerBindings = groupsDocument?.playerPartners;
  if (partnerBindings && partnerBindings.schemaVersion !== 'trainer-player-partners/v1') throw new Error('Unsupported player partner contract');
  const groups = { ...groupsDocument?.records };
  const allyIds = new Set();
  const boundEnemies = new Set();
  for (const binding of partnerBindings?.bindings || []) {
    if (!binding.id || bindingsById.has(binding.id)) throw new Error('Ambiguous player partner binding identity');
    bindingsById.set(binding.id, binding);
    if (binding.battleFormat !== 'doubles' || binding.playerPartyPolicy !== 'per-trainer'
      || binding.playerSlot !== 0 || binding.partnerSlot !== 1 || !binding.partnerOptions?.length
      || ![1, 2].includes(binding.enemyTrainerIds?.length)
      || binding.enemyPartyPolicy !== (binding.enemyTrainerIds.length === 2 ? 'per-trainer' : 'shared')) throw new Error(`Invalid player partner binding ${binding.id}`);
    if (binding.formatChoice && !['double-only', 'single-or-double'].includes(binding.formatChoice)) throw new Error(`Invalid player partner format ${binding.id}`);
    if (binding.maxPlayerPartySize !== undefined && (!Number.isInteger(binding.maxPlayerPartySize) || binding.maxPlayerPartySize < 1 || binding.maxPlayerPartySize > 6)) throw new Error(`Invalid player party limit ${binding.id}`);
    const optionIds = new Set();
    for (const option of binding.partnerOptions) {
      const optionId = option.id || option.trainerId;
      if (!optionId || optionIds.has(optionId)) throw new Error(`Ambiguous player partner option ${binding.id}`);
      optionIds.add(optionId);
      const partner = index.get(option.trainerId);
      if (!partner || (partner.mechanicsVariants?.length && !partner.mechanicsVariants.some(variant => variant.id === option.trainerVariantId))
        || (option.trainerVariantId && !partner.mechanicsVariants?.some(variant => variant.id === option.trainerVariantId))) throw new Error(`Unresolved player partner ${option.trainerId}`);
      if (option.hideFromOpponentSelection !== false) allyIds.add(option.trainerId);
    }
    for (const id of binding.enemyTrainerIds) {
      const trainer = structuredClone(index.get(id));
      if (!trainer) throw new Error(`Missing player partner enemy ${id}`);
      // Explicit encounter alternatives (e.g. choose one Striaton brother)
      // bind the synthetic encounter, never an arbitrary shared source trainer.
      if (binding.choiceFamilyId) continue;
      if (boundEnemies.has(id)) throw new Error(`Ambiguous player partner for ${id}`);
      boundEnemies.add(id);
      trainer.playerPartnerBinding = structuredClone(binding);
      if (binding.formatChoice !== 'single-or-double') trainer.battleProfiles = { ...trainer.battleProfiles, [profileId]: { ...trainer.battleProfiles?.[profileId], format: 'double', formatSource: `player-partner:${binding.id}` } };
      index.set(id, trainer);
    }
    const existing = groups[binding.id];
    // A reviewed additive binding can activate a previously gated raw context
    // record. Already-active contracts must still agree exactly.
    if (existing && (existing.consumerActivation?.plc !== false && existing.formatChoice !== (binding.formatChoice || 'double-only')
      || groups[binding.id].enemyTrainerIds?.length !== binding.enemyTrainerIds.length
      || binding.enemyTrainerIds.some(id => !groups[binding.id].enemyTrainerIds.includes(id)))) throw new Error(`Conflicting player partner encounter ${binding.id}`);
    if (binding.enemyTrainerIds.length === 2) {
      groups[binding.id] = { ...existing, id: binding.id, battleFormat: 'multi-trainer', enemyTrainerIds: binding.enemyTrainerIds,
        enemySlotTrainerIds: binding.enemyTrainerIds, partyPolicy: 'per-trainer', formatChoice: binding.formatChoice || 'double-only',
        ...(binding.choiceFamilyId ? { choiceFamilyId: binding.choiceFamilyId } : {}), consumerActivation: { ...existing?.consumerActivation, plc: true } };
    }
  }
  for (const group of Object.values(groups)) {
    if (group.consumerActivation?.plc === false) continue;
    if (!['double', 'doubles', 'tag', 'multi-trainer'].includes(group.battleFormat)) continue;
    if (!Array.isArray(group.enemyTrainerIds) || group.enemyTrainerIds.length !== 2) throw new Error(`Invalid paired encounter ${group.id}`);
    if (group.partyPolicy !== 'per-trainer') throw new Error(`Unsupported party policy for ${group.id}`);
    if (!['double-only', 'single-or-double'].includes(group.formatChoice)) throw new Error(`Missing format choice for ${group.id}`);
    if (!Array.isArray(group.enemySlotTrainerIds) || group.enemySlotTrainerIds.length !== 2
      || new Set(group.enemySlotTrainerIds).size !== 2
      || group.enemySlotTrainerIds.some(id => !group.enemyTrainerIds.includes(id))) throw new Error(`Invalid enemy slot ownership for ${group.id}`);
    const ids = group.enemySlotTrainerIds;
    const trainers = ids.map(id => index.get(id));
    if (trainers.some(trainer => !trainer)) throw new Error(`Missing trainer in ${group.id}`);
    if (trainers.some(trainer => trainer.mechanicsVariants?.length)) throw new Error(`Encounter ${group.id} requires explicit participant variants`);
    const paired = structuredClone(trainers[0]);
    Object.assign(paired, { id: group.id, displayName: trainers.map(trainer => trainer.displayName || trainer.name).join(' & '),
      consumerTrainerId: null, finalRomTrainerId: null, finalRomTrainerIds: [],
      encounter: structuredClone(group), team: [] });
    const binding = bindingsById.get(group.id);
    if (binding) paired.playerPartnerBinding = structuredClone(binding);
    if (binding?.choiceFamilyId) paired.displayName += ` · with ${index.get(binding.partnerOptions[0].trainerId).displayName}`;
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
      if (group.choiceFamilyId) {
        const choices = choicesByMember.get(id) || [];
        if (byMember.has(id) || choices.some(choice=>choice.encounter.choiceFamilyId !== group.choiceFamilyId)) throw new Error(`Trainer ${id} has ambiguous encounter family`);
        choicesByMember.set(id, [...choices,paired]);
        continue;
      }
      if (choicesByMember.has(id)) throw new Error(`Trainer ${id} has ambiguous encounter membership`);
      if (byMember.has(id)) throw new Error(`Trainer ${id} has ambiguous encounter membership`);
      byMember.set(id, paired);
    }
  }
  return { byMember, choicesByMember, syntheticIds, allyIds };
}

export function encounterNavigation(groups, encounters) {
  const seen = new Set();
  return groups.map(group => ({ ...group, trainers: group.trainers.flatMap(trainer => {
    if (encounters.allyIds?.has(trainer.id)) return [];
    if (encounters.syntheticIds.has(trainer.id)) return [];
    const choices = encounters.choicesByMember?.get(trainer.id);
    if (choices) return choices.filter(choice=>{ if(seen.has(choice.id)) return false; seen.add(choice.id); return true; });
    const paired = encounters.byMember.get(trainer.id);
    if (!paired || paired.encounter.formatChoice === 'single-or-double') return [trainer];
    if (seen.has(paired.id)) return [];
    seen.add(paired.id); return [paired];
  }) })).filter(group => group.trainers.length);
}
