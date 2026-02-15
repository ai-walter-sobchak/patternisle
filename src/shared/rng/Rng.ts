import { hash32 } from "./hash32";

export class Rng {
  private state: number;

  constructor(seed: string | number) {
    const s = typeof seed === "number" ? String(seed) : seed;
    this.state = hash32(s) || 0x12345678;
  }

  private nextU32(): number {
    // mulberry32
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  float(): number {
    return this.nextU32() / 0xffffffff;
  }

  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    const r = this.float();
    return Math.floor(r * (max - min + 1)) + min;
  }

  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  pick<T>(arr: T[]): T {
    if (arr.length === 0) throw new Error("pick() from empty array");
    return arr[this.int(0, arr.length - 1)];
  }

  shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
