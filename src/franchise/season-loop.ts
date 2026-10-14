/**
 * The franchise game loop: the one public entry point a UI needs to move a league through time.
 *
 *   advanceLeagueWeek   one game week: user results recorded -> week.ts advanceWeekDetailed (default simulator:
 *                       the real whole-game sim, sim-real.ts) -> events.ts advanceClubWeek (rivalries, fans,
 *                       finances, morale, franchise events) -> in the regular season: progression.ts
 *                       weeklyDevelopment, draft.ts weeklyScouting (the class is opened when the regular season
 *                       starts) and trades.ts runAiTradeActivity while the trade window is open
 *   advanceLeaguePhase  one calendar phase: a game phase moves through phase.ts nextPhase (its guards apply); an
 *                       offseason phase runs its work (offseason.ts runOffseasonPhase with the standard deps and
 *                       the offseason news adapter), refuses to leave postDraft / trainingCamp while the user's
 *                       roster breaks roster-rules.ts (unless `autoFix`, which settles it with aiFinalCuts), moves
 *                       the calendar and runs events.ts advanceClubPhase
 *   simulateToPhase     repeats the two until the league reaches a target phase ("sim to the playoffs", "sim to
 *                       the end of the season", "sim through the offseason")
 * Both steps finish by posting the loop news (news-items.ts: injuries, trades, career milestones, coaching changes).
 *
 * Randomness: an injected Rng is forked per step; without one the League rng is used and its state written back.
 * Pure: the input League is never mutated.
 */
