/**
 * Season-level measurement harness for the whole-game simulator: generates a league, plays a round-robin slice
 * (every team plays once per round, circle method) through simulateGame and aggregates the season stat sheet —
 * leaders, scoring, records, parity and a whole-yards audit. Shared by season-calibration.test.ts.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Player } from '@/players/types';
import type { PlayerStatLine } from '@/statistics/types';
import { STAT_PATHS, applyDelta, readStat } from '@/statistics/apply';
import { emptyPlayerStatLine } from '@/statistics/empty';
import { generateLeagueEntities, type LeagueEntities } from '@/teams/league-generator';
import { playbookRegistries, quickSetup, simulateGame } from '@/simulation/game-sim';
import { LEAGUE_SIM_OVERTIME_SEC, LEAGUE_SIM_QUARTER_SEC } from '@/franchise/settings';
import { staffPlaycaller } from '@/franchise/sim-real';

export interface TeamRecord { id: TeamId; abbr: string; overall: number; wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number }

export interface Leader { name: string; position: string; value: number; extra: string }

export interface SeasonSummary {
  games: number;
  rounds: number;
  pointsPerTeamGame: number;
  playsPerGame: number;
  passLeader: Leader;
  passTdLeader: Leader;
  recLeader: Leader;
  receptionsLeader: Leader;
  rushLeader: Leader;
  sackLeader: Leader;
  /** Top five rushers / receivers / passers, for the printed report. */
  top: { rush: Leader[]; rec: Leader[]; pass: Leader[] };
  /** Highest single-player share of his team's targets (min 6 games). */
  maxTargetShare: number;
  /** Mean over teams of the team's top target share. */
  meanTopTargetShare: number;
  bestWins: number;
  worstWins: number;
  winSd: number;
  /** Mean |home - away| over all games, and the share of games decided by 28+ / by 7 or fewer. */
  margins: { mean: number; blowoutShare: number; closeShare: number };
  records: TeamRecord[];
  /** Non-integer yard stats found on the season sheet (should be empty). */
  fractional: string[];
  /** League-wide per-team-game averages. */
  perTeamGame: { passYds: number; rushYds: number; passAtt: number; passCmp: number; rushAtt: number; sacks: number; turnovers: number; fgMade: number; fgAtt: number; offTd: number; rzTrips: number; rzTd: number; punts: number; ints: number; fumblesLost: number; fourthAtt: number; fourthConv: number };
}

/** Stats that are legitimately fractional. */
const FRACTIONAL_OK = new Set(['epa', 'receiving.separationTotal', 'defense.sacks']);

/** Adds one game's line into a season line (sums; longest-style stats keep the max). */
const add = (into: PlayerStatLine, line: PlayerStatLine): void => {
  for (const p of STAT_PATHS) {
    const v = readStat(line, p);
    if (v) applyDelta(into, p, v);
  }
};

/** Circle-method pairings for round r of a 2n-team round robin; alternates home/away by round. */
export const roundPairs = (ids: readonly TeamId[], r: number): [TeamId, TeamId][] => {
  const n = ids.length;
  const fixed = ids[0] as TeamId;
  const rest = ids.slice(1);
  const rot = rest.map((_, i) => rest[(i + r) % rest.length] as TeamId);
  const order = [fixed, ...rot];
  const out: [TeamId, TeamId][] = [];
  for (let i = 0; i < n / 2; i++) {
    const a = order[i] as TeamId;
    const b = order[n - 1 - i] as TeamId;
    out.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
  }
  return out;
};

const sd = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

/** Lets the test runner's RPC breathe between rounds (a full season is minutes of synchronous work). */
const yieldToRunner = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Plays `rounds` rounds of a 32-team league generated from `seed` and summarises the season, the way a franchise
 * league sims its games: full-length simulated games (LEAGUE_SIM_QUARTER_SEC quarters, LEAGUE_SIM_OVERTIME_SEC
 * overtime, as franchise/settings leagueSimRuleset) called by both clubs' staffs (franchise/sim-real staffPlaycaller).
 * `formSd` overrides the per-game form SD (undefined = the simulator default); `quarterLengthSec` overrides the quarter.
 */
