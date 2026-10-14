/**
 * Rating-based placeholder game simulator (the default GameSimulator until the integrator injects the
 * real whole-game sim). It never runs plays: expected points come from offense-vs-defense team ratings,
 * home field and weather; touchdowns/field goals are Poisson draws; overtime follows the ruleset. It then
 * writes plausible, internally consistent stat lines for every starter (passing = sum of receiving,
 * sacks/interceptions/fumbles credited to the opposing defense, kicker lines match the score) and rolls
 * occasional injuries with players/injuries `rollInjury`. Deterministic per setup.seed.
 */
import type { PlayerId } from '@/core/ids';
import { createRng, type Rng } from '@/core/rng';
import { clamp, clamp01, logistic } from '@/core/math';
import type { Player, Position } from '@/players/types';
import { rollInjury } from '@/players/injuries';
import { fatigueCostFactor } from '@/players/fatigue';
import { teamRatings } from '@/teams/ratings';
import { emptyPlayerStatLine, emptyTeamStatLine } from '@/statistics/empty';
import type { PlayerStatLine, TeamStatLine } from '@/statistics/types';
import type { GameInjury, GameSetup, GameTeamSetup, TeamSide } from '@/game/types';
import { stampSetupTeams, type GameSimResult, type GameSimulator } from './sim-seam';

/** Tuning of the placeholder model. */
export const FALLBACK_TUNING = Object.freeze({
  basePoints: 23,
  /** Expected points per rating point of offense-over-defense edge. */
  pointsPerRating: 0.42,
  homeField: 2.2,
  /** Share of expected points scored through touchdowns (the rest are field goals). */
  touchdownShare: 0.64,
  extraPointRate: 0.94,
  twoPointTryRate: 0.05,
  safetyRate: 0.03,
  /** Regular-season overtime games that still end tied. */
  overtimeTieRate: 0.1,
  plays: 63,
  passShare: 0.58,
  injuryRollsPerStarter: 18,
});

/** Healthy starters (and the next men up used for touches) the placeholder model writes lines for. */
export interface FallbackLineup {
  qb: Player | null; rbs: Player[]; wrs: Player[]; tes: Player[]; fb: Player | null; ol: Player[];
  dl: Player[]; lbs: Player[]; dbs: Player[]; k: Player | null; p: Player | null; starters: Player[];
}

/** Target share by position (receivers) and tackle share by position (defenders). */
const TARGET_WEIGHT: Partial<Record<Position, number>> = { WR: 0.2, TE: 0.13, RB: 0.09, FB: 0.03 };
const TACKLE_WEIGHT: Partial<Record<Position, number>> = { MLB: 0.13, OLB: 0.11, SS: 0.11, FS: 0.09, CB: 0.08, DE: 0.06, DT: 0.05 };

interface Scoring { tds: number; passTds: number; fgMade: number; fgMissed: number; xpAtt: number; xpMade: number; twoPt: number; safeties: number }

const available = (p: Player | undefined): p is Player => !!p && p.injury === null && !p.retired;

const pick = (side: GameTeamSetup, pos: Position, n: number, used: Set<PlayerId>): Player[] => {
  const listed = (side.team.depthChart[pos] ?? []).map((id) => side.players[id]);
  const extra = Object.values(side.players).filter((p) => p.position === pos).sort((a, b) => b.overall - a.overall || (a.id < b.id ? -1 : 1));
  const out: Player[] = [];
  for (const p of [...listed, ...extra]) {
    if (out.length >= n) break;
    if (available(p) && !used.has(p.id)) {
      out.push(p);
      used.add(p.id);
    }
  }
  return out;
};

