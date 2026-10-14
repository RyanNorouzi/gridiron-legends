/**
 * Franchise UI contracts. Every franchise screen receives a `FranchiseContext`: read the current League,
 * commit a new immutable League (with an autosave reason), fork deterministic RNGs, open player/team views,
 * toast, and push/pop screens. The hub is a list of `HubTab`s contributed by the team / market / league
 * chains (tabs-team.ts, tabs-market.ts, tabs-league.ts), grouped by `HubGroup`.
 *
 * `createFranchiseContext` is the production implementation over getter/setter deps (the hub owns the League
 * and wires `onCommit` to the autosaver); `createTestFranchiseContext` builds a headless one over a real
 * ScreenStack that records commits, toasts, pushes, pops and open requests for unit tests.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { restoreRng, type Rng } from '@/core/rng';
import type { Settings } from '@/core/settings';
import type { League } from '@/franchise/types';
import type { GameState } from '@/game/types';
import type { AutosaveReason } from '@/save/autosave';
import { defaultSettings } from '@/save/settings-store';
import { Camera } from '../camera';
import type { Action, InputManager, InputState } from '../input/types';
import { SpriteCache } from '../render/sprites';
import type { Screen, ScreenServices } from '../screens/screen';
import { ScreenStack } from '../screens/stack';
import { createTheme } from '../theme';
import type { Rect } from './kit/list';
import { TeamViewScreen } from './league/team-view';
import { PlayerCardScreen } from './player-card';

/** Why a League was committed: 'edit' (no autosave urgency) or an autosave reason. */
export type CommitReason = 'edit' | AutosaveReason;

/** Services every franchise screen gets. */
export interface FranchiseContext {
  /** The current League (immutable; never mutate it). */
  league(): League;
  /** Replaces the League. Non-'edit' reasons also mark the autosaver. */
  commit(next: League, reason: CommitReason): void;
  readonly userTeamId: TeamId;
  /**
   * Deterministic RNG for UI-initiated actions: forked from the League's current rng state, `label` and a
   * per-context counter (so two calls never share a stream). The League's rngState is NOT advanced; engine
   * functions that consume League randomness write their own rngState back into the League they return.
   */
  rng(label: string): Rng;
  /** Opens the player card (or the hub's player view). */
  openPlayer(id: PlayerId): void;
  /** Opens a team view. */
  openTeam(id: TeamId): void;
  toast(msg: string): void;
  services: ScreenServices;
  push(screen: Screen): void;
  pop(): void;
  /**
   * Area a hub tab's screen draws into (below the hub header and tab bar, above its hint bar). Screens pushed
   * full-screen with `push` (player card, dialogs, drill-downs) use the whole canvas instead.
   */
  contentRect(): Rect;
  /**
   * Stores the state of the user's live game with the League in the save slot after each play (null clears it once
   * the game is over), so a reload resumes that game at its score instead of replaying it. Optional: absent when
   * nothing is saved.
   */
  saveLiveGame?(state: Readonly<GameState> | null): void;
}

/** Hub tab groups, in display order. */
export type HubGroup = 'home' | 'team' | 'market' | 'league';
export const HUB_GROUPS: readonly HubGroup[] = ['home', 'team', 'market', 'league'];
/** Captions for the hub tab bar. */
export const HUB_GROUP_LABELS: Readonly<Record<HubGroup, string>> = Object.freeze({ home: 'Home', team: 'Team', market: 'Market', league: 'League' });

/**
 * A franchise hub tab. `create` builds the tab's content screen. The hub HOSTS it (it is not pushed on the
 * stack): the hub calls enter/update/render itself, draws it inside `fc.contentRect()`, and keeps
 * menuTabLeft/menuTabRight (tab switching) and 'back' (leave the hub) for itself, so tab screens should ignore
 * those two. Drill-down views are opened with `fc.push` / `fc.openPlayer` and close themselves with `fc.pop`.
 * Tab screens read `fc.league()` when building view-models and rebuild them after their own commits and in
 * `resume` (called by the hub when a pushed screen above it closes).
 */
