/**
 * Game speed (Settings.gameSpeed, 0.5x .. 2x, default 1.25x = core/settings DEFAULT_GAME_SPEED): how many live-play
 * ticks run per loop tick. The loop stays at a fixed 60 Hz; at 0.5x every other loop tick runs no play tick, at 1.5x
 * every other one runs two. Game time per play tick is unchanged, so only the pacing on screen changes (the clock,
 * physics and AI see the same ticks). Button edges that arrive on a skipped tick are carried to the next play tick so
 * no press is lost, and a second play tick in the same loop tick sees the held buttons without repeating the edges.
 */
import type { Action, InputState } from '../input/types';

/** Accepted range of the speed multiplier. */
export const MIN_GAME_SPEED = 0.25;
export const MAX_GAME_SPEED = 3;

const EMPTY: ReadonlySet<Action> = new Set<Action>();

export class GameSpeedGate {
  private acc = 0;
  private carried: Set<Action> | null = null;
  private carriedUp: Set<Action> | null = null;

  /** Inputs for the play ticks to run this loop tick (possibly none) at `speed`. */
  step(speed: number, input: InputState): InputState[] {
    const s = Number.isFinite(speed) ? Math.max(MIN_GAME_SPEED, Math.min(MAX_GAME_SPEED, speed)) : 1;
    if (s === 1 && !this.carried) {
      this.acc = 0;
      return [input];
    }
    this.acc += s;
    const n = Math.floor(this.acc + 1e-9);
    this.acc -= n;
    if (n === 0) {
      this.carry(input);
      return [];
    }
    const first = this.carried ? this.merge(input) : input;
    this.carried = null;
    this.carriedUp = null;
    const out: InputState[] = [first];
    for (let i = 1; i < n; i++) out.push({ ...input, justPressed: EMPTY, justReleased: EMPTY, pointer: input.pointer ? { ...input.pointer, justDown: false, justUp: false } : null });
    return out;
  }

  /** Drops the carried edges and the fractional tick (a new play). */
  reset(): void {
    this.acc = 0;
    this.carried = null;
    this.carriedUp = null;
  }

  private carry(input: InputState): void {
    if (input.justPressed.size === 0 && input.justReleased.size === 0) return;
    this.carried ??= new Set();
    this.carriedUp ??= new Set();
    for (const a of input.justPressed) this.carried.add(a);
    for (const a of input.justReleased) this.carriedUp.add(a);
  }

  private merge(input: InputState): InputState {
    const pressed = new Set(this.carried ?? []);
    for (const a of input.justPressed) pressed.add(a);
    const released = new Set(this.carriedUp ?? []);
    for (const a of input.justReleased) released.add(a);
    return { ...input, justPressed: pressed, justReleased: released };
  }
}
