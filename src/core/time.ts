/** Simulation timing constants. The simulation runs on a fixed timestep. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** Max sim ticks processed per animation frame to prevent spiral-of-death. */
export const MAX_TICKS_PER_FRAME = 6;

export const secondsToTicks = (s: number): number => Math.round(s * TICK_RATE);
export const ticksToSeconds = (t: number): number => t / TICK_RATE;

/** Format seconds as M:SS (e.g. 125 -> "2:05"). Sub-minute shows tenths when under 10s if `tenths`. */
export const formatClock = (seconds: number, tenths = false): string => {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (tenths && s < 10) return `${rem.toFixed(1)}`;
  const whole = Math.ceil(rem);
  return whole === 60 ? `${m + 1}:00` : `${m}:${whole.toString().padStart(2, '0')}`;
};