import type { GameId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import type { WeatherState } from '@/game/types';
import { isDepthChartValid } from '@/teams/depth-chart';
import { openScouting, weeklyScouting } from './draft';
import { advanceClubPhase, advanceClubWeek, type RecordBreak } from './events';
import { aiFinalCuts } from './gm/roster-fill';
import { leagueRng, withRngState } from './league';
import { OFFSEASON_STEP_PHASES, runOffseasonPhase, type OffseasonDeps, type OffseasonEvent } from './offseason';
import { standardOffseasonDeps } from './offseason-deps';
import { postLoopNews } from './news-items';
import { postOffseasonEvents, postTransactionNews } from './offseason-events';
import { nextPhase } from './phase';
import { weeklyDevelopment } from './progression';
import { refreshTeamInPlace } from './roster';
import { phaseRosterBlockers, type RosterRuleIssue } from './roster-rules';
import type { GameSimResult, GameSimulator } from './sim-seam';
import { realGameSimulator } from './sim-real';
import { expireTrades, runAiTradeActivity, tradeWindowOpen } from './trades';
import type { FranchiseEvent, League, ScheduledGame, SeasonPhase } from './types';
import { advanceWeekDetailed, isGamePhase, recordUserGameResult, type WeekEvent } from './week';

/** A game the user played live, as the game screen reports it (recordUserGameResult's input). */
export type UserGameResult = GameSimResult & { weather?: WeatherState };

/** Options of advanceLeagueWeek. */
export interface LeagueWeekOptions {
  /** Default: the League rng (state written back). */
  rng?: Rng;
  /** Game simulator for every unplayed game; default the real whole-game simulator (sim-real.ts). */
  simulator?: GameSimulator;
  /** Results of games the user played live this week, by game id (recorded before the week is simulated). */
  userResults?: Readonly<Record<GameId, UserGameResult>>;
  /** Throw when the user's game this week has neither a stored nor a supplied result (default: simulate it). */
  requireUserGame?: boolean;
  /** Also run franchise events for AI teams (resolved at once with their default choice). Default true. */
  aiEvents?: boolean;
}

/** What one league week produced. */
export interface LeagueWeekResult {
  league: League;
  /** Week-engine events (results, injuries, clinches, records, phase changes...). */
  events: WeekEvent[];
  /** New franchise events for the user team (club layer). */
  franchiseEvents: FranchiseEvent[];
  /** Records broken this week. */
  brokenRecords: RecordBreak[];
  /** Games completed this week. */
  games: ScheduledGame[];
}

/** Opens the scouting season for league.year when it is not open yet (draft.ts openScouting is a no-op otherwise). */
const ensureScouting = (league: League, rng: Rng): League => openScouting(league, rng);

/**
 * Plays the current game week and runs everything that follows it (see the module header). Throws outside the
 * game phases (use advanceLeaguePhase) and for invalid user results.
 */
export const advanceLeagueWeek = (league: League, opts: LeagueWeekOptions = {}): LeagueWeekResult => {
  const { phase, week, year } = league.season;
  if (!isGamePhase(phase)) throw new Error(`advanceLeagueWeek: no games are played in the ${phase} phase; use advanceLeaguePhase`);
  const rng = opts.rng ?? leagueRng(league);
  let current = league;
  for (const [gameId, result] of Object.entries(opts.userResults ?? {}) as [GameId, UserGameResult][]) current = recordUserGameResult(current, gameId, result);
  const r = advanceWeekDetailed(current, {
    simulate: opts.simulator ?? realGameSimulator, rng: rng.fork(`games:${year}:${phase}:${week}`), userGame: opts.requireUserGame ? 'require' : 'simulate',
  });
  const brokenRecords: RecordBreak[] = r.events.flatMap((e) => (e.type === 'record' ? [{ record: e.record, previous: e.previous }] : []));
  const club = advanceClubWeek(r.league, { games: r.games, phase, week, brokenRecords, aiEvents: opts.aiEvents ?? true, rng: rng.fork(`club:${year}:${phase}:${week}`) });
  let next = club.league;
  if (phase === 'regularSeason') {
    next = weeklyDevelopment(next, week, rng.fork(`dev:${year}:${week}`));
    next = ensureScouting(next, rng.fork(`scouting:${year}`));
    next = weeklyScouting(next, rng.fork(`scout:${year}:${week}`));
    next = tradeWindowOpen(next) ? runAiTradeActivity(next, rng.fork(`trades:${year}:${week}`)) : expireTrades(next);
  }
  if (phase === 'preseason' && next.season.phase === 'regularSeason') next = ensureScouting(next, rng.fork(`scouting:${year}`));
  next = postLoopNews(current, next, r.events);
  return { league: opts.rng ? next : withRngState(next, rng), events: r.events, franchiseEvents: club.events, brokenRecords, games: r.games };
};

/** Options of advanceLeaguePhase. */
export interface LeaguePhaseOptions {
  /** Settle the user's roster (aiFinalCuts with includeUser, depth chart rebuilt) instead of refusing to leave
   *  postDraft / trainingCamp with blocking roster issues. Default false. */
  autoFix?: boolean;
  /** Skip the free-agency / draft guards of nextPhase (see phase.ts). */
  force?: boolean;
}

/** What one phase move produced. */
export interface LeaguePhaseResult {
  /** The League after the phase's work and, unless blocked, the calendar move. */
  league: League;
  /** Phase whose work ran. */
  phase: SeasonPhase;
  /** Phase the League is in afterwards (equal to `phase` when blocked). */
  next: SeasonPhase;
  /** Offseason events of the phase's work (empty for game phases). */
  events: OffseasonEvent[];
  /** New club-layer franchise events for the user team. */
  franchiseEvents: FranchiseEvent[];
  warnings: string[];
  /** Blocking roster issues that kept the League in `phase` (empty when it moved). */
  blockedBy: RosterRuleIssue[];
}

/** Settles the user's roster at final-cut size and rebuilds his depth chart when it cannot field a lineup. */
export const autoFixUserRoster = (league: League): League => {
  const user = league.userTeamId as TeamId | null;
  if (!user) return league;
  const settled = aiFinalCuts(league, { includeUser: true });
  const team = settled.teams[user];
  if (!team) return settled;
  const roster = team.rosterIds.map((id) => settled.players[id]).filter((p) => p !== undefined);
  if (isDepthChartValid(team.depthChart, roster)) return settled;
  const work: League = { ...settled, teams: { ...settled.teams } };
  refreshTeamInPlace(work, user, true);
  return work;
};

/**
 * Advances one calendar phase (see the module header). Game phases use nextPhase (throws while games remain);
 * offseason phases run their work first. `deps` default to standardOffseasonDeps() (the user's roster is his job)
 * with the offseason news adapter as `events`. Blocking user-roster issues in postDraft / trainingCamp return the
 * League unmoved with `blockedBy` set, unless `opts.autoFix`.
 */
export const advanceLeaguePhase = (league: League, rng?: Rng, deps: OffseasonDeps = standardOffseasonDeps(), opts: LeaguePhaseOptions = {}): LeaguePhaseResult => {
  const r = rng ?? leagueRng(league);
  const phase = league.season.phase;
  const done = (after: League, rest: Omit<LeaguePhaseResult, 'league' | 'phase' | 'next'>): LeaguePhaseResult => {
    const out = postLoopNews(league, after);
    return { league: rng ? out : withRngState(out, r), phase, next: out.season.phase, ...rest };
  };
  const stepRng = r.fork(`phase:${league.season.year}:${phase}`);
  if (!OFFSEASON_STEP_PHASES.includes(phase)) {
    let moved = nextPhase(league, { force: opts.force });
    if (moved.season.phase === 'regularSeason') moved = ensureScouting(moved, stepRng.fork('scouting'));
    return done(moved, { events: [], franchiseEvents: [], warnings: [], blockedBy: [] });
  }
  const work = runOffseasonPhase(league, stepRng.fork('work'), { ...deps, events: deps.events ?? postOffseasonEvents });
  let out = phase === 'freeAgency' || phase === 'draft' ? postTransactionNews(work.league) : work.league;
  let blockers = phaseRosterBlockers(out);
  if (blockers.length > 0 && opts.autoFix) {
    out = autoFixUserRoster(out);
    blockers = phaseRosterBlockers(out);
  }
  if (blockers.length > 0) return done(out, { events: work.events, franchiseEvents: [], warnings: work.warnings, blockedBy: blockers });
  const missingDep = (phase === 'freeAgency' && !deps.runFreeAgency) || (phase === 'draft' && !deps.runDraft);
  const moved = nextPhase(out, { force: opts.force || missingDep });
  const club = advanceClubPhase(moved, stepRng.fork('club'));
  return done(club.league, { events: work.events, franchiseEvents: club.events, warnings: work.warnings, blockedBy: [] });
};

/** Options of simulateToPhase. */
export interface SimulateToPhaseOptions extends Omit<LeagueWeekOptions, 'rng' | 'userResults' | 'requireUserGame'>, LeaguePhaseOptions {
  /** Default: the League rng (state written back). */
  rng?: Rng;
  /** Offseason dependencies for advanceLeaguePhase. */
  deps?: OffseasonDeps;
  /** Safety valve on weeks + phases advanced (default 120). */
  maxSteps?: number;
  /** Called after every week / phase step (progress bars). */
  onStep?: (league: League) => void;
}

/** What a multi-step simulation produced. */
export interface SimulateToPhaseResult {
  league: League;
  weekEvents: WeekEvent[];
  offseasonEvents: OffseasonEvent[];
  franchiseEvents: FranchiseEvent[];
  /** Non-empty when a user-roster issue stopped the run before the target. */
  blockedBy: RosterRuleIssue[];
  /** Weeks and phases advanced. */
  steps: number;
}

/**
 * Advances week by week (game phases) and phase by phase (offseason) until the League is in `target`: e.g.
 * 'playoffs' (end of the regular season), 'awards' (end of the playoffs), 'preseason' (through the offseason into
 * the next year). Stops early when the user's roster blocks a phase move. No-op when already in `target`.
 */
export const simulateToPhase = (league: League, target: SeasonPhase, opts: SimulateToPhaseOptions = {}): SimulateToPhaseResult => {
  const rng = opts.rng ?? leagueRng(league);
  const deps = opts.deps ?? standardOffseasonDeps();
  const maxSteps = opts.maxSteps ?? 120;
  const out: SimulateToPhaseResult = { league, weekEvents: [], offseasonEvents: [], franchiseEvents: [], blockedBy: [], steps: 0 };
  while (out.league.season.phase !== target) {
    if (out.steps >= maxSteps) throw new Error(`simulateToPhase: ${target} not reached after ${maxSteps} steps (stuck in ${out.league.season.phase})`);
    const s = out.league.season;
    const stepRng = rng.fork(`sim:${s.year}:${s.phase}:${s.week}`);
    if (isGamePhase(s.phase)) {
      const w = advanceLeagueWeek(out.league, { rng: stepRng, ...(opts.simulator ? { simulator: opts.simulator } : {}), ...(opts.aiEvents !== undefined ? { aiEvents: opts.aiEvents } : {}) });
      out.league = w.league;
      out.weekEvents.push(...w.events);
      out.franchiseEvents.push(...w.franchiseEvents);
    } else {
      const p = advanceLeaguePhase(out.league, stepRng, deps, { autoFix: opts.autoFix, force: opts.force });
      out.league = p.league;
      out.offseasonEvents.push(...p.events);
      out.franchiseEvents.push(...p.franchiseEvents);
      if (p.blockedBy.length > 0) {
        out.blockedBy = p.blockedBy;
        break;
      }
    }
    out.steps++;
    opts.onStep?.(out.league);
  }
  if (!opts.rng) out.league = withRngState(out.league, rng);
  return out;
};
