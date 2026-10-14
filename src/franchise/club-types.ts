/**
 * Supporting franchise contract types split out of types.ts (kept under the file-size limit): club-layer records
 * (finance history, roster tenure, extension talks, the weekly practice plan) and the compact play-by-play snap.
 * Re-exported from types.ts; import them from there.
 */
import type { TeamId } from '@/core/ids';
import type { ContractRole } from '@/players/types';
import type { SeasonPhase } from './types';

/** One snap of a compact play-by-play (League.playSummaries). `s` is [away, home] after the play; `k` 0 normal,
 *  1 score, 2 turnover. */
export interface CompactPlay {
  q: number;
  c: number;
  p: 'home' | 'away';
  d: number;
  t: number;
  b: number;
  x: string;
  s: [number, number];
  k: 0 | 1 | 2;
}

/** One closed season of a team's books (club layer, franchise/finances.ts). */
export interface ClubFinanceRecord {
  year: number;
  revenue: number;
  expenses: number;
  profit: number;
  cashEnd: number;
  ownerSubsidy: number;
  ownerConfidence: number;
  averageAttendancePct: number;
}

/** Where and since when a player has been rostered (club layer, franchise/morale.ts). */
export interface RosterTenure {
  teamId: TeamId | null;
  /** League year the player joined teamId. */
  since: number;
}

/** How hard a team practises during the season week (recovery vs sharpness). */
export type PracticePlan = 'rest' | 'normal' | 'intense';

/** One player's contract-extension talks with his team this season (franchise/extension-talks.ts). */
export interface ExtensionTalks {
  teamId: TeamId;
  /** Season year (a record from another year is stale and ignored). */
  year: number;
  /** Phase of the last round (a break-off lasts until the phase changes). */
  phase: SeasonPhase;
  /** Offers refused on merit this season. */
  rounds: number;
  /** Refused offers that were far below his bar (in the current stretch of talks). */
  lowballs: number;
  /** Patience with the talks 0..1: every refused round wears it down, lowballs more; at 0 he breaks off. */
  patience: number;
  /** True once he broke off talks (no new talks until the next phase). */
  brokenOff: boolean;
  /** His last counter: an offer at least as good on every term is signed. */
  counter: { salary: number; years: number; guaranteed: number; signingBonus: number; role: ContractRole } | null;
}
