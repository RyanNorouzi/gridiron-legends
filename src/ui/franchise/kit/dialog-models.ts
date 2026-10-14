/**
 * Pure models behind the franchise dialogs (no drawing, no stack): a multi-field number/amount stepper for
 * contract offers, ticket prices and similar (min/max/step with a big step, values snapped to the step grid),
 * and an on-screen letter grid for typing names and abbreviations without a DOM text input.
 */
import { cycleIndex } from './list';

/* --------------------------------- stepper --------------------------------- */

/** One numeric field. */
export interface StepperSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  /** Small step (left/right). Must be > 0. */
  step: number;
  /** Large step (tab left/right); default 10 x step. */
  bigStep?: number;
  /** Initial value (snapped and clamped). */
  value: number;
  /** Display text for a value (default String). */
  format?(value: number): string;
}

/** Snaps `value` to the field's step grid (anchored at min) and clamps it into [min, max]. */
export const snapToStep = (value: number, spec: Pick<StepperSpec, 'min' | 'max' | 'step'>): number => {
  if (!(spec.step > 0)) throw new Error('snapToStep: step must be > 0');
  if (spec.max < spec.min) throw new Error('snapToStep: max < min');
  const v = Number.isFinite(value) ? value : spec.min;
  // The tiny nudge makes float midpoints (0.35 / 0.1 = 3.4999...) round half up like exact decimals.
  const snapped = spec.min + Math.round((v - spec.min) / spec.step + 1e-9) * spec.step;
  // Round away float noise from fractional steps (e.g. 0.1).
  const clean = Math.round(snapped * 1e6) / 1e6;
  return Math.max(spec.min, Math.min(spec.max, clean));
};

/** Stepper state for one or more fields; the focused field receives steps. */
export class StepperModel {
  readonly specs: readonly StepperSpec[];
  private readonly vals: number[];
  private focusIndex = 0;

  constructor(specs: readonly StepperSpec[]) {
    if (specs.length === 0) throw new Error('StepperModel: at least one field is required');
    this.specs = specs;
    this.vals = specs.map((s) => snapToStep(s.value, s));
  }

  get focus(): number { return this.focusIndex; }
  get focused(): StepperSpec { return this.specs[this.focusIndex] as StepperSpec; }

  /** Current value of a field by id (NaN for unknown ids). */
  value(id: string): number {
    const i = this.specs.findIndex((s) => s.id === id);
    return i < 0 ? Number.NaN : (this.vals[i] as number);
  }

  /** All values keyed by field id. */
  values(): Record<string, number> {
    return Object.fromEntries(this.specs.map((s, i) => [s.id, this.vals[i] as number]));
  }

  /** Display text of a field's value. */
  display(index: number): string {
    const spec = this.specs[index];
    if (!spec) return '';
    const v = this.vals[index] as number;
    return spec.format ? spec.format(v) : String(v);
  }

  /** Moves the focus between fields (wraps). */
  moveFocus(delta: number): boolean {
    const next = cycleIndex(this.focusIndex, delta, this.specs.length);
    const changed = next !== this.focusIndex;
    this.focusIndex = next;
    return changed;
  }

  /** Focuses a field by index. */
  setFocus(index: number): boolean {
    if (index < 0 || index >= this.specs.length) return false;
    this.focusIndex = index;
    return true;
  }

  /** Steps the focused field by `delta` small (or big) steps; true when the value changed. */
  step(delta: number, big = false): boolean {
    const spec = this.focused;
    const size = big ? (spec.bigStep ?? spec.step * 10) : spec.step;
    return this.setValue(spec.id, (this.vals[this.focusIndex] as number) + delta * size);
  }

  /** Sets a field (snapped + clamped); true when it changed. */
  setValue(id: string, value: number): boolean {
    const i = this.specs.findIndex((s) => s.id === id);
    const spec = this.specs[i];
    if (!spec) return false;
    const next = snapToStep(value, spec);
    if (next === this.vals[i]) return false;
    this.vals[i] = next;
    return true;
  }

  atMin(index = this.focusIndex): boolean {
    return (this.vals[index] as number) <= (this.specs[index] as StepperSpec).min;
  }

  atMax(index = this.focusIndex): boolean {
    return (this.vals[index] as number) >= (this.specs[index] as StepperSpec).max;
  }
}

/* ------------------------------- letter grid ------------------------------- */

/** Special keys of the letter grid. */
export type SpecialKey = 'SPACE' | 'DEL' | 'OK';
/** A grid key: one character or a special key. */
export type GridKey = string;