export interface HubTab {
  /** Unique across all tab lists. */
  id: string;
  label: string;
  group: HubGroup;
  /** Hidden when false (e.g. Draft outside the draft phases). Default: always available. */
  available?(league: League): boolean;
  /** Short alert/count after the label ("3", "!"), or null. */
  badge?(league: League): string | null;
  create(fc: FranchiseContext): Screen;
}

/** Deterministic child RNG: League rng state + label + counter. Pure (the League is untouched). */
export const deriveRng = (league: Pick<League, 'rngSeed' | 'rngState'>, label: string, counter: number): Rng =>
  restoreRng(league.rngSeed, league.rngState).fork(`ui:${label}#${counter}`);

/** Dependencies of the production context. */
export interface FranchiseContextDeps {
  services: ScreenServices;
  getLeague(): League;
  setLeague(next: League): void;
  /** After every commit (the hub marks the autosaver for non-'edit' reasons). */
  onCommit?(next: League, reason: CommitReason): void;
  /** Default: the League's userTeamId (required then). */
  userTeamId?: TeamId;
  /** Default: push a read-only PlayerCardScreen. */
  openPlayer?(fc: FranchiseContext, id: PlayerId): void;
  /** Default: push the read-only TeamViewScreen (league/team-view.ts); unknown teams toast. */
  openTeam?(fc: FranchiseContext, id: TeamId): void;
  /** Hub content area; default the whole canvas. */
  contentRect?(): Rect;
  /** Receives the live game's state after each play (null when it ends); the owner saves it with the League. */
  onLiveGame?(state: Readonly<GameState> | null): void;
}

/** Builds the production FranchiseContext. Throws when no user team can be determined. */
export const createFranchiseContext = (deps: FranchiseContextDeps): FranchiseContext => {
  const userTeamId = deps.userTeamId ?? deps.getLeague().userTeamId;
  if (!userTeamId) throw new Error('createFranchiseContext: the league has no user team');
  let counter = 0;
  const fc: FranchiseContext = {
    league: () => deps.getLeague(),
    commit: (next, reason) => {
      if (!next || typeof next !== 'object' || !next.teams) throw new Error('FranchiseContext.commit: not a League');
      deps.setLeague(next);
      deps.onCommit?.(next, reason);
    },
    userTeamId,
    rng: (label) => deriveRng(deps.getLeague(), label, counter++),
    openPlayer: (id) => (deps.openPlayer ? deps.openPlayer(fc, id) : fc.push(new PlayerCardScreen(fc, id))),
    openTeam: (id) => {
      if (deps.openTeam) return deps.openTeam(fc, id);
      if (!deps.getLeague().teams[id]) return fc.toast('Unknown team');
      fc.push(new TeamViewScreen(fc, id));
    },
    toast: (msg) => deps.services.toast(msg),
    services: deps.services,
    push: (screen) => deps.services.stack.push(screen),
    pop: () => {
      deps.services.stack.pop();
    },
    contentRect: () => deps.contentRect?.() ?? { x: 0, y: 0, w: deps.services.width, h: deps.services.height },
  };
  const onLive = deps.onLiveGame;
  if (onLive) fc.saveLiveGame = (state) => onLive(state);
  return fc;
};

/* ------------------------------ headless testing ------------------------------ */

/** An InputState with nothing pressed. */
export const idleInput = (): InputState => ({
  axis: { x: 0, y: 0 }, down: new Set<Action>(), justPressed: new Set<Action>(), justReleased: new Set<Action>(), pointer: null, lastDevice: 'keyboard',
});

