/**
 * Main-menu mode wiring of the app shell. Every mode lives in a lazily loaded bundle (lazy/*-bundle.ts) so the
 * boot chunk holds only the shell, menus, settings, input, rendering, audio and saves: Quick Game / Watch /
 * Custom Game load the game bundle (engine, AI, sim, Game screen, replays), Franchise / Season / Playoffs the
 * franchise bundle, Practice / Tutorial the practice bundle. The AI deciders register when a bundle that plays
 * games arrives. Franchise saves go through the one shared save system (autosaved by the hub).
 */
import type { AudioManager } from '@/audio/index';
import type { Settings } from '@/core/settings';
import type { GameSimulator } from '@/franchise/sim-seam';
import type { League } from '@/franchise/types';
import type { GameSetup, GameState } from '@/game/types';
import type { SaveSlotMeta, SaveSystem } from '@/save/index';
import type { GameSession } from './game/session-types';
import { lazyBundle, withBundle } from './lazy/loader';
import type { MainMenuActions } from './screens/main-menu';
import type { ScreenServices } from './screens/screen';
import type { TutorialProgressController } from './tutorial/progress';

/** The game bundle (loaded on first use). */
export const gameBundle = lazyBundle(() => import('./lazy/game-bundle'), (m) => m.ensureAiRegistered());
/** The franchise bundle. */
export const franchiseBundle = lazyBundle(() => import('./lazy/franchise-bundle'), (m) => m.ensureAiRegistered());
/** The practice / tutorial bundle. */
export const practiceBundle = lazyBundle(() => import('./lazy/practice-bundle'));

/** What the mode wiring needs from the shell. */
export interface ModeContext {
  services: ScreenServices;
  settings: Settings;
  audio: AudioManager | undefined;
  saves: SaveSystem;
  tutorialProgress: TutorialProgressController;
  openSettings(): void;
  /** Pops back to the main menu. */
  toMenu(): void;
  leagueSeed: number;
  /** Test / host override of the session factory (default: the game bundle's real executors). */
  createSession?: (setup: GameSetup) => GameSession;
  leagueSimulator?: GameSimulator;
}

