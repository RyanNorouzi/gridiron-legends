/**
 * Week advance: plays every game of the current phase-week and folds the results into the League.
 *
 * Per week: (1) injuries with no weeks left heal before kickoff; (2) every game is simulated through the
 * injected GameSimulator, except games that already carry a result (a user game played live and stored
 * with recordUserGameResult); (3) results are stored (play-by-play kept for user and playoff games),
 * regular-season stats/team stats/standings and playoff stats accumulate; (4) existing injuries count
 * down one week, then the week's new injuries are attached — the injured player's club matters: the medical
 * center (facilities.ts injuryChanceMultiplier) prevents some of them outright and shortens the rest
 * (medicalInjuryWeeks), and the strength staff (staff.ts injuryRecoveryBonus) trims the weeks further;
 * (5) season wear is carried (wear.ts: snaps add wear, byes and light weeks shed it; it becomes next week's
 * GameSetup.fatigue); (6) game, season and
 * team records are checked; (7) clinches are announced; (8) the week advances, moving preseason ->
 * regular season -> playoffs (seeding + bracket) -> round by round -> awards (champion crowned).
 * Preseason games never touch standings, stats or records. Pure: the input League is not mutated.
 */
import type { GameId, PlayerId, TeamId } from '@/core/ids';
import { createRng, type Rng } from '@/core/rng';
import type { AttributeSet, InjurySeverity, InjuryStatus, Player } from '@/players/types';
import { AREA_ATTRIBUTES, SEVERITY_WEEKS, advanceInjury, applyInjury } from '@/players/injuries';
import { accumulatePlayerStats, accumulateSeason, clonePlayerStatLine, hasActivity } from '@/statistics/aggregate';
import type { GameStats, PlayerStatLine } from '@/statistics/types';
import { prunePlayerTeams } from '@/statistics/game-teams';
import type { GameSetup, PlayLogEntry, WeatherState } from '@/game/types';
import type { PlayOutcome } from '@/game/play-types';
import { facilityEffects, medicalInjuryWeeks } from './facilities';
import { compactPlayLog } from './play-text';
import { applyPracticeChemistry, weekPracticePlans } from './practice-plan';
import { buildGameSetup, gameWeather, userSideOf } from './game-setup';
import { checkWeekRecords, crownChampion, isNewRecordHolder, isRecordNews } from './history';
import { leagueRng, withRngState } from './league';
import { advanceBracket, beginPlayoffs, currentRound, runnerUp, schedulePlayoffRound, type BracketResult } from './playoffs';
import { leagueRuleset, scheduleWeekCount } from './settings';
import { staffEffects } from './staff';
import { gamesInWeek } from './schedule';
import { applyWeekWear, weekSnaps } from './wear';
import { fallbackSimulator } from './sim-fallback';
import { stampSetupTeams, validateSimResult, type GameSimResult, type GameSimulator } from './sim-seam';
import { applyGameResult, clinchStatuses, tiebreakContext, type ClinchStatus } from './standings';
import type { GameResult, League, LeagueRecord, ScheduledGame, SeasonPhase } from './types';

/** Something that happened during a week advance, for the UI and the events engine. */
export type WeekEvent =
  | { type: 'gameResult'; gameId: GameId; phase: SeasonPhase; week: number; home: TeamId; away: TeamId; homeScore: number; awayScore: number;
      overtime: boolean; winner: TeamId | null; isPlayoff: boolean; isPreseason: boolean; userGame: boolean }
  | { type: 'injury'; playerId: PlayerId; teamId: TeamId | null; severity: InjurySeverity; weeksOut: number; gameId: GameId }
  | { type: 'recovered'; playerId: PlayerId; teamId: TeamId | null }
  /** A record-book change by a new holder; `headline` is true only when it is news (history.ts isRecordNews). */
  | { type: 'record'; record: LeagueRecord; previous: LeagueRecord | null; headline: boolean }
  | { type: 'clinch'; teamId: TeamId; status: Exclude<ClinchStatus, 'eliminated' | null> }
  | { type: 'eliminated'; teamId: TeamId }
  | { type: 'playoffsSet'; seeds: Record<string, TeamId[]> }
  | { type: 'playoffAdvance'; round: number; roundName: string; winner: TeamId; loser: TeamId }
  | { type: 'champion'; teamId: TeamId; runnerUp: TeamId | null; year: number }
  | { type: 'phaseChange'; from: SeasonPhase; to: SeasonPhase; year: number };

