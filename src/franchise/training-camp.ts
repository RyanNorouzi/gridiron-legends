/**
 * Training camp (the last offseason phase before the year rolls over). Per team:
 * - small attribute gains: expected points = basePoints x intensity gain x strength-staff factor (staff.ts
 *   staffEffects conditioning) x age factor x sqrt(devTrait multiplier); each point goes to the player's focus
 *   attribute (focusShare of the time) or a position-weighted attribute, never pushing the overall past the
 *   potential. Injured players sit out.
 * - camp injuries: `reps` contact rolls through players/injuries `rollInjury` with the intensity's contact and
 *   fatigue (hard camps hurt more players); the medical center avoids some (injuryChanceMultiplier) and, with the
 *   conditioning staff, shortens the rest (facilities.ts treatedInjuryWeeks). The rollover (phase.ts startNewSeason) still runs the offseason
 *   injury countdown after camp, so camp injuries are stored padded by SEASON_CONFIG.offseasonRecoveryWeeks and
 *   reach the season with exactly the weeks reported here.
 * - incoming rookies' overall settles: ability revealed within +-rookieSettleMax of the draft-day number.
 * - position battles (last starter vs first backup within battleMargin before camp) are resolved into the depth
 *   chart: AI teams (and the user's when `autoDepthChart`) get autoDepthChart with morale breaking exact ties.
 * The user team uses `choices.intensity` and `choices.focus`; AI teams `choices.aiIntensity` (default normal).
 * Camp stores the team-overall snapshot COY uses next season. Once per offseason ('camp' task flag). Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { clamp, lerp, ratingToFactor } from '@/core/math';
import { applyAttrDeltas, computeOverall, diffAttrs, positionWeights } from '@/players/attributes';
import { ageCurveFactor, devTraitMultiplier } from '@/players/development';
import { applyInjury, canPlayHurt, rollInjury } from '@/players/injuries';
import { ATTRIBUTE_KEYS, POSITIONS, type AttributeKey, type AttributeSet, type InjurySeverity, type Player, type Position } from '@/players/types';
import { STARTER_COUNTS, autoDepthChart, isAvailable } from '@/teams/depth-chart';
import { teamRatings } from '@/teams/ratings';
import type { DepthChart, Team } from '@/teams/types';
import { awardsSection, isTaskDone, markTask, numberPair, numberRecord } from './awards';
import { facilityEffects, treatedInjuryWeeks } from './facilities';
import { isIncomingRookie } from './progression';
import { isUserTeam } from './roster';
import { SEASON_CONFIG } from './settings';
import { staffEffects } from './staff';
import type { League } from './types';

/** Camp workload. */
export type CampIntensity = 'light' | 'normal' | 'hard';
/** Every intensity. */
export const CAMP_INTENSITIES: readonly CampIntensity[] = ['light', 'normal', 'hard'];

/** Camp tuning (awards.json "camp"). */
export interface CampConfig {
  reps: number;
  basePoints: number;
  focusShare: number;
  intensity: Record<CampIntensity, Record<'gain' | 'contact' | 'fatigue', number>>;
  strengthCoachRange: [number, number];
  veteranFactor: number;
  battleMargin: number;
  rookieSettleSd: number;
  rookieSettleMax: number;
}

const loadConfig = (): CampConfig => {
  const raw = awardsSection('camp');
  const intensity = {} as CampConfig['intensity'];
  for (const i of CAMP_INTENSITIES) intensity[i] = numberRecord(awardsSection(`camp.intensity.${i}`), ['gain', 'contact', 'fatigue'], `camp.intensity.${i}`, 0);
  return {
    ...numberRecord(raw, ['reps', 'basePoints', 'focusShare', 'veteranFactor', 'battleMargin', 'rookieSettleSd', 'rookieSettleMax'], 'camp', 0),
    intensity,
    strengthCoachRange: numberPair(raw.strengthCoachRange, 'camp.strengthCoachRange'),
  };
};

/** Validated camp tuning. */
export const CAMP_CONFIG: CampConfig = loadConfig();

/** The user's camp decisions. */
export interface CampChoices {
  /** User-team intensity (default 'normal'). */
  intensity?: CampIntensity;
  /** Per-player focus for the user's team; persisted as Player.trainingFocus. */
  focus?: Partial<Record<PlayerId, AttributeKey>>;
  /** Intensity for AI teams (default 'normal'). */
  aiIntensity?: CampIntensity;
  /** Let camp rebuild the user's depth chart too (default false: the manual order is kept). */
  autoDepthChart?: boolean;
}

