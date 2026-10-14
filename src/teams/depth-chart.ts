/**
 * Depth charts: 53-man roster composition, automatic ordering by overall, KR/PR selection, validation
 * and manual substitutions. Pure and headless; every function returns new objects.
 *
 * A DepthChart lists, per position slot, the roster players in playing order (index 0 = starter). A
 * player may appear in several slots (a WR who is also KR1). KR/PR are roles, not positions.
 */
import type { PlayerId } from '@/core/ids';
import { POSITIONS } from '@/players/types';
import type { Player, Position } from '@/players/types';
import { canPlayHurt } from '@/players/injuries';
import type { DepthChart, DepthSlot } from '@/teams/types';

/** Active roster size. */
export const ROSTER_SIZE = 53;

/** Players carried per position on a 53-man roster (sums to ROSTER_SIZE). */
export const ROSTER_COMPOSITION: Readonly<Record<Position, number>> = Object.freeze({
  QB: 3, RB: 4, FB: 1, WR: 6, TE: 3, OT: 4, OG: 3, C: 2,
  DE: 4, DT: 4, OLB: 4, MLB: 3, CB: 6, FS: 2, SS: 2, K: 1, P: 1,
});

/** Base-package starters per slot (11 personnel offense, 4-3 defense). FB starts only in heavy sets. */
export const STARTER_COUNTS: Readonly<Record<DepthSlot, number>> = Object.freeze({
  QB: 1, RB: 1, FB: 1, WR: 3, TE: 1, OT: 2, OG: 2, C: 1,
  DE: 2, DT: 2, OLB: 2, MLB: 1, CB: 2, FS: 1, SS: 1, K: 1, P: 1, KR: 1, PR: 1,
});

/** Every depth-chart slot in display order. */
export const DEPTH_SLOTS: readonly DepthSlot[] = [...POSITIONS, 'KR', 'PR'];

/** Positions eligible to return kicks and punts. */
export const RETURNER_POSITIONS: readonly Position[] = ['RB', 'WR', 'CB', 'FS'];

/** Returners listed per return role. */
export const RETURNER_DEPTH = 3;

/** Penalty applied to a starter's return score so backups return kicks unless clearly better. */
const STARTER_RETURN_PENALTY = 6;

/** Categories reported by validateDepthChart. */
export type DepthChartIssueKind =
  | 'unknownPlayer' | 'duplicate' | 'wrongPosition' | 'retired' | 'understaffed' | 'unlisted'
  | 'injuredStarter' | 'ineligibleReturner' | 'missingSlot';

/** One validation finding for a slot (playerId set when a specific player is at fault). */
export interface DepthChartIssue {
  slot: DepthSlot;
  /** Errors make the chart unusable for a game; warnings are advisory. */
  severity: 'error' | 'warning';
  kind: DepthChartIssueKind;
  message: string;
  playerId: PlayerId | null;
}

/** A chart with every slot present and empty. */
export const emptyDepthChart = (): DepthChart => {
  const chart = {} as DepthChart;
  for (const slot of DEPTH_SLOTS) chart[slot] = [];
  return chart;
};

/** Deep copy (new arrays per slot). */
export const cloneDepthChart = (chart: DepthChart): DepthChart => {
  const out = emptyDepthChart();
  for (const slot of DEPTH_SLOTS) out[slot] = [...(chart[slot] ?? [])];
  return out;
};

/** Number of roster players per position. */
export const rosterPositionCounts = (players: readonly Pick<Player, 'position'>[]): Record<Position, number> => {
  const counts = {} as Record<Position, number>;
  for (const pos of POSITIONS) counts[pos] = 0;
  for (const p of players) counts[p.position] += 1;
  return counts;
};

/** True when the player can dress this week (healthy or playing through a light injury). */
export const isAvailable = (player: Pick<Player, 'injury' | 'retired'>): boolean => !player.retired && canPlayHurt(player);

/**
 * Ordering key for a position slot: available players first, then overall desc, then potential desc,
 * then age asc; the id breaks any remaining tie so the order is total and deterministic.
 */
