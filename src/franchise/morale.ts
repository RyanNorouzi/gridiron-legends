/**
 * Weekly morale, team chemistry, roster-move reactions and the morale multipliers for game setups.
 *
 * weeklyMorale feeds players/personality adjustMorale with what happened to each player this week: the
 * team result (rivalry, playoff and blowout weight; the staff's motivation shapes the swing), a winning
 * streak, his role (an expected starter left on the bench, or a starter barely seeing snaps according to
 * Season.stats), a new injury, arriving by trade, contract-year anxiety when underpaid, and event flags
 * (disgruntled, a broken targets promise). Morale then drifts gently toward neutral and the head coach's
 * style nudges the coach relationship. Team chemistry combines teams/ratings trait chemistry with roster
 * continuity (ClubState.tenure), leaders among the starters, the head coach and event adjustments.
 *
 * syncRosterMoves compares rosters with the tenure ledger to find arrivals and departures (trades,
 * signings, draft picks, star departures), applies the fan and morale reactions and records tenure.
 * resetSeasonFlags (yearly club close) clears the seasonal event flags.
 * Pure: every function returns a new League.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { clamp } from '@/core/math';
import { careerStage, mentorshipBoost, stageEvents } from './career-stage';
import { adjustMorale, moraleEffectOnPerformance, traitMoraleMultiplier, type MoraleEvent, type MoraleEventType } from '@/players/personality';
import { ATTRIBUTE_KEYS, POSITIONS, type InjurySeverity, type Morale, type Player } from '@/players/types';
import { STARTER_COUNTS, isAvailable } from '@/teams/depth-chart';
import { teamChemistry as rosterChemistry } from '@/teams/ratings';
import type { Team } from '@/teams/types';
import { leagueCapYear } from './contracts';
import { applyFanEvent } from './fans';
import { ensureClub, rivalryEffects, rivalryIntensity, withClub } from './rivalries';
import { injuryStampWeek } from './week';
import { staffEffects, teamStaff } from './staff';
import type { League, PlayerFlag, RosterTenure, ScheduledGame, SeasonPhase } from './types';

/** Morale and chemistry tuning. */
export const MORALE_TUNING = Object.freeze({
  driftTarget: 55,
  driftRate: 0.04,
  benchedMagnitude: 0.8,
  /** A backup at least this much better (overall) than an active starter considers himself benched. */
  benchMargin: 3,
  lowSnapsMagnitude: 0.4,
  /** A listed starter below this share of the expected snaps per game counts as benched. */
  lowSnapsShare: 0.35,
  minGamesForSnaps: 2,
  expectedSnapsPerGame: 55,
  specialistSnapsPerGame: 8,
  playingTimeMagnitude: 0.3,
  streakForSuccess: 3,
  successMagnitude: 0.4,
  blowoutMargin: 21,
  blowoutMultiplier: 1.3,
  playoffMultiplier: 1.5,
  contractYearAnxiety: 1.5,
  underpaidRatio: 1.25,
  disgruntledPerWeek: 1.5,
  brokenPromisePerWeek: 2,
  /** A promised receiver below this share of the team's targets feels let down. */
  targetShareFloor: 0.18,
  injuryMagnitude: { minor: 0.3, short: 0.6, moderate: 1, seasonEnding: 2, careerThreatening: 3 } as Readonly<Record<InjurySeverity, number>>,
  playersCoachRelationship: 0.8,
  disciplinarianRelationship: -0.4,
  chemistryBonusDecay: 0.85,
  continuityWeight: 16,
  continuityPivot: 0.75,
  leaderBonus: 2,
  leaderCap: 8,
  disgruntledChemistry: 1.5,
  disgruntledChemistryCap: 6,
  /** Overall at which arrivals excite and departures upset the fans. */
  starOverall: 82,
  /** Team chemistry's weight on the performance multiplier (±2% at 0/100). */
  chemistryPerformance: 0.02,
});

/** Flags of a player (empty when none). */
export const playerFlags = (league: Pick<League, 'club'>, playerId: PlayerId): PlayerFlag[] => league.club?.playerFlags[playerId] ?? [];

/** Calendar week injuries are stamped with (the season engine's week.ts convention). */
export { injuryStampWeek };

/** Healthy players in a position slot, in depth-chart order (injured players are skipped, as in a game). */
const activeDepth = (team: Pick<Team, 'depthChart'>, roster: readonly Player[], p: Player): Player[] => {
  const byId = new Map(roster.map((q) => [q.id, q]));
  return (team.depthChart[p.position] ?? []).map((id) => byId.get(id)).filter((q): q is Player => q !== undefined && isAvailable(q));
};

