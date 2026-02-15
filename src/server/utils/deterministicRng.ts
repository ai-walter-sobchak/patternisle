/**
 * Deterministic RNG for server-authoritative placement (e.g. shard pickups).
 * Same seed always produces the same sequence. Do not use Math.random for placement.
 *
 * Mulberry32: fast, minimal state, good enough distribution for game use.
 * See: https://github.com/bryc/code/junk/master/mulberry32.js
 */

export function createDeterministicRng(seed: number): () => number {
  return function rng(): number {
    let t = (seed += 0x6d2b79f5); // 32-bit mulberry constant
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