/** Injected collaborators of advanceWeek. */
export interface AdvanceWeekDeps {
  /** Game simulator; default the rating-based placeholder (sim-fallback.ts). */
  simulate?: GameSimulator;
  /** Rng for week-level rolls (injury details). Default: the League rng, whose state is written back. */
  rng?: Rng;
  onGame?: (game: ScheduledGame, result: GameResult) => void;
  onEvent?: (event: WeekEvent) => void;
  /** 'require' throws when the user's game this week has not been played live yet. Default 'simulate'. */
  userGame?: 'simulate' | 'require';
}

/** A week advance: the new League, what happened, and the games that were completed. */
export interface WeekAdvanceResult {
  league: League;
  events: WeekEvent[];
  games: ScheduledGame[];
}

/** Phases in which games are played. */
export const GAME_PHASES: readonly SeasonPhase[] = ['preseason', 'regularSeason', 'playoffs'];
/** True for preseason, regular season and playoffs. */
export const isGamePhase = (phase: SeasonPhase): boolean => GAME_PHASES.includes(phase);

/** The current phase-week's games (empty outside game phases). */
export const gamesThisWeek = (league: League): ScheduledGame[] => {
  const phase = league.season.phase;
  return phase === 'preseason' || phase === 'regularSeason' || phase === 'playoffs' ? gamesInWeek(league.season.schedule, phase, league.season.week) : [];
};

/** The user team's game this week, or null (bye, no user team, non-game phase). */
export const userGameThisWeek = (league: League): ScheduledGame | null => gamesThisWeek(league).find((g) => userSideOf(league, g) !== null) ?? null;

/** True when a game's full play-by-play is kept in League.playLogs (user-team and playoff games); every other game
 *  keeps a compact one in League.playSummaries (franchise/play-text.ts). */
export const keepsPlayLog = (league: League, game: ScheduledGame): boolean => game.isPlayoff || userSideOf(league, game) !== null;

/** A play outcome as League.playLogs keeps it: the per-play stat deltas and on-field fatigue map are dropped (the
 *  box score already holds the game's stats; they were ~70% of a stored log), also inside a review's alternate. */
const storedOutcome = (o: PlayOutcome): PlayOutcome =>
  ({ ...o, stats: [], fatigueAfter: {}, review: o.review ? { ...o.review, ifOverturned: storedOutcome(o.review.ifOverturned) } : null });

/** The play-by-play as League.playLogs stores it (see storedOutcome): everything a replay or drive chart reads. */
export const storedPlayLog = (log: readonly PlayLogEntry[]): PlayLogEntry[] => log.map((e) => ({ ...e, outcome: storedOutcome(e.outcome) }));

/** Copies a stats object keeping only player lines with activity (dressed-but-unused players are dropped), and
 *  the team each kept line was recorded for (GameStats.playerTeams). */
const pruneStats = (stats: GameStats): GameStats => {
  const players: Record<PlayerId, PlayerStatLine> = {};
  for (const [id, line] of Object.entries(stats.players) as [PlayerId, PlayerStatLine][]) if (hasActivity(line)) players[id] = clonePlayerStatLine(line);
  const playerTeams = prunePlayerTeams(stats, Object.keys(players) as PlayerId[]);
  return { players, teams: { home: { ...stats.teams.home }, away: { ...stats.teams.away } }, ...(playerTeams ? { playerTeams } : {}) };
};