export const simulateSeason = async (seed: number, rounds = 17, opts: { entities?: LeagueEntities; formSd?: number; quarterLengthSec?: number } = {}): Promise<SeasonSummary> => {
  const entities = opts.entities;
  const league = entities ?? generateLeagueEntities(seed, { year: 2026, salaryCap: 250_000_000 });
  const registries = playbookRegistries();
  const teams = Object.values(league.teams).sort((a, b) => a.abbr.localeCompare(b.abbr));
  const ids = teams.map((t) => t.id);
  const rec = new Map<TeamId, TeamRecord>(teams.map((t) => [t.id, { id: t.id, abbr: t.abbr, overall: t.overall, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }]));
  const lines = new Map<PlayerId, PlayerStatLine>();
  const teamOf = new Map<PlayerId, TeamId>();
  const gamesOf = new Map<PlayerId, number>();
  let games = 0;
  let plays = 0;
  const margins: number[] = [];
  const tot = { passYds: 0, rushYds: 0, passAtt: 0, passCmp: 0, rushAtt: 0, sacks: 0, turnovers: 0, fgMade: 0, fgAtt: 0, offTd: 0, rzTrips: 0, rzTd: 0, punts: 0, ints: 0, fumblesLost: 0, fourthAtt: 0, fourthConv: 0 };
  for (let r = 0; r < rounds; r++) {
    await yieldToRunner();
    for (const [h, a] of roundPairs(ids, r)) {
      const home = league.teams[h];
      const away = league.teams[a];
      if (!home || !away) continue;
      const base = quickSetup(league, home.abbr, away.abbr, { seed: seed * 1000 + r * 37 + games + 1, week: r + 1 });
      const setup = { ...base, ruleset: { ...base.ruleset, quarterLengthSec: opts.quarterLengthSec ?? LEAGUE_SIM_QUARTER_SEC, overtimeLengthSec: LEAGUE_SIM_OVERTIME_SEC } };
      const { result } = simulateGame(setup, { registries, playcaller: staffPlaycaller(setup), ...(opts.formSd !== undefined ? { formSd: opts.formSd } : {}) });
      games += 1;
      plays += result.plays;
      margins.push(Math.abs(result.homeScore - result.awayScore));
      const hr = rec.get(h) as TeamRecord;
      const ar = rec.get(a) as TeamRecord;
      hr.pointsFor += result.homeScore; hr.pointsAgainst += result.awayScore;
      ar.pointsFor += result.awayScore; ar.pointsAgainst += result.homeScore;
      if (result.winner === 'home') { hr.wins++; ar.losses++; } else if (result.winner === 'away') { ar.wins++; hr.losses++; } else { hr.ties++; ar.ties++; }
      for (const side of ['home', 'away'] as const) {
        const t = result.stats.teams[side];
        tot.passYds += t.passYards; tot.rushYds += t.rushYards; tot.sacks += t.sacks; tot.turnovers += t.turnovers; tot.rzTrips += t.redZoneTrips; tot.rzTd += t.redZoneTouchdowns;
        tot.fourthAtt += t.fourthDownAttempts; tot.fourthConv += t.fourthDownConversions;
      }
      for (const [pid, line] of Object.entries(result.stats.players) as [PlayerId, PlayerStatLine][]) {
        const acc = lines.get(pid) ?? emptyPlayerStatLine();
        add(acc, line);
        lines.set(pid, acc);
        tot.passAtt += line.passing.attempts; tot.passCmp += line.passing.completions; tot.rushAtt += line.rushing.attempts; tot.fgMade += line.kicking.fgMade; tot.fgAtt += line.kicking.fgAttempts;
        tot.offTd += line.passing.touchdowns + line.rushing.touchdowns; tot.punts += line.kicking.punts;
        tot.ints += line.passing.interceptions; tot.fumblesLost += line.fumblesLost;
        const p: Player | undefined = league.players[pid];
        if (p?.teamId) teamOf.set(pid, p.teamId);
        if (line.snaps > 0) gamesOf.set(pid, (gamesOf.get(pid) ?? 0) + 1);
      }
    }
  }
  const nameOf = (pid: PlayerId): { name: string; position: string } => {
    const p = league.players[pid];
    const abbr = p?.teamId ? league.teams[p.teamId]?.abbr ?? '?' : '?';
    return { name: p ? `${p.firstName} ${p.lastName} (${abbr})` : pid, position: p?.position ?? '?' };
  };
  const leader = (value: (l: PlayerStatLine) => number, extra: (l: PlayerStatLine) => string): Leader => {
    let best: [PlayerId, PlayerStatLine] | null = null;
    for (const e of lines) if (!best || value(e[1]) > value(best[1])) best = e;
    if (!best) return { name: '-', position: '-', value: 0, extra: '' };
    return { ...nameOf(best[0]), value: value(best[1]), extra: extra(best[1]) };
  };
  const topN = (value: (l: PlayerStatLine) => number, extra: (l: PlayerStatLine) => string): Leader[] =>
    [...lines].sort((a, b) => value(b[1]) - value(a[1])).slice(0, 5).map(([pid, l]) => ({ ...nameOf(pid), value: value(l), extra: extra(l) }));
  const teamTargets = new Map<TeamId, number>();
  for (const [pid, l] of lines) { const t = teamOf.get(pid); if (t) teamTargets.set(t, (teamTargets.get(t) ?? 0) + l.receiving.targets); }
  let maxTargetShare = 0;
  const topShare = new Map<TeamId, number>();
  for (const [pid, l] of lines) {
    const t = teamOf.get(pid);
    const total = t ? teamTargets.get(t) ?? 0 : 0;
    if (!t || total <= 0 || (gamesOf.get(pid) ?? 0) < Math.min(6, rounds)) continue;
    const share = l.receiving.targets / total;
    maxTargetShare = Math.max(maxTargetShare, share);
    topShare.set(t, Math.max(topShare.get(t) ?? 0, share));
  }
  const meanTopTargetShare = topShare.size ? [...topShare.values()].reduce((a, b) => a + b, 0) / topShare.size : 0;
  const fractional: string[] = [];
  for (const [pid, l] of lines) {
    for (const p of STAT_PATHS) {
      if (FRACTIONAL_OK.has(p)) continue;
      const v = readStat(l, p);
      if (!Number.isInteger(v)) fractional.push(`${nameOf(pid).name} ${p}=${v}`);
    }
  }
  const records = [...rec.values()].sort((a, b) => b.wins - a.wins || b.overall - a.overall);
  const wins = records.map((r) => r.wins + 0.5 * r.ties);
  const tg = games * 2;
  return {
    games, rounds,
    pointsPerTeamGame: records.reduce((s, r) => s + r.pointsFor, 0) / tg,
    playsPerGame: plays / Math.max(1, games),
    passLeader: leader((l) => l.passing.yards, (l) => `${l.passing.completions}/${l.passing.attempts} ${l.passing.touchdowns} TD ${l.passing.interceptions} INT`),
    passTdLeader: leader((l) => l.passing.touchdowns, (l) => `${l.passing.yards} yds`),
    recLeader: leader((l) => l.receiving.yards, (l) => `${l.receiving.receptions} rec / ${l.receiving.targets} tgt ${l.receiving.touchdowns} TD`),
    receptionsLeader: leader((l) => l.receiving.receptions, (l) => `${l.receiving.yards} yds / ${l.receiving.targets} tgt`),
    rushLeader: leader((l) => l.rushing.yards, (l) => `${l.rushing.attempts} att ${l.rushing.touchdowns} TD`),
    sackLeader: leader((l) => l.defense.sacks, () => ''),
    top: {
      rush: topN((l) => l.rushing.yards, (l) => `${l.rushing.attempts}`),
      rec: topN((l) => l.receiving.yards, (l) => `${l.receiving.receptions}/${l.receiving.targets}`),
      pass: topN((l) => l.passing.yards, (l) => `${l.passing.touchdowns}td`),
    },
    maxTargetShare,
    meanTopTargetShare,
    bestWins: Math.max(...wins),
    worstWins: Math.min(...wins),
    winSd: sd(wins),
    margins: {
      mean: margins.reduce((a, b) => a + b, 0) / Math.max(1, margins.length),
      blowoutShare: margins.filter((m) => m >= 28).length / Math.max(1, margins.length),
      closeShare: margins.filter((m) => m <= 7).length / Math.max(1, margins.length),
    },
    records,
    fractional,
    perTeamGame: {
      passYds: tot.passYds / tg, rushYds: tot.rushYds / tg, passAtt: tot.passAtt / tg, passCmp: tot.passCmp / tg, rushAtt: tot.rushAtt / tg, sacks: tot.sacks / tg, turnovers: tot.turnovers / tg,
      fgMade: tot.fgMade / tg, fgAtt: tot.fgAtt / tg, offTd: tot.offTd / tg, rzTrips: tot.rzTrips / tg, rzTd: tot.rzTd / tg, punts: tot.punts / tg, ints: tot.ints / tg, fumblesLost: tot.fumblesLost / tg, fourthAtt: tot.fourthAtt / tg, fourthConv: tot.fourthConv / tg,
    },
  };
};

