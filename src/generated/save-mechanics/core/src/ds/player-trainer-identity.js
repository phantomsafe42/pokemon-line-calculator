import { asBytes, readUint16LE } from "../binary/little-endian.js";
import { createPlayerTrainerIdentity } from "../contracts/player-trainer-identity.js";
import { DS_SAVE_LAYOUTS } from "./layouts/index.js";

export function readDsPlayerTrainerIdentity(value, formatId, selection) {
  const bytes = asBytes(value, { label: `${formatId} save` });
  const layout = DS_SAVE_LAYOUTS[formatId];
  if (!layout) throw new Error(`Unsupported DS save layout: ${formatId}`);
  const selectedBaseOffset = layout.generation === 4
    ? selection?.smallBlockOffset
    : selection?.blockOffset;
  if (!Number.isSafeInteger(selectedBaseOffset) || selectedBaseOffset < 0) {
    throw new Error(`${formatId} player trainer identity requires a selected save block`);
  }
  const offset = selectedBaseOffset + layout.playerTrainerIdentityOffset;
  return createPlayerTrainerIdentity({
    trainerId: readUint16LE(bytes, offset),
    secretId: readUint16LE(bytes, offset + 2),
  });
}
