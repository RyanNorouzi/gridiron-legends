/**
 * Player-card actions for players on the user's roster, as pure checks and League transforms:
 * restructure (salary converted to prorated bonus, with a cap-savings preview), release (dead-money split
 * preview, then roster.ts cutPlayer), franchise / transition tags (offseason before free agency, expiring
 * deals only, one tag per team per offseason, cap checked), trading-block flag, training focus and the
 * position comparison rows. The extension flow lives in negotiation-model.ts. Every transform returns an
 * ActionResult; refusals leave the League untouched and carry the reason.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import {
  capHit, contractEndYear, franchiseTag, leagueCapYear, maxRestructureAmount, minimumSalaryFor, restructure, restructureSavings,
  tagPositionAverage, tagSalary, transitionTag, yearsRemainingAt, type TagKind,
} from '@/franchise/contracts';
import { isFreeAgencyOpen } from '@/franchise/free-agency';
import { extensionAsk, extensionCapIssue } from '@/franchise/negotiation';
import { ensureClub, withClub } from '@/franchise/rivalries';
import { cutPlayer, cutPreview } from '@/franchise/roster';
import { rosterSizeBand } from '@/franchise/roster-rules';
import type { League, PlayerFlag, SeasonPhase } from '@/franchise/types';
import { positionAttributeProfile } from '@/players/attributes';
import { fullName, type AttributeKey, type Player } from '@/players/types';
import { depthRank } from '@/teams/depth-chart';
import { formatMoney, humanize, type ToneText } from '../kit/format';
import { potentialVisibility } from '../kit/player-view';
import { done, refused, type ActionResult } from './common';

/** Ids of the card actions. */
export type PlayerActionId = 'extend' | 'restructure' | 'release' | 'tag' | 'block' | 'focus' | 'compare';

/** One row of the card's Actions section. */
export interface PlayerAction {
  id: PlayerActionId;
  label: string;
  detail: ToneText;
  enabled: boolean;
  reason: string | null;
}

/** Phases in which tags may be applied (before free agency opens). */
export const TAG_PHASES: readonly SeasonPhase[] = ['offseason', 'resigning'];

/** The player when he is on `teamId`'s roster, else null. */
export const ownPlayer = (league: League, teamId: TeamId, playerId: PlayerId): Player | null => {
  const p = league.players[playerId];
  return p && p.teamId === teamId && league.teams[teamId]?.rosterIds.includes(playerId) ? p : null;
};

/* ------------------------------- restructure ------------------------------- */

/** Whether a restructure is possible, with the largest convertible amount. */
export interface RestructureCheck {
  ok: boolean;
  reason: string | null;
  max: number;
  minimumSalary: number;
  year: number;
}

/** Restructure eligibility: two or more seasons left and salary above his minimum. */
export const restructureCheck = (league: League, teamId: TeamId, playerId: PlayerId): RestructureCheck => {
  const year = leagueCapYear(league);
  const p = ownPlayer(league, teamId, playerId);
  const c = p?.contract;
  if (!p || !c) return { ok: false, reason: 'Not under contract with your team', max: 0, minimumSalary: 0, year };
  const minimumSalary = minimumSalaryFor(p.experience, league.settings);
  if (contractEndYear(c) < year) return { ok: false, reason: 'His contract has expired', max: 0, minimumSalary, year };
  const max = maxRestructureAmount(c, minimumSalary, year);
  if (yearsRemainingAt(c, year) < 2) return { ok: false, reason: 'Needs two or more seasons left on the deal', max: 0, minimumSalary, year };
  if (max <= 0) return { ok: false, reason: 'Salary is already at his minimum', max: 0, minimumSalary, year };
  return { ok: true, reason: null, max, minimumSalary, year };
};

/** Cap effect of converting `amount`: this year's saving and the cap hit per remaining season before/after. */
export const restructurePreview = (league: League, playerId: PlayerId, amount: number): { savings: number; years: { year: number; before: number; after: number }[] } => {
  const c = league.players[playerId]?.contract;
  const year = leagueCapYear(league);
  if (!c || amount <= 0) return { savings: 0, years: [] };
  const min = minimumSalaryFor(league.players[playerId]?.experience ?? 0, league.settings);
  const convert = Math.min(amount, maxRestructureAmount(c, min, year));
  if (convert <= 0) return { savings: 0, years: [] };
  const next = restructure(c, convert, { minimumSalary: min, year });
  const years: { year: number; before: number; after: number }[] = [];
  for (let y = year; y <= contractEndYear(c); y++) years.push({ year: y, before: capHit(c, y), after: capHit(next, y) });
  return { savings: restructureSavings(c, convert, year), years };
};