/** The stored result of a simulated or live game; every line is credited to the side its player dressed for in `setup`. */
const toGameResult = (sim: GameSimResult, weather: WeatherState, playLogId: string | null, setup: GameSetup): GameResult => ({
  homeScore: sim.homeScore, awayScore: sim.awayScore, overtime: sim.overtime, stats: pruneStats(stampSetupTeams(sim.stats, setup)), weather: { ...(sim.weather ?? weather) },
  injuries: sim.injuries.map((i) => ({ ...i })), playLogId, quarterLengthSec: sim.quarterLengthSec ?? setup.ruleset.quarterLengthSec,
});

const BODY_AREAS: readonly InjuryStatus['bodyArea'][] = ['lowerBody', 'upperBody', 'core', 'head'];
const BODY_AREA_WEIGHTS: readonly number[] = [0.55, 0.25, 0.1, 0.1];

/**
 * A franchise injury record for an in-game injury of known severity: body area, weeks out from
 * SEVERITY_WEEKS and, for career-threatening injuries, a permanent attribute loss.
 */
export const injuryFromSeverity = (rng: Rng, severity: InjurySeverity, year: number, week: number): InjuryStatus => {
  const bodyArea = rng.weighted(BODY_AREAS, BODY_AREA_WEIGHTS);
  const [lo, hi] = SEVERITY_WEEKS[severity];
  const weeksRemaining = rng.int(lo, hi);
  let permanentPenalty: Partial<AttributeSet> | null = null;
  if (severity === 'careerThreatening') {
    permanentPenalty = {};
    for (const key of AREA_ATTRIBUTES[bodyArea].slice(0, 3)) permanentPenalty[key] = -rng.int(2, 6);
    permanentPenalty.injuryResistance = -rng.int(4, 9);
  }
  return { bodyArea, severity, weeksRemaining, permanentPenalty, occurredYear: year, occurredWeek: week };
};

/**
 * The club's say in a new in-game injury: null when the medical center prevented it (chance 1 -
 * injuryChanceMultiplier, rolled from a stream keyed by league seed, game and player so no other roll moves),
 * else the injury with its weeks cut by the medical center (medicalInjuryWeeks) and the strength staff's
 * injuryRecoveryBonus (never below 1 week). Free agents / unknown teams keep the injury as rolled.
 */
export const clubAdjustedInjury = (league: Pick<League, 'teams' | 'coaches' | 'rngSeed'>, player: Pick<Player, 'id' | 'teamId'>, gameId: GameId, status: InjuryStatus): InjuryStatus | null => {
  const team = player.teamId ? league.teams[player.teamId] : undefined;
  if (!team) return status;
  const prevent = 1 - facilityEffects(team).injuryChanceMultiplier;
  if (prevent > 0 && createRng(`${league.rngSeed}:medical:${gameId}:${player.id}`).chance(prevent)) return null;
  const medical = medicalInjuryWeeks(team, status.weeksRemaining);
  const weeks = medical <= 0 ? 0 : Math.max(1, Math.round(medical * (1 - staffEffects(league, team).injuryRecoveryBonus)));
  return weeks === status.weeksRemaining ? status : { ...status, weeksRemaining: weeks };
};

/** Season calendar week injuries are stamped with: 0 in the preseason, the regular-season week, then playoff rounds after it. */
export const injuryStampWeek = (league: Pick<League, 'settings'>, phase: SeasonPhase, week: number): number =>
  phase === 'preseason' ? 0 : phase === 'playoffs' ? scheduleWeekCount(league.settings) + week : week;

/**
 * Plays the current week and returns the new League with everything that happened. Throws outside game
 * phases (use phase.ts nextPhase) and, with `userGame: 'require'`, when the user's game is unplayed.
 */
