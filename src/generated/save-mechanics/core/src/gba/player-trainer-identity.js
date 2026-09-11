import { asBytes, readUint16LE } from "../binary/little-endian.js";
import { createPlayerTrainerIdentity } from "../contracts/player-trainer-identity.js";

export function readGbaPlayerTrainerIdentity(value, offset = 0x0a) {
  const saveBlock2 = asBytes(value, { label: "GBA save block 2" });
  return createPlayerTrainerIdentity({
    trainerId: readUint16LE(saveBlock2, offset),
    secretId: readUint16LE(saveBlock2, offset + 2),
  });
}
