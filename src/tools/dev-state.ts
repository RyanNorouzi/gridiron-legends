/**
 * Developer-mode state: which debug overlays are drawn and which cheats are on, plus the gate that decides whether
 * developer mode exists at all (Settings.devMode, or `?dev=1` in the page URL read through an injectable location
 * reader). Everything here is a pure reducer over an immutable DevState; a disabled state ignores every change, so
 * nothing downstream (console, overlays, engine hooks) can be switched on outside developer mode.
 */
import type { Settings } from '@/core/settings';
import type { DevHooks } from '@/game/engine-api';
import type { TeamSide } from '@/game/types';

/** A developer overlay drawn over the field. */
export type OverlayKind = 'hitboxes' | 'ids' | 'routes' | 'coverage' | 'ai' | 'attributes' | 'ball';

/** Every overlay, in menu / cycle order. */
export const OVERLAY_KINDS: readonly OverlayKind[] = ['hitboxes', 'ids', 'routes', 'coverage', 'ai', 'attributes', 'ball'];

/** Menu / toast names of the overlays. */
export const OVERLAY_LABELS: Readonly<Record<OverlayKind, string>> = {
  hitboxes: 'HITBOXES', ids: 'PLAYER IDS', routes: 'ROUTES', coverage: 'COVERAGE', ai: 'AI DECISIONS', attributes: 'ATTRIBUTES', ball: 'BALL PATH',
};

/**
 * What devOverlayCycle steps through: off, each overlay on its own, then everything. A custom mix (built in the
 * console) cycles back to off first.
 */
export const OVERLAY_CYCLE: readonly (readonly OverlayKind[])[] = [[], ...OVERLAY_KINDS.map((k) => [k]), OVERLAY_KINDS];

/** Cheat switches (the first three become DevHooks flags; fastSim drives the session). */
export interface DevCheats {
  /** The user's team cannot be tackled, fumble or be intercepted; its contests always win. */
  godMode: boolean;
  /** The user's team never tires and never runs out of burst. */
  infiniteStamina: boolean;
  /** Everyone not under human control stands still once the ball is live. */
  freezeAi: boolean;
  /** The session fast-sims every play until the current drive ends. */
  fastSim: boolean;
}

/** One of the DevCheats switches. */
export type CheatKey = keyof DevCheats;

/** Every cheat, in console order. */
export const CHEAT_KEYS: readonly CheatKey[] = ['godMode', 'infiniteStamina', 'freezeAi', 'fastSim'];

/** Console names of the cheats. */
export const CHEAT_LABELS: Readonly<Record<CheatKey, string>> = {
  godMode: 'GOD MODE', infiniteStamina: 'INFINITE STAMINA', freezeAi: 'FREEZE AI', fastSim: 'FAST SIM DRIVE',
};

/** Immutable developer-mode state (overlays + cheats). */
export interface DevState {
  /** False outside developer mode: every reducer is then a no-op. */
  readonly enabled: boolean;
  readonly overlays: ReadonlySet<OverlayKind>;
  readonly cheats: Readonly<DevCheats>;
}

const NO_CHEATS: Readonly<DevCheats> = Object.freeze({ godMode: false, infiniteStamina: false, freezeAi: false, fastSim: false });

/* ----------------------------------------- gate ----------------------------------------- */

/** Reads the page's query string; injectable so tests (and non-browser hosts) never touch `window`. */
export type LocationReader = () => string;

/** The real browser location's `search` ('' outside a browser). */
export const browserLocationSearch: LocationReader = () => {
  const loc = (globalThis as { location?: { search?: unknown } }).location;
  return typeof loc?.search === 'string' ? loc.search : '';
};

/** True when the query string carries `dev=1` (e.g. '?dev=1', '?team=3&dev=1'). */
export const hasDevQuery = (search: string): boolean => {
  const q = search.startsWith('?') ? search.slice(1) : search;
  if (q.length === 0) return false;
  return q.split('&').some((pair) => {
    const [k, v] = pair.split('=');
    return k === 'dev' && v === '1';
  });
};