/**
 * True when a healthy player sits behind the active starters at his position although he is clearly better
 * (by MORALE_TUNING.benchMargin overall or more) than one of them.
 */
export const isBenchedStarter = (team: Pick<Team, 'depthChart'>, roster: readonly Player[], p: Player): boolean => {
  if (!isAvailable(p)) return false;
  const depth = activeDepth(team, roster, p);
  const n = STARTER_COUNTS[p.position];
  const rank = depth.findIndex((q) => q.id === p.id);
  if (rank >= 0 && rank < n) return false;
  return depth.slice(0, n).some((q) => q.overall + MORALE_TUNING.benchMargin <= p.overall);
};

/** An active starter by depth chart (injured players ahead of him skipped). */
const isListedStarter = (team: Pick<Team, 'depthChart'>, roster: readonly Player[], p: Player): boolean => {
  const rank = activeDepth(team, roster, p).findIndex((q) => q.id === p.id);
  return rank >= 0 && rank < STARTER_COUNTS[p.position];
};

/** Applies a direct morale change scaled by the player's traits as if it were `type`. */
const nudge = (p: Pick<Player, 'morale' | 'traits'>, delta: number, type: MoraleEventType): Morale => {
  let mult = 1;
  for (const t of p.traits) mult *= traitMoraleMultiplier(t, type, delta < 0);
  return { ...p.morale, morale: clamp(Math.round(p.morale.morale + delta * mult), 0, 100) };
};

/** The team's finished game of the given phase-week, if any. */
export const teamGameOf = (league: League, teamId: TeamId, phase: SeasonPhase, week: number): ScheduledGame | null =>
  league.season.schedule.find((g) => (g.home === teamId || g.away === teamId) && g.week === week && g.result !== null
    && (phase === 'preseason' ? g.isPreseason : phase === 'playoffs' ? g.isPlayoff : !g.isPreseason && !g.isPlayoff)) ?? null;

/** Context of weeklyMorale (defaults read from the League). */
export interface WeeklyMoraleContext {
  /** The team's game this week (null = bye). Default: looked up in the schedule. */
  game?: ScheduledGame | null;
  /** Phase the week belonged to. Default: the League's phase. */
  phase?: SeasonPhase;
}

const resultEvents = (league: League, team: Team, game: ScheduledGame | null, motivation: number): MoraleEvent[] => {
  const T = MORALE_TUNING;
  const r = game?.result;
  if (!game || !r || game.isPreseason) return [];
  const mine = game.home === team.id ? r.homeScore : r.awayScore;
  const theirs = game.home === team.id ? r.awayScore : r.homeScore;
  if (mine === theirs) return [];
  const won = mine > theirs;
  const motive = motivation / 99;
  let magnitude = rivalryEffects(rivalryIntensity(league, game.home, game.away)).moraleMultiplier;
  if (game.isPlayoff) magnitude *= T.playoffMultiplier;
  if (Math.abs(mine - theirs) >= T.blowoutMargin) magnitude *= T.blowoutMultiplier;
  magnitude *= won ? 0.85 + 0.3 * motive : 1.15 - 0.3 * motive;
  const out: MoraleEvent[] = [{ type: won ? 'win' : 'loss', magnitude }];
  const streak = league.season.standings[team.id]?.streak ?? 0;
  if (won && !game.isPlayoff && streak >= T.streakForSuccess) out.push({ type: 'teamSuccess', magnitude: T.successMagnitude });
  return out;
};

/**
 * One week of morale for a team's players (see the module header) and the refreshed team chemistry.
 * `week` is the phase-week that was just played.
 */