/** Printable report of a season summary. */
export const formatSeason = (s: SeasonSummary): string => {
  const L = (label: string, l: Leader): string => `${label.padEnd(16)} ${String(l.value).padStart(6)}  ${l.name} ${l.position} ${l.extra}`;
  const recs = s.records.map((r) => `${r.abbr} ${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''} (${r.overall})`).join('  ');
  const p = s.perTeamGame;
  return [
    `SEASON: ${s.games} games, ${s.rounds} rounds, ${s.playsPerGame.toFixed(1)} plays/game, ${s.pointsPerTeamGame.toFixed(1)} pts/team-game`,
    `per team game: pass ${p.passYds.toFixed(0)} yds on ${p.passAtt.toFixed(1)} att (${(100 * p.passCmp / Math.max(1, p.passAtt)).toFixed(1)}% cmp), rush ${p.rushYds.toFixed(0)} on ${p.rushAtt.toFixed(1)}, sacks ${p.sacks.toFixed(2)}, TO ${p.turnovers.toFixed(2)} (INT ${p.ints.toFixed(2)} = ${(100 * p.ints / Math.max(1, p.passAtt)).toFixed(1)}% of att, fumbles lost ${p.fumblesLost.toFixed(2)}; 4th-down tries ${p.fourthAtt.toFixed(2)}, conv ${p.fourthConv.toFixed(2)})`,
    `scoring per team game: off TD ${p.offTd.toFixed(2)}, FG ${p.fgMade.toFixed(2)}/${p.fgAtt.toFixed(2)}, red zone ${p.rzTd.toFixed(2)}/${p.rzTrips.toFixed(2)}, punts ${p.punts.toFixed(2)}`,
    L('pass yds', s.passLeader), L('pass TD', s.passTdLeader), L('rec yds', s.recLeader), L('receptions', s.receptionsLeader),
    L('rush yds', s.rushLeader), L('sacks', s.sackLeader),
    `top rush: ${s.top.rush.map((l) => `${l.value}/${l.extra}`).join(', ')}`,
    `top rec:  ${s.top.rec.map((l) => `${l.value}/${l.extra}`).join(', ')}`,
    `top pass: ${s.top.pass.map((l) => `${l.value}/${l.extra}`).join(', ')}`,
    `target share max ${(s.maxTargetShare * 100).toFixed(1)}% mean-top ${(s.meanTopTargetShare * 100).toFixed(1)}%   best ${s.bestWins} wins, worst ${s.worstWins}, win SD ${s.winSd.toFixed(2)}`,
    `margins: mean ${s.margins.mean.toFixed(1)}, 28+ ${(100 * s.margins.blowoutShare).toFixed(0)}%, <=7 ${(100 * s.margins.closeShare).toFixed(0)}%   red-zone TD ${(100 * p.rzTd / Math.max(1e-9, p.rzTrips)).toFixed(0)}%   pass TD leader ${s.passTdLeader.value} (${s.passTdLeader.extra})`,
    `records: ${recs}`,
    `fractional: ${s.fractional.length} ${s.fractional.slice(0, 5).join('; ')}`,
  ].join('\n');
};