/** Developer mode exists only when the setting is on or the URL asks for it. */
export const isDevModeEnabled = (settings: Pick<Settings, 'devMode'> | null | undefined, locationSearch: string | null | undefined): boolean =>
  settings?.devMode === true || hasDevQuery(locationSearch ?? '');

/* --------------------------------------- reducers --------------------------------------- */

/** Fresh state: no overlays, no cheats. */
export const createDevState = (enabled: boolean): DevState => ({ enabled, overlays: new Set(), cheats: { ...NO_CHEATS } });

/** Turning developer mode off also clears every overlay and cheat. */
export const setDevEnabled = (s: DevState, enabled: boolean): DevState => (enabled ? { ...s, enabled: true } : createDevState(false));

/** Replaces the overlay set. */
export const setOverlays = (s: DevState, kinds: Iterable<OverlayKind>): DevState => (s.enabled ? { ...s, overlays: new Set(kinds) } : s);

/** Flips one overlay on or off. */
export const toggleOverlay = (s: DevState, kind: OverlayKind): DevState => {
  if (!s.enabled) return s;
  const next = new Set(s.overlays);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return { ...s, overlays: next };
};

/** Index of the current overlay set in OVERLAY_CYCLE, or -1 for a custom mix. */
export const overlayCycleIndex = (s: DevState): number =>
  OVERLAY_CYCLE.findIndex((set) => set.length === s.overlays.size && set.every((k) => s.overlays.has(k)));

/** One devOverlayCycle press: the next preset in OVERLAY_CYCLE (a custom mix goes back to off). */
export const cycleOverlays = (s: DevState): DevState => {
  if (!s.enabled) return s;
  const next = OVERLAY_CYCLE[(overlayCycleIndex(s) + 1) % OVERLAY_CYCLE.length] ?? [];
  return setOverlays(s, next);
};

/** Sets one cheat (returns the same state when nothing changes). */
export const setCheat = (s: DevState, key: CheatKey, on: boolean): DevState =>
  (s.enabled && s.cheats[key] !== on ? { ...s, cheats: { ...s.cheats, [key]: on } } : s);

/** Flips one cheat. */
export const toggleCheat = (s: DevState, key: CheatKey): DevState => setCheat(s, key, !s.cheats[key]);

/** Short status text for the dev badge / toasts: 'OFF', 'ALL', one overlay's label, or 'CUSTOM (n)'. */
export const overlayLabel = (s: DevState): string => {
  const i = overlayCycleIndex(s);
  if (i === 0) return 'OFF';
  if (i === OVERLAY_CYCLE.length - 1) return 'ALL';
  const only = i > 0 ? OVERLAY_CYCLE[i]?.[0] : undefined;
  return only ? OVERLAY_LABELS[only] : `CUSTOM (${s.overlays.size})`;
};

/** Short tags of the active cheats, e.g. ['GOD', 'STAMINA']. */
export const cheatTags = (s: DevState): string[] => {
  const tags: string[] = [];
  if (s.cheats.godMode) tags.push('GOD');
  if (s.cheats.infiniteStamina) tags.push('STAMINA');
  if (s.cheats.freezeAi) tags.push('FREEZE');
  if (s.cheats.fastSim) tags.push('FAST SIM');
  return tags;
};

/* ------------------------------------- engine hooks ------------------------------------- */

/** Engine cheat flags for a dev state (all off when developer mode is disabled). */
export const hooksFor = (s: DevState, side: TeamSide | null = null): DevHooks => ({
  godMode: s.enabled && s.cheats.godMode,
  infiniteStamina: s.enabled && s.cheats.infiniteStamina,
  freezeAi: s.enabled && s.cheats.freezeAi,
  side,
});

/**
 * Copies the flags onto the hooks object shared with the live engines (they read it every tick). The command inbox
 * is kept, and emptied when developer mode is off.
 */
export const syncHooks = (target: DevHooks, s: DevState, side: TeamSide | null = null): DevHooks => {
  Object.assign(target, hooksFor(s, side));
  if (!target.commands) target.commands = [];
  if (!s.enabled) target.commands.length = 0;
  return target;
};
