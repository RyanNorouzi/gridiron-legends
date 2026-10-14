/**
 * Pure text formatters shared by every franchise screen: money ($12.3M / $950K), cap share, ratings with a
 * colour tone per tier, ages, W-L-T records, ordinals, height/weight, positions, contract summaries
 * ("3y $42.0M ($14.0M/yr)"), league dates ("2027 Wk 5"), injuries, morale and trait labels.
 *
 * Colours are never hard-coded here: formatters return a semantic `Tone` which `toneColor` resolves against
 * the active Theme, so colorblind modes (which remap success/warning/danger) apply automatically. The pixel
 * font upper-cases everything at draw time, so strings keep natural casing.
 */
import { contractApy } from '@/franchise/contracts';
import type { SeasonPhase } from '@/franchise/types';
import type { Contract, DevTrait, InjuryStatus, Position } from '@/players/types';
import type { Theme } from '../../theme';

/** Semantic colour of a piece of text, resolved against the theme by `toneColor`. */
export type Tone = 'normal' | 'dim' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

/** Text plus an optional tone (default 'normal'). */
export interface ToneText {
  text: string;
  tone?: Tone;
}

/** Theme colour for a tone. Status tones follow the theme's colorblind remapping. */
export const toneColor = (theme: Theme, tone: Tone = 'normal'): string => {
  const c = theme.colors;
  switch (tone) {
    case 'dim': return c.textDim;
    case 'accent': return c.accent;
    case 'info': return c.accent2;
    case 'success': return c.success;
    case 'warning': return c.warning;
    case 'danger': return c.danger;
    default: return c.text;
  }
};

/* --------------------------------- money --------------------------------- */

/** Compact dollars: $1.2B, $12.3M, $950K, $500; negatives keep a leading minus ("-$2.0M"). */
export const formatMoney = (amount: number): string => {
  if (!Number.isFinite(amount)) return '$?';
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const thousands = Math.round(abs / 1e3);
  if (abs < 1000) return `${sign}$${Math.round(abs)}`;
  if (thousands < 1000) return `${sign}$${thousands}K`;
  const millions = Math.round(abs / 1e5) / 10;
  if (millions < 1000) return `${sign}$${millions.toFixed(1)}M`;
  return `${sign}$${(Math.round(abs / 1e8) / 10).toFixed(1)}B`;
};

/** Share of the cap as a percentage with one decimal ("12.3%"); "0.0%" for a non-positive cap. */
export const formatCapPct = (amount: number, cap: number): string =>
  cap > 0 ? `${((amount / cap) * 100).toFixed(1)}%` : '0.0%';

/** Fraction 0..1 as a percentage ("45.5%"); `digits` decimals (default 1). */
export const formatPercent = (fraction: number, digits = 1): string =>
  Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : '-';

/** Signed integer delta: "+3", "-2", "0". */
export const formatSigned = (n: number): string => (n > 0 ? `+${Math.round(n)}` : `${Math.round(n)}`);

/* -------------------------------- ratings -------------------------------- */

/** Rating tiers, best first. */
export type RatingTier = 'elite' | 'great' | 'good' | 'average' | 'weak' | 'poor';

/** Tier of a 1..99 rating: 90+ elite, 80+ great, 70+ good, 60+ average, 50+ weak, else poor. */
export const ratingTier = (rating: number): RatingTier =>
  rating >= 90 ? 'elite' : rating >= 80 ? 'great' : rating >= 70 ? 'good' : rating >= 60 ? 'average' : rating >= 50 ? 'weak' : 'poor';

const TIER_TONE: Record<RatingTier, Tone> = {
  elite: 'accent', great: 'success', good: 'info', average: 'normal', weak: 'warning', poor: 'danger',
};

/** Tone for a rating tier (elite gold, great green, good blue, average plain, weak orange, poor red). */
export const ratingTone = (rating: number): Tone => TIER_TONE[ratingTier(rating)];

/** Rating as text with its tier tone; null/NaN renders as a dim "?". */
export const formatRating = (rating: number | null | undefined): ToneText =>
  rating === null || rating === undefined || !Number.isFinite(rating)
    ? { text: '?', tone: 'dim' }
    : { text: String(Math.round(rating)), tone: ratingTone(rating) };

/** A rating range "68-74" toned by its midpoint (a single value when lo === hi). */
export const formatRatingRange = (lo: number, hi: number): ToneText => {
  const a = Math.round(Math.min(lo, hi));
  const b = Math.round(Math.max(lo, hi));
  return { text: a === b ? String(a) : `${a}-${b}`, tone: ratingTone((a + b) / 2) };
};

/* ------------------------------ people & bio ------------------------------ */

/** Age as "27", or "Age 27" in long form. */
export const formatAge = (age: number, long = false): string => (long ? `Age ${Math.round(age)}` : String(Math.round(age)));

/** Height in inches as feet-inches: 74 -> 6'2". */
export const formatHeight = (inches: number): string => {
  const total = Math.max(0, Math.round(inches));
  return `${Math.floor(total / 12)}'${total % 12}"`;
};

/** Weight in pounds: "215 lb". */
export const formatWeight = (lb: number): string => `${Math.round(lb)} lb`;

/** "Rookie" for 0 seasons, else "5 yrs" ("1 yr"). */
export const formatExperience = (seasons: number): string =>
  seasons <= 0 ? 'Rookie' : seasons === 1 ? '1 yr' : `${seasons} yrs`;

/**
 * A player name for a narrow table cell: the full name when it has at most `max` characters, else the first
 * initial plus the rest ("Marquis Whitfield" -> "M. Whitfield"), so the surname stays readable.
 */