/** Healthy starters from the depth chart (backups fill in for injured players). */
export const fallbackLineup = (side: GameTeamSetup): FallbackLineup => {
  const used = new Set<PlayerId>();
  const qb = pick(side, 'QB', 1, used)[0] ?? null;
  const rbs = pick(side, 'RB', 2, used), wrs = pick(side, 'WR', 3, used), tes = pick(side, 'TE', 2, used);
  const fb = pick(side, 'FB', 1, used)[0] ?? null;
  const ol = [...pick(side, 'OT', 2, used), ...pick(side, 'OG', 2, used), ...pick(side, 'C', 1, used)];
  const dl = [...pick(side, 'DE', 2, used), ...pick(side, 'DT', 2, used)];
  const lbs = [...pick(side, 'OLB', 2, used), ...pick(side, 'MLB', 1, used)];
  const dbs = [...pick(side, 'CB', 2, used), ...pick(side, 'FS', 1, used), ...pick(side, 'SS', 1, used)];
  const k = pick(side, 'K', 1, used)[0] ?? null, p = pick(side, 'P', 1, used)[0] ?? null;
  const starters = [qb, ...rbs.slice(0, 1), ...wrs, ...tes.slice(0, 1), fb, ...ol, ...dl, ...lbs, ...dbs, k, p].filter((x): x is Player => x !== null);
  return { qb, rbs, wrs, tes, fb, ol, dl, lbs, dbs, k, p, starters };
};

/** Poisson draw (Knuth), for small means. */
export const poisson = (rng: Rng, lambda: number): number => {
  const limit = Math.exp(-Math.max(0, lambda));
  let k = 0;
  for (let prod = rng.next(); prod > limit; prod *= rng.next()) k++;
  return k;
};
const binomial = (rng: Rng, n: number, p: number): number => {
  let k = 0;
  for (let i = 0; i < n; i++) if (rng.chance(p)) k++;
  return k;
};

/** Hands out `count` units one at a time by weight (capped per item when `cap` is given). */
const allocate = <T>(rng: Rng, count: number, items: readonly T[], weight: (t: T) => number, cap?: (t: T) => number): number[] => {
  const got = items.map(() => 0);
  for (let n = 0; n < count && items.length > 0; n++) {
    const w = items.map((t, i) => (cap && got[i]! >= cap(t) ? 0 : Math.max(0, weight(t))));
    if (w.every((x) => x <= 0)) break;
    got[items.indexOf(rng.weighted(items, w))]! += 1;
  }
  return got;
};

/** Splits `total` yards over players with `units` touches each; returns per-player yards and longest gain. */
const spreadYards = (rng: Rng, total: number, units: readonly number[]): { yards: number[]; longest: number[] } => {
  const draws = units.map((u) => Array.from({ length: u }, () => Math.max(0.1, -Math.log(1 - rng.next()))));
  const sumDraws = draws.flat().reduce((a, b) => a + b, 0);
  const scale = sumDraws > 0 ? total / sumDraws : 0;
  const yards = draws.map((d) => Math.round(d.reduce((a, b) => a + b, 0) * scale));
  const diff = total - yards.reduce((a, b) => a + b, 0);
  const top = units.indexOf(Math.max(0, ...units));
  if (top >= 0) yards[top]! += diff;
  const longest = draws.map((d, i) => (d.length === 0 ? 0 : clamp(Math.round(Math.max(...d) * scale), 0, Math.max(0, yards[i]!))));
  return { yards, longest };
};

const lineOf = (lines: Record<PlayerId, PlayerStatLine>, p: Player, snaps: number): PlayerStatLine => {
  let line = lines[p.id];
  if (!line) {
    line = emptyPlayerStatLine();
    line.gamesPlayed = 1;
    line.gamesStarted = 1;
    line.snaps = snaps;
    lines[p.id] = line;
  }
  return line;
};

const expectedPoints = (off: number, def: number, home: boolean, weatherDrag: number): number =>
  Math.max(3, (FALLBACK_TUNING.basePoints + FALLBACK_TUNING.pointsPerRating * (off - def) + (home ? 0.5 : -0.5) * FALLBACK_TUNING.homeField) * weatherDrag);

const rollScoring = (rng: Rng, expected: number): Scoring => {
  const t = FALLBACK_TUNING;
  const tds = poisson(rng, (expected * t.touchdownShare) / 6.95);
  const fgMade = poisson(rng, (expected * (1 - t.touchdownShare)) / 3);
  const fgMissed = poisson(rng, 0.25 + fgMade * 0.12);
  let xpAtt = 0, xpMade = 0, twoPt = 0;
  for (let i = 0; i < tds; i++) {
    if (rng.chance(t.twoPointTryRate)) twoPt += rng.chance(0.48) ? 1 : 0;
    else {
      xpAtt++;
      if (rng.chance(t.extraPointRate)) xpMade++;
    }
  }
  return { tds, passTds: 0, fgMade, fgMissed, xpAtt, xpMade, twoPt, safeties: rng.chance(t.safetyRate) ? 1 : 0 };
};

