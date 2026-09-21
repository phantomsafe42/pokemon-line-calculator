import { slotsPerSide } from '../core/battle_slots.js';
import { triplePositionForSlot } from '../rulesets/triple_battle.js';

export const displayTrainerName = name => String(name || '').replace(/\s+#\d+(?=\s*(?:&|·|$))/gu, '');
export const trainerFormatLabel = format => ({ singles: 'Single', doubles: 'Double', triples: 'Triple', rotation: 'Rotation' })[format] || format;

export function trainerRequirement(dataset, trainer, splitId) {
  const ids = trainer.encounter?.enemyTrainerIds || [trainer.id];
  const rows = Object.values(dataset.documents['trainer_order.json'].records || {});
  const flags = ids.map(id => {
    const matches = rows.filter(row => (row.trainerId === id || row.participantTrainerIds?.includes(id)) && (!row.splitId || row.splitId === splitId));
    return matches.some(row => row.mandatory === true) ? true : matches.length && matches.every(row => row.mandatory === false) ? false : null;
  });
  return flags.some(value => value === true) ? 'required' : flags.every(value => value === false) ? 'optional' : 'unknown';
}

// This is a view of the opening deployment, never a mutation of the party.
export function trainerDisplayBlocks(dataset, trainer) {
  const format = dataset.trainerBattleFormat(trainer.id);
  const count = slotsPerSide(format);
  let team;
  try { team = dataset.trainerTeam(trainer.id); } catch { team = trainer.team || []; }
  const initial = format === 'triples' ? [0, 2, 1] : Array.from({ length: count }, (_, i) => i);
  const entries = team.map((member, sourceIndex) => {
    const slot = initial.indexOf(sourceIndex);
    const position = slot < 0 ? null : triplePositionForSlot(format, 'enemy', slot);
    return { member, sourceIndex, slot: position === null ? null : count + position + 1,
      side: position !== null && format === 'triples' ? ['Left', 'Center', 'Right'][position] : null };
  });
  const owners = trainer.encounter?.enemySlotTrainerIds || [trainer.id];
  return owners.map(id => ({ trainer: dataset.trainer(id), format, multi: Boolean(trainer.encounter),
    entries: entries.filter(entry => owners.length === 1 || entry.member.ownerTrainerId === id)
      .sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity) || a.sourceIndex - b.sourceIndex) }));
}

export function trainerSpriteQuery(trainer) {
  const identity = trainer?.trainerVisualIdentity;
  if (identity?.status !== 'resolved') return null;
  return { kind: 'trainer-sprite', gameStyle: identity.gameStyle, presentation: identity.presentation,
    subjectKind: identity.subjectKind, subject: identity.subjectId, gender: identity.gender, variant: identity.variant,
    ...(identity.spriteSet ? { spriteSet: identity.spriteSet } : {}) };
}

const element = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text == null ? {} : { textContent: text }) });