export const advanceWeekDetailed = (league: League, deps: AdvanceWeekDeps = {}): WeekAdvanceResult => {
  const { phase, week, year } = league.season;
  if (!isGamePhase(phase)) throw new Error(`advanceWeek: no games are played in the ${phase} phase; use nextPhase`);
  const events: WeekEvent[] = [];
  const emit = (e: WeekEvent): void => {
    events.push(e);
    deps.onEvent?.(e);
  };
  if (phase === 'preseason' && (week < 1 || week > league.settings.preseasonWeeks)) {
    emit({ type: 'phaseChange', from: 'preseason', to: 'regularSeason', year });
    return { league: { ...league, season: { ...league.season, phase: 'regularSeason', week: 1 } }, events, games: [] };
  }
  const games = gamesThisWeek(league);
  const userGame = games.find((g) => userSideOf(league, g) !== null);
  if (deps.userGame === 'require' && userGame && !userGame.result) throw new Error(`advanceWeek: the user's game ${userGame.id} must be played first`);
  const rng = deps.rng ?? leagueRng(league);
  const weekRng = rng.fork(`week:${year}:${phase}:${week}`);
  const simulate = deps.simulate ?? fallbackSimulator;
  const players: Record<PlayerId, Player> = { ...league.players };
  for (const p of Object.values(league.players)) {
    if (p.injury && p.injury.weeksRemaining <= 0) {
      players[p.id] = advanceInjury(p);
      emit({ type: 'recovered', playerId: p.id, teamId: p.teamId });
    }
  }
  const pre: League = { ...league, players };
  const season = { ...pre.season, stats: { ...pre.season.stats }, playoffStats: { ...pre.season.playoffStats }, teamStats: { ...pre.season.teamStats } };
  const ownedStats = new Set<string>();
  const own = (table: Record<PlayerId, PlayerStatLine>, tag: string, ids: readonly PlayerId[]): void => {
    for (const id of ids) {
      const line = table[id];
      if (line && !ownedStats.has(`${tag}:${id}`)) table[id] = clonePlayerStatLine(line);
      ownedStats.add(`${tag}:${id}`);
    }
  };
  const playLogs = { ...pre.playLogs };
  const playSummaries = { ...pre.playSummaries };
  const newInjuries: { playerId: PlayerId; severity: InjurySeverity; gameId: GameId }[] = [];
  const finished = new Map<GameId, ScheduledGame>();
  for (const g of games) {
    let result = g.result;
    if (!result) {
      const setup = buildGameSetup(pre, g);
      const keep = keepsPlayLog(pre, g);
      // Every game keeps a play history: the full log for user / playoff games, a compact one for the rest.
      const sim = validateSimResult(setup, simulate(setup, { keepPlayLog: true }));
      const logId = keep && sim.playLog && sim.playLog.length > 0 ? g.id : null;
      if (logId && sim.playLog) playLogs[logId] = storedPlayLog(sim.playLog);
      else if (sim.playLog && sim.playLog.length > 0) playSummaries[g.id] = compactPlayLog(sim.playLog, setup);
      result = toGameResult(sim, setup.weather, logId, setup);
    }
    const done: ScheduledGame = { ...g, result };
    finished.set(g.id, done);
    const ids = Object.keys(result.stats.players) as PlayerId[];
    if (g.isPlayoff) {
      own(season.playoffStats, 'po', ids);
      accumulatePlayerStats(season.playoffStats, result.stats.players);
    } else if (!g.isPreseason) {
      own(season.stats, 'rs', ids);
      accumulateSeason(season, result.stats, { home: g.home, away: g.away });
      season.standings = applyGameResult(season.standings, done, pre.teams);
    }
    if (pre.settings.injuriesEnabled) for (const inj of result.injuries) newInjuries.push({ playerId: inj.playerId, severity: inj.severity, gameId: g.id });
    const winner = result.homeScore > result.awayScore ? g.home : result.awayScore > result.homeScore ? g.away : null;
    emit({
      type: 'gameResult', gameId: g.id, phase, week, home: g.home, away: g.away, homeScore: result.homeScore, awayScore: result.awayScore,
      overtime: result.overtime, winner, isPlayoff: g.isPlayoff, isPreseason: g.isPreseason, userGame: userSideOf(pre, g) !== null,
    });
    deps.onGame?.(done, result);
  }
  season.schedule = pre.season.schedule.map((g) => finished.get(g.id) ?? g);
  // Injury countdown for everyone already hurt, then this week's new injuries.
  for (const p of Object.values(players)) {
    if (!p.injury) continue;
    const next = advanceInjury(p);
    players[p.id] = next;
    if (!next.injury) emit({ type: 'recovered', playerId: p.id, teamId: p.teamId });
  }
  const stampWeek = injuryStampWeek(league, phase, week);
  for (const inj of newInjuries) {
    const p = players[inj.playerId];
    if (!p) continue;
    const status = clubAdjustedInjury(pre, p, inj.gameId, injuryFromSeverity(weekRng, inj.severity, year, stampWeek));
    if (!status) continue;
    players[p.id] = applyInjury(p, status);
    emit({ type: 'injury', playerId: p.id, teamId: p.teamId, severity: status.severity, weeksOut: status.weeksRemaining, gameId: inj.gameId });
  }
  // Season wear: this week's snaps (every finished game, live user games included) against what was carried in;
  // with fatigue off nobody plays tired, so any carried wear only recovers.
  const snaps = pre.settings.fatigueEnabled ? weekSnaps([...finished.values()].flatMap((g) => (g.result ? [g.result.stats] : []))) : new Map<PlayerId, number>();
  // The week's practice plans (the user's choice, AI staffs by roster wear) shape recovery and chemistry.
  const plans = weekPracticePlans(pre);
  const fatigue = applyWeekWear(pre, players, pre.fatigue ?? {}, snaps, pre.settings.fatigueEnabled ? plans : {});
  let next: League = applyPracticeChemistry({ ...pre, players, playLogs, playSummaries, season, ...(pre.settings.fatigueEnabled || pre.fatigue !== undefined ? { fatigue } : {}) }, plans);
  if (phase !== 'preseason') {
    const records = checkWeekRecords(next, [...finished.values()]);
    next = records.league;
    for (const b of records.broken) if (isNewRecordHolder(b)) emit({ type: 'record', record: b.record, previous: b.previous, headline: isRecordNews(next, b) });
  }
  if (phase === 'regularSeason') {
    const before = clinchStatuses(tiebreakContext(league), league.settings);
    const after = clinchStatuses(tiebreakContext(next), next.settings);
    for (const [id, status] of Object.entries(after) as [TeamId, ClinchStatus][]) {
      if (status === before[id] || status === null) continue;
      if (status === 'eliminated') emit({ type: 'eliminated', teamId: id });
      else if (!(status === 'clinchedPlayoffs' && before[id] === 'clinchedDivision')) emit({ type: 'clinch', teamId: id, status });
    }
  }
  next = advanceCalendar(next, [...finished.values()], emit);
  return { league: deps.rng ? next : withRngState(next, rng), events, games: [...finished.values()] };
};