const comparePlayers = (a: Player, b: Player): number => {
  const availA = isAvailable(a) ? 0 : 1;
  const availB = isAvailable(b) ? 0 : 1;
  if (availA !== availB) return availA - availB;
  if (b.overall !== a.overall) return b.overall - a.overall;
  if (b.potential !== a.potential) return b.potential - a.potential;
  if (a.age !== b.age) return a.age - b.age;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Return-role aptitude (0..99 scale): burst and elusiveness dominate, hands matter more for punts
 * (fielding the ball), ball security for both.
 */
export const returnScore = (player: Pick<Player, 'attrs'>, role: 'KR' | 'PR'): number => {
  const a = player.attrs;
  const handsWeight = role === 'PR' ? 0.2 : 0.1;
  const speedWeight = role === 'PR' ? 0.28 : 0.35;
  return (
    a.speed * speedWeight + a.acceleration * 0.2 + a.agility * 0.17 + a.hands * handsWeight + a.carrying * 0.1 + a.vision * 0.05
  );
};

/** Picks returners from RB/WR/CB/FS by returnScore, nudging backups ahead of entrenched starters. */
const pickReturners = (players: readonly Player[], starterIds: ReadonlySet<PlayerId>, role: 'KR' | 'PR'): PlayerId[] => {
  const candidates = players.filter((p) => RETURNER_POSITIONS.includes(p.position) && isAvailable(p));
  const scored = candidates.map((p) => ({ id: p.id, score: returnScore(p, role) - (starterIds.has(p.id) ? STARTER_RETURN_PENALTY : 0) }));
  scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return scored.slice(0, RETURNER_DEPTH).map((s) => s.id);
};

/**
 * Builds a full depth chart: each position ordered by availability then overall; KR/PR chosen from
 * the fastest RB/WR/CB/FS with reliable hands. Players not on the roster list are simply absent.
 */
export const autoDepthChart = (players: readonly Player[]): DepthChart => {
  const chart = emptyDepthChart();
  const starterIds = new Set<PlayerId>();
  for (const pos of POSITIONS) {
    const group = players.filter((p) => p.position === pos && !p.retired).sort(comparePlayers);
    chart[pos] = group.map((p) => p.id);
    for (const p of group.slice(0, STARTER_COUNTS[pos])) starterIds.add(p.id);
  }
  chart.KR = pickReturners(players, starterIds, 'KR');
  chart.PR = pickReturners(players, starterIds, 'PR');
  return chart;
};

/** The first `n` players at a slot (default: the slot's base starter count). */
export const starters = (chart: DepthChart, slot: DepthSlot, n: number = STARTER_COUNTS[slot]): PlayerId[] =>
  (chart[slot] ?? []).slice(0, Math.max(0, n));

/** 0-based rank of a player within a slot, or -1 when not listed. */
export const depthRank = (chart: DepthChart, slot: DepthSlot, playerId: PlayerId): number => (chart[slot] ?? []).indexOf(playerId);

/**
 * Moves `playerId` to `rank` within `slot` (0 = starter), inserting him when he is not yet listed.
 * Other slots are untouched, so a receiver can be promoted to KR1 without leaving the WR list.
 * Returns a new chart; the input is not mutated.
 */
export const applySubstitution = (chart: DepthChart, slot: DepthSlot, playerId: PlayerId, rank = 0): DepthChart => {
  if (!DEPTH_SLOTS.includes(slot)) throw new Error(`applySubstitution: unknown slot '${String(slot)}'`);
  const out = cloneDepthChart(chart);
  const list = out[slot].filter((id) => id !== playerId);
  const index = Math.max(0, Math.min(Math.floor(rank), list.length));
  list.splice(index, 0, playerId);
  out[slot] = list;
  return out;
};

/** Removes a player from every slot (roster cut, trade, retirement). Returns a new chart. */
export const removeFromDepthChart = (chart: DepthChart, playerId: PlayerId): DepthChart => {
  const out = cloneDepthChart(chart);
  for (const slot of DEPTH_SLOTS) out[slot] = out[slot].filter((id) => id !== playerId);
  return out;
};

/**
 * Validates a chart against the roster. Errors: missing slot, unknown/retired/duplicate ids, a slot
 * with fewer entries than its base starter count, a returner outside RETURNER_POSITIONS. Warnings:
 * a player listed under another position, a roster player missing from his position, a starter who
 * cannot dress because of injury.
 */
export const validateDepthChart = (chart: DepthChart, players: readonly Player[]): DepthChartIssue[] => {
  const issues: DepthChartIssue[] = [];
  const byId = new Map<PlayerId, Player>(players.map((p) => [p.id, p]));
  const push = (slot: DepthSlot, severity: 'error' | 'warning', kind: DepthChartIssueKind, message: string, playerId: PlayerId | null = null): void => {
    issues.push({ slot, severity, kind, message, playerId });
  };
  for (const slot of DEPTH_SLOTS) {
    const list = chart[slot];
    if (!Array.isArray(list)) {
      push(slot, 'error', 'missingSlot', `slot ${slot} is missing from the chart`);
      continue;
    }
    const seen = new Set<PlayerId>();
    let valid = 0;
    list.forEach((id, i) => {
      const player = byId.get(id);
      if (!player) {
        push(slot, 'error', 'unknownPlayer', `${slot}${i + 1} refers to unknown player ${id}`, id);
        return;
      }
      if (seen.has(id)) {
        push(slot, 'error', 'duplicate', `${slot}${i + 1}: ${id} is listed twice`, id);
        return;
      }
      seen.add(id);
      if (player.retired) {
        push(slot, 'error', 'retired', `${slot}${i + 1}: ${player.firstName} ${player.lastName} is retired`, id);
        return;
      }
      valid += 1;
      if (slot === 'KR' || slot === 'PR') {
        if (!RETURNER_POSITIONS.includes(player.position)) {
          push(slot, 'error', 'ineligibleReturner', `${slot}${i + 1}: ${player.position} cannot return kicks`, id);
        }
      } else if (player.position !== slot) {
        push(slot, 'warning', 'wrongPosition', `${slot}${i + 1}: ${player.firstName} ${player.lastName} is a ${player.position}`, id);
      }
      if (i < STARTER_COUNTS[slot] && !canPlayHurt(player)) {
        push(slot, 'warning', 'injuredStarter', `${slot}${i + 1}: ${player.firstName} ${player.lastName} is injured (${player.injury?.weeksRemaining ?? 0} wk)`, id);
      }
    });
    if (valid < STARTER_COUNTS[slot]) {
      push(slot, 'error', 'understaffed', `${slot} lists ${valid} usable player(s); ${STARTER_COUNTS[slot]} needed`);
    }
  }
  for (const p of players) {
    if (p.retired) continue;
    const list = chart[p.position];
    if (Array.isArray(list) && !list.includes(p.id)) {
      push(p.position, 'warning', 'unlisted', `${p.firstName} ${p.lastName} (${p.position}) is not on the depth chart`, p.id);
    }
  }
  return issues;
};

/** True when validateDepthChart reports no errors. */
export const isDepthChartValid = (chart: DepthChart, players: readonly Player[]): boolean =>
  validateDepthChart(chart, players).every((i) => i.severity !== 'error');