export const weeklyMorale = (league: League, teamId: TeamId, week: number, ctx: WeeklyMoraleContext = {}): League => {
  const T = MORALE_TUNING;
  const team = league.teams[teamId];
  if (!team) return league;
  const phase = ctx.phase ?? league.season.phase;
  const game = ctx.game !== undefined ? ctx.game : teamGameOf(league, teamId, phase, week);
  const club = ensureClub(league);
  const fx = staffEffects(league, team);
  const hc = teamStaff(league, team).HC;
  const roster = team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => p !== undefined);
  const shared = resultEvents(league, team, game, fx.motivation);
  const teamGames = Math.max(0, (league.season.standings[teamId]?.results.length ?? 0));
  const stamp = injuryStampWeek(league, phase, week);
  const hurtThisWeek = new Set<string>((game?.result?.injuries ?? []).map((i) => i.playerId));
  const passAttempts = roster.reduce((s, p) => s + (league.season.stats[p.id]?.passing.attempts ?? 0), 0);
  const tenure = { ...club.tenure };
  // An unseeded ledger (syncRosterMoves never ran) treats everyone as established, not as a new arrival.
  const seeded = Object.keys(club.tenure).length > 0;
  const year = leagueCapYear(league);
  const players = { ...league.players };
  const rookieBoost = mentorshipBoost(teamStarters(league, team));
  for (const p of roster) {
    const events: MoraleEvent[] = [...shared];
    const known = tenure[p.id];
    if (known && known.teamId !== null && known.teamId !== teamId) events.push({ type: 'traded' });
    if (!known || known.teamId !== teamId) tenure[p.id] = { teamId, since: known || seeded ? year : year - 1 };
    if (isBenchedStarter(team, roster, p)) events.push({ type: 'benched', magnitude: T.benchedMagnitude });
    else if (isListedStarter(team, roster, p)) {
      const line = league.season.stats[p.id];
      const expected = p.position === 'K' || p.position === 'P' ? T.specialistSnapsPerGame : T.expectedSnapsPerGame;
      const perGame = line && teamGames > 0 ? line.snaps / teamGames : null;
      if (perGame !== null && teamGames >= T.minGamesForSnaps && perGame < expected * T.lowSnapsShare) events.push({ type: 'benched', magnitude: T.lowSnapsMagnitude });
      else if (game && !game.isPreseason) events.push({ type: 'playingTime', magnitude: T.playingTimeMagnitude });
    }
    // Only an injury suffered in this week's game: preseason injuries all share stamp week 0, so the stamp alone
    // would hit a player hurt in preseason week 1 again in weeks 2 and 3.
    if (p.injury && p.injury.occurredYear === league.season.year && p.injury.occurredWeek === stamp && hurtThisWeek.has(p.id)) {
      events.push({ type: 'injury', magnitude: T.injuryMagnitude[p.injury.severity] });
    }
    let q: Player = p;
    // Rookies and veterans react differently (career-stage.ts); rookies also lean on the veterans around them.
    for (const e of stageEvents(p, events)) q = { ...q, morale: adjustMorale(q, e) };
    if (careerStage(p) === 'rookie' && rookieBoost > 0) q = { ...q, morale: { ...q.morale, confidence: clamp(Math.round(q.morale.confidence + rookieBoost), 0, 100) } };
    if (phase === 'regularSeason' && p.contract && p.contract.yearsRemaining <= 1 && p.askingSalary > p.contract.salary * T.underpaidRatio) {
      q = { ...q, morale: nudge(q, -T.contractYearAnxiety, 'contract') };
    }
    const flags = club.playerFlags[p.id] ?? [];
    if (flags.includes('disgruntled')) q = { ...q, morale: nudge(q, -T.disgruntledPerWeek, 'benched') };
    if (flags.includes('targetsPromised') && passAttempts > 0) {
      const share = (league.season.stats[p.id]?.receiving.targets ?? 0) / passAttempts;
      if (share < T.targetShareFloor) q = { ...q, morale: nudge(q, -T.brokenPromisePerWeek, 'playingTime') };
    }
    const m = q.morale;
    const rel = hc?.traits.includes('playersCoach') ? T.playersCoachRelationship : hc?.traits.includes('disciplinarian') ? T.disciplinarianRelationship : 0;
    const drift = (v: number): number => clamp(Math.round(v + (T.driftTarget - v) * T.driftRate), 0, 100);
    q = { ...q, morale: { morale: drift(m.morale), confidence: drift(m.confidence), coachRelationship: clamp(Math.round(m.coachRelationship + rel), 0, 100) } };
    players[p.id] = q;
  }
  const bonus = { ...club.chemistryBonus, [teamId]: Math.round((club.chemistryBonus[teamId] ?? 0) * T.chemistryBonusDecay * 100) / 100 };
  const next = withClub({ ...league, players }, { tenure, chemistryBonus: bonus });
  const chemistry = teamChemistry(next, team);
  return { ...next, teams: { ...next.teams, [teamId]: { ...team, chemistry } } };
};