/** Converts `amount` of salary into prorated bonus. */
export const restructurePlayer = (league: League, teamId: TeamId, playerId: PlayerId, amount: number): ActionResult => {
  const check = restructureCheck(league, teamId, playerId);
  if (!check.ok) return refused(league, check.reason ?? 'Cannot restructure');
  if (!Number.isFinite(amount) || amount <= 0 || amount > check.max) return refused(league, `Convert between $1 and ${formatMoney(check.max)}`);
  const p = league.players[playerId] as Player;
  const contract = restructure(p.contract as NonNullable<Player['contract']>, amount, { minimumSalary: check.minimumSalary, year: check.year });
  const saved = restructureSavings(p.contract as NonNullable<Player['contract']>, amount, check.year);
  return done({ ...league, players: { ...league.players, [playerId]: { ...p, contract } } }, `Restructured ${fullName(p)}: saves ${formatMoney(saved)} this year`);
};

/* --------------------------------- release --------------------------------- */

/** Release preview: dead money split, savings and a roster-size warning. */
export interface ReleaseCheck {
  ok: boolean;
  reason: string | null;
  deadThisYear: number;
  deadNextYear: number;
  capSavings: number;
  rosterAfter: number;
  /** Set when the roster would drop below the phase minimum. */
  warning: string | null;
}

/** What releasing the player now would cost. */
export const releaseCheck = (league: League, teamId: TeamId, playerId: PlayerId): ReleaseCheck => {
  const p = ownPlayer(league, teamId, playerId);
  const size = league.teams[teamId]?.rosterIds.length ?? 0;
  if (!p) return { ok: false, reason: 'Not on your roster', deadThisYear: 0, deadNextYear: 0, capSavings: 0, rosterAfter: size, warning: null };
  const prev = cutPreview(league, teamId, playerId);
  const [min] = rosterSizeBand(league, league.season.phase);
  const rosterAfter = size - 1;
  const warning = rosterAfter < min ? `Roster drops to ${rosterAfter} (minimum ${min})` : null;
  return { ok: true, reason: null, ...prev, rosterAfter, warning };
};

/** Releases the player into free agency (dead money booked). */
export const releasePlayer = (league: League, teamId: TeamId, playerId: PlayerId): ActionResult => {
  const check = releaseCheck(league, teamId, playerId);
  if (!check.ok) return refused(league, check.reason ?? 'Cannot release');
  const p = league.players[playerId] as Player;
  const dead = check.deadThisYear + check.deadNextYear;
  return done(cutPlayer(league, teamId, playerId), `Released ${fullName(p)}${dead > 0 ? ` (${formatMoney(dead)} dead money)` : ''}`);
};

/* ----------------------------------- tags ---------------------------------- */

/** One tag choice with its salary and eligibility. */
export interface TagOption {
  kind: TagKind;
  label: string;
  salary: number;
  ok: boolean;
  reason: string | null;
}

/** Why the player cannot be tagged right now (null = eligible apart from the cap). */
export const tagWindowReason = (league: League, teamId: TeamId, playerId: PlayerId): string | null => {
  const p = ownPlayer(league, teamId, playerId);
  const c = p?.contract;
  if (!p || !c) return 'Not under contract with your team';
  if (!TAG_PHASES.includes(league.season.phase) || isFreeAgencyOpen(league)) return 'Tags are applied in the offseason before free agency';
  const year = leagueCapYear(league);
  if (c.tag && c.signedYear === year) return 'Already tagged this offseason';
  if (contractEndYear(c) >= year) return 'Only expiring contracts can be tagged';
  const team = league.teams[teamId];
  const used = team?.rosterIds.some((id) => { const k = league.players[id]?.contract; return !!k && k.tag !== null && k.signedYear === year; });
  if (used) return 'Your team already used its tag this offseason';
  return null;
};

