import { canonicalStats, nowIso, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { isHiddenPowerType, resolvedHiddenPowerType } from "../core/hidden_power.js?v=20260905-drafts-freecalc-partners-v1";
import { normalizeBoxPokemon } from "./library.js?v=20260905-drafts-freecalc-partners-v1";

const STAT_ALIASES = Object.freeze({
  hp: "hp", atk: "atk", attack: "atk", def: "def", defense: "def",
  spa: "spa", spatk: "spa", specialattack: "spa",
  spd: "spd", spdef: "spd", specialdefense: "spd",
  spe: "spe", speed: "spe"
});

function statId(value) {
  return STAT_ALIASES[toId(value)] || null;
}

function parseStats(value, fallback) {
  const output = canonicalStats({}, fallback);
  for (const part of String(value || "").split("/")) {
    const match = part.trim().match(/^(\d+)\s+(.+)$/);
    const stat = match ? statId(match[2]) : null;
    if (stat) output[stat] = Number(match[1]);
  }
  return output;
}

function firstLine(value) {
  let line = String(value || "").trim();
  let item = "";
  const itemAt = line.lastIndexOf(" @ ");
  if (itemAt >= 0) {
    item = line.slice(itemAt + 3).trim();
    line = line.slice(0, itemAt).trim();
  }
  let gender = null;
  const genderMatch = line.match(/\s+\(([MF])\)$/i);
  if (genderMatch) {
    gender = genderMatch[1].toUpperCase();
    line = line.slice(0, genderMatch.index).trim();
  }
  let nickname = "";
  let species = line;
  const speciesMatch = line.match(/^(.*?)\s+\(([^()]+)\)$/);
  if (speciesMatch) {
    nickname = speciesMatch[1].trim();
    species = speciesMatch[2].trim();
  }
  return { nickname, species, gender, item };
}

function datasetRecord(dataset, kind, value, label, { optional = false } = {}) {
  const id = toId(value);
  if (!id && optional) return null;
  const record = dataset.get(kind, id);
  if (!record) throw new Error(`${label} ${value || "(blank)"} is unavailable for ${dataset.displayName}`);
  return record;
}

function parseBlock(block, dataset, index) {
  const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const header = firstLine(lines.shift());
  const species = datasetRecord(dataset, "species", header.species, "Species");
  let level = 100;
  let gender = header.gender;
  let ability = null;
  let item = header.item ? datasetRecord(dataset, "items", header.item, "Item") : null;
  let nature = null;
  let ivs = canonicalStats({}, 31);
  let evs = canonicalStats({}, 0);
  let hiddenPowerTypeOverride = null;
  const moves = [];
  for (const line of lines) {
    if (/^Ability\s*:/i.test(line)) ability = datasetRecord(dataset, "abilities", line.replace(/^Ability\s*:/i, "").trim(), "Ability");
    else if (/^Level\s*:/i.test(line)) level = Number(line.replace(/^Level\s*:/i, "").trim());
    else if (/^Gender\s*:/i.test(line)) gender = line.replace(/^Gender\s*:/i, "").trim().toUpperCase().slice(0, 1);
    else if (/^EVs\s*:/i.test(line)) evs = parseStats(line.replace(/^EVs\s*:/i, ""), 0);
    else if (/^IVs\s*:/i.test(line)) ivs = parseStats(line.replace(/^IVs\s*:/i, ""), 31);
    else if (/ Nature$/i.test(line)) nature = datasetRecord(dataset, "natures", line.replace(/ Nature$/i, "").trim(), "Nature");
    else if (/^[-–]\s*/.test(line)) {
      const rawMove = line.replace(/^[-–]\s*/, "").trim();
      const hiddenPowerMatch = rawMove.match(/^Hidden Power\s*\[([^\]]+)\]$/i);
      if (hiddenPowerMatch) {
        hiddenPowerTypeOverride = toId(hiddenPowerMatch[1]);
        if (!isHiddenPowerType(hiddenPowerTypeOverride)) throw new Error(`${hiddenPowerMatch[1]} is not a valid Hidden Power type`);
      }
      const moveName = hiddenPowerMatch ? "Hidden Power" : rawMove.replace(/\s*\[[^\]]+\]\s*$/, "").trim();
      const move = datasetRecord(dataset, "moves", moveName, "Move");
      const type = move.id === "hiddenpower" && hiddenPowerTypeOverride ? hiddenPowerTypeOverride : move.type;
      if (moves.length < 4) moves.push({ moveId: move.id, name: move.name, type, basePower: Number(move.basePower || 0), pp: Number(move.pp || 0) });
    }
  }
  if (!nature) nature = datasetRecord(dataset, "natures", "Serious", "Nature");
  if (!ability) {
    const abilityId = species.abilities?.[0];
    ability = datasetRecord(dataset, "abilities", abilityId, "Ability");
  }
  return normalizeBoxPokemon({
    id: `pokemon-showdown-${Date.now().toString(36)}-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    speciesId: species.id,
    displayName: species.name,
    nickname: header.nickname,
    level,
    gender: ["M", "F", "N"].includes(gender) ? gender : null,
    natureId: nature.id,
    abilityId: ability.id,
    itemId: item?.id || null,
    hiddenPowerTypeOverride,
    baseStats: species.baseStats,
    ivs,
    evs,
    moves,
    source: { kind: "showdown-import", importedAt: nowIso() }
  });
}

export function parseShowdown(text, dataset) {
  const blocks = String(text || "").trim().split(/\r?\n\s*\r?\n+/).filter(block => block.trim());
  if (!blocks.length) throw new Error("Paste at least one Showdown Pokémon set");
  const records = blocks.map((block, index) => parseBlock(block, dataset, index)).filter(Boolean);
  if (!records.length) throw new Error("No Pokémon could be read from the Showdown text");
  return records;
}

function statsLine(label, stats, fallback) {
  const names = { hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" };
  const values = Object.entries(stats || {}).filter(([, value]) => Number(value) !== fallback).map(([stat, value]) => `${value} ${names[stat]}`);
  return values.length ? `${label}: ${values.join(" / ")}` : null;
}

export function exportShowdown(records, dataset) {
  return (records || []).map(record => {
    const species = dataset.get("species", record.speciesId);
    const nature = dataset.get("natures", record.natureId);
    const ability = dataset.get("abilities", record.abilityId);
    const item = record.itemId ? dataset.get("items", record.itemId) : null;
    const name = record.nickname ? `${record.nickname} (${species?.name || record.displayName})` : species?.name || record.displayName;
    const gender = record.gender === "M" || record.gender === "F" ? ` (${record.gender})` : "";
    const lines = [`${name}${gender}${item ? ` @ ${item.name}` : ""}`];
    if (ability) lines.push(`Ability: ${ability.name}`);
    lines.push(`Level: ${record.level}`);
    const evs = statsLine("EVs", record.evs, 0);
    const ivs = statsLine("IVs", record.ivs, 31);
    if (evs) lines.push(evs);
    if (ivs) lines.push(ivs);
    if (nature) lines.push(`${nature.name} Nature`);
    const hasHiddenPower = (record.moves || []).some(moveEntry => moveEntry.moveId === "hiddenpower");
    const hiddenPowerType = hasHiddenPower
      ? resolvedHiddenPowerType(record.ivs, record.hiddenPowerTypeOverride, { generation: dataset.mechanics.damageGeneration })
      : null;
    for (const moveEntry of record.moves || []) {
      const moveName = dataset.get("moves", moveEntry.moveId)?.name || moveEntry.name;
      lines.push(moveEntry.moveId === "hiddenpower" ? `- ${moveName} [${dataset.get("types", hiddenPowerType)?.name || hiddenPowerType}]` : `- ${moveName}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}
