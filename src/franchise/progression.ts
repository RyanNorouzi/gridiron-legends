/**
 * Offseason progression, aging and in-season development.
 *
 * `offseasonProgression` runs players/development `progressPlayer` for every rostered player and free agent (not
 * the incoming rookie class, whose ability is revealed at camp instead). The context comes from the club layer:
 * the development rating is staff.ts `coachDevelopmentFor` (position coach + coordinator, head coach, developer
 * trait), the facility level is facilities.ts `progressionFacilityLevel` (development center for the young, training
 * complex for veterans), snaps come from last season's regular-season + playoff lines (estimated from games when a
 * simulator does not track snaps), and team success is the win percentage plus a playoff/title bonus. Free agents
 * train alone (awards.json progression.freeAgent*).
 * Growth and decline move morale; breakouts, jumps, slumps and declines are returned for events. A player with a
 * progression entry for the season is skipped, so a second pass is a no-op.
 *
 * `advanceAges` adds a year of age and experience once per offseason (the season rollover does not);
 * `weeklyDevelopment` is the in-season hook: tiny gains for young players who are getting snaps, likelier with a
 * good development staff and facilities. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { clamp01 } from '@/core/math';
import { computeOverall, positionWeights } from '@/players/attributes';
import { ageCurveFactor, devTraitMultiplier, progressPlayer, type ProgressionContext } from '@/players/development';
import { adjustMorale } from '@/players/personality';
import { ATTRIBUTE_KEYS, fullName, type AttributeKey, type Player, type Position, type ProgressionKind } from '@/players/types';
import type { Team } from '@/teams/types';
import { awardsSection, flagsFor, isTaskDone, markTask, numberRecord } from './awards';
import { facilityGrowthMultiplier, progressionFacilityLevel } from './facilities';
import { seedOf } from './playoffs';
import { beginRosterEdit, refreshTeamInPlace } from './roster';
import { coachDevelopmentFor as staffDevelopmentFor } from './staff';
import { winPct } from './standings';
import type { League } from './types';

const P_KEYS = [
  'freeAgentCoachRating', 'freeAgentFacilityLevel', 'freeAgentTeamSuccess', 'snapsPerStart', 'snapsPerGame', 'championSuccessBonus',
  'playoffSuccessBonus', 'moraleGrowthThreshold', 'moraleDeclineThreshold',
] as const;

/** Progression tuning (awards.json "progression"). */
export interface ProgressionConfig extends Record<(typeof P_KEYS)[number], number> {
  facilityBlend: Record<'development' | 'training', number>;
  weekly: Record<'maxAge' | 'chance' | 'snapsForFull', number>;
}

/** Validated progression tuning. */
export const PROGRESSION_CONFIG: ProgressionConfig = {
  ...numberRecord(awardsSection('progression'), P_KEYS, 'progression'),
  facilityBlend: numberRecord(awardsSection('progression.facilityBlend'), ['development', 'training'], 'progression.facilityBlend', 0),
  weekly: numberRecord(awardsSection('progression.weekly'), ['maxAge', 'chance', 'snapsForFull'], 'progression.weekly', 0),
};

/** Development rating 1..99 a team's staff gives a position (staff.ts; free agents: freeAgentCoachRating). */
export const coachDevelopmentFor = (league: Pick<League, 'coaches'>, team: Team | null, position: Position, cfg: ProgressionConfig = PROGRESSION_CONFIG): number =>
  team ? staffDevelopmentFor(league, team, position) : cfg.freeAgentCoachRating;

/**
 * Facility level 1..5 used for development: facilities.ts progressionFacilityLevel for the player's age, or the
 * facilityBlend of the development and training facilities when no player is given (free agents: freeAgentFacilityLevel).
 */
export const facilityLevelFor = (team: Team | null, cfg: ProgressionConfig = PROGRESSION_CONFIG, player?: Pick<Player, 'age'>): number => {
  if (!team) return cfg.freeAgentFacilityLevel;
  if (player) return progressionFacilityLevel(team, player);
  const b = cfg.facilityBlend;
  return (team.facilities.development * b.development + team.facilities.training * b.training) / Math.max(1e-9, b.development + b.training);
};