const pointsOf = (s: Scoring): number => s.tds * 6 + s.xpMade + s.twoPt * 2 + s.fgMade * 3 + s.safeties * 2;

interface UnitRatings { offense: number; defense: number }

/** Offensive stat lines for `lu` (and the matching defensive lines for `def`), returning the team line. */
const writeGame = (
  rng: Rng, lines: Record<PlayerId, PlayerStatLine>, lu: FallbackLineup, def: FallbackLineup, sc: Scoring, r: UnitRatings, opp: UnitRatings, slick: number,
): TeamStatLine => {
  const edge = r.offense - opp.defense;
  const callPlays = clamp(Math.round(rng.gaussian(FALLBACK_TUNING.plays, 6)), 48, 82);
  const passShare = clamp(rng.gaussian(FALLBACK_TUNING.passShare - 0.06 * slick, 0.05), 0.38, 0.74);
  const sacks = poisson(rng, 2.3 * clamp(1 + -edge / 40, 0.4, 2));
  const dropbacks = Math.max(sacks + 8, Math.round(callPlays * passShare));
  const attempts = dropbacks - sacks;
  const qb = lu.qb;
  const acc = qb ? (qb.attrs.throwAccuracy + qb.overall) / 2 : 45;
  const completions = Math.round(attempts * clamp(rng.gaussian(0.62 + (acc - 75) * 0.005 + edge * 0.003, 0.05), 0.4, 0.8));
  const passYards = Math.max(0, Math.round(completions * clamp(rng.gaussian(10.8 + edge * 0.05, 1.3), 5.5, 17)));
  const sackYards = sacks * rng.int(4, 9);
  const ints = poisson(rng, clamp(0.85 - (acc - 70) * 0.02 - edge * 0.02, 0.2, 2.2));
  const rushes = Math.max(10, callPlays - dropbacks);
  const plays = dropbacks + rushes;
  const rb = lu.rbs[0];
  const rushYards = Math.max(rushes, Math.round(rushes * clamp(rng.gaussian(4.3 + ((rb?.overall ?? 60) - 75) * 0.03 + edge * 0.04, 0.6), 2, 7)));
  const fumblesLost = poisson(rng, 0.45);
  sc.passTds = completions === 0 ? 0 : binomial(rng, sc.tds, clamp(0.6 * (passShare / FALLBACK_TUNING.passShare), 0.3, 0.85));
  const rushTds = sc.tds - sc.passTds;
  // Passing and receiving.
  const receivers = [...lu.wrs, ...lu.tes, ...lu.rbs, ...(lu.fb ? [lu.fb] : [])];
  const primary = new Set([lu.wrs[0], lu.tes[0], lu.rbs[0]]);
  const tWeight = (p: Player): number => (TARGET_WEIGHT[p.position] ?? 0.05) * (0.6 + p.overall / 100) * (primary.has(p) ? 1.3 : 1);
  const targets = allocate(rng, attempts, receivers, tWeight);
  const catches = allocate(rng, completions, receivers, (p) => targets[receivers.indexOf(p)]! * (0.5 + p.attrs.catching / 100), (p) => targets[receivers.indexOf(p)]!);
  const recYards = spreadYards(rng, passYards, catches);
  const recTds = allocate(rng, sc.passTds, receivers, (p) => catches[receivers.indexOf(p)]!);
  receivers.forEach((p, i) => {
    if (targets[i] === 0) return;
    const l = lineOf(lines, p, plays);
    Object.assign(l.receiving, {
      targets: targets[i], receptions: catches[i], yards: recYards.yards[i], touchdowns: recTds[i], longest: recYards.longest[i],
      yac: Math.round(recYards.yards[i]! * 0.42), firstDowns: Math.round(catches[i]! * 0.55), airYards: Math.round(recYards.yards[i]! * 0.58),
      separationTotal: Math.round(targets[i]! * rng.range(1.5, 3.2) * 10) / 10, drops: binomial(rng, targets[i]! - catches[i]!, 0.12),
      explosivePlays: recYards.longest[i]! >= 20 ? 1 : 0,
    });
    l.offensivePlays += targets[i]!;
    l.successfulPlays += Math.round(catches[i]! * 0.7);
  });
  if (qb) {
    const l = lineOf(lines, qb, plays);
    Object.assign(l.passing, {
      attempts, completions, yards: passYards, touchdowns: sc.passTds, interceptions: ints, sacks, sackYards,
      longest: Math.max(0, ...recYards.longest), airYards: Math.round(passYards * 0.58), pressures: sacks + poisson(rng, 5), throwaways: poisson(rng, 1),
    });
    l.offensivePlays += dropbacks;
    l.successfulPlays += Math.round(completions * 0.62);
    l.epa += Math.round(((pointsOf(sc) - 20) * 0.35 - ints * 1.5) * 10) / 10;
  }
  // Rushing.
  const carriers = [...lu.rbs, ...(qb ? [qb] : [])];
  const carries = allocate(rng, rushes, carriers, (p) => (p === lu.rbs[0] ? 0.74 : p.position === 'QB' ? 0.07 : 0.19));
  const rushSplit = spreadYards(rng, rushYards, carries);
  const rushTdSplit = allocate(rng, rushTds, carriers, (p) => carries[carriers.indexOf(p)]!);
  const fumbles = allocate(rng, fumblesLost, carriers, (p) => carries[carriers.indexOf(p)]! + 1);
  carriers.forEach((p, i) => {
    if (carries[i] === 0 && fumbles[i] === 0) return;
    const l = lineOf(lines, p, plays);
    Object.assign(l.rushing, {
      attempts: carries[i], yards: rushSplit.yards[i], touchdowns: rushTdSplit[i], longest: rushSplit.longest[i], fumbles: fumbles[i],
      yardsAfterContact: Math.round(Math.max(0, rushSplit.yards[i]!) * 0.45), brokenTackles: poisson(rng, carries[i]! * 0.08),
      firstDowns: Math.round(carries[i]! * 0.22), explosivePlays: rushSplit.longest[i]! >= 12 ? 1 : 0,
    });
    l.fumbles += fumbles[i]!;
    l.fumblesLost += fumbles[i]!;
    l.offensivePlays += carries[i]!;
    l.successfulPlays += Math.round(carries[i]! * 0.42);
  });
  // Blocking, kicking, punting.
  const sacksAllowed = allocate(rng, sacks, lu.ol, () => 1);
  lu.ol.forEach((p, i) => Object.assign(lineOf(lines, p, plays).blocking, { snaps: plays, sacksAllowed: sacksAllowed[i], pancakes: poisson(rng, 1.1), pressuresAllowed: poisson(rng, 1) }));
  const punts = Math.max(0, Math.round(rng.gaussian(5 - pointsOf(sc) / 9, 1.1)));
  if (lu.k) {
    const kickoffs = sc.tds + sc.fgMade + 1;
    Object.assign(lineOf(lines, lu.k, 0).kicking, {
      fgAttempts: sc.fgMade + sc.fgMissed, fgMade: sc.fgMade, fgLong: sc.fgMade > 0 ? rng.int(24, 54) : 0,
      xpAttempts: sc.xpAtt, xpMade: sc.xpMade, kickoffs, touchbacks: binomial(rng, kickoffs, 0.6),
    });
  }
  if (lu.p && punts > 0) {
    Object.assign(lineOf(lines, lu.p, 0).kicking, { punts, puntYards: punts * rng.int(40, 50), puntsInside20: binomial(rng, punts, 0.38), puntLong: rng.int(50, 64) });
  }
  // The opposing defense.
  const d = def;
  const front = [...d.dl, ...d.lbs];
  const everyone = [...d.dl, ...d.lbs, ...d.dbs];
  const tackleWeight = (p: Player): number => TACKLE_WEIGHT[p.position] ?? 0.05;
  const tackleEvents = Math.max(0, rushes + completions - rushTds - sc.passTds);
  const assisted = Math.round(tackleEvents * 0.28);
  const solo = allocate(rng, tackleEvents - assisted, everyone, tackleWeight);
  const assists = allocate(rng, assisted * 2, everyone, tackleWeight);
  const sackCredit = allocate(rng, sacks, front, (p) => (p.position === 'DE' ? 0.35 : p.position === 'DT' ? 0.14 : p.position === 'OLB' ? 0.12 : 0.04));
  const picks = allocate(rng, ints, everyone, (p) => (p.position === 'CB' ? 0.3 : p.position === 'FS' || p.position === 'SS' ? 0.22 : p.position === 'MLB' ? 0.06 : 0.02));
  const breakups = allocate(rng, poisson(rng, 4.5), everyone, (p) => (p.position === 'CB' ? 0.35 : p.position === 'FS' || p.position === 'SS' ? 0.15 : 0.03));
  const forced = allocate(rng, fumblesLost, everyone, tackleWeight);
  const recovered = allocate(rng, fumblesLost, everyone, tackleWeight);
  const tfl = allocate(rng, poisson(rng, 3), front, () => 1);
  const coverage = allocate(rng, attempts, d.dbs.length ? d.dbs : everyone, () => 1);
  everyone.forEach((p, i) => {
    const l = lineOf(lines, p, plays);
    const cov = d.dbs.indexOf(p);
    Object.assign(l.defense, {
      soloTackles: solo[i], assists: assists[i], tackles: solo[i]! + assists[i]!, sacks: sackCredit[front.indexOf(p)] ?? 0,
      tfl: (tfl[front.indexOf(p)] ?? 0) + (sackCredit[front.indexOf(p)] ?? 0), interceptions: picks[i], interceptionYards: picks[i]! * rng.int(0, 25),
      passBreakups: breakups[i], forcedFumbles: forced[i], fumbleRecoveries: recovered[i], missedTackles: poisson(rng, 0.6),
      pressures: (sackCredit[front.indexOf(p)] ?? 0) + (front.includes(p) ? poisson(rng, 0.8) : 0),
      targetsAllowed: cov >= 0 ? coverage[cov] : 0, receptionsAllowed: cov >= 0 ? Math.round(coverage[cov]! * (completions / Math.max(1, attempts))) : 0,
      yardsAllowed: cov >= 0 ? Math.round((coverage[cov]! / Math.max(1, attempts)) * passYards) : 0,
      passRushSnaps: front.includes(p) ? dropbacks : 0, coverageSnaps: cov >= 0 ? dropbacks : 0,
    });
  });
  const netPass = passYards - sackYards;
  const thirdDowns = Math.round(plays * 0.21);
  const trips = sc.tds + Math.ceil(sc.fgMade / 2) + poisson(rng, 0.4);
  return {
    ...emptyTeamStatLine(), points: pointsOf(sc), totalYards: netPass + rushYards, passYards: netPass, rushYards, plays,
    turnovers: ints + fumblesLost, firstDowns: Math.round((netPass + rushYards) / 15) + sc.tds,
    thirdDownAttempts: thirdDowns, thirdDownConversions: binomial(rng, thirdDowns, clamp(0.4 + edge / 150, 0.2, 0.6)),
    fourthDownAttempts: poisson(rng, 0.9), redZoneTrips: trips, redZoneTouchdowns: Math.min(trips, sc.tds),
    explosivePlays: poisson(rng, 4 + edge / 10), successfulPlays: Math.round(plays * clamp(0.44 + edge / 200, 0.3, 0.6)),
    epa: Math.round((pointsOf(sc) - 21) * 3.5) / 10, drives: clamp(Math.round(rng.gaussian(11, 1)), 8, 15),
  };
};