/** weeklyMorale for every team. */
export const weeklyMoraleAll = (league: League, week: number, ctx: Omit<WeeklyMoraleContext, 'game'> = {}): League => {
  let out = league;
  for (const id of Object.keys(league.teams) as TeamId[]) out = weeklyMorale(out, id, week, ctx);
  return out;
};

/** Depth-chart starters of a team (every position's starter slots). */
export const teamStarters = (league: Pick<League, 'players'>, team: Pick<Team, 'depthChart'>): Player[] => {
  const out: Player[] = [];
  for (const pos of POSITIONS) {
    for (const id of (team.depthChart[pos] ?? []).slice(0, STARTER_COUNTS[pos])) {
      const p = league.players[id];
      if (p) out.push(p);
    }
  }
  return out;
};

/**
 * Team chemistry 0..100: trait/morale/experience chemistry of the roster (teams/ratings), roster continuity
 * (share of players here since before this season), leaders and mentors among the starters, the head
 * coach's style, disgruntled players and event adjustments (ClubState.chemistryBonus).
 */
export const teamChemistry = (league: League, team: Pick<Team, 'id' | 'rosterIds' | 'depthChart' | 'staffIds' | 'headCoachId'>): number => {
  const T = MORALE_TUNING;
  const roster = team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => p !== undefined);
  if (roster.length === 0) return 50;
  const club = ensureClub(league);
  const year = leagueCapYear(league);
  const established = roster.filter((p) => {
    const t: RosterTenure | undefined = club.tenure[p.id];
    return !t || (t.teamId === team.id && t.since < year);
  }).length;
  const continuity = (established / roster.length - T.continuityPivot) * T.continuityWeight;
  const leaders = teamStarters(league, team).reduce((s, p) => s + (p.traits.includes('leader') ? 1 : 0) + (p.traits.includes('mentor') ? 0.5 : 0), 0);
  const hc = teamStaff(league, team).HC;
  const coach = (hc?.traits.includes('playersCoach') ? 3 : 0) + (hc?.traits.includes('motivator') ? 1 : 0) + (hc?.traits.includes('disciplinarian') ? 1 : 0);
  const disgruntled = roster.filter((p) => (club.playerFlags[p.id] ?? []).includes('disgruntled')).length;
  const value = rosterChemistry(roster) + continuity + Math.min(T.leaderCap, leaders * T.leaderBonus) + coach
    - Math.min(T.disgruntledChemistryCap, disgruntled * T.disgruntledChemistry) + (club.chemistryBonus[team.id] ?? 0);
  return clamp(Math.round(value), 0, 100);
};

/**
 * Per-player attribute multiplier for a game (for the GameSetup builder): players/personality
 * moraleEffectOnPerformance shaded ±chemistryPerformance by team chemistry.
 */
export const moraleEffects = (league: League, teamId: TeamId): Record<PlayerId, number> => {
  const team = league.teams[teamId];
  if (!team) return {};
  const chem = 1 + ((clamp(team.chemistry, 0, 100) - 50) / 50) * MORALE_TUNING.chemistryPerformance;
  const out: Record<PlayerId, number> = {};
  for (const id of team.rosterIds) {
    const p = league.players[id];
    if (p) out[id] = Math.round(moraleEffectOnPerformance(p.morale) * chem * 10000) / 10000;
  }
  return out;
};

/**
 * Players with attributes scaled by their morale multiplier (injuryResistance untouched; values rounded and
 * clamped to 1..99; the cached overall is left as is). Players without a multiplier are returned unchanged.
 */
export const applyMoraleEffects = (players: Readonly<Record<PlayerId, Player>>, effects: Readonly<Record<PlayerId, number>>): Record<PlayerId, Player> => {
  const out: Record<PlayerId, Player> = {};
  for (const [id, p] of Object.entries(players) as [PlayerId, Player][]) {
    const m = effects[id];
    if (m === undefined || m === 1) {
      out[id] = p;
      continue;
    }
    const attrs = { ...p.attrs };
    for (const k of ATTRIBUTE_KEYS) if (k !== 'injuryResistance') attrs[k] = clamp(Math.round(p.attrs[k] * m), 1, 99);
    out[id] = { ...p, attrs };
  }
  return out;
};

/* ------------------------------------------------------------ roster moves */

/** One roster move since the tenure ledger was last synced. */
export interface RosterChange {
  playerId: PlayerId;
  from: TeamId | null;
  to: TeamId | null;
  overall: number;
  /** True for a player never seen before (a draftee or a newly generated free agent). */
  newcomer: boolean;
}