/** One player's camp gains. */
export interface CampGain { playerId: PlayerId; overallBefore: number; overallAfter: number; deltas: Partial<AttributeSet> }
/** One camp injury (weeksOut as the season will see it). */
export interface CampInjury { playerId: PlayerId; severity: InjurySeverity; weeksOut: number }
/** A resolved position battle. */
export interface PositionBattle {
  position: Position;
  winner: PlayerId;
  loser: PlayerId;
  winnerOverall: number;
  loserOverall: number;
  decidedBy: 'overall' | 'morale';
}
/** A rookie whose ability was revealed. */
export interface RookieReveal { playerId: PlayerId; before: number; after: number }

/** Everything that happened at one team's camp. */
export interface CampReport {
  teamId: TeamId;
  intensity: CampIntensity;
  gains: CampGain[];
  injuries: CampInjury[];
  battles: PositionBattle[];
  rookies: RookieReveal[];
  overallBefore: number;
  overallAfter: number;
}

const moraleScore = (p: Player): number => p.morale.morale + p.morale.confidence;

/** autoDepthChart with morale (morale + confidence) breaking exact overall ties inside each position. */
export const campDepthChart = (players: readonly Player[]): DepthChart => {
  const chart = autoDepthChart(players);
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const pos of POSITIONS) {
    const list = chart[pos].map((id, i) => ({ p: byId.get(id) as Player, i }));
    list.sort((a, b) => {
      const av = isAvailable(a.p) ? 0 : 1, bv = isAvailable(b.p) ? 0 : 1;
      if (av !== bv) return av - bv;
      if (a.p.overall !== b.p.overall) return b.p.overall - a.p.overall;
      return moraleScore(b.p) - moraleScore(a.p) || a.i - b.i;
    });
    chart[pos] = list.map((x) => x.p.id);
  }
  return chart;
};

/** Strength-staff multiplier on camp gains from staff.ts staffEffects conditioning (strength coach + head coach). */
const strengthFactor = (league: League, team: Team, cfg: CampConfig): number =>
  lerp(cfg.strengthCoachRange[0], cfg.strengthCoachRange[1], ratingToFactor(staffEffects(league, team).conditioning));

const ageFactor = (p: Player, cfg: CampConfig): number => {
  const f = ageCurveFactor(p.position, p.age);
  return f > 0 ? Math.max(cfg.veteranFactor, f) : f === 0 ? cfg.veteranFactor : cfg.veteranFactor / 2;
};

const pickAttribute = (rng: Rng, position: Position): AttributeKey => {
  const w = positionWeights(position);
  const keys = ATTRIBUTE_KEYS.filter((k) => (w[k] ?? 0) > 0);
  return rng.weighted(keys, keys.map((k) => w[k] ?? 0));
};

/** Camp gains for one player (new object; the input is untouched). */
const campGains = (p: Player, expected: number, focus: AttributeKey | null, rng: Rng, cfg: CampConfig): Player => {
  const points = Math.floor(expected) + (rng.chance(expected - Math.floor(expected)) ? 1 : 0);
  let attrs = p.attrs;
  for (let i = 0; i < points; i++) {
    const key = focus && rng.chance(cfg.focusShare) ? focus : pickAttribute(rng, p.position);
    if (attrs[key] >= 99) continue;
    const next = applyAttrDeltas(attrs, { [key]: 1 });
    if (computeOverall(next, p.position) > p.potential) continue;
    attrs = next;
  }
  return attrs === p.attrs ? p : { ...p, attrs, overall: computeOverall(attrs, p.position) };
};

/** Moves a rookie's overall by `delta` through position-weighted attribute points (potential raised if passed). */
const settleRookie = (p: Player, delta: number, rng: Rng): Player => {
  if (delta === 0) return p;
  const target = clamp(p.overall + delta, 1, 99);
  let attrs = p.attrs;
  for (let guard = 0; guard < 200 && computeOverall(attrs, p.position) !== target; guard++) {
    const key = pickAttribute(rng, p.position);
    attrs = applyAttrDeltas(attrs, { [key]: computeOverall(attrs, p.position) < target ? 1 : -1 });
  }
  const overall = computeOverall(attrs, p.position);
  return { ...p, attrs, overall, potential: Math.max(p.potential, overall) };
};

/** Battles: last starter vs first backup within battleMargin, per position (pre-camp chart order). */
const openBattles = (chart: DepthChart, byId: ReadonlyMap<PlayerId, Player>, cfg: CampConfig): [PlayerId, PlayerId][] => {
  const out: [PlayerId, PlayerId][] = [];
  for (const pos of POSITIONS) {
    const n = STARTER_COUNTS[pos];
    const list = chart[pos].filter((id) => byId.has(id));
    const a = list[n - 1], b = list[n];
    if (!a || !b) continue;
    const pa = byId.get(a) as Player, pb = byId.get(b) as Player;
    if (isAvailable(pa) && isAvailable(pb) && Math.abs(pa.overall - pb.overall) <= cfg.battleMargin) out.push([a, b]);
  }
  return out;
};

