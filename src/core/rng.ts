/**
 * Deterministic seeded random number generator (xoshiro128**).
 * Every source of randomness in the simulation MUST flow through an Rng
 * instance so games, seasons and replays are reproducible from a seed.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Random element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights need not be normalised. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Approximately normal sample via Box-Muller. */
  gaussian(mean?: number, stdDev?: number): number;
  /** Fisher-Yates shuffle returning a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Fork a child generator deterministically derived from this one. */
  fork(label?: string): Rng;
  /** Serialisable internal state. */
  getState(): RngState;
  setState(state: RngState): void;
  readonly seed: number;
}

export type RngState = [number, number, number, number];

const hashString = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

const splitmix32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
};

class Xoshiro128 implements Rng {
  private s: RngState;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const sm = splitmix32(this.seed);
    this.s = [sm(), sm(), sm(), sm()];
    if (this.s.every((v) => v === 0)) this.s = [1, 2, 3, 4];
  }

  private nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  next(): number {
    return this.nextU32() / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length - 1)] as T;
  }
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('Rng.weighted: empty array');
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i] ?? 0);
      if (r < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }
  gaussian(mean = 0, stdDev = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
  fork(label = ''): Rng {
    return new Xoshiro128((this.nextU32() ^ hashString(label)) >>> 0);
  }
  getState(): RngState {
    return [...this.s] as RngState;
  }
  setState(state: RngState): void {
    this.s = [...state] as RngState;
  }
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export const createRng = (seed: number | string): Rng =>
  new Xoshiro128(typeof seed === 'string' ? hashString(seed) : seed);

export const restoreRng = (seed: number, state: RngState): Rng => {
  const r = new Xoshiro128(seed);
  r.setState(state);
  return r;
};
