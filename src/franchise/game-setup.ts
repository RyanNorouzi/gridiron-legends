/**
 * League -> GameSetup. Resolves both teams' rosters, head coaches and playbooks (bundled data first, then
 * the League's custom content), the venue (home stadium; a neutral site for the two-conference
 * championship), weather (seeded per game when weather is enabled, clear otherwise), the ruleset with
 * the league's injury/fatigue toggles copied in, and a per-game seed derived from the League seed and the
 * game id, so the same game always simulates identically regardless of the order games are played.
 * Club effects: every dressed player is handed over with his morale/chemistry multiplier applied
 * (morale.ts moraleEffects/applyMoraleEffects on copies; League players are never mutated), and the
 * league's carried fatigue (League.fatigue) is passed as GameSetup.fatigue when fatigue is enabled, and the head
 * coach is handed over with the analytics department's game plan folded into his ratings (gameDayCoach).
 */
import type { PlayerId, StadiumId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import type { Player } from '@/players/types';
import { resolvePlaybook, type CustomPlaybookContent, type ResolvedPlaybook } from '@/playbook/loader';
import { DEFAULT_PLAYBOOK_ID } from '@/teams/league-generator';
import type { Coach, Stadium, Team } from '@/teams/types';
import { clearWeather, generateWeather } from '@/game/weather';
import type { ControllerKind, DifficultyProfile, GameSetup, GameTeamSetup, TeamSide, WeatherState } from '@/game/types';
import { leagueRuleset, leagueSimRuleset, scheduleWeekCount } from './settings';
import { isChampionshipRound } from './playoffs';
import { applyMoraleEffects, moraleEffects } from './morale';
import { facilityEffects } from './facilities';
import type { League, ScheduledGame } from './types';

/** Options for buildGameSetup. */
export interface BuildGameSetupOptions {
  /** Local viewer side; defaults to the user team's side when `controllers` marks it human, else null. */
  userSide?: TeamSide | null;
  /** Who decides for each side; defaults to AI for both (auto-sim). */
  controllers?: Record<TeamSide, ControllerKind>;
  /** Overrides the league difficulty (e.g. a per-game difficulty change). */
  difficulty?: DifficultyProfile;
  /** Overrides the generated weather. */
  weather?: WeatherState;
  /** Custom playbook content to resolve against instead of the League's custom* lists. */
  registries?: CustomPlaybookContent;
  /** Apply morale/chemistry multipliers to the dressed players (default true). */
  applyMorale?: boolean;
}

/** 32-bit seed for a game, stable for (league seed, game id). */
export const gameSeed = (league: Pick<League, 'rngSeed'>, gameId: string): number => createRng(`${league.rngSeed}:game:${gameId}`).int(1, 0x7fffffff);

/** Calendar week of the season used for climate bands (preseason early, playoffs after the regular season). */
export const calendarWeek = (league: Pick<League, 'settings'>, game: ScheduledGame): number => {
  if (game.isPreseason) return 1;
  if (game.isPlayoff) return scheduleWeekCount(league.settings) + (game.playoffRound ?? game.week);
  return game.week;
};

/** The League's custom playbook content in the loader's shape. */
export const customContent = (league: Pick<League, 'customPlaybooks' | 'customOffensePlays' | 'customDefensePlays'>): CustomPlaybookContent => ({
  playbooks: league.customPlaybooks,
  offense: league.customOffensePlays,
  defense: league.customDefensePlays,
});

/**
 * Neutral championship venue: a stadium belonging to neither finalist, preferring domes and warm
 * climates, rotating by year. Falls back to the home team's stadium when no other stadium exists.
 */
export const neutralSite = (league: Pick<League, 'stadiums' | 'teams'>, game: ScheduledGame, year: number): Stadium => {
  const excluded = new Set<StadiumId>([league.teams[game.home]?.stadiumId, league.teams[game.away]?.stadiumId].filter((s): s is StadiumId => !!s));
  const all = Object.values(league.stadiums).filter((s) => !excluded.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const preferred = all.filter((s) => s.roof !== 'open' || s.climate === 'warm' || s.climate === 'desert');
  const pool = preferred.length > 0 ? preferred : all;
  const home = league.stadiums[league.teams[game.home]?.stadiumId as StadiumId];
  const chosen = pool.length > 0 ? pool[((year % pool.length) + pool.length) % pool.length] : home;
  if (!chosen) throw new Error(`neutralSite: no stadium available for ${game.id}`);
  return chosen;
};

/** Venue of a scheduled game (neutral site for the championship). */
export const gameStadium = (league: League, game: ScheduledGame): Stadium => {
  if (game.isPlayoff && game.playoffRound !== null && isChampionshipRound(league.settings, game.playoffRound)) return neutralSite(league, game, league.season.year);
  const team = league.teams[game.home];
  const stadium = team ? league.stadiums[team.stadiumId] : undefined;
  if (!stadium) throw new Error(`gameStadium: home team ${game.home} has no stadium`);
  return stadium;
};

/** Deterministic weather for a game (clear when weather is disabled). */
export const gameWeather = (league: League, game: ScheduledGame): WeatherState => {
  if (!league.settings.weatherEnabled) return clearWeather();
  const stadium = gameStadium(league, game);
  const w = generateWeather(createRng(`${league.rngSeed}:weather:${game.id}`), stadium.climate, calendarWeek(league, game), stadium.roof);
  // Math.round can yield -0 below freezing; JSON saves write it as 0, so normalise it to keep the save round trip exact.
  return Object.is(w.temperatureF, -0) ? { ...w, temperatureF: 0 } : w;
};

/** Rating points per 1.0 of facilities.ts gameplanBonus (0..0.02 by analytics level: up to +8). */
export const GAMEPLAN_RATING_SCALE = 400;

/**
 * The head coach as he coaches a game: the analytics department's game plan (facilities.ts gameplanBonus, 0 at
 * level 1 up to 0.02 at level 5) adds gameplanBonus x GAMEPLAN_RATING_SCALE points (up to +8, capped at 99) to his
 * game management (fourth downs, two-point tries, clock and challenges in ai/coaching.ts) and to his offense and
 * defense ratings (the play-calling IQ ai/coaching.ts coachIq blends in, which also sharpens his fourth-down
 * conversion estimates). A copy: the League's coach is untouched.
 */
export const gameDayCoach = (coach: Coach, team: Pick<Team, 'facilities'>): Coach => {
  const bonus = Math.round(facilityEffects(team).gameplanBonus * GAMEPLAN_RATING_SCALE);
  if (bonus <= 0) return coach;
  const up = (v: number): number => Math.min(99, v + bonus);
  const r = coach.ratings;
  return { ...coach, ratings: { ...r, gameManagement: up(r.gameManagement), offense: up(r.offense), defense: up(r.defense) } };
};

/**
 * One side of a game: team, full roster (the lineup logic skips injured players), head coach and coordinators,
 * playbook. With
 * `applyMorale` (default true) the players are copies with their morale multiplier applied.
 */
export const teamGameSetup = (league: League, teamId: TeamId, custom: CustomPlaybookContent, applyMorale = true): GameTeamSetup => {
  const team = league.teams[teamId];
  if (!team) throw new Error(`teamGameSetup: unknown team ${teamId}`);
  const roster: Record<PlayerId, Player> = {};
  for (const id of team.rosterIds) {
    const p = league.players[id];
    if (!p) throw new Error(`teamGameSetup: ${team.abbr} roster references unknown player ${id}`);
    roster[id] = p;
  }
  const players = applyMorale ? applyMoraleEffects(roster, moraleEffects(league, teamId)) : roster;
  let resolved: ResolvedPlaybook;
  try {
    resolved = resolvePlaybook(team.playbookId, custom);
  } catch {
    resolved = resolvePlaybook(DEFAULT_PLAYBOOK_ID, custom);
  }
  return {
    team,
    players,
    headCoach: headCoachOf(league, team),
    offensiveCoordinator: coordinatorOf(league, team, 'OC'),
    defensiveCoordinator: coordinatorOf(league, team, 'DC'),
    offensePlays: resolved.offense,
    defensePlays: resolved.defense,
  };
};

const headCoachOf = (league: League, team: Team): Coach | null => {
  const hc = team.headCoachId ? league.coaches[team.headCoachId] : undefined;
  return hc ? gameDayCoach(hc, team) : null;
};

/** The team's coordinator in `role` (first on the staff list), or null when the post is vacant. */
export const coordinatorOf = (league: Pick<League, 'coaches'>, team: Pick<Team, 'staffIds'>, role: 'OC' | 'DC'): Coach | null => {
  for (const id of team.staffIds) {
    const c = league.coaches[id];
    if (c && c.role === role) return c;
  }
  return null;
};

/** League.fatigue for the dressed players (null when fatigue is off or nobody carries any). */
export const carriedFatigue = (league: Pick<League, 'settings' | 'fatigue'>, sides: readonly GameTeamSetup[]): Record<PlayerId, number> | null => {
  if (!league.settings.fatigueEnabled || !league.fatigue) return null;
  const out: Record<PlayerId, number> = {};
  for (const side of sides) {
    for (const id of Object.keys(side.players) as PlayerId[]) {
      const f = league.fatigue[id];
      if (f !== undefined && f > 0) out[id] = f;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
};

/** The side the league's user team plays in a game, or null. */
export const userSideOf = (league: Pick<League, 'userTeamId'>, game: ScheduledGame): TeamSide | null =>
  league.userTeamId === game.home ? 'home' : league.userTeamId === game.away ? 'away' : null;

/**
 * Builds the GameSetup for a scheduled game. Without options the game is set up for auto-simulation
 * (both sides AI, no viewer, the full simulated game length of `leagueSimRuleset`); pass `controllers` (and
 * optionally `userSide`) for a live user game, which is played at the league's chosen quarter length.
 */
export const buildGameSetup = (league: League, game: ScheduledGame, opts: BuildGameSetupOptions = {}): GameSetup => {
  const controllers: Record<TeamSide, ControllerKind> = opts.controllers ? { ...opts.controllers } : { home: 'ai', away: 'ai' };
  const naturalSide = userSideOf(league, game);
  const userSide = opts.userSide !== undefined ? opts.userSide : naturalSide !== null && controllers[naturalSide] !== 'ai' ? naturalSide : null;
  if (userSide !== null && controllers[userSide] === 'ai') controllers[userSide] = 'human';
  const custom = opts.registries ?? customContent(league);
  const applyMorale = opts.applyMorale ?? true;
  const home = teamGameSetup(league, game.home, custom, applyMorale);
  const away = teamGameSetup(league, game.away, custom, applyMorale);
  const fatigue = carriedFatigue(league, [home, away]);
  return {
    id: game.id,
    home,
    away,
    stadium: gameStadium(league, game),
    // Live user games keep the league's chosen quarter length; auto-simulated games play the calibrated full length.
    ruleset: opts.controllers ? leagueRuleset(league.settings) : leagueSimRuleset(league.settings),
    difficulty: opts.difficulty ? { ...opts.difficulty } : { ...league.settings.difficulty },
    weather: opts.weather ? { ...opts.weather } : gameWeather(league, game),
    seed: gameSeed(league, game.id),
    userSide,
    controllers,
    isPlayoff: game.isPlayoff,
    ...(fatigue ? { fatigue } : {}),
    // The user's club stays the human team when its game is simulated, so the CPU opponent keeps the difficulty.
    ...(naturalSide !== null ? { humanTeam: naturalSide } : {}),
  };
};