/**
 * Runs camp for every team (see the module header). Returns the League (players, depth charts and cached ratings
 * updated; preseason rating snapshot stored) and a report per team, in team-id order. A second call in the same
 * offseason returns the League unchanged with no reports.
 */
export const runTrainingCamp = (league: League, rng: Rng, choices: CampChoices = {}, cfg: CampConfig = CAMP_CONFIG): { league: League; reports: CampReport[] } => {
  const year = league.season.year;
  if (isTaskDone(league, year, 'camp')) return { league, reports: [] };
  const players: League['players'] = { ...league.players };
  const teams: League['teams'] = { ...league.teams };
  const reports: CampReport[] = [];
  const ratings: Record<string, number> = {};
  for (const team of Object.values(league.teams).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const user = isUserTeam(league, team);
    const intensity = (user ? choices.intensity : choices.aiIntensity) ?? 'normal';
    const load = cfg.intensity[intensity];
    const teamRng = rng.fork(`camp:${team.id}`);
    const strength = strengthFactor(league, team, cfg);
    const medical = facilityEffects(team);
    const recovery = staffEffects(league, team).injuryRecoveryBonus;
    const before = team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => p !== undefined);
    const beforeById = new Map(before.map((p) => [p.id, p]));
    const battles = openBattles(campDepthChart(before), beforeById, cfg);
    const report: CampReport = { teamId: team.id, intensity, gains: [], injuries: [], battles: [], rookies: [], overallBefore: team.overall, overallAfter: team.overall };
    for (const p0 of before) {
      const prng = teamRng.fork(`p:${p0.id}`);
      let p = p0;
      const chosen = user ? choices.focus?.[p.id] : undefined;
      if (chosen) p = { ...p, trainingFocus: chosen };
      if (isIncomingRookie(league, p)) {
        const delta = clamp(Math.round(prng.gaussian(0, cfg.rookieSettleSd)), -cfg.rookieSettleMax, cfg.rookieSettleMax);
        const settled = settleRookie(p, delta, prng);
        report.rookies.push({ playerId: p.id, before: p.overall, after: settled.overall });
        p = settled;
      }
      if (canPlayHurt(p)) {
        const expected = cfg.basePoints * load.gain * strength * ageFactor(p, cfg) * Math.sqrt(devTraitMultiplier(p.devTrait));
        const trained = campGains(p, expected, p.trainingFocus, prng, cfg);
        if (trained !== p) report.gains.push({ playerId: p.id, overallBefore: p.overall, overallAfter: trained.overall, deltas: diffAttrs(p.attrs, trained.attrs) });
        p = trained;
        for (let rep = 0; rep < cfg.reps; rep++) {
          const injury = rollInjury(prng, p, {
            contact: load.contact, fatigue: load.fatigue, playCount: rep, injuriesEnabled: league.settings.injuriesEnabled, weatherSlick: 0, year: year + 1, week: 0,
          });
          // Medical center: some knocks are avoided outright, the rest heal faster (with the conditioning staff).
          if (!injury || (medical.injuryChanceMultiplier < 1 && !prng.chance(medical.injuryChanceMultiplier))) continue;
          const weeksOut = treatedInjuryWeeks(team, injury.weeksRemaining, recovery);
          report.injuries.push({ playerId: p.id, severity: injury.severity, weeksOut });
          p = applyInjury(p, { ...injury, weeksRemaining: weeksOut + SEASON_CONFIG.offseasonRecoveryWeeks });
          break;
        }
      }
      if (p !== p0) players[p.id] = p;
    }
    const roster = team.rosterIds.map((id) => players[id]).filter((p): p is Player => p !== undefined);
    const depthChart = user && !choices.autoDepthChart ? team.depthChart : campDepthChart(roster);
    const r = teamRatings(roster, depthChart);
    teams[team.id] = { ...team, depthChart, overall: r.overall, offenseRating: r.offense, defenseRating: r.defense };
    for (const [a, b] of battles) {
      const pa = players[a] as Player, pb = players[b] as Player;
      const aFirst = campDepthChart([pa, pb])[pa.position][0] === a;
      const [w, l] = aFirst ? [pa, pb] : [pb, pa];
      report.battles.push({ position: pa.position, winner: w.id, loser: l.id, winnerOverall: w.overall, loserOverall: l.overall, decidedBy: w.overall === l.overall ? 'morale' : 'overall' });
    }
    report.overallAfter = r.overall;
    ratings[team.id] = r.overall;
    reports.push(report);
  }
  const next: League = { ...league, players, teams };
  return { league: markTask(next, year, 'camp', { preseasonRatings: { year: year + 1, ratings } }), reports };
};

/** Every camp injury across reports (for events). */
export const campInjuries = (reports: readonly CampReport[]): (CampInjury & { teamId: TeamId })[] =>
  reports.flatMap((r) => r.injuries.map((i) => ({ ...i, teamId: r.teamId })));