export const compactName = (name: string, max = 14): string => {
  const trimmed = name.trim();
  const cut = trimmed.indexOf(' ');
  if (trimmed.length <= max || cut <= 0) return trimmed;
  return `${trimmed.slice(0, 1)}. ${trimmed.slice(cut + 1)}`;
};

/** `Column.shorten` for name cells: always the initial form ("Marquis Whitfield (TB)" -> "M. Whitfield (TB)"). */
export const initialName = (text: string): string => compactName(text, 0);

/** English ordinal: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 102nd. */
export const ordinal = (n: number): string => {
  const i = Math.round(n);
  const mod100 = Math.abs(i) % 100;
  const mod10 = Math.abs(i) % 10;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
  return `${i}${suffix}`;
};

/** A W-L-T record; ties are shown only when non-zero unless `alwaysTies`. */
export const formatRecord = (r: { wins: number; losses: number; ties?: number }, alwaysTies = false): string => {
  const ties = r.ties ?? 0;
  return ties > 0 || alwaysTies ? `${r.wins}-${r.losses}-${ties}` : `${r.wins}-${r.losses}`;
};

/** Win/loss streak: +3 -> "W3", -2 -> "L2", 0 -> "-". */
export const formatStreak = (streak: number): string => (streak > 0 ? `W${streak}` : streak < 0 ? `L${-streak}` : '-');

/** Full position names for cards and tooltips. */
export const POSITION_NAMES: Readonly<Record<Position, string>> = Object.freeze({
  QB: 'Quarterback', RB: 'Running Back', FB: 'Fullback', WR: 'Wide Receiver', TE: 'Tight End',
  OT: 'Offensive Tackle', OG: 'Offensive Guard', C: 'Center', DE: 'Defensive End', DT: 'Defensive Tackle',
  OLB: 'Outside Linebacker', MLB: 'Middle Linebacker', CB: 'Cornerback', FS: 'Free Safety', SS: 'Strong Safety',
  K: 'Kicker', P: 'Punter',
});

/** Position abbreviations joined with "/" ("QB/RB"); "-" for none. */
export const formatPositions = (positions: readonly string[]): string => (positions.length > 0 ? positions.join('/') : '-');

/** camelCase identifier to words: "hotHeaded" -> "Hot Headed", "seasonEnding" -> "Season Ending". */
export const humanize = (id: string): string =>
  id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** Development trait label. */
export const formatDevTrait = (trait: DevTrait): string => humanize(trait);

/* ------------------------------- contracts ------------------------------- */

/**
 * Contract summary "3y $42.0M ($14.0M/yr)": years, total value (APY x years) and APY (salary + prorated
 * bonus). `remaining` summarises only the years left. Null contracts read "No contract".
 */
export const formatContract = (c: Contract | null | undefined, opts: { remaining?: boolean } = {}): string => {
  if (!c) return 'No contract';
  const years = Math.max(0, opts.remaining ? c.yearsRemaining : c.years);
  const apy = contractApy(c);
  // A deal with no seasons left is over: "0y $0" read like a free contract.
  if (years === 0) return `Expired (was ${formatMoney(apy)}/yr)`;
  return `${years}y ${formatMoney(apy * years)} (${formatMoney(apy)}/yr)`;
};

/* ---------------------------------- dates --------------------------------- */

const PHASE_LABELS: Record<SeasonPhase, string> = {
  preseason: 'Preseason', regularSeason: 'Regular Season', playoffs: 'Playoffs', awards: 'Awards',
  offseason: 'Offseason', resigning: 'Re-signing', freeAgency: 'Free Agency', draft: 'Draft',
  postDraft: 'Post-Draft', trainingCamp: 'Training Camp',
};

/** Human label for a season phase. */
export const phaseLabel = (phase: SeasonPhase): string => PHASE_LABELS[phase];

/**
 * League date: "2027 Wk 5" (regular season), "2027 Pre Wk 2", "2027 Wild Card" (playoffs with round names,
 * else "2027 Playoffs Rd 1"), and "2027 Free Agency" for phases without weeks.
 */
export const formatDate = (year: number, week: number, phase: SeasonPhase = 'regularSeason', roundNames: readonly string[] = []): string => {
  if (week > 0) {
    if (phase === 'regularSeason') return `${year} Wk ${week}`;
    if (phase === 'preseason') return `${year} Pre Wk ${week}`;
    if (phase === 'playoffs') return `${year} ${roundNames[week - 1] ?? `Playoffs Rd ${week}`}`;
  }
  return `${year} ${phaseLabel(phase)}`;
};

/* ------------------------------ health & mood ------------------------------ */

/** Tone for a 0..100 mood value: 70+ success, 40+ normal, 25+ warning, else danger. */
export const moodTone = (value: number): Tone => (value >= 70 ? 'success' : value >= 40 ? 'normal' : value >= 25 ? 'warning' : 'danger');

/** Word for a 0..100 mood value. */
export const moodLabel = (value: number): string =>
  value >= 85 ? 'Ecstatic' : value >= 70 ? 'Happy' : value >= 40 ? 'Content' : value >= 25 ? 'Unhappy' : 'Furious';

/** Injury summary "Lower Body - Short (3 wks)" toned by severity, or "Healthy". */
export const formatInjury = (injury: InjuryStatus | null | undefined): ToneText => {
  if (!injury) return { text: 'Healthy', tone: 'success' };
  const weeks = injury.weeksRemaining === 1 ? '1 wk' : `${injury.weeksRemaining} wks`;
  const tone: Tone = injury.severity === 'minor' ? 'warning' : 'danger';
  return { text: `${humanize(injury.bodyArea)} - ${humanize(injury.severity)} (${weeks})`, tone };
};
