/**
 * Hold-vs-toggle for held actions (accessibility): with toggle on, a press of a latched action (sprint) switches
 * it on until the next press or the end of the play, instead of having to be held. `apply` rewrites the
 * InputState's `down` set; everything else passes through untouched.
 */
import type { Action, InputState } from './types';

/** Actions that can be latched: the offense and defense sprint buttons. */
export const TOGGLE_ACTIONS: readonly Action[] = ['sprint', 'defSprint'];

export class ToggleLatch {
  private readonly on = new Set<Action>();

  constructor(private readonly actions: readonly Action[] = TOGGLE_ACTIONS) {}

  /** True while `action` is latched on. */
  isOn(action: Action): boolean {
    return this.on.has(action);
  }

  /** The input with latched actions held down (and their physical hold ignored). */
  apply(input: InputState): InputState {
    let touched = false;
    for (const a of this.actions) {
      if (input.justPressed.has(a)) {
        if (this.on.has(a)) this.on.delete(a);
        else this.on.add(a);
      }
      if (input.down.has(a) || this.on.has(a)) touched = true;
    }
    if (!touched) return input;
    const down = new Set(input.down);
    for (const a of this.actions) {
      if (this.on.has(a)) down.add(a);
      else down.delete(a);
    }
    return { ...input, down };
  }

  /** Releases every latch (between plays). */
  reset(): void {
    this.on.clear();
  }
}