const tagTerms = (salary: number, kind: TagKind): { salary: number; years: number; guaranteed: number; signingBonus: number; role: 'franchise' | 'starter' } =>
  ({ salary, years: 1, guaranteed: salary, signingBonus: 0, role: kind === 'franchise' ? 'franchise' : 'starter' });

/** Franchise and transition tag options (salary = position average or a raise, cap-checked). */
export const tagOptions = (league: League, teamId: TeamId, playerId: PlayerId): TagOption[] => {
  const p = league.players[playerId];
  if (!p) return [];
  const window = tagWindowReason(league, teamId, playerId);
  return (['franchise', 'transition'] as const).map((kind) => {
    const salary = tagSalary(p, tagPositionAverage(league, p.position, kind), kind);
    const cap = window ? null : extensionCapIssue(league, teamId, p, tagTerms(salary, kind), leagueCapYear(league));
    const reason = window ?? (cap ? `Cap: ${cap}` : null);
    return { kind, label: `${humanize(kind)} tag`, salary, ok: reason === null, reason };
  });
};

/** Applies a one-year fully guaranteed tag starting in the cap year. */
export const applyTag = (league: League, teamId: TeamId, playerId: PlayerId, kind: TagKind): ActionResult => {
  const option = tagOptions(league, teamId, playerId).find((o) => o.kind === kind);
  if (!option) return refused(league, 'Unknown player');
  if (!option.ok) return refused(league, option.reason ?? 'Cannot tag');
  const p = league.players[playerId] as Player;
  const avg = tagPositionAverage(league, p.position, kind);
  const year = leagueCapYear(league);
  const contract = kind === 'franchise' ? franchiseTag(p, avg, year) : transitionTag(p, avg, year);
  return done({ ...league, players: { ...league.players, [playerId]: { ...p, contract } } }, `${humanize(kind)} tag on ${fullName(p)}: ${formatMoney(contract.salary)} for ${year}`);
};

/* ------------------------------ trading block ------------------------------ */

/** True when the player carries the trade-block flag. */
export const isOnTradingBlock = (league: League, playerId: PlayerId): boolean => (league.club?.playerFlags[playerId] ?? []).includes('tradeBlock');

/** Adds or removes the trade-block flag. */
export const toggleTradingBlock = (league: League, teamId: TeamId, playerId: PlayerId): ActionResult => {
  const p = ownPlayer(league, teamId, playerId);
  if (!p) return refused(league, 'Not on your roster');
  const club = ensureClub(league);
  const flags = club.playerFlags[playerId] ?? [];
  const on = flags.includes('tradeBlock');
  const next: PlayerFlag[] = on ? flags.filter((f) => f !== 'tradeBlock') : [...flags, 'tradeBlock'];
  const playerFlags = { ...club.playerFlags };
  if (next.length > 0) playerFlags[playerId] = next;
  else delete playerFlags[playerId];
  return done(withClub(league, { playerFlags }), on ? `${fullName(p)} removed from the trading block` : `${fullName(p)} is on the trading block`);
};

/* ------------------------------ training focus ----------------------------- */

/** One training-focus choice ('balanced' or an attribute that counts for his position). */
export interface FocusOption {
  id: 'balanced' | AttributeKey;
  label: string;
  value: number | null;
}

/** Balanced plus every attribute that counts toward his position, most important first. */
export const focusOptions = (player: Player): FocusOption[] => {
  const prof = positionAttributeProfile(player.position);
  return [
    { id: 'balanced', label: 'Balanced', value: null },
    ...[...prof.primary, ...prof.secondary].map((k) => ({ id: k, label: humanize(k), value: player.attrs[k] })),
  ];
};

/** Label of the player's current focus. */
export const focusLabel = (player: Player): string => (player.trainingFocus ? humanize(player.trainingFocus) : 'Balanced');

/** Sets Player.trainingFocus (null = balanced). */
export const setTrainingFocus = (league: League, teamId: TeamId, playerId: PlayerId, focus: AttributeKey | null): ActionResult => {
  const p = ownPlayer(league, teamId, playerId);
  if (!p) return refused(league, 'Not on your roster');
  if (focus !== null && !focusOptions(p).some((o) => o.id === focus)) return refused(league, `${humanize(focus)} does not count for a ${p.position}`);
  return done({ ...league, players: { ...league.players, [playerId]: { ...p, trainingFocus: focus } } }, `${fullName(p)} now trains: ${focus ? humanize(focus) : 'Balanced'}`);
};

