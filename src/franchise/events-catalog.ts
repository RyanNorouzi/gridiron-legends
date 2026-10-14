/**
 * Franchise event catalog (src/data/events.json, validated at load): per FranchiseEventType a priority,
 * a cooldown, templated title/description ({player}, {team}, {stat}, {value}...), the choices and the
 * effects each choice applies, plus the default choice used when an event is left unresolved.
 *
 * `applyEventEffects` is the effect engine resolveEvent uses: morale/confidence/coach relationship for the
 * subject player or the whole roster, chemistry (ClubState.chemistryBonus, decaying weekly), fan support and
 * excitement, cash, sponsorship money, ticket price, player flags (optionally by chance), injury weeks and
 * depth-chart promotion (user-managed charts only; AI charts are rebuilt automatically). Pure.
 */
import eventsJson from '@/data/events.json';
import type { Rng } from '@/core/rng';
import { clamp } from '@/core/math';
import type { Morale, Player } from '@/players/types';
import { applySubstitution } from '@/teams/depth-chart';
import { teamRatings } from '@/teams/ratings';
import type { Team } from '@/teams/types';
import { jsonArray, jsonNumber, jsonObject, roundMoney } from './contracts';
import { economyScale } from './facilities';
import { ticketPriceRange } from './fans';
import { enforceCashFloor } from './finances';
import { ensureClub, withClub } from './rivalries';
import type { EventChoice, FranchiseEvent, FranchiseEventType, League, NewsEventType, PlayerFlag } from './types';

/** Event types with a catalog entry (decisions); news items (news.ts) have none. */
export type CatalogEventType = Exclude<FranchiseEventType, NewsEventType>;

/** Every catalog event type, in catalog order. */
export const FRANCHISE_EVENT_TYPES: readonly CatalogEventType[] = [
  'tradeDemand', 'extensionRequest', 'rookieBreakout', 'veteranDecline', 'playerSlump', 'playerJump', 'lockerRoomConflict', 'injury',
  'coachDisagreement', 'targetsRequest', 'unhappyPlayer', 'winningStreak', 'losingStreak', 'rivalryGame', 'recordBroken', 'holdout',
  'retirementAnnounced', 'fanUnrest', 'sponsorOffer',
];
const FLAGS: readonly PlayerFlag[] = ['tradeBlock', 'holdout', 'extensionTalks', 'retiring', 'disgruntled', 'targetsPromised'];

/** One effect of a choice. `chance` (0..1) makes flag and sponsor effects probabilistic. */
export type EventEffect =
  | { kind: 'playerMorale' | 'playerConfidence' | 'coachRelationship' | 'teamMorale' | 'teamConfidence' | 'teamCoachRelationship'; value: number }
  | { kind: 'teamChemistry' | 'fanSupport' | 'fanExcitement' | 'cash' | 'injuryWeeks'; value: number }
  | { kind: 'sponsor'; share: number; chance?: number }
  | { kind: 'ticketPrice'; factor: number }
  | { kind: 'addFlag' | 'removeFlag'; flag: PlayerFlag; chance?: number }
  | { kind: 'promoteDepth' };

/** A catalog choice. */
export interface CatalogChoice extends EventChoice {
  effects: EventEffect[];
}

/** A catalog entry for one event type. */
export interface EventTemplate {
  priority: number;
  /** Weeks (club clock) before the same type may fire again for the same subject. */
  cooldownWeeks: number;
  /** Weeks before the same type may fire again for the same team, whatever the subject. */
  teamCooldownWeeks: number;
  defaultChoice: string;
  title: string;
  description: string;
  choices: CatalogChoice[];
}

/** Validated events.json. */
export interface EventCatalog {
  limits: { maxPerWeek: number; autoResolveWeeks: number; keepAiEventYears: number };
  types: Record<CatalogEventType, EventTemplate>;
}

const FILE = 'events.json';
const VALUE_KINDS = ['playerMorale', 'playerConfidence', 'coachRelationship', 'teamMorale', 'teamConfidence', 'teamCoachRelationship',
  'teamChemistry', 'fanSupport', 'fanExcitement', 'cash', 'injuryWeeks'] as const;