export function createTrainerSelector({ dialog, dataset, starterId, resolver, renderCard, onContinue }) {
  const groups = dataset.trainerGroups(starterId);
  const tabs = dialog.querySelector('.trainer-split-tabs');
  const list = dialog.querySelector('.trainer-options');
  const next = dialog.querySelector('.trainer-continue');
  const summary = dialog.querySelector('.trainer-selection-summary');
  let selected = null, groupIndex = 0;
  const observers = [];
  let disposed = false;
  const updateSelection = () => {
    const visible = groups[groupIndex]?.trainers.find(trainer => trainer.id === selected);
    next.disabled = !visible;
    summary.textContent = visible ? displayTrainerName(visible.displayName || visible.name) : 'Choose a trainer';
    for (const row of list.querySelectorAll('.trainer-option')) row.setAttribute('aria-selected', String(row.dataset.trainerId === selected));
  };
  const portrait = (trainer) => {
    const frame = element('div', 'trainer-portrait-frame');
    const identity = trainer.trainerVisualIdentity;
    if (identity?.status === 'ambiguous' && identity.alternatives?.length
      && identity.alternatives.every(choice => choice.status === 'resolved')) {
      frame.classList.add('trainer-portrait-alternatives');
      frame.title = 'Trainer artwork depends on the battle variant selected in New Line.';
      for (const choice of identity.alternatives) {
        frame.append(portrait({ ...trainer, displayName: choice.subjectId.replaceAll('-', ' '), trainerVisualIdentity: choice }));
      }
      return frame;
    }
    if (identity?.status === 'inapplicable') {
      frame.append(element('span', 'trainer-sprite-missing', 'Wild encounter'));
      return frame;
    }
    const query = trainerSpriteQuery(trainer);
    if (!query) { frame.append(element('span', 'trainer-sprite-missing', 'Sprite unavailable')); return frame; }
    const image = element('img', 'trainer-portrait');
    image.alt = displayTrainerName(trainer.displayName || trainer.name);
    // The asset gateway permits image embedding from private test origins but
    // does not grant those origins CORS pixel access. Use normal image loading.
    image.loading = 'lazy';
    let bounds;
    const fit = () => {
      if (!bounds || !frame.isConnected) return;
      const [x, y, w, h] = bounds, scale = Math.min(2, frame.clientWidth / w, frame.clientHeight / h);
      Object.assign(image.style, { width: `${image.naturalWidth * scale}px`, height: `${image.naturalHeight * scale}px`,
        left: `${(frame.clientWidth - w * scale) / 2 - x * scale}px`, top: `${(frame.clientHeight - h * scale) / 2 - y * scale}px` });
    };
    image.addEventListener('load', () => {
      if (disposed) return;
      // Keep source-pixel proportions and APNG animation. A shared frame and
      // 2x cap make the scale independent of the number of Pokemon card rows.
      bounds = [0, 0, image.naturalWidth, image.naturalHeight];
      fit();
    });
    const observer = new ResizeObserver(fit); observer.observe(frame); observers.push(observer);
    frame.append(image);
    const missing = () => { image.hidden = true; if (!frame.querySelector('.trainer-sprite-missing')) frame.append(element('span', 'trainer-sprite-missing', 'Sprite unavailable')); };
    image.addEventListener('error', missing);
    if (resolver.setAssetImage) resolver.setAssetImage(image, query, { onUnavailable: missing });
    else Promise.resolve(resolver.resolveAsset(query)).then(result => { if (result.status === 'ok') image.src = result.url; else missing(); }).catch(missing);
    return frame;
  };
  function renderGroup(index) {
    groupIndex = index;
    for (const observer of observers.splice(0)) observer.disconnect();
    for (const [i, tab] of [...tabs.children].entries()) { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; }
    const group = groups[index];
    list.replaceChildren(); list.scrollTop = 0;
    list.setAttribute('aria-labelledby', `trainer-split-${index}`);
    for (const trainer of group?.trainers || []) {
      const row = element('div', 'trainer-option'); row.tabIndex = 0; row.setAttribute('role', 'option'); row.dataset.trainerId = trainer.id;
      const requirement = trainerRequirement(dataset, trainer, group.id); row.dataset.requirement = requirement;
      const requirementLabel = requirement === 'unknown' ? 'Requirement unspecified' : requirement === 'required' ? 'Required' : 'Optional';
      row.setAttribute('aria-label', `${displayTrainerName(trainer.displayName || trainer.name)} · ${requirementLabel}`);
      row.title = requirementLabel;
      let blocks;
      try { blocks = trainerDisplayBlocks(dataset, trainer); } catch { blocks = []; }
      for (const block of blocks) {
        const section = element('div', 'trainer-block'); section.dataset.ownerTrainerId = block.trainer.id;
        const heading = element('div', 'trainer-heading');
        heading.append(element('h3', 'trainer-name', displayTrainerName(block.trainer.displayName || block.trainer.name)),
          element('span', 'trainer-format', `· ${block.multi ? 'Multi Battle' : trainerFormatLabel(block.format)}`));
        if (block.trainer.mechanicsVariants?.length > 1) heading.append(element('span', 'trainer-format', '· Team varies'));
        const team = element('div', 'trainer-team');
        for (const entry of block.entries) {
          const wrapper = element('div', `trainer-entry${entry.slot ? ' has-slot-heading' : ''}`); wrapper.dataset.sourcePartyIndex = entry.sourceIndex;
          if (entry.slot) wrapper.append(element('div', 'combatant-slot-heading', `Slot ${entry.slot}${entry.side ? ` · ${entry.side}` : ''}`));
          wrapper.append(renderCard(entry.member)); team.append(wrapper);
        }
        if (!block.entries.length) team.append(element('p', 'muted', 'Choose an exact team in New Line.'));
        section.append(heading, portrait(block.trainer), team); row.append(section);
      }
      if (!blocks.length) row.append(element('h3', 'trainer-name', displayTrainerName(trainer.displayName || trainer.name)));
      const select = () => { selected = trainer.id; updateSelection(); };
      row.onclick = select;
      row.onkeydown = event => {
        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); const rows = [...list.children]; const current = rows.indexOf(row);
          rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
        }
      };
      list.append(row);
    }
    updateSelection();
  }
  tabs.replaceChildren(...groups.map((group, index) => {
    const tab = element('button', 'secondary', group.label); tab.type = 'button'; tab.id = `trainer-split-${index}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'trainer-options-panel');
    tab.onclick = () => renderGroup(index);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
      renderGroup(nextIndex); tabs.children[nextIndex].focus();
    };
    return tab;
  }));
  next.onclick = () => { if (!next.disabled) onContinue(selected); };
  renderGroup(0);
  return { dispose() { disposed = true; for (const observer of observers) observer.disconnect(); next.onclick = null; } };
}