const nullInput = (): InputManager => {
  let scheme = {} as ReturnType<InputManager['getScheme']>;
  let deviceMap: ReturnType<InputManager['getDeviceMap']> = { keyboard: {}, mouse: {}, gamepadDeadzone: 0.2 };
  let last = idleInput();
  return {
    update: () => undefined,
    consumeTick: () => (last = idleInput()),
    state: () => last,
    setScheme: (s) => { scheme = s; },
    getScheme: () => scheme,
    setDeviceMap: (m) => { deviceMap = m; },
    getDeviceMap: () => deviceMap,
    isDown: () => false,
    justPressed: () => false,
    axis: () => ({ x: 0, y: 0 }),
    glyph: () => '?',
  };
};

/** Headless ScreenServices over a fresh ScreenStack (no fade). */
export const createHeadlessServices = (settingsOverride: Partial<Settings> = {}, toast: (msg: string) => void = () => undefined): ScreenServices => {
  const settings: Settings = { ...defaultSettings(), ...settingsOverride };
  const stack = new ScreenStack({ fadeSeconds: 0 });
  const services: ScreenServices = {
    stack, settings, theme: createTheme(settings), camera: new Camera(480, 270), input: nullInput(), sprites: new SpriteCache(),
    width: 480, height: 270, time: 0, toast,
  };
  stack.attach(services);
  return services;
};

/** Options for createTestFranchiseContext. */
export interface TestFranchiseContextOptions {
  /** Default: league.userTeamId. */
  userTeamId?: TeamId;
  settings?: Partial<Settings>;
  /** Push a real PlayerCardScreen on openPlayer (default false: only recorded). */
  openPlayerScreens?: boolean;
  /** Hub content area (default TEST_CONTENT_RECT). */
  contentRect?: Rect;
}

/** Content area used by test contexts: roughly the hub's area below a header and tab bar at normal text size. */
export const TEST_CONTENT_RECT: Readonly<Rect> = Object.freeze({ x: 0, y: 40, w: 480, h: 206 });

/** A FranchiseContext that records everything for assertions. */
export interface TestFranchiseContext extends FranchiseContext {
  readonly commits: { league: League; reason: CommitReason }[];
  readonly toasts: string[];
  readonly pushed: Screen[];
  readonly openedPlayers: PlayerId[];
  readonly openedTeams: TeamId[];
  readonly stack: ScreenStack;
  /** Number of pop() calls. */
  pops(): number;
  /** Runs one tick of input (default: idle) through the top screen. */
  tick(input?: InputState, dt?: number): void;
}

/** Headless FranchiseContext over `league` for unit tests. */
export const createTestFranchiseContext = (league: League, opts: TestFranchiseContextOptions = {}): TestFranchiseContext => {
  const toasts: string[] = [];
  const commits: { league: League; reason: CommitReason }[] = [];
  const pushed: Screen[] = [];
  const openedPlayers: PlayerId[] = [];
  const openedTeams: TeamId[] = [];
  let popCount = 0;
  let current = league;
  const services = createHeadlessServices(opts.settings, (msg) => toasts.push(msg));
  const base = createFranchiseContext({
    services,
    getLeague: () => current,
    setLeague: (next) => { current = next; },
    onCommit: (next, reason) => commits.push({ league: next, reason }),
    ...(opts.userTeamId ? { userTeamId: opts.userTeamId } : {}),
    openPlayer: (fc, id) => {
      openedPlayers.push(id);
      if (opts.openPlayerScreens) fc.push(new PlayerCardScreen(fc, id));
    },
    openTeam: (_fc, id) => { openedTeams.push(id); },
    contentRect: () => ({ ...(opts.contentRect ?? TEST_CONTENT_RECT) }),
  });
  const fc: TestFranchiseContext = Object.assign(base, {
    commits, toasts, pushed, openedPlayers, openedTeams, stack: services.stack,
    push: (screen: Screen) => {
      pushed.push(screen);
      services.stack.push(screen);
    },
    pop: () => {
      popCount++;
      services.stack.pop();
    },
    pops: () => popCount,
    tick: (input: InputState = idleInput(), dt = 1 / 60) => services.stack.update(dt, input),
  });
  return fc;
};
