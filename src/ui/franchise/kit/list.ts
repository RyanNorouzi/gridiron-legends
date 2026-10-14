/**
 * Small list helpers for franchise screens: stable sorting by a key, index cycling/clamping, a scroll window
 * that keeps a selection visible, hold-to-repeat for digital directions and filter-option cycling. Pure,
 * headless and shared by the DataTable, tab bar and dialogs.
 */
import type { Action, InputState } from '../../input/types';

/** Sort direction. */
export type SortDir = 'asc' | 'desc';

/** Comparable sort key. Strings compare case-insensitively; null/undefined always sort last. */
export type SortValue = number | string | null | undefined;

/** Compares two sort values ascending; nullish values go last regardless of direction handling upstream. */
export const compareValues = (a: SortValue, b: SortValue): number => {
  const an = a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a));
  const bn = b === null || b === undefined || (typeof b === 'number' && Number.isNaN(b));
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base', numeric: true });
};

/** Stable sort by `value`; nullish keys stay at the end in both directions. Returns a new array. */
export const sortRows = <R>(rows: readonly R[], value: (row: R) => SortValue, dir: SortDir = 'asc'): R[] => {
  const keyed = rows.map((row, i) => ({ row, i, v: value(row) }));
  keyed.sort((x, y) => {
    const xn = x.v === null || x.v === undefined;
    const yn = y.v === null || y.v === undefined;
    if (xn !== yn) return xn ? 1 : -1;
    const c = compareValues(x.v, y.v);
    return (dir === 'asc' ? c : -c) || x.i - y.i;
  });
  return keyed.map((k) => k.row);
};

/** Index moved by `delta` with wrap-around; -1 for an empty list. */
export const cycleIndex = (index: number, delta: number, length: number): number =>
  length <= 0 ? -1 : (((index + delta) % length) + length) % length;

/** Index clamped into [0, length-1]; -1 for an empty list. */
export const clampIndex = (index: number, length: number): number => (length <= 0 ? -1 : Math.max(0, Math.min(length - 1, index)));

/** Next/previous entry of `options` after `current` (wraps; unknown current starts from the first). */
export const cycleOption = <T>(options: readonly T[], current: T, delta: number): T => {
  if (options.length === 0) throw new Error('cycleOption: no options');
  const i = options.indexOf(current);
  return options[cycleIndex(i < 0 ? 0 : i, i < 0 ? 0 : delta, options.length)] as T;
};

/** Scroll offset that keeps `selected` inside a window of `visible` rows over `total` rows. */
export const scrollToShow = (scroll: number, selected: number, visible: number, total: number): number => {
  const v = Math.max(1, visible);
  let s = scroll;
  if (selected >= 0) {
    if (selected < s) s = selected;
    else if (selected >= s + v) s = selected - v + 1;
  }
  return Math.max(0, Math.min(s, Math.max(0, total - v)));
};

/** Groups items by key, preserving first-seen key order and item order. */
export const groupBy = <T, K extends string>(items: readonly T[], key: (item: T) => K): { key: K; items: T[] }[] => {
  const out: { key: K; items: T[] }[] = [];
  const index = new Map<K, number>();
  for (const item of items) {
    const k = key(item);
    let i = index.get(k);
    if (i === undefined) {
      i = out.length;
      index.set(k, i);
      out.push({ key: k, items: [] });
    }
    out[i]?.items.push(item);
  }
  return out;
};

/** True when any of the actions was pressed this tick. */
export const pressed = (input: InputState, actions: readonly Action[]): boolean => actions.some((a) => input.justPressed.has(a));
/** True when any of the actions is held. */
export const held = (input: InputState, actions: readonly Action[]): boolean => actions.some((a) => input.down.has(a));

/** Digital + analog direction on one axis, with MenuList-style hold-to-repeat. */
export class RepeatAxis {
  private timer = 0;
  private heldDir = 0;

  constructor(
    private readonly negative: readonly Action[],
    private readonly positive: readonly Action[],
    private readonly axis: 'x' | 'y',
    private readonly delay = 0.35,
    private readonly rate = 0.1,
  ) {}

  /** -1, 0 or +1 for this tick: fires on a press, then repeatedly while held. */
  step(dt: number, input: InputState): number {
    let dir = pressed(input, this.negative) ? -1 : pressed(input, this.positive) ? 1 : 0;
    const a = input.axis[this.axis];
    const hold = held(input, this.negative) ? -1 : held(input, this.positive) ? 1 : a < -0.5 ? -1 : a > 0.5 ? 1 : 0;
    if (hold !== 0 && hold === this.heldDir) {
      this.timer -= dt;
      if (this.timer <= 0) {
        dir = hold;
        this.timer = this.rate;
      }
    } else {
      this.timer = this.delay;
      if (hold !== 0 && dir === 0) dir = hold;
    }
    this.heldDir = hold;
    return dir;
  }
}

/** Vertical navigation actions (menu d-pad plus movement keys). */
export const UP_ACTIONS: readonly Action[] = ['menuUp', 'moveUp'];
export const DOWN_ACTIONS: readonly Action[] = ['menuDown', 'moveDown'];
export const LEFT_ACTIONS: readonly Action[] = ['menuLeft', 'moveLeft'];
export const RIGHT_ACTIONS: readonly Action[] = ['menuRight', 'moveRight'];
/**
 * The franchise UI's secondary button: the virtual gamepad's X (keyboard J by default), bound to the
 * `showPlayArt` action. Tables use it to flip the sort direction.
 */
export const SECONDARY_ACTIONS: readonly Action[] = ['showPlayArt'];
/** The franchise UI's tertiary button: the virtual gamepad's Y (keyboard I), bound to `audible`. */
export const TERTIARY_ACTIONS: readonly Action[] = ['audible'];

/** Axis-aligned rectangle in logical pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True when (x, y) lies inside the rectangle (right/bottom edges exclusive). */
export const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