/** Snaps a player took last season (regular season + playoffs), estimated from games when snaps were not tracked. */
export const snapsFor = (league: Pick<League, 'season'>, id: PlayerId, cfg: ProgressionConfig = PROGRESSION_CONFIG): number => {
  const lines = [league.season.stats[id], league.season.playoffStats[id]];
  let snaps = 0, estimate = 0;
  for (const l of lines) {
    if (!l) continue;
    snaps += l.snaps;
    estimate += l.gamesStarted * cfg.snapsPerStart + Math.max(0, l.gamesPlayed - l.gamesStarted) * cfg.snapsPerGame;
  }
  return snaps > 0 ? snaps : estimate;
};

/** 0..1 team success last season: win% plus a playoff / championship bonus (free agents: freeAgentTeamSuccess). */
export const teamSuccessFor = (league: Pick<League, 'season'>, teamId: TeamId | null, cfg: ProgressionConfig = PROGRESSION_CONFIG): number => {
  if (!teamId) return cfg.freeAgentTeamSuccess;
  const s = league.season.standings[teamId];
  let v = s ? winPct(s) : 0.5;
  if (league.season.champion === teamId) v += cfg.championSuccessBonus;
  else if (league.season.bracket && seedOf(league.season.bracket, teamId)) v += cfg.playoffSuccessBonus;
  return clamp01(v);
};

/** The progressPlayer context for one player this offseason. */
export const progressionContextFor = (league: League, player: Player, rng: Rng, cfg: ProgressionConfig = PROGRESSION_CONFIG): ProgressionContext => {
  const team = player.teamId ? (league.teams[player.teamId] ?? null) : null;
  return {
    rng, year: league.season.year,
    coachDevelopment: coachDevelopmentFor(league, team, player.position, cfg),
    facilityLevel: facilityLevelFor(team, cfg, player),
    snapsPlayed: snapsFor(league, player.id, cfg),
    teamSuccess: teamSuccessFor(league, player.teamId, cfg),
  };
};

/** One player's offseason development (for the UI and events). */
export interface ProgressionReport {
  playerId: PlayerId;
  teamId: TeamId | null;
  name: string;
  position: Position;
  age: number;
  kind: ProgressionKind;
  overallBefore: number;
  overallAfter: number;
  potentialBefore: number;
  potentialAfter: number;
}

/** Progression kinds that deserve an event. */
export const NOTABLE_PROGRESSION: readonly ProgressionKind[] = ['breakout', 'jump', 'slump', 'decline'];

/** True for a player who joins the league next season (drafted / signed this offseason): camp reveals his ability instead. */
export const isIncomingRookie = (league: Pick<League, 'season'>, p: Pick<Player, 'rookieYear'>): boolean => p.rookieYear > league.season.year;

/**
 * One offseason of development for every active player (see the module header). Returns the League (players
 * replaced, cached team ratings refreshed, AI depth charts rebuilt) and a report per progressed player.
 */
export const offseasonProgression = (league: League, rng: Rng, cfg: ProgressionConfig = PROGRESSION_CONFIG): { league: League; entries: ProgressionReport[] } => {
  const year = league.season.year;
  const work = beginRosterEdit(league);
  const entries: ProgressionReport[] = [];
  const touched = new Set<TeamId>();
  for (const id of (Object.keys(league.players) as PlayerId[]).sort()) {
    const p = league.players[id];
    if (!p || p.retired || isIncomingRookie(league, p) || p.progressionLog.some((e) => e.year === year)) continue;
    if (p.teamId === null && !league.freeAgentIds.includes(id)) continue;
    const { player, entry } = progressPlayer(p, progressionContextFor(league, p, rng.fork(`prog:${id}`), cfg));
    const delta = entry.overallAfter - entry.overallBefore;
    let morale = player.morale;
    if (delta >= cfg.moraleGrowthThreshold) morale = adjustMorale(player, { type: 'praise', magnitude: Math.min(3, delta / 3) });
    else if (delta <= cfg.moraleDeclineThreshold) morale = adjustMorale(player, { type: 'loss', magnitude: Math.min(3, -delta / 3) });
    work.players[id] = { ...player, morale };
    if (p.teamId) touched.add(p.teamId);
    entries.push({
      playerId: id, teamId: p.teamId, name: fullName(p), position: p.position, age: p.age, kind: entry.kind,
      overallBefore: entry.overallBefore, overallAfter: entry.overallAfter, potentialBefore: p.potential, potentialAfter: player.potential,
    });
  }
  for (const t of [...touched].sort()) refreshTeamInPlace(work, t);
  return { league: work, entries };
};