/** Arrivals and departures since the last sync (empty before the tenure ledger was first seeded). */
export const rosterChanges = (league: League): RosterChange[] => {
  const tenure = ensureClub(league).tenure;
  if (Object.keys(tenure).length === 0) return [];
  const out: RosterChange[] = [];
  for (const p of Object.values(league.players)) {
    const t = tenure[p.id];
    if (!t) {
      if (p.teamId !== null) out.push({ playerId: p.id, from: null, to: p.teamId, overall: p.overall, newcomer: true });
    } else if (t.teamId !== p.teamId) out.push({ playerId: p.id, from: t.teamId, to: p.teamId, overall: p.overall, newcomer: false });
  }
  for (const [id, t] of Object.entries(tenure)) {
    const retired = league.retiredPlayers[id as PlayerId];
    if (!league.players[id as PlayerId] && t.teamId !== null) out.push({ playerId: id as PlayerId, from: t.teamId, to: null, overall: retired?.overall ?? 0, newcomer: false });
  }
  return out.sort((a, b) => (a.playerId < b.playerId ? -1 : 1));
};

const starMagnitude = (overall: number): number => clamp((overall - MORALE_TUNING.starOverall + 4) / 6, 0.5, 2.5);

/**
 * Reacts to roster moves since the last sync and records tenure for every active player: a star arriving
 * (trade or signing) excites the fans, a first-round draftee too; a star leaving for another team upsets
 * them; a player arriving by trade takes the 'traded' morale hit; team-specific event flags are cleared for
 * movers. The first call only seeds the ledger (everyone counts as established).
 */
export const syncRosterMoves = (league: League): { league: League; changes: RosterChange[] } => {
  const club = ensureClub(league);
  const seeded = Object.keys(club.tenure).length > 0;
  const year = leagueCapYear(league);
  const changes = rosterChanges(league);
  let out = league;
  const players = { ...league.players };
  const playerFlagsNext = { ...club.playerFlags };
  for (const c of changes) {
    const p = players[c.playerId];
    if (c.to !== null && p) {
      const drafted = c.newcomer && p.draft !== null && p.draft.round === 1 && p.experience === 0;
      if (drafted) out = applyFanEvent(out, c.to, 'draftPick', 1);
      else if (c.overall >= MORALE_TUNING.starOverall) out = applyFanEvent(out, c.to, 'bigSigning', starMagnitude(c.overall));
      if (c.from !== null) players[p.id] = { ...p, morale: adjustMorale(p, { type: 'traded' }) };
    }
    if (c.from !== null && c.to !== null && c.overall >= MORALE_TUNING.starOverall) out = applyFanEvent(out, c.from, 'starTraded', starMagnitude(c.overall));
    if (c.from !== null) {
      const kept = (playerFlagsNext[c.playerId] ?? []).filter((f) => f === 'retiring');
      if (kept.length) playerFlagsNext[c.playerId] = kept;
      else delete playerFlagsNext[c.playerId];
    }
  }
  const tenure: Record<string, RosterTenure> = {};
  for (const p of Object.values(league.players)) {
    const t = club.tenure[p.id];
    tenure[p.id] = t && t.teamId === p.teamId ? t : { teamId: p.teamId, since: seeded ? year : year - 1 };
  }
  // Fan events only touch teams, so the players map built above is still the complete, current one.
  out = withClub({ ...out, players }, { tenure, playerFlags: playerFlagsNext });
  return { league: out, changes };
};

/* ------------------------------------------------------------ season flags */

/** Player flags that belong to one season (event decisions); cleared when the club year closes. */
const SEASONAL_FLAGS: readonly PlayerFlag[] = ['tradeBlock', 'holdout', 'extensionTalks', 'disgruntled', 'targetsPromised'];

/** Clears the seasonal player flags and drops flags of players who left the league ('retiring' is kept for
 *  active players: retirement.ts honours it at the next retirement pass). */
export const resetSeasonFlags = (league: League): League => {
  const flags = ensureClub(league).playerFlags;
  const playerFlags: Record<string, PlayerFlag[]> = {};
  for (const [id, list] of Object.entries(flags)) {
    if (!league.players[id as PlayerId]) continue;
    const kept = list.filter((f) => !SEASONAL_FLAGS.includes(f));
    if (kept.length) playerFlags[id] = kept;
  }
  return withClub(league, { playerFlags });
};