/** The default main-menu actions over lazily loaded bundles. */
export const createModeActions = (ctx: ModeContext): MainMenuActions => {
  const { services, saves, settings } = ctx;
  const stack = services.stack;
  const toast = services.toast;
  const game = (use: (m: NonNullable<typeof gameBundle.loaded>) => void): void => withBundle(gameBundle, toast, use);
  const franchise = (use: (m: NonNullable<typeof franchiseBundle.loaded>) => void): void => withBundle(franchiseBundle, toast, use);
  const practice = (use: (m: NonNullable<typeof practiceBundle.loaded>) => void): void => withBundle(practiceBundle, toast, use);
  const leagueSim = ctx.leagueSimulator ? { simulator: ctx.leagueSimulator } : {};
  const sessionFor = ctx.createSession ? { createSession: ctx.createSession } : {};

  const openGame = (setup: GameSetup): void => game((m) => {
    const session = ctx.createSession ? ctx.createSession(setup) : m.createDefaultSession(setup, { settings, audio: ctx.audio });
    stack.push(new m.GameScreen(session, {
      onQuit: ctx.toMenu,
      onPlayAgain: () => {
        ctx.toMenu();
        openGame({ ...setup, seed: (setup.seed + 1) >>> 0 });
      },
      onSettings: ctx.openSettings,
    }));
  });
  const openPractice = (filter: 'offense' | 'defense' | null) => (): void => practice((m) => stack.push(new m.PracticeMenuScreen({ filter, onQuit: ctx.toMenu })));
  const openHub = (league: League, slot: string | null, resumeGame: GameState | null = null): void => franchise((m) => {
    ctx.toMenu();
    stack.push(new m.FranchiseHubScreen({ league, slot, saveSystem: slot ? saves : null, resumeGame, onSettings: ctx.openSettings, onExit: ctx.toMenu, ...sessionFor, ...leagueSim }));
  });
  const playoffsScreen = (league: League, slot: string | null, resumeGame: GameState | null = null): void => franchise((m) => {
    ctx.toMenu();
    stack.push(new m.PlayoffsModeScreen({ league, slot, saveSystem: slot ? saves : null, resumeGame, onExit: ctx.toMenu, onSettings: ctx.openSettings, ...sessionFor, ...leagueSim }));
  });
  /** Reopens a saved slot in its own mode (franchise hub, Season-mode hub or the Playoffs bracket). */
  const openSaved = (league: League, meta: SaveSlotMeta, game: GameState | null): void => {
    if (meta.mode === 'playoffs') playoffsScreen(league, meta.id, game);
    else if (meta.mode === 'season') franchise((m) => {
      ctx.toMenu();
      stack.push(m.createSeasonHub(league, { saves, onExit: ctx.toMenu, onSettings: ctx.openSettings, ...sessionFor, ...leagueSim }, meta.id, game));
    });
    else openHub(league, meta.id, game);
  };
  const loadSlot = (meta: SaveSlotMeta): void => franchise((m) => {
    void saves.slots.load(meta.id).then((loaded) => openSaved(loaded.league, loaded.meta, loaded.game)).catch((err: unknown) => toast(m.saveErrorText(err, 'Loading')));
  });
  const createFranchise = (league: League, name: string | null): void => franchise((m) => {
    void saves.slots.list()
      .then((metas) => saves.slots.save(m.nextSlotId(metas), league, null, name ? { name } : {}))
      .then((meta) => openHub(league, meta.id))
      .catch((err: unknown) => {
        toast(m.saveErrorText(err, 'Saving the new franchise'));
        openHub(league, null);
      });
  });
  return {
    quickGame: () => game((m) => stack.push(new m.QuickGameSetupScreen({ mode: 'play', onStart: openGame, leagueSeed: ctx.leagueSeed }))),
    watchMode: () => game((m) => stack.push(new m.QuickGameSetupScreen({ mode: 'watch', onStart: openGame, leagueSeed: ctx.leagueSeed }))),
    customGame: () => game((m) => stack.push(new m.CustomGameScreen({ onStart: openGame, leagueSeed: ctx.leagueSeed }))),
    settings: ctx.openSettings,
    practice: openPractice(null),
    offensePractice: openPractice('offense'),
    defensePractice: openPractice('defense'),
    tutorial: () => practice((m) => stack.push(new m.TutorialScreen({ progress: ctx.tutorialProgress, onExit: ctx.toMenu }))),
    franchise: () => franchise((m) => stack.push(new m.FranchiseMenuScreen({
      slots: saves.slots,
      onNew: () => stack.push(new m.NewFranchiseScreen({ mode: 'franchise', onCreate: createFranchise })),
      onLoadList: () => stack.push(new m.LoadFranchiseScreen({ slots: saves.slots, onLoad: (league, meta, game) => openSaved(league, meta, game ?? null) })),
      onContinue: loadSlot,
    }))),
    season: () => franchise((m) => { m.startSeasonMode(services, { saves, onExit: ctx.toMenu, onSettings: ctx.openSettings, ...sessionFor, ...leagueSim }); }),
    playoffs: () => franchise((m) => stack.push(new m.NewFranchiseScreen({
      mode: 'playoffs',
      onCreate: (league) => {
        const team = league.userTeamId ? league.teams[league.userTeamId] : undefined;
        void saves.slots.list()
          .then((metas) => saves.slots.save(m.nextSlotId(metas, 'playoffs'), league, null, { mode: 'playoffs', name: m.modeSaveName(team, league.year, 'playoffs') }))
          .then((meta) => playoffsScreen(league, meta.id))
          .catch((err: unknown) => {
            toast(m.saveErrorText(err, 'Saving the playoff run'));
            playoffsScreen(league, null);
          });
      },
    }))),
  };
};