const str = (o: Record<string, unknown>, key: string, path: string): string => {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${FILE}: ${path}.${key} must be a non-empty string`);
  return v;
};

const chanceOf = (o: Record<string, unknown>, path: string): number | undefined =>
  o.chance === undefined ? undefined : jsonNumber(o, 'chance', FILE, path, 0, 1);

const parseEffect = (raw: unknown, path: string): EventEffect => {
  const o = jsonObject(raw, FILE, path);
  const kind = o.kind;
  if ((VALUE_KINDS as readonly unknown[]).includes(kind)) return { kind: kind as (typeof VALUE_KINDS)[number], value: jsonNumber(o, 'value', FILE, path, -1e9, 1e9) } as EventEffect;
  if (kind === 'sponsor') {
    const chance = chanceOf(o, path);
    return { kind, share: jsonNumber(o, 'share', FILE, path, 0, 5), ...(chance !== undefined ? { chance } : {}) };
  }
  if (kind === 'ticketPrice') return { kind, factor: jsonNumber(o, 'factor', FILE, path, 0.1, 3) };
  if (kind === 'promoteDepth') return { kind };
  if (kind === 'addFlag' || kind === 'removeFlag') {
    if (!FLAGS.includes(o.flag as PlayerFlag)) throw new Error(`${FILE}: ${path}.flag must be one of ${FLAGS.join(', ')}`);
    const chance = chanceOf(o, path);
    return { kind, flag: o.flag as PlayerFlag, ...(chance !== undefined ? { chance } : {}) };
  }
  throw new Error(`${FILE}: ${path}.kind '${String(kind)}' is not a known effect`);
};

/** Validates events.json: every event type present, choices unique, the default choice valid, effects known. */
export const validateEventCatalog = (raw: unknown): EventCatalog => {
  const o = jsonObject(raw, FILE, '$');
  const l = jsonObject(o.limits, FILE, '$.limits');
  const t = jsonObject(o.types, FILE, '$.types');
  const types = {} as Record<CatalogEventType, EventTemplate>;
  for (const type of FRANCHISE_EVENT_TYPES) {
    const p = `$.types.${type}`;
    const e = jsonObject(t[type], FILE, p);
    const choices = jsonArray(e.choices, FILE, `${p}.choices`).map((c, i): CatalogChoice => {
      const cp = `${p}.choices[${i}]`;
      const co = jsonObject(c, FILE, cp);
      return { id: str(co, 'id', cp), label: str(co, 'label', cp), description: str(co, 'description', cp), effects: jsonArray(co.effects, FILE, `${cp}.effects`).map((x, j) => parseEffect(x, `${cp}.effects[${j}]`)) };
    });
    if (choices.length === 0) throw new Error(`${FILE}: ${p}.choices must not be empty`);
    if (new Set(choices.map((c) => c.id)).size !== choices.length) throw new Error(`${FILE}: ${p}.choices ids must be unique`);
    const defaultChoice = str(e, 'defaultChoice', p);
    if (!choices.some((c) => c.id === defaultChoice)) throw new Error(`${FILE}: ${p}.defaultChoice '${defaultChoice}' is not one of its choices`);
    types[type] = {
      priority: jsonNumber(e, 'priority', FILE, p, 0, 100), cooldownWeeks: jsonNumber(e, 'cooldownWeeks', FILE, p, 0, 100),
      teamCooldownWeeks: jsonNumber(e, 'teamCooldownWeeks', FILE, p, 0, 100),
      defaultChoice, title: str(e, 'title', p), description: str(e, 'description', p), choices,
    };
  }
  const unknown = Object.keys(t).filter((k) => !FRANCHISE_EVENT_TYPES.includes(k as CatalogEventType));
  if (unknown.length) throw new Error(`${FILE}: unknown event types ${unknown.join(', ')}`);
  return {
    limits: {
      maxPerWeek: jsonNumber(l, 'maxPerWeek', FILE, '$.limits', 1, 20),
      autoResolveWeeks: jsonNumber(l, 'autoResolveWeeks', FILE, '$.limits', 1, 52),
      keepAiEventYears: jsonNumber(l, 'keepAiEventYears', FILE, '$.limits', 0, 20),
    },
    types,
  };
};

/** Validated event catalog. */
export const EVENT_CATALOG: EventCatalog = validateEventCatalog(eventsJson);

/** Replaces {name} placeholders; unknown placeholders are left in place. */
export const renderTemplate = (template: string, vars: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (m, key: string) => (vars[key] !== undefined ? String(vars[key]) : m));

/** The catalog entry of an event type (undefined for news types). */
export const catalogTemplate = (type: FranchiseEventType): EventTemplate | undefined =>
  (FRANCHISE_EVENT_TYPES as readonly string[]).includes(type) ? EVENT_CATALOG.types[type as CatalogEventType] : undefined;

/** The player-facing choices of an event type (effects stripped; news items offer only 'noted'). */
export const eventChoices = (type: FranchiseEventType): EventChoice[] =>
  catalogTemplate(type)?.choices.map((c) => ({ id: c.id, label: c.label, description: c.description })) ?? [{ id: 'noted', label: 'Noted', description: 'News item.' }];

/* ------------------------------------------------------------------ effects */

const shiftMorale = (m: Morale, key: keyof Morale, delta: number): Morale => ({ ...m, [key]: clamp(Math.round(m[key] + delta), 0, 100) });

const setPlayer = (league: League, p: Player): League => ({ ...league, players: { ...league.players, [p.id]: p } });
const setTeam = (league: League, t: Team): League => ({ ...league, teams: { ...league.teams, [t.id]: t } });

const MORALE_KEY: Record<'playerMorale' | 'playerConfidence' | 'coachRelationship', keyof Morale> = {
  playerMorale: 'morale', playerConfidence: 'confidence', coachRelationship: 'coachRelationship',
};
const TEAM_MORALE_KEY: Record<'teamMorale' | 'teamConfidence' | 'teamCoachRelationship', keyof Morale> = {
  teamMorale: 'morale', teamConfidence: 'confidence', teamCoachRelationship: 'coachRelationship',
};

const withFlag = (league: League, playerId: string, flag: PlayerFlag, add: boolean): League => {
  const club = ensureClub(league);
  const current = club.playerFlags[playerId] ?? [];
  const next = add ? (current.includes(flag) ? current : [...current, flag]) : current.filter((f) => f !== flag);
  const playerFlags = { ...club.playerFlags };
  if (next.length) playerFlags[playerId] = next;
  else delete playerFlags[playerId];
  return withClub(league, { playerFlags });
};

const promote = (league: League, team: Team, p: Player): League => {
  if (!(team.isUserControlled || league.userTeamId === team.id)) return league;
  const depthChart = applySubstitution(team.depthChart, p.position, p.id, 0);
  const roster = team.rosterIds.map((id) => league.players[id]).filter((x): x is Player => x !== undefined);
  const r = teamRatings(roster, depthChart);
  return setTeam(league, { ...team, depthChart, overall: r.overall, offenseRating: r.offense, defenseRating: r.defense });
};

/** Applies one effect for an event (subject player skipped when he is gone or no longer on the team). */
export const applyEventEffect = (league: League, event: FranchiseEvent, effect: EventEffect, rng: Rng): League => {
  const team = league.teams[event.teamId];
  if (!team) return league;
  const p = event.playerId ? league.players[event.playerId] : undefined;
  const onTeam = p !== undefined && p.teamId === team.id;
  switch (effect.kind) {
    case 'playerMorale': case 'playerConfidence': case 'coachRelationship':
      return onTeam ? setPlayer(league, { ...p, morale: shiftMorale(p.morale, MORALE_KEY[effect.kind], effect.value) }) : league;
    case 'teamMorale': case 'teamConfidence': case 'teamCoachRelationship': {
      const players = { ...league.players };
      for (const id of team.rosterIds) {
        const q = players[id];
        if (q) players[id] = { ...q, morale: shiftMorale(q.morale, TEAM_MORALE_KEY[effect.kind], effect.value) };
      }
      return { ...league, players };
    }
    case 'teamChemistry': {
      const club = ensureClub(league);
      const out = withClub(league, { chemistryBonus: { ...club.chemistryBonus, [team.id]: (club.chemistryBonus[team.id] ?? 0) + effect.value } });
      return setTeam(out, { ...team, chemistry: clamp(Math.round(team.chemistry + effect.value), 0, 100) });
    }
    case 'fanSupport': case 'fanExcitement': {
      const key = effect.kind === 'fanSupport' ? 'support' : 'excitement';
      return setTeam(league, { ...team, fans: { ...team.fans, [key]: clamp(Math.round((team.fans[key] + effect.value) * 10) / 10, 0, 100) } });
    }
    case 'cash':
      // A payment the club cannot afford is covered by the owner (finances.ts cash floor / ownerSubsidy).
      return enforceCashFloor(setTeam(league, { ...team, finances: { ...team.finances, cash: team.finances.cash + roundMoney(effect.value * economyScale(league.settings)) } }), team.id);
    case 'sponsor': {
      if (effect.chance !== undefined && !rng.chance(effect.chance)) return league;
      const amount = roundMoney((event.data?.amount ?? 0) * effect.share);
      const f = team.finances;
      return setTeam(league, { ...team, finances: { ...f, cash: f.cash + amount, seasonRevenue: { ...f.seasonRevenue, sponsors: f.seasonRevenue.sponsors + amount } } });
    }
    case 'ticketPrice': {
      const [lo, hi] = ticketPriceRange(economyScale(league.settings));
      return setTeam(league, { ...team, finances: { ...team.finances, ticketPrice: clamp(Math.round(team.finances.ticketPrice * effect.factor), lo, hi) } });
    }
    case 'addFlag': case 'removeFlag':
      if (!event.playerId || !onTeam || (effect.chance !== undefined && !rng.chance(effect.chance))) return league;
      return withFlag(league, event.playerId, effect.flag, effect.kind === 'addFlag');
    case 'injuryWeeks':
      if (!onTeam || !p.injury) return league;
      return setPlayer(league, { ...p, injury: { ...p.injury, weeksRemaining: Math.max(1, p.injury.weeksRemaining + Math.round(effect.value)) } });
    case 'promoteDepth':
      return onTeam ? promote(league, team, p) : league;
    default:
      return league;
  }
};

/** Applies every effect of a choice in catalog order. Throws for an unknown choice. */
export const applyEventEffects = (league: League, event: FranchiseEvent, choiceId: string, rng: Rng): League => {
  const tpl = catalogTemplate(event.type);
  if (!tpl) return league; // news items: nothing to apply
  const choice = tpl.choices.find((c) => c.id === choiceId);
  if (!choice) throw new Error(`Event ${event.id} (${event.type}) has no choice '${choiceId}'`);
  let out = league;
  for (const e of choice.effects) out = applyEventEffect(out, event, e, rng);
  return out;
};
