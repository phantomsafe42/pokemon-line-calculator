const UINT16_MAX = 0xffff;

function requireUint16(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > UINT16_MAX) {
    throw new RangeError(`${label} must be an unsigned 16-bit integer`);
  }
  return normalized;
}

export function createPlayerTrainerIdentity({ trainerId, secretId }) {
  const normalizedTrainerId = requireUint16(trainerId, "trainerId");
  const normalizedSecretId = requireUint16(secretId, "secretId");
  return Object.freeze({
    trainerId: normalizedTrainerId,
    secretId: normalizedSecretId,
    trainerIdDisplay: String(normalizedTrainerId).padStart(5, "0"),
    secretIdDisplay: String(normalizedSecretId).padStart(5, "0"),
    fullId32: ((normalizedSecretId * 0x10000) + normalizedTrainerId) >>> 0,
  });
}