/** Moves the calendar after a played week (phase transitions included). */
const advanceCalendar = (league: League, finished: readonly ScheduledGame[], emit: (e: WeekEvent) => void): League => {
  const s = league.season;
  if (s.phase === 'preseason') {
    if (s.week < league.settings.preseasonWeeks) return { ...league, season: { ...s, week: s.week + 1 } };
    emit({ type: 'phaseChange', from: 'preseason', to: 'regularSeason', year: s.year });
    return { ...league, season: { ...s, phase: 'regularSeason', week: 1 } };
  }
  if (s.phase === 'regularSeason') {
    if (s.week < scheduleWeekCount(league.settings)) return { ...league, season: { ...s, week: s.week + 1 } };
    const started = beginPlayoffs(league);
    emit({ type: 'phaseChange', from: 'regularSeason', to: 'playoffs', year: s.year });
    emit({ type: 'playoffsSet', seeds: { ...(started.season.bracket?.seeds ?? {}) } });
    return started;
  }
  if (!s.bracket) throw new Error('advanceWeek: playoffs without a bracket');
  const results: BracketResult[] = [];
  for (const g of finished) {
    if (!g.isPlayoff || !g.result) continue;
    const homeWon = g.result.homeScore > g.result.awayScore;
    const r: BracketResult = { winner: homeWon ? g.home : g.away, loser: homeWon ? g.away : g.home };
    results.push(r);
    emit({ type: 'playoffAdvance', round: s.week, roundName: league.settings.playoff.roundNames[s.week - 1] ?? `Round ${s.week}`, ...r });
  }
  const bracket = advanceBracket(s.bracket, results, league.settings, s.standings);
  if (bracket.champion) {
    const crowned = crownChampion({ ...league, season: { ...s, bracket } }, bracket.champion);
    for (const b of crowned.broken) if (isNewRecordHolder(b)) emit({ type: 'record', record: b.record, previous: b.previous, headline: isRecordNews(league, b) });
    emit({ type: 'champion', teamId: bracket.champion, runnerUp: runnerUp(bracket), year: s.year });
    emit({ type: 'phaseChange', from: 'playoffs', to: 'awards', year: s.year });
    return { ...crowned.league, season: { ...crowned.league.season, phase: 'awards', week: 0 } };
  }
  const round = currentRound(bracket);
  if (round === s.week) return { ...league, season: { ...s, bracket } };
  const scheduled = schedulePlayoffRound(bracket, s.year, round);
  return { ...league, season: { ...s, bracket: scheduled.bracket, week: round, schedule: [...s.schedule, ...scheduled.games] } };
};

