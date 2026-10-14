/**
 * Post-game data: team stat rows, leaders (passers, rushers, receivers, defenders, kickers) with names from
 * the setup, the scoring summary and the play log, all aggregated from GameState.stats + playLog. Pure.
 */
import type { PlayerId } from '@/core/ids';
import { formatClock } from '@/core/time';
import type { GameSetup, GameState, PlayLogEntry, TeamSide } from '@/game/types';
import { shortName, type Player } from '@/players/types';
import { leadersBy, passerRating, teamGameSummary, type PlayerStatLine, type TeamGameSummary } from '@/statistics/index';
import { generatedPbp } from './session-flow';

export interface TeamStatRow {
  label: string;
  home: string;
  away: string;
}

export interface LeaderLine {
  playerId: PlayerId;
  name: string;
  position: string;
  /** Compact stat line, e.g. "18/27 · 231 YDS · 2 TD". */
  line: string;
  value: number;
}

export interface SideLeaders {
  passing: LeaderLine[];
  rushing: LeaderLine[];
  receiving: LeaderLine[];
  defense: LeaderLine[];
  kicking: LeaderLine[];
}

export interface ScoringPlay {
  quarter: number;
  clock: string;
  side: TeamSide;
  text: string;
  score: Record<TeamSide, number>;
}

export interface PostGameData {
  score: Record<TeamSide, number>;
  winner: TeamSide | null;
  abbr: Record<TeamSide, string>;
  names: Record<TeamSide, string>;
  quarters: number;
  overtime: boolean;
  teamRows: TeamStatRow[];
  summary: Record<TeamSide, TeamGameSummary>;
  leaders: Record<TeamSide, SideLeaders>;
  scoring: ScoringPlay[];
  playLog: string[];
}

/** A rate, or '-' when there were no attempts (0% would claim every attempt failed). */
const pct = (v: number, attempts = 1): string => (attempts > 0 ? `${Math.round(v)}%` : '-');
const num = (v: number): string => `${Math.round(v)}`;
const dec = (v: number, d = 1): string => v.toFixed(d);

/** Team comparison rows in display order. */
export const teamStatRows = (home: TeamGameSummary, away: TeamGameSummary): TeamStatRow[] => [
  { label: 'TOTAL YARDS', home: num(home.totalYards), away: num(away.totalYards) },
  { label: 'PASSING', home: num(home.passYards), away: num(away.passYards) },
  { label: 'RUSHING', home: num(home.rushYards), away: num(away.rushYards) },
  { label: 'PLAYS', home: num(home.plays), away: num(away.plays) },
  { label: 'YDS / PLAY', home: dec(home.yardsPerPlay), away: dec(away.yardsPerPlay) },
  { label: 'FIRST DOWNS', home: num(home.firstDowns), away: num(away.firstDowns) },
  { label: '3RD DOWN', home: pct(home.thirdDownPct, home.thirdDownAttempts), away: pct(away.thirdDownPct, away.thirdDownAttempts) },
  { label: '4TH DOWN', home: pct(home.fourthDownPct, home.fourthDownAttempts), away: pct(away.fourthDownPct, away.fourthDownAttempts) },
  { label: 'RED ZONE', home: pct(home.redZonePct, home.redZoneTrips), away: pct(away.redZonePct, away.redZoneTrips) },
  { label: 'TURNOVERS', home: num(home.turnovers), away: num(away.turnovers) },
  { label: 'SACKS', home: num(home.sacks), away: num(away.sacks) },
  // Half-the-distance enforcement leaves fractional yards: the line shows whole yards ("6-60", never "6-59.5").
  { label: 'PENALTIES', home: `${home.penalties}-${num(home.penaltyYards)}`, away: `${away.penalties}-${num(away.penaltyYards)}` },
  { label: 'POSSESSION', home: formatClock(home.timeOfPossessionSec), away: formatClock(away.timeOfPossessionSec) },
  { label: 'EXPLOSIVE', home: num(home.explosivePlays), away: num(away.explosivePlays) },
  { label: 'EPA', home: dec(home.epa), away: dec(away.epa) },
];

const passingLine = (l: PlayerStatLine): string => {
  const p = l.passing;
  const parts = [`${p.completions}/${p.attempts}`, `${p.yards} YDS`];
  if (p.touchdowns) parts.push(`${p.touchdowns} TD`);
  if (p.interceptions) parts.push(`${p.interceptions} INT`);
  parts.push(`${passerRating(p).toFixed(1)} RTG`);
  return parts.join(' · ');
};
const rushingLine = (l: PlayerStatLine): string => {
  const r = l.rushing;
  const parts = [`${r.attempts} CAR`, `${r.yards} YDS`];
  if (r.touchdowns) parts.push(`${r.touchdowns} TD`);
  if (r.longest) parts.push(`LG ${r.longest}`);
  return parts.join(' · ');
};
const receivingLine = (l: PlayerStatLine): string => {
  const r = l.receiving;
  const parts = [`${r.receptions}/${r.targets}`, `${r.yards} YDS`];
  if (r.touchdowns) parts.push(`${r.touchdowns} TD`);
  if (r.drops) parts.push(`${r.drops} DROP`);
  return parts.join(' · ');
};
const defenseLine = (l: PlayerStatLine): string => {
  const d = l.defense;
  const parts = [`${d.tackles} TKL`];
  if (d.sacks) parts.push(`${d.sacks} SCK`);
  if (d.tfl) parts.push(`${d.tfl} TFL`);
  if (d.interceptions) parts.push(`${d.interceptions} INT`);
  if (d.passBreakups) parts.push(`${d.passBreakups} PBU`);
  if (d.forcedFumbles) parts.push(`${d.forcedFumbles} FF`);
  return parts.join(' · ');
};
const kickingLine = (l: PlayerStatLine): string => {
  const k = l.kicking;
  const parts: string[] = [];
  if (k.fgAttempts) parts.push(`FG ${k.fgMade}/${k.fgAttempts}${k.fgLong ? ` LG ${k.fgLong}` : ''}`);
  if (k.xpAttempts) parts.push(`XP ${k.xpMade}/${k.xpAttempts}`);
  if (k.punts) parts.push(`${k.punts} PUNTS · ${(k.puntYards / k.punts).toFixed(1)} AVG`);
  return parts.join(' · ');
};