/**
 * Builds a placeholder simulator. The result is deterministic for a given setup.seed; it never returns a
 * tied playoff game, respects ruleset.injuries/fatigue and the overtime format.
 */
export const createFallbackSimulator = (): GameSimulator => (setup: GameSetup): GameSimResult => {
  const rng = createRng(setup.seed).fork('fallback-sim');
  const sides: TeamSide[] = ['home', 'away'];
  const lineups = { home: fallbackLineup(setup.home), away: fallbackLineup(setup.away) };
  const ratings = {
    home: teamRatings(setup.home.players, setup.home.team.depthChart),
    away: teamRatings(setup.away.players, setup.away.team.depthChart),
  };
  const w = setup.weather;
  const drag = clamp(1 - 0.18 * w.fieldSlick - Math.max(0, w.windMph - 10) / 120 - (1 - w.visibility) * 0.15, 0.6, 1);
  const scoring = {
    home: rollScoring(rng, expectedPoints(ratings.home.offense, ratings.away.defense, true, drag)),
    away: rollScoring(rng, expectedPoints(ratings.away.offense, ratings.home.defense, false, drag)),
  };
  let overtime = false;
  if (pointsOf(scoring.home) === pointsOf(scoring.away) && (setup.isPlayoff || setup.ruleset.overtime !== 'none')) {
    overtime = true;
    if (setup.isPlayoff || !rng.chance(FALLBACK_TUNING.overtimeTieRate)) {
      const homeWins = rng.chance(logistic(ratings.home.overall - ratings.away.overall + FALLBACK_TUNING.homeField, 0, 0.12));
      const winner = scoring[homeWins ? 'home' : 'away'];
      if (rng.chance(0.65)) winner.fgMade += 1;
      else winner.tds += 1;
    }
  }
  const players: Record<PlayerId, PlayerStatLine> = {};
  const teams = {
    home: writeGame(rng, players, lineups.home, lineups.away, scoring.home, ratings.home, ratings.away, w.fieldSlick),
    away: writeGame(rng, players, lineups.away, lineups.home, scoring.away, ratings.away, ratings.home, w.fieldSlick),
  };
  for (const s of sides) {
    const o = s === 'home' ? 'away' : 'home';
    teams[s] = { ...teams[s], takeaways: teams[o].turnovers, sacks: lineups[o].qb ? (players[lineups[o].qb.id]?.passing.sacks ?? 0) : 0, pointsAgainst: teams[o].points, yardsAgainst: teams[o].totalYards, timeOfPossessionSec: Math.round((3600 * teams[s].plays) / (teams[s].plays + teams[o].plays)), penalties: setup.ruleset.penalties ? poisson(rng, 6 * setup.ruleset.penaltyFrequency) : 0 };
    teams[s].penaltyYards = teams[s].penalties * rng.int(5, 10);
  }
  for (const s of sides) {
    const starterIds = new Set(lineups[s].starters.map((p) => p.id));
    for (const p of lineups[s].starters) lineOf(players, p, teams[s].plays);
    for (const p of Object.values(setup[s].players)) {
      const line = players[p.id];
      if (line) line.gamesStarted = starterIds.has(p.id) ? 1 : 0;
    }
  }
  const injuries: GameInjury[] = [];
  const fatigue: Record<PlayerId, number> = {};
  const rolls = FALLBACK_TUNING.injuryRollsPerStarter;
  for (const s of sides) {
    for (const p of lineups[s].starters) {
      if (setup.ruleset.fatigue) fatigue[p.id] = clamp01(0.25 + ((players[p.id]?.snaps ?? 0) / 260) * fatigueCostFactor(p.attrs.stamina) + rng.gaussian(0, 0.03));
      for (let i = 0; i < rolls; i++) {
        const injury = rollInjury(rng, p, { contact: rng.range(0.25, 1), fatigue: clamp01(0.35 + (setup.ruleset.fatigue ? setup.fatigue?.[p.id] ?? 0 : 0)), playCount: i * 3, injuriesEnabled: setup.ruleset.injuries, weatherSlick: w.fieldSlick });
        if (!injury) continue;
        injuries.push({ playerId: p.id, severity: injury.severity, quarter: 1 + Math.floor((i / rolls) * 4), playIndex: Math.round((i / rolls) * 130) });
        break;
      }
    }
  }
  return { homeScore: teams.home.points, awayScore: teams.away.points, overtime, stats: stampSetupTeams({ players, teams }, setup), injuries, fatigue };
};

/** The shared default placeholder simulator instance. */
export const fallbackSimulator: GameSimulator = createFallbackSimulator();