/**
 * Adds one year of age and experience to every active player who was in the league this season (incoming rookies
 * keep their draft age and experience 0). Once per offseason: guarded by the 'aging' task flag.
 */
export const advanceAges = (league: League): League => {
  const year = league.season.year;
  if (isTaskDone(league, year, 'aging')) return league;
  const players: League['players'] = { ...league.players };
  for (const p of Object.values(league.players)) {
    if (isIncomingRookie(league, p)) continue;
    players[p.id] = { ...p, age: p.age + 1, experience: p.experience + 1 };
  }
  return markTask({ ...league, players }, year, 'aging');
};

const weightedAttribute = (rng: Rng, position: Position): AttributeKey => {
  const w = positionWeights(position);
  const keys = ATTRIBUTE_KEYS.filter((k) => (w[k] ?? 0) > 0);
  return rng.weighted(keys, keys.map((k) => w[k] ?? 0));
};

/**
 * Club multiplier on the in-season growth chance: the position's staff development rating (staff.ts
 * coachDevelopmentFor: 0.75 at 1 .. 1.25 at 99) times the facilities' growth multiplier (facilities.ts
 * facilityGrowthMultiplier: training complex, plus the development center for young players).
 */
export const weeklyClubFactor = (league: Pick<League, 'coaches'>, team: Team, player: Pick<Player, 'age' | 'position'>): number =>
  (0.75 + 0.5 * (staffDevelopmentFor(league, team, player.position) / 99)) * facilityGrowthMultiplier(team, player);

/**
 * In-season development hook for week `week`: every rostered player up to weekly.maxAge who is below his
 * potential may gain one point in a position-weighted attribute, with a chance scaled by devTrait, the age curve,
 * his share of snaps so far (snapsFor: estimated from games when the simulator does not track snaps) and his
 * club's staff and facilities (weeklyClubFactor). The overall never passes the potential. Once per (year, week).
 */
export const weeklyDevelopment = (league: League, week: number, rng: Rng, cfg: ProgressionConfig = PROGRESSION_CONFIG): League => {
  const year = league.season.year;
  const last = league.offseasonFlags?.lastWeeklyDevelopment;
  if (last && last.year === year && last.week === week) return league;
  const work = beginRosterEdit(league);
  const touched = new Set<TeamId>();
  const w = cfg.weekly;
  for (const id of (Object.keys(league.players) as PlayerId[]).sort()) {
    const p = league.players[id];
    if (!p || p.teamId === null || p.age > w.maxAge || p.overall >= p.potential) continue;
    const snaps = snapsFor(league, id, cfg);
    const share = clamp01(snaps / (Math.max(1, week) * w.snapsForFull));
    const team = work.teams[p.teamId];
    const club = team ? weeklyClubFactor(league, team, p) : 1;
    const chance = w.chance * devTraitMultiplier(p.devTrait) * Math.max(0, ageCurveFactor(p.position, p.age)) * share * club;
    if (chance <= 0 || !rng.chance(chance)) continue;
    const key = weightedAttribute(rng, p.position);
    if (p.attrs[key] >= 99) continue;
    const attrs = { ...p.attrs, [key]: p.attrs[key] + 1 };
    const overall = computeOverall(attrs, p.position);
    if (overall > p.potential) continue;
    work.players[id] = { ...p, attrs, overall };
    touched.add(p.teamId);
  }
  for (const t of [...touched].sort()) refreshTeamInPlace(work, t);
  const flags = flagsFor(league, league.offseasonFlags?.year ?? year);
  return { ...work, offseasonFlags: { ...flags, lastWeeklyDevelopment: { year, week } } };
};