const defenseValue = (l: PlayerStatLine): number => l.defense.tackles + l.defense.sacks * 4 + l.defense.interceptions * 6 + l.defense.passBreakups * 2 + l.defense.forcedFumbles * 4 + l.defense.tfl;
const kickingValue = (l: PlayerStatLine): number => l.kicking.fgMade * 3 + l.kicking.xpMade + l.kicking.punts;

/** Leaders for one side, names resolved from the roster. `n` rows per category. */
export const sideLeaders = (stats: Record<PlayerId, PlayerStatLine>, players: Record<PlayerId, Player>, n = 3): SideLeaders => {
  const own: Record<PlayerId, PlayerStatLine> = {};
  for (const id of Object.keys(players) as PlayerId[]) {
    const line = stats[id];
    if (line) own[id] = line;
  }
  const rows = (board: { playerId: PlayerId; value: number }[], fmt: (l: PlayerStatLine) => string): LeaderLine[] =>
    board.map((e) => {
      const p = players[e.playerId] as Player;
      const line = own[e.playerId] as PlayerStatLine;
      return { playerId: e.playerId, name: shortName(p), position: p.position, line: fmt(line), value: e.value };
    });
  return {
    passing: rows(leadersBy(own, (l) => l.passing.yards, n, (l) => l.passing.attempts > 0), passingLine),
    rushing: rows(leadersBy(own, (l) => l.rushing.yards, n, (l) => l.rushing.attempts > 0), rushingLine),
    receiving: rows(leadersBy(own, (l) => l.receiving.yards, n, (l) => l.receiving.targets > 0), receivingLine),
    defense: rows(leadersBy(own, defenseValue, n, (l) => defenseValue(l) > 0), defenseLine),
    kicking: rows(leadersBy(own, kickingValue, 1, (l) => l.kicking.fgAttempts + l.kicking.xpAttempts + l.kicking.punts > 0), kickingLine),
  };
};

const scoringText = (e: PlayLogEntry): string => {
  const o = e.outcome;
  if (o.safety) return 'SAFETY';
  if (o.touchdown) return o.turnover ? `DEFENSIVE TD${o.returnYards ? ` · ${Math.round(o.returnYards)} YD RETURN` : ''}` : `${o.result === 'pass' ? 'PASSING' : o.result === 'kickoff' || o.result === 'punt' ? 'RETURN' : 'RUSHING'} TD · ${Math.round(o.yards)} YDS`;
  if (o.result === 'fieldGoal') return `FIELD GOAL · ${Math.round(o.kickDistance ?? 0)} YDS`;
  if (o.result === 'extraPoint') return 'EXTRA POINT';
  if (o.result === 'twoPoint') return 'TWO-POINT CONVERSION';
  return `${o.points} POINTS`;
};

/** Every scoring play in order with the running score. */
export const scoringSummary = (log: readonly PlayLogEntry[]): ScoringPlay[] =>
  log.filter((e) => e.outcome.points > 0 && e.outcome.scoringSide).map((e) => ({
    quarter: e.quarter, clock: formatClock(e.clock), side: e.outcome.scoringSide as TeamSide, text: scoringText(e), score: { ...e.scoreAfter },
  }));

/** Play log lines: "Q2 4:12 (2nd & 7 at OPP 34) ATL: ..." describing each play from its applied facts (clean, rounded). */
export const playLogLines = (setup: GameSetup, log: readonly PlayLogEntry[]): string[] =>
  log.map((e) => `Q${e.quarter} ${formatClock(e.clock)} ${generatedPbp(setup, e)}`);

/** Everything the post-game screen shows. */
export const buildPostGame = (setup: GameSetup, state: GameState, leadersPerCategory = 3): PostGameData => {
  const s = teamGameSummary(state.stats);
  const score = { home: state.score.home, away: state.score.away };
  return {
    score,
    winner: score.home > score.away ? 'home' : score.away > score.home ? 'away' : null,
    abbr: { home: setup.home.team.abbr, away: setup.away.team.abbr },
    names: { home: `${setup.home.team.city} ${setup.home.team.name}`, away: `${setup.away.team.city} ${setup.away.team.name}` },
    quarters: state.clock.quarter,
    overtime: state.overtimePeriods > 0,
    teamRows: teamStatRows(s.home, s.away),
    summary: { home: s.home, away: s.away },
    leaders: {
      home: sideLeaders(state.stats.players, setup.home.players, leadersPerCategory),
      away: sideLeaders(state.stats.players, setup.away.players, leadersPerCategory),
    },
    scoring: scoringSummary(state.playLog),
    playLog: playLogLines(setup, state.playLog),
  };
};
