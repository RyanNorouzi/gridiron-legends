/**
 * Shared pure helpers for the team-management tabs: the user's team lookup, the result shape of UI-level
 * League transforms, precise money text for steppers, attribute abbreviations for compact columns and the
 * two-column label/value line table used by info views (finances, staff effects, negotiation terms).
 */
import type { TeamId } from '@/core/ids';
import type { League } from '@/franchise/types';
import type { AttributeKey } from '@/players/types';
import type { Team } from '@/teams/types';
import type { CellValue, Column } from '../kit/data-table';
import type { Tone } from '../kit/format';

/** Result of a UI-initiated League change; `league` is the input League when `ok` is false. */
export interface ActionResult {
  ok: boolean;
  /** Why the action was refused (null when ok). */
  reason: string | null;
  league: League;
  /** Toast text describing what happened. */
  message: string;
}

/** A refused action (League unchanged). */
export const refused = (league: League, reason: string): ActionResult => ({ ok: false, reason, league, message: reason });

/** A successful action. */
export const done = (league: League, message: string): ActionResult => ({ ok: true, reason: null, league, message });

/** The team `teamId` of `league`; throws with a descriptive error when it does not exist. */
export const teamOrThrow = (league: League, teamId: TeamId): Team => {
  const team = league.teams[teamId];
  if (!team) throw new Error(`team ${teamId} does not exist`);
  return team;
};

/** Money with two decimals for millions ("$12.35M"), whole thousands below ("$950K"), used by steppers. */
export const moneyPrecise = (amount: number): string => {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(Math.round(amount));
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`;
  return `${sign}$${abs}`;
};

/** Three-letter attribute abbreviations for compact table headers. */
export const ATTR_ABBR: Readonly<Record<AttributeKey, string>> = Object.freeze({
  speed: 'SPD', acceleration: 'ACC', strength: 'STR', agility: 'AGI', balance: 'BAL', awareness: 'AWR', reaction: 'REA',
  stamina: 'STA', injuryResistance: 'DUR', jumping: 'JMP', hands: 'HND', catching: 'CTH', routeRunning: 'RTE', release: 'RLS',
  throwPower: 'THP', throwAccuracy: 'THA', vision: 'VIS', carrying: 'CAR', tackling: 'TAK', coverage: 'COV', pursuit: 'PUR',
  passRush: 'PRS', blocking: 'BLK', kickPower: 'KPW', kickAccuracy: 'KAC',
});

/** One label/value row of an info view. Headings have an empty value and an accent label. */
export interface InfoLine {
  id: string;
  label: string;
  value: CellValue;
  heading?: boolean;
  /** Optional 0..max bar drawn in the value column instead of text. */
  bar?: { value: number; max?: number; tone?: Tone } | null;
}

/** A heading line. */
export const infoHeading = (id: string, label: string): InfoLine => ({ id, label, value: '', heading: true });

/** Columns of a two-column info table (no sorting; the value may be drawn as a bar). */
export const infoColumns = (labelFlex = 2, valueFlex = 3): Column<InfoLine>[] => [
  { key: 'label', label: 'Item', flex: labelFlex, minWidth: 6, format: (l) => (l.heading ? { text: l.label, tone: 'accent' } : { text: l.label, tone: 'dim' }) },
  { key: 'value', label: 'Value', flex: valueFlex, minWidth: 6, format: (l) => l.value, bar: (l) => (l.bar ? { value: l.bar.value, max: l.bar.max, tone: l.bar.tone } : null) },
];

/** Tone of a 0..100 quality meter (fans, confidence): 70+ success, 45+ normal, 30+ warning, else danger. */
export const meterTone = (value: number): Tone => (value >= 70 ? 'success' : value >= 45 ? 'normal' : value >= 30 ? 'warning' : 'danger');

/** "3 players" / "1 player". */
export const plural = (n: number, word: string, pluralWord = `${word}s`): string => `${n} ${n === 1 ? word : pluralWord}`;