/* --------------------------------- compare --------------------------------- */

/** One teammate at the position. */
export interface CompareRow {
  id: PlayerId;
  name: string;
  age: number;
  overall: number;
  potential: ToneText;
  potentialSort: number | null;
  /** 1-based depth rank at his position (null when unlisted). */
  depth: number | null;
  attrs: Record<AttributeKey, number>;
  apy: number;
  self: boolean;
}

/** The attributes compared for a position (its first four primary ratings). */
export const compareKeys = (player: Pick<Player, 'position'>): AttributeKey[] => positionAttributeProfile(player.position).primary.slice(0, 4);

/** The player and every teammate at his position. */
export const compareRows = (league: League, teamId: TeamId, playerId: PlayerId): CompareRow[] => {
  const me = league.players[playerId];
  const team = league.teams[teamId];
  if (!me || !team) return [];
  return team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => !!p && p.position === me.position).map((p) => {
    const vis = potentialVisibility(league, p, teamId);
    const rank = depthRank(team.depthChart, p.position, p.id);
    return {
      id: p.id, name: fullName(p), age: p.age, overall: p.overall, potential: vis.text, potentialSort: vis.mode === 'exact' ? p.potential : null,
      depth: rank >= 0 ? rank + 1 : null, attrs: { ...p.attrs }, apy: p.contract ? capHit(p.contract, leagueCapYear(league)) : 0, self: p.id === playerId,
    };
  });
};

/* --------------------------------- actions --------------------------------- */

/** The card's action rows for a player on `teamId` (empty for anyone else). */
export const playerActions = (league: League, teamId: TeamId, playerId: PlayerId): PlayerAction[] => {
  const p = ownPlayer(league, teamId, playerId);
  const team = league.teams[teamId];
  if (!p || !team) return [];
  const year = leagueCapYear(league);
  const out: PlayerAction[] = [];
  const hasContract = !!p.contract;
  const ask = hasContract ? extensionAsk(p, league, team, year) : null;
  out.push({
    id: 'extend', label: 'Negotiate extension', enabled: hasContract, reason: hasContract ? null : 'He has no contract',
    detail: ask ? { text: `Asks ${formatMoney(ask.apy)}/yr for ${ask.years}y`, tone: 'info' } : { text: 'No contract', tone: 'dim' },
  });
  const rs = restructureCheck(league, teamId, playerId);
  out.push({
    id: 'restructure', label: 'Restructure contract', enabled: rs.ok, reason: rs.reason,
    detail: rs.ok ? { text: `Save up to ${formatMoney(restructureSavings(p.contract as NonNullable<Player['contract']>, rs.max, year))} this year`, tone: 'info' } : { text: rs.reason ?? '', tone: 'dim' },
  });
  const rel = releaseCheck(league, teamId, playerId);
  out.push({
    id: 'release', label: 'Release player', enabled: rel.ok, reason: rel.reason,
    detail: { text: `Dead ${formatMoney(rel.deadThisYear)} now${rel.deadNextYear > 0 ? ` + ${formatMoney(rel.deadNextYear)} next yr` : ''} · saves ${formatMoney(rel.capSavings)}`, tone: rel.capSavings < 0 ? 'danger' : 'warning' },
  });
  const tagWhy = tagWindowReason(league, teamId, playerId);
  out.push({ id: 'tag', label: 'Franchise / transition tag', enabled: tagWhy === null, reason: tagWhy, detail: tagWhy ? { text: tagWhy, tone: 'dim' } : { text: 'Expiring deal: one-year tag available', tone: 'success' } });
  const blocked = isOnTradingBlock(league, playerId);
  out.push({ id: 'block', label: blocked ? 'Remove from trading block' : 'Put on trading block', enabled: true, reason: null, detail: { text: blocked ? 'Listed for trades' : 'Not listed', tone: blocked ? 'info' : 'dim' } });
  out.push({ id: 'focus', label: 'Training focus', enabled: true, reason: null, detail: { text: focusLabel(p), tone: 'info' } });
  const mates = team.rosterIds.filter((id) => league.players[id]?.position === p.position).length;
  out.push({ id: 'compare', label: `Compare ${p.position}s`, enabled: true, reason: null, detail: { text: `${mates} on the roster`, tone: 'dim' } });
  return out;
};
