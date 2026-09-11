import { decodeGen45Pokemon } from "../pokemon.js";

export function decodeGen5Pokemon(value, options = {}) {
  return decodeGen45Pokemon(value, { ...options, generation: 5 });
}
