import { decodeGen45Pokemon } from "../pokemon.js";

export function decodeGen4Pokemon(value, options = {}) {
  return decodeGen45Pokemon(value, { ...options, generation: 4 });
}
