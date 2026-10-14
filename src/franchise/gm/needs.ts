/**
 * Team needs and direction for the GM AI. Per position: how far the starters fall short of a good starter,
 * how thin the depth is against ROSTER_COMPOSITION, how old the starters are and whose deals run out. Team
 * direction (contend / retool / rebuild) comes from league-relative strength, record and starter age.
 * Pure; reads only the League.
 */
import type { TeamId } from '@/core/ids';
import { clamp01 } from '@/core/math';
import { ageCurve } from '@/players/development';
import { POSITIONS } from '@/players/types';
import type { Player, Position } from '@/players/types';
import { ROSTER_COMPOSITION, STARTER_COUNTS } from '@/teams/depth-chart';
import { SLOT_WEIGHTS } from '@/teams/ratings';
import type { Team } from '@/teams/types';
import type { League } from '@/franchise/types';
import { contractEndYear, leagueCapYear } from '@/franchise/contracts';
import { teamWinPct } from '@/franchise/negotiation';
import { positionDepth } from '@/franchise/roster';

/** Overall of a starter the AI is happy with. */
export const NEED_TARGET_OVERALL = 78;
/** Overall credited to an empty starting slot. */
export const EMPTY_SLOT_OVERALL = 40;
/** Need at or above which a position is a real hole. */
export const MAJOR_NEED = 0.45;

export interface PositionNeed {
  position: Position;
  /** 0..1: how badly the position needs help. */
  need: number;
  /** need scaled by how much the position swings games (QB highest). Used for ranking. */
  priority: number;
  /** Mean overall of the base-package starters (empty slots count as EMPTY_SLOT_OVERALL). */
  startersQuality: number;
  /** Overall of the weakest starter (the bar an upgrade must clear). */
  weakestStarter: number;
  depthCount: number;
  /** 0..1 share of starters past their position's peak. */
  aging: number;
  /** 0..1 share of starters whose contracts end with the current cap year. */
  expiring: number;
}

export type TeamDirection = 'contend' | 'retool' | 'rebuild';

export interface TeamNeeds {
  teamId: TeamId;
  direction: TeamDirection;
  /** 0..1 blend of league strength percentile and win percentage. */
  strength: number;
  averageStarterAge: number;
  positions: Record<Position, PositionNeed>;
  /** Positions by priority, biggest hole first. */
  ranked: Position[];
  /** Positions with tradeable depth (over composition, or a backup nearly as good as the starters). */
  surplus: Position[];
}

/** How much a position's starters swing a game (first-rank slot weight). */
export const positionImportance = (pos: Position): number => SLOT_WEIGHTS[pos][0] ?? 0.5;

/** Need of one position from its players (best first). */
export const positionNeed = (position: Position, players: readonly Player[], capYear: number): PositionNeed => {
  const starters = STARTER_COUNTS[position];
  const comp = ROSTER_COMPOSITION[position];
  const top = players.slice(0, starters);
  const quals = Array.from({ length: starters }, (_, i) => top[i]?.overall ?? EMPTY_SLOT_OVERALL);
  const startersQuality = quals.reduce((s, v) => s + v, 0) / starters;
  const weakestStarter = Math.min(...quals);
  const quality = clamp01((NEED_TARGET_OVERALL - startersQuality) / 20);
  const depthShort = clamp01((comp - players.length) / comp);
  const peakEnd = ageCurve(position).peakEnd;
  const aging = top.filter((p) => p.age > peakEnd).length / starters;
  const expiring = top.filter((p) => p.contract && contractEndYear(p.contract) <= capYear).length / starters;
  const need = clamp01(0.62 * quality + 0.23 * depthShort + 0.1 * aging + 0.05 * expiring);
  return {
    position, need, priority: need * (0.5 + positionImportance(position) / 2),
    startersQuality, weakestStarter, depthCount: players.length, aging, expiring,
  };
};

/** League-relative strength 0..1: 60% overall percentile, 40% win percentage. */
export const teamStrength = (league: League, team: Team): number => {
  const others = Object.values(league.teams);
  const below = others.filter((t) => t.id !== team.id && t.overall < team.overall).length;
  const ties = others.filter((t) => t.id !== team.id && t.overall === team.overall).length;
  const pct = others.length > 1 ? (below + 0.5 * ties) / (others.length - 1) : 0.5;
  return clamp01(0.6 * pct + 0.4 * teamWinPct(league, team));
};

const starterAge = (depth: Record<Position, Player[]>): number => {
  let sum = 0;
  let n = 0;
  for (const pos of POSITIONS) {
    for (const p of depth[pos].slice(0, STARTER_COUNTS[pos])) {
      sum += p.age;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 27;
};

/** Direction from strength and starter age: strong teams contend, weak or weak-and-old teams rebuild. */
export const directionFor = (strength: number, averageStarterAge: number): TeamDirection => {
  if (strength >= 0.6) return 'contend';
  if (strength < 0.35 || (strength < 0.5 && averageStarterAge >= 29)) return 'rebuild';
  return 'retool';
};

/** Team direction (see directionFor). */
export const teamDirection = (league: League, team: Team): TeamDirection =>
  directionFor(teamStrength(league, team), starterAge(positionDepth(league, team)));

/** Full needs report for a team. */
export const teamNeeds = (league: League, team: Team): TeamNeeds => {
  const capYear = leagueCapYear(league);
  const depth = positionDepth(league, team);
  const positions = {} as Record<Position, PositionNeed>;
  const surplus: Position[] = [];
  for (const pos of POSITIONS) {
    const n = positionNeed(pos, depth[pos], capYear);
    positions[pos] = n;
    const firstBackup = depth[pos][STARTER_COUNTS[pos]];
    if (depth[pos].length > ROSTER_COMPOSITION[pos] || (firstBackup && firstBackup.overall >= n.startersQuality - 3 && n.need < MAJOR_NEED)) surplus.push(pos);
  }
  const ranked = [...POSITIONS].sort((a, b) => positions[b].priority - positions[a].priority || POSITIONS.indexOf(a) - POSITIONS.indexOf(b));
  const strength = teamStrength(league, team);
  const averageStarterAge = starterAge(depth);
  return { teamId: team.id, direction: directionFor(strength, averageStarterAge), strength, averageStarterAge, positions, ranked, surplus };
};
