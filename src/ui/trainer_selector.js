import { slotsPerSide } from '../core/battle_slots.js';
import { triplePositionForSlot } from '../rulesets/triple_battle.js';
import { starterAllows } from '../adapters/starter_selection.js';

// Presentation only: keep source names, IDs and encounter disambiguators intact.
export const displayBattleLabel = name => String(name || '')
  // Square/pipe annotations in the current contracts describe teams,
  // difficulty, battle format or location, not the in-game trainer name.
  .replace(/\s*\[[^\[\]]*\]/gu, '')
  .replace(/\s*\|[^|]*\|/gu, '')
  // Keep narrative names (e.g. named quests) and genuine title qualifiers;
  // remove only recognizable technical parenthetical annotations.
  .replace(/\s*\((?:Encounter\s*#?\s*\d+|(?:Single|Double|Triple|Rotation|Multi)\s+Battle|(?:Morning|Day|Night)\s+only|w\.\s+[^()]+|(?:immediately\s+after|after|three\s+beasts\s+back\s+to\s+back|two\s+birds\s+back\s+to\s+back|entrance\s+and)\s+[^()]+)\)/giu, '')
  .replace(/\s+(?:[·—–-]\s*)?(?:Encounter\s*#?\s*\d+|#\d+)(?=\s*(?:&|·|\(|$))/giu, '')
  .trim();
// Name presentation only. Do not apply these rules to user-authored plan names
// or mechanics-variant labels, whose numbers are meaningful.
export function displayTrainerName(name, gameId) {
  const decoded = String(name || '').replace(/\{\{([^{}]+)\}\}/gu, (_, body) => body.includes('|') ? body.split('|').at(-1) : body.replace(/^ho(?=[A-Z])/u, ''));
  let label = displayBattleLabel(decoded)
    .replace(/[♂♀]/gu, '')
    .replace(/\s*\([MF]\)/gu, '')
    .replace(/\b(Swimmer|Cooltrainer|Ace Trainer|Pokémon Ranger|Pokemon Ranger|Clerk|Camper|Picnicker|Psychic|Tuber)[-~][MF0-9]+\b/giu, '$1')
    .replace(/[{}]/gu, '')
    .replace(/\.{2,}/gu, ' ')
    .replace(/\bCooltrainer\b/giu, 'Cool Trainer')
    .replace(/\s+-\s+(?:Easy|Normal|Difficult|Expert|Insane)\s*$/giu, '')
    .replace(/\d+(?:\s+\d+)*(?=\s*(?:&|$))/gu, '')
    .replace(/\b(Team Plasma Grunt)\s+\1\b/giu, '$1')
    .replace(/\s+/gu, ' ').trim();
  // A rival label is presentation; source character identity stays intact.
  label = label.split(/\s+&\s+/u).map(part =>
    /^(?:Rival(?:\s|$)|Pok[eé]mon Trainer Barry$)/iu.test(part) ? 'Rival' : part
  ).join(' & ');
  if (gameId === 'fire-red-omega') label = label.replace(/^Leader\s+/u, '');
  return label;
}

export function campaignTrainerGroups(groups) {
  const end = groups.findIndex(group => /^(?:champion|league|elite-?four)$/u.test(group.id));
  const bounded = end < 0 ? groups : groups.slice(0, end + 1);
  return bounded.filter(group => !['other', 'postgame', 'facilities', 'frontier', 'battle-frontier'].includes(group.id));
}

export const trainerFormatLabel = format => ({ singles: 'Single', doubles: 'Double', triples: 'Triple', rotation: 'Rotation' })[format] || format;

const searchText = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function trainerSearchIndex(dataset, groups, starterId) {
  const entries = new Map();
  for (const group of groups) for (const trainer of group.trainers) {
    if (entries.has(trainer.id)) continue;
    const participants = trainer.encounter?.enemyTrainerIds?.map(id => dataset.trainer(id)).filter(Boolean) || [];
    const records = [trainer, ...participants];
    const fields = [], locations = [];
    for (const record of records) {
      fields.push(displayTrainerName(record.displayName || record.name, dataset.gameId), record.displayName || record.name, record.shortName);
      locations.push(record.locationName, record.location);
      const variants = (record.mechanicsVariants || []).filter(v => starterAllows(dataset.starterSelection, starterId, record.id, v.id));
      const teams = record.mechanicsVariants?.length ? variants.map(v => dataset.trainerTeam(record.id, v.id)) : [record.team || []];
      for (const member of teams.flat()) {
        const species = dataset.get('species', member.speciesId);
        fields.push(member.speciesId, species?.name || species?.displayName || member.displaySpecies);
      }
    }
    entries.set(trainer.id, { trainer, splitId: group.id, hasLocation: locations.some(value => typeof value === 'string' && value.trim()),
      terms: [...fields, ...locations].filter(value => typeof value === 'string').map(searchText) });
  }
  return [...entries.values()];
}

export function searchTrainerIndex(index, query) {
  const terms = String(query).trim().split(/\s+/u).map(searchText).filter(Boolean);
  return index.filter(entry => terms.every(term => entry.terms.some(field => field.includes(term))));
}

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
  const identity = trainer?.presentation?.trainerVisualIdentity || trainer?.trainerVisualIdentity;
  if (identity?.status !== 'resolved') return null;
  return { kind: 'trainer-sprite', gameStyle: identity.gameStyle, presentation: identity.presentation,
    subjectKind: identity.subjectKind, subject: identity.subjectId, gender: identity.gender, variant: identity.variant,
    ...(identity.spriteSet ? { spriteSet: identity.spriteSet } : {}) };
}

// Combined encounters carry presentation-only participants, not separate teams.
export function trainerPortraitParticipants(trainer) {
  return (trainer?.trainerVisualParticipants || []).map(participant => ({
    ...participant,
    displayName: participant.label,
  }));
}

export function trainerPortraitFallback(trainer) {
  // A missing singular portrait can also describe paired human trainers.
  // Only an explicit wild-battle source may be labeled as a wild encounter.
  return trainer?.sourceType === 'boss-wild' && !trainer.trainerVisualParticipants?.length
    ? 'Wild encounter' : 'Sprite unavailable';
}

const element = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text == null ? {} : { textContent: text }) });

// Explicit presentation families; split/leader aliases remain owned by the
// shared asset resolver. VW2R shares the exact B2W2 family with retail B2W2.
const badgeStyles = {
  'volt-white-2r': 'b2w2-unova',
  'pokemon-ruby': 'pgl-hoenn', 'pokemon-sapphire': 'pgl-hoenn', 'pokemon-emerald': 'pgl-hoenn',
  'pokemon-firered': 'lgpe-kanto', 'pokemon-leafgreen': 'lgpe-kanto',
  'pokemon-diamond': 'dp-sinnoh', 'pokemon-pearl': 'dp-sinnoh', 'pokemon-platinum': 'dp-sinnoh',
  'pokemon-heartgold': 'hgss-johto', 'pokemon-soulsilver': 'hgss-johto',
  'pokemon-black': 'b2w2-unova', 'pokemon-white': 'b2w2-unova',
  'pokemon-black-2': 'b2w2-unova', 'pokemon-white-2': 'b2w2-unova'
};

export function trainerSplitBadgeQuery(gameId, group) {
  if (group.id === 'postgame') return { kind: 'item-sprite', style: 'showdown', item: 'master-ball' };
  if (['facilities', 'frontier', 'battle-frontier'].includes(group.id)) return { kind: 'item-sprite', style: 'showdown', item: 'poke-ball' };
  if (group.id === 'other') return { kind: 'pokemon-sprite', spriteType: 'pixel', species: 'unown', form: 'question', view: 'front' };
  const style = badgeStyles[gameId];
  // Game context disambiguates BW Gym Leader Iris from the BW2 Champion.
  return { kind: 'badge-icon', game: gameId.replace(/^pokemon-/, ''), ...(style ? { style } : {}),
    badge: group.id === 'league' ? 'elite-four' : group.id };
}

// Keep a small, resolver-scoped set of image elements alive so opening the
// selector can attach already-loaded artwork without another request/decode.
const splitIconCaches = new WeakMap();
function splitIconImage(resolver, query) {
  let cache = splitIconCaches.get(resolver);
  if (!cache) { cache = new Map(); splitIconCaches.set(resolver, cache); }
  const key = JSON.stringify(query);
  let image = cache.get(key);
  if (!image) {
    image = element('img', 'trainer-split-badge'); image.alt = '';
    image.dataset.assetKind = query.kind;
    image.loading = 'eager'; image.fetchPriority = 'high';
    cache.set(key, image);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    if (resolver.setAssetImage) resolver.setAssetImage(image, query);
    else Promise.resolve(resolver.resolveAsset(query)).then(result => {
      if (result.status === 'ok') image.src = result.url;
    }).catch(() => {});
  }
  return image;
}

export function preloadTrainerSplitIcons(dataset, resolver) {
  if (!resolver) return;
  for (const group of dataset.trainerGroups()) {
    const query = trainerSplitBadgeQuery(dataset.gameId, group);
    if (query) splitIconImage(resolver, query);
  }
}

export function trainerSpriteQueries(dataset) {
  const queries = new Map();
  const visit = trainer => {
    const query = trainerSpriteQuery(trainer);
    if (query) queries.set(JSON.stringify(query), query);
    for (const identity of trainer.trainerVisualIdentity?.alternatives || []) visit({ trainerVisualIdentity: identity });
    for (const participant of trainer.trainerVisualParticipants || []) visit(participant);
  };
  for (const trainer of Object.values(dataset.documents['trainers.json'].records)) visit(trainer);
  return [...queries.values()];
}

// Start at game selection, deduplicating shared class portraits. Four low-priority
// downloads at a time leave capacity for game data and split icons. Retain loaded
// images so later portrait elements reuse the browser's decoded image cache.
const trainerImageCaches = new WeakMap();
export function preloadTrainerSprites(dataset, resolver) {
  if (!resolver) return Promise.resolve();
  let state = trainerImageCaches.get(resolver);
  if (!state) { state = { images: new Map(), run: 0 }; trainerImageCaches.set(resolver, state); }
  const run = ++state.run, queries = trainerSpriteQueries(dataset);
  const load = query => {
    const key = JSON.stringify(query);
    if (state.images.has(key)) return state.images.get(key).done;
    const image = element('img', ''); image.loading = 'eager'; image.fetchPriority = 'low';
    const entry = { image };
    state.images.set(key, entry);
    entry.done = new Promise(resolve => {
      let finished = false;
      const finish = ok => {
        if (finished) return; finished = true; clearTimeout(timer);
        image.onload = null; image.onerror = null;
        if (!ok) state.images.delete(key);
        resolve();
      };
      const timer = setTimeout(() => finish(false), 15000);
      image.onload = () => finish(true); image.onerror = () => finish(false);
      try {
        if (resolver.setAssetImage) resolver.setAssetImage(image, query, { onUnavailable: () => finish(false) });
        else Promise.resolve(resolver.resolveAsset(query)).then(result => {
          if (result.status === 'ok') image.src = result.url; else finish(false);
        }).catch(() => finish(false));
      } catch { finish(false); }
    });
    if (state.images.size > 384) state.images.delete(state.images.keys().next().value);
    return entry.done;
  };
  return Promise.all(Array.from({ length: 4 }, async () => {
    while (state.run === run && queries.length) await load(queries.shift());
  }));
}

export function createTrainerSelector({ dialog, dataset, starterId, resolver, renderCard, onContinue }) {
  const groups = campaignTrainerGroups(dataset.trainerGroups(starterId));
  const tabs = dialog.querySelector('.trainer-split-tabs');
  const list = dialog.querySelector('.trainer-options');
  const next = dialog.querySelector('.trainer-continue');
  const search = dialog.querySelector('.trainer-search');
  const searchIndex = trainerSearchIndex(dataset, groups, starterId);
  const searchLabel = searchIndex.some(entry => entry.hasLocation) ? 'Search trainers, Pokémon, or locations' : 'Search trainers or Pokémon';
  search.value = ''; search.placeholder = searchLabel; search.setAttribute('aria-label', searchLabel);
  let selected = null, groupIndex = 0;
  let visibleEntries = [], searchTimer;
  const observers = [];
  const badgeRetries = new Set();
  const badgeListeners = [];
  let disposed = false;
  let sizeFrame;
  const sizeToTabs = () => {
    cancelAnimationFrame(sizeFrame);
    sizeFrame = requestAnimationFrame(() => {
      if (disposed || !dialog.open) return;
      const css = getComputedStyle(tabs), shell = getComputedStyle(tabs.parentElement), border = getComputedStyle(dialog);
      const number = value => parseFloat(value) || 0;
      const width = [...tabs.children].reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0)
        + Math.max(0, tabs.children.length - 1) * number(css.columnGap)
        + number(css.paddingLeft) + number(css.paddingRight)
        + number(shell.paddingLeft) + number(shell.paddingRight)
        + number(border.borderLeftWidth) + number(border.borderRightWidth);
      dialog.style.width = `${Math.ceil(width)}px`;
    });
  };
  const tabObserver = new ResizeObserver(sizeToTabs);
  tabObserver.observe(tabs);
  const updateSelection = () => {
    const visible = visibleEntries.find(entry => entry.trainer.id === selected);
    next.disabled = !visible;
    for (const row of list.querySelectorAll('.trainer-option')) row.setAttribute('aria-selected', String(row.dataset.trainerId === selected));
  };
  const portrait = (trainer) => {
    const frame = element('div', 'trainer-portrait-frame');
    const participants = trainerPortraitParticipants(trainer);
    if (participants.length) {
      frame.classList.add('trainer-portrait-participants');
      frame.setAttribute('role', 'group');
      frame.setAttribute('aria-label', 'Trainer portraits');
      for (const participant of participants) {
        const child = portrait(participant);
        child.title = participant.displayName;
        frame.append(child);
      }
      return frame;
    }
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
      frame.append(element('span', 'trainer-sprite-missing', trainerPortraitFallback(trainer)));
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
    search.value = ''; clearTimeout(searchTimer);
    renderEntries((groups[index]?.trainers || []).map(trainer => ({ trainer, splitId: groups[index].id })), index);
  }
  function renderEntries(entries, activeSplit = null) {
    visibleEntries = entries;
    for (const observer of observers.splice(0)) observer.disconnect();
    for (const [i, tab] of [...tabs.children].entries()) { tab.setAttribute('aria-selected', String(i === activeSplit)); tab.tabIndex = i === (activeSplit ?? groupIndex) ? 0 : -1; }
    list.replaceChildren(); list.scrollTop = 0;
    if (activeSplit === null) { list.removeAttribute('aria-labelledby'); list.setAttribute('aria-label', 'Game-wide trainer search results'); }
    else { list.removeAttribute('aria-label'); list.setAttribute('aria-labelledby', `trainer-split-${activeSplit}`); }
    if (!entries.length) list.append(element('p', 'muted trainer-search-empty', 'No trainers match your search.'));
    for (const { trainer, splitId } of entries) {
      const row = element('div', 'trainer-option'); row.tabIndex = 0; row.setAttribute('role', 'option'); row.dataset.trainerId = trainer.id;
      const requirement = trainerRequirement(dataset, trainer, splitId); row.dataset.requirement = requirement;
      const requirementLabel = requirement === 'unknown' ? 'Requirement unspecified' : requirement === 'required' ? 'Required' : 'Optional';
      row.setAttribute('aria-label', `${displayTrainerName(trainer.displayName || trainer.name, dataset.gameId)} · ${requirementLabel}`);
      row.title = requirementLabel;
      let blocks;
      try { blocks = trainerDisplayBlocks(dataset, trainer); } catch { blocks = []; }
      for (const block of blocks) {
        const section = element('div', 'trainer-block'); section.dataset.ownerTrainerId = block.trainer.id;
        const heading = element('div', 'trainer-heading');
        heading.append(element('h3', 'trainer-name', displayTrainerName(block.trainer.displayName || block.trainer.name, dataset.gameId)),
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
      if (!blocks.length) row.append(element('h3', 'trainer-name', displayTrainerName(trainer.displayName || trainer.name, dataset.gameId)));
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
    tab.setAttribute('aria-label', group.label); tab.title = group.label;
    const query = trainerSplitBadgeQuery(dataset.gameId, group);
    if (query) {
      const image = splitIconImage(resolver, query);
      const label = element('span', 'trainer-split-loading-label', group.label.replace(/\s+Split$/iu, ''));
      tab.classList.add('has-badge', 'badge-loading'); tab.replaceChildren(image, label);
      tab.dataset.badgeStatus = 'loading';
      let retried = false, retryPending = false, loadTimer;
      const clearDeadline = () => { clearTimeout(loadTimer); badgeRetries.delete(loadTimer); };
      const missing = () => {
        if (disposed || retryPending) return;
        clearDeadline();
        if (!retried) {
          retried = true; retryPending = true;
          const timer = setTimeout(() => {
            badgeRetries.delete(timer); retryPending = false;
            if (disposed) return;
            image.removeAttribute('src'); loadBadge();
          }, 300);
          badgeRetries.add(timer);
          return;
        }
        tab.classList.remove('has-badge', 'badge-loading'); tab.textContent = group.label;
        tab.dataset.badgeStatus = 'unavailable'; sizeToTabs();
      };
      const loaded = () => {
        if (disposed) return;
        clearDeadline(); image.hidden = false; tab.replaceChildren(image);
        tab.classList.add('has-badge'); tab.classList.remove('badge-loading');
        tab.dataset.badgeStatus = 'loaded';
        sizeToTabs();
      };
      image.addEventListener('load', loaded);
      image.addEventListener('error', missing);
      badgeListeners.push(() => {
        image.removeEventListener('load', loaded); image.removeEventListener('error', missing);
        image.onerror = null;
      });
      function loadBadge() {
        loadTimer = setTimeout(missing, 8000); badgeRetries.add(loadTimer);
        // A same-URL image retry can rejoin the stalled browser request. The
        // shared API's equivalent selector gives this one retry a
        // separate request without changing the requested asset or release.
        const request = { ...query };
        if (retried && request.kind === 'badge-icon') { request.badgeId = request.badge; delete request.badge; }
        if (retried && request.kind === 'item-sprite') { request.itemId = request.item; delete request.item; }
        if (retried && request.kind === 'pokemon-sprite') { request.name = request.species; delete request.species; }
        if (resolver.setAssetImage) resolver.setAssetImage(image, request, { onUnavailable: missing });
        else Promise.resolve(resolver.resolveAsset(request)).then(result => { if (result.status === 'ok') image.src = result.url; else missing(); }).catch(missing);
      }
      if (image.complete && image.naturalWidth > 0) loaded();
      else if (!image.getAttribute('src') || image.complete) loadBadge();
      else { loadTimer = setTimeout(missing, 8000); badgeRetries.add(loadTimer); }
    } else tab.dataset.badgeStatus = 'unavailable';
    tab.onclick = () => renderGroup(index);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length;
      renderGroup(nextIndex); tabs.children[nextIndex].focus();
    };
    return tab;
  }));
  next.onclick = () => { if (!next.disabled) onContinue(selected); };
  search.oninput = () => {
    clearTimeout(searchTimer); selected = null; next.disabled = true;
    searchTimer = setTimeout(() => {
      if (search.value.trim()) renderEntries(searchTrainerIndex(searchIndex, search.value));
      else renderGroup(groupIndex);
    }, 120);
  };
  search.onkeydown = event => {
    // Enter in this form must not submit/close the selector.
    if (event.key === 'Enter') event.preventDefault();
    if (event.key === 'ArrowUp') { event.preventDefault(); list.querySelector('.trainer-option')?.focus(); }
  };
  renderGroup(0);
  sizeToTabs();
  return { dispose() { disposed = true; clearTimeout(searchTimer); search.oninput = null; search.onkeydown = null; for (const timer of badgeRetries) clearTimeout(timer); for (const cleanup of badgeListeners) cleanup(); cancelAnimationFrame(sizeFrame); tabObserver.disconnect(); for (const observer of observers) observer.disconnect(); next.onclick = null; } };
}
