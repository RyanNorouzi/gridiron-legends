/**
 * Statistical simulation: the fast play executor (AI-vs-AI league games, sim-to-end, skipped plays), the
 * whole-game driver on top of GameController and the watch-mode controls.
 */
export { simulatePlay } from './fast-sim';
export { simulateSpecialTeams } from './special-teams-sim';
export { buildMatchups, conceptModifiers, routeInfo, carrierPowerOf, tacklePowerOf, openFieldOf, returnerScore, separationYards } from './matchups';
export type { Matchups, MatchupKnobs, RatedPlayer, ReceiverOption, ConceptModifiers } from './matchups';
export { knobsFor, resolveScrimmagePlay, resolveKneel, resolveSpike, rpoThrows, isScrimmageContext } from './play-model';
export type { ModelKnobs, PlayResolution, RunResolution, PassResolution, KneelResolution, SpikeResolution, TackleInfo, FumbleInfo, SackInfo, InterceptionInfo } from './play-model';
export { resolveRun, FUMBLE_PER_CARRY } from './run-model';
export type { RunOptions } from './run-model';
export { resolvePass, FUMBLE_PER_RECEPTION } from './pass-model';
export type { PassOptions } from './pass-model';
export { simulateGame, simulateGames, simulateToEnd, quickSetup, setupTeamIds, playbookRegistries } from './game-sim';
export type { SimulateGameOptions, GameSimResult, GameResultSummary, QuickSetupOptions } from './game-sim';
export { defaultPlaycaller, fourthDownChoice, shouldGoForTwo, shouldOnside, situationOf, FG_TRUST_BALL_ON, FG_DESPERATE_BALL_ON } from './playcaller';
export type { Playcaller, FourthDownChoice } from './playcaller';
export { createWatchMode, isJumpInMoment, describeGameSituation, jumpInRole, SIM_SPEEDS } from './watch-mode';
export type { WatchMode, WatchModeOptions, PromptPolicy } from './watch-mode';
export { isHurryUp, presnapSeconds } from './sim-support';