/** advanceWeekDetailed, returning only the League. */
export const advanceWeek = (league: League, deps: AdvanceWeekDeps = {}): League => advanceWeekDetailed(league, deps).league;

/**
 * Advances week by week until the season reaches `target` (or leaves the game phases), collecting events.
 * `maxWeeks` guards against a runaway loop.
 */
export const advanceToPhase = (league: League, target: SeasonPhase, deps: AdvanceWeekDeps = {}, maxWeeks = 64): WeekAdvanceResult => {
  let current = league;
  const events: WeekEvent[] = [];
  const games: ScheduledGame[] = [];
  for (let i = 0; i < maxWeeks && current.season.phase !== target && isGamePhase(current.season.phase); i++) {
    const r = advanceWeekDetailed(current, deps);
    current = r.league;
    events.push(...r.events);
    games.push(...r.games);
  }
  return { league: current, events, games };
};

/**
 * Stores the result of a game the user played live (current phase-week, no result yet). Stats, standings,
 * injuries and season wear (from the stored snaps; the result's end-of-game fatigue is not carried, a week of rest
 * clears it) are applied when the week advances. The play-by-play is kept under the game id; weather
 * defaults to the game's deterministic weather. Throws for unknown, finished or out-of-week games and for
 * results that fail the simulator boundary checks.
 */
export const recordUserGameResult = (league: League, gameId: GameId, result: GameSimResult & { weather?: WeatherState }): League => {
  const game = league.season.schedule.find((g) => g.id === gameId);
  if (!game) throw new Error(`recordUserGameResult: unknown game ${gameId}`);
  if (game.result) throw new Error(`recordUserGameResult: game ${gameId} already has a result`);
  if (!gamesThisWeek(league).some((g) => g.id === gameId)) throw new Error(`recordUserGameResult: game ${gameId} is not scheduled this week`);
  const setup = buildGameSetup(league, game);
  validateSimResult(setup, result);
  const playLogId = result.playLog && result.playLog.length > 0 ? gameId : null;
  // Played live: at the league's own quarter length unless the result says otherwise.
  const played = { ...result, quarterLengthSec: result.quarterLengthSec ?? leagueRuleset(league.settings).quarterLengthSec };
  const stored = toGameResult(played, result.weather ?? gameWeather(league, game), playLogId, setup);
  return {
    ...league,
    playLogs: playLogId && result.playLog ? { ...league.playLogs, [playLogId]: storedPlayLog(result.playLog) } : league.playLogs,
    season: { ...league.season, schedule: league.season.schedule.map((g) => (g.id === gameId ? { ...g, result: stored } : g)) },
  };
};
