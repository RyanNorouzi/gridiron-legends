/** Scalar math helpers. Pure. */
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const inverseLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v: number, inLo: number, inHi: number, outLo: number, outHi: number): number =>
  lerp(outLo, outHi, clamp01(inverseLerp(inLo, inHi, v)));
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const approach = (current: number, target: number, maxDelta: number): number => {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return target;
};
export const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const round = (v: number, decimals = 0): number => {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
};
/** Maps a 1-99 rating to a 0..1 factor with an optional curve exponent. */
export const ratingToFactor = (rating: number, exponent = 1): number => clamp01((rating - 1) / 98) ** exponent;
/** Logistic function centred at `mid` with steepness `k`. */
export const logistic = (x: number, mid = 0, k = 1): number => 1 / (1 + Math.exp(-k * (x - mid)));
export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