/** Casing applied to typed letters: 'upper' (abbreviations) or 'title' (names: capital after start/space). */
export type GridCasing = 'upper' | 'title';

/** Options for a letter grid. */
export interface LetterGridOptions {
  initial?: string;
  maxLength: number;
  minLength?: number;
  /** Character rows; the special row (SPACE if allowed, DEL, OK) is appended. Default NAME_ROWS. */
  rows?: readonly string[];
  allowSpace?: boolean;
  casing?: GridCasing;
  /** Extra validation: error message or null when the text is acceptable. */
  validate?(text: string): string | null;
}

/** Letters, digits and name punctuation. */
export const NAME_ROWS: readonly string[] = ['ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ', "0123456789.-'"];
/** Letters only (team abbreviations). */
export const ABBR_ROWS: readonly string[] = ['ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ'];

/** Result of pressing the focused key. */
export type GridPress = 'typed' | 'deleted' | 'submit' | 'full' | 'invalid' | 'none';

/** On-screen keyboard state: the typed text, the cursor key and validation. */
export class LetterGridModel {
  readonly keys: readonly (readonly GridKey[])[];
  private readonly opts: LetterGridOptions;
  private value: string;
  private r = 0;
  private c = 0;

  constructor(opts: LetterGridOptions) {
    this.opts = opts;
    const rows = (opts.rows ?? NAME_ROWS).map((row) => Array.from(row));
    const special: GridKey[] = [...((opts.allowSpace ?? true) ? ['SPACE'] : []), 'DEL', 'OK'];
    this.keys = [...rows, special];
    this.value = '';
    for (const ch of Array.from(opts.initial ?? '')) this.type(ch);
  }

  get text(): string { return this.value; }
  get row(): number { return this.r; }
  get col(): number { return this.c; }
  get key(): GridKey { return this.keys[this.r]?.[this.c] ?? 'OK'; }
  get maxLength(): number { return this.opts.maxLength; }

  /** Validation error for the current text, or null when it can be submitted. */
  get error(): string | null {
    const min = this.opts.minLength ?? 1;
    if (this.value.trim().length < min) return min <= 1 ? 'Enter a name' : `At least ${min} characters`;
    return this.opts.validate?.(this.value) ?? null;
  }

  get canSubmit(): boolean {
    return this.error === null;
  }

  /** Moves the cursor (wraps in both axes; the column is clamped when rows differ in length). */
  move(dx: number, dy: number): void {
    if (dy !== 0) {
      this.r = cycleIndex(this.r, dy, this.keys.length);
      this.c = Math.min(this.c, (this.keys[this.r]?.length ?? 1) - 1);
    }
    if (dx !== 0) this.c = cycleIndex(this.c, dx, this.keys[this.r]?.length ?? 1);
  }

  /** Puts the cursor on a key; false when out of range. */
  focus(row: number, col: number): boolean {
    if (!this.keys[row]?.[col]) return false;
    this.r = row;
    this.c = col;
    return true;
  }

  /** Types one character (casing and allowed set applied); false when full or not allowed. */
  type(ch: string): boolean {
    if (this.value.length >= this.opts.maxLength) return false;
    if (ch === ' ') {
      if (!(this.opts.allowSpace ?? true) || this.value.length === 0 || this.value.endsWith(' ')) return false;
      this.value += ' ';
      return true;
    }
    const upper = ch.toUpperCase();
    if (!this.keys.some((row) => row.includes(upper))) return false;
    const title = (this.opts.casing ?? 'title') === 'title';
    const startOfWord = this.value.length === 0 || /[\s\-.']$/.test(this.value);
    this.value += title && !startOfWord ? upper.toLowerCase() : upper;
    return true;
  }

  /** Deletes the last character; false when empty. */
  backspace(): boolean {
    if (this.value.length === 0) return false;
    this.value = this.value.slice(0, -1);
    return true;
  }

  /** Presses the focused key. */
  press(): GridPress {
    const key = this.key;
    if (key === 'OK') return this.canSubmit ? 'submit' : 'invalid';
    if (key === 'DEL') return this.backspace() ? 'deleted' : 'none';
    if (this.value.length >= this.opts.maxLength) return 'full';
    return this.type(key === 'SPACE' ? ' ' : key) ? 'typed' : 'none';
  }

  /** Final text (trimmed) for submission. */
  result(): string {
    return this.value.trim();
  }
}
