/**
 * Playbook view-model for the user's team. The team's playbook is resolved with the loader
 * (resolvePlaybook: bundled data first, then League.customPlaybooks). Every bundled and League custom play is
 * listed per side with a membership flag, a category (Run / Pass / Special, or Man / Zone / Match / Blitz /
 * Special) and its description. Toggling a play copies the current playbook into the team's CUSTOM playbook
 * (id `custom-<teamId>`, stored in League.customPlaybooks) the first time and sets it as Team.playbookId;
 * a side always keeps at least one scrimmage play (kick and return units have synthetic fallbacks in games).
 * Validation messages combine the loader's issues (validatePlaybook, resolvePlaybook) with coverage warnings
 * (no runs, no passes, missing kicks or returns, which fall back to generic plays in games).
 */
import type { TeamId } from '@/core/ids';
import { customContent } from '@/franchise/game-setup';
import type { League } from '@/franchise/types';
import { loadPlaybookData, resolvePlaybook, validatePlaybook, type PlaybookRegistry, type ResolvedPlaybook } from '@/playbook/loader';
import { isKickConcept } from '@/playbook/special-teams';
import type { DefensivePlay, OffensivePlay, Playbook } from '@/playbook/types';
import { DEFAULT_PLAYBOOK_ID } from '@/teams/league-generator';
import { describeDefense, describeOffense } from '../../game/play-art';
import { done, refused, type ActionResult } from './common';

/** Offense or defense. */
export type PlaySide = 'offense' | 'defense';

/** One play of the catalogue. */
export interface PlayRow {
  id: string;
  name: string;
  side: PlaySide;
  formation: string;
  category: string;
  description: string;
  inBook: boolean;
  /** Authored by the user (League.customOffensePlays / customDefensePlays). */
  custom: boolean;
}

/** Id of the team's custom playbook. */
export const customPlaybookId = (teamId: TeamId): string => `custom-${teamId}`;

/** The registry used by the tab (bundled data plus the League's custom plays for lookups and art). */
export const playbookRegistry = (league: League): PlaybookRegistry => {
  const reg = loadPlaybookData();
  const byId = <T extends { id: string }>(items: readonly T[]): Record<string, T> => Object.fromEntries(items.map((p) => [p.id, p]));
  return { ...reg, offensePlays: { ...byId(league.customOffensePlays), ...reg.offensePlays }, defensePlays: { ...byId(league.customDefensePlays), ...reg.defensePlays } };
};

/** The team's playbook object (bundled or custom), falling back to the default playbook. */
export const currentPlaybook = (league: League, teamId: TeamId): Playbook => {
  const reg = loadPlaybookData();
  const id = league.teams[teamId]?.playbookId ?? DEFAULT_PLAYBOOK_ID;
  return reg.playbooks[id] ?? league.customPlaybooks.find((p) => p.id === id) ?? (reg.playbooks[DEFAULT_PLAYBOOK_ID] as Playbook);
};

/** The team's resolved playbook, or the loader's error. */
export const resolvedPlaybook = (league: League, teamId: TeamId): { resolved: ResolvedPlaybook | null; error: string | null } => {
  try {
    return { resolved: resolvePlaybook(currentPlaybook(league, teamId).id, customContent(league)), error: null };
  } catch (e) {
    return { resolved: null, error: e instanceof Error ? e.message : String(e) };
  }
};

/** True when the team uses its custom playbook. */
export const usesCustom = (league: League, teamId: TeamId): boolean => league.teams[teamId]?.playbookId === customPlaybookId(teamId);

const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);
const RUN_TYPES = new Set(['run', 'qbRun']);
const SPECIAL_DEF_TAGS = ['kickReturn', 'puntReturn', 'fgBlock'];

/** Category of an offensive play. */
export const offenseCategory = (p: OffensivePlay): string => (RUN_TYPES.has(p.type) ? 'Run' : PASS_TYPES.has(p.type) ? 'Pass' : 'Special');

/** Category of a defensive play. */
export const defenseCategory = (p: DefensivePlay): string =>
  p.tags.some((t) => SPECIAL_DEF_TAGS.includes(t)) ? 'Special' : p.blitz !== 'none' ? 'Blitz' : p.family === 'man' ? 'Man' : p.family === 'zone' ? 'Zone' : 'Match';

/** True for an offensive play callable on a scrimmage down (not a kick concept, kneel or spike). */
export const isScrimmageOffense = (p: OffensivePlay): boolean => !isKickConcept(p.concept) && p.type !== 'kneel' && p.type !== 'spike';

/** True for a defensive play callable on a scrimmage down (not a return / block unit). */
export const isScrimmageDefense = (p: DefensivePlay): boolean => defenseCategory(p) !== 'Special';

/** Whether play `id` of `side` is a scrimmage play. Games have synthetic kick and return units, not scrimmage ones. */
const isScrimmageId = (reg: PlaybookRegistry, side: PlaySide, id: string): boolean => {
  if (side === 'offense') {
    const p = reg.offensePlays[id];
    return !!p && isScrimmageOffense(p);
  }
  const p = reg.defensePlays[id];
  return !!p && isScrimmageDefense(p);
};

/** Every play of a side with the team's membership. */
export const playRows = (league: League, teamId: TeamId, side: PlaySide): PlayRow[] => {
  const pb = currentPlaybook(league, teamId);
  const reg = loadPlaybookData();
  if (side === 'offense') {
    const inBook = new Set(pb.offensePlayIds);
    const all: [OffensivePlay, boolean][] = [...Object.values(reg.offensePlays).map((p): [OffensivePlay, boolean] => [p, false]), ...league.customOffensePlays.filter((p) => !reg.offensePlays[p.id]).map((p): [OffensivePlay, boolean] => [p, true])];
    return all.map(([p, custom]) => ({ id: p.id, name: p.name, side, formation: p.formation, category: offenseCategory(p), description: describeOffense(p), inBook: inBook.has(p.id), custom }));
  }
  const inBook = new Set(pb.defensePlayIds);
  const all: [DefensivePlay, boolean][] = [...Object.values(reg.defensePlays).map((p): [DefensivePlay, boolean] => [p, false]), ...league.customDefensePlays.filter((p) => !reg.defensePlays[p.id]).map((p): [DefensivePlay, boolean] => [p, true])];
  return all.map(([p, custom]) => ({ id: p.id, name: p.name, side, formation: p.formation, category: defenseCategory(p), description: describeDefense(p), inBook: inBook.has(p.id), custom }));
};

/** Looks a play up by side and id (bundled first, then League custom plays). */
export const findPlay = (league: League, side: PlaySide, id: string): OffensivePlay | DefensivePlay | null => {
  const reg = playbookRegistry(league);
  return (side === 'offense' ? reg.offensePlays[id] : reg.defensePlays[id]) ?? null;
};

/** Loader issues plus coverage warnings for the team's playbook. */
export const playbookIssues = (league: League, teamId: TeamId): string[] => {
  const { resolved, error } = resolvedPlaybook(league, teamId);
  if (!resolved) return [error ?? 'Playbook could not be resolved'];
  const out = resolved.issues.map((i) => i.message);
  if (usesCustom(league, teamId)) out.push(...validatePlaybook(resolved.playbook, playbookRegistry(league)).map((i) => i.message));
  const off = resolved.offense;
  const def = resolved.defense;
  if (!off.some((p) => RUN_TYPES.has(p.type))) out.push('No run plays: the offense can only pass');
  if (!off.some((p) => PASS_TYPES.has(p.type))) out.push('No pass plays: the offense can only run');
  for (const concept of ['kickoff', 'punt', 'fieldGoal', 'extraPoint'] as const) {
    if (!off.some((p) => p.concept === concept)) out.push(`No ${concept === 'fieldGoal' ? 'field goal' : concept === 'extraPoint' ? 'extra point' : concept} play: a generic one is used`);
  }
  if (!def.some((p) => defenseCategory(p) !== 'Special')) out.push('No scrimmage defenses');
  for (const tag of ['kickReturn', 'puntReturn'] as const) {
    if (!def.some((p) => p.tags.includes(tag))) out.push(`No ${tag === 'kickReturn' ? 'kick' : 'punt'} return: a generic one is used`);
  }
  return [...new Set(out)];
};

/** Adds or removes a play, moving the team onto its custom playbook. */
export const togglePlay = (league: League, teamId: TeamId, side: PlaySide, playId: string): ActionResult => {
  const team = league.teams[teamId];
  if (!team) return refused(league, 'Unknown team');
  const play = findPlay(league, side, playId);
  if (!play) return refused(league, `Unknown play ${playId}`);
  const base = currentPlaybook(league, teamId);
  const id = customPlaybookId(teamId);
  const pb: Playbook = base.id === id ? { ...base, offensePlayIds: [...base.offensePlayIds], defensePlayIds: [...base.defensePlayIds] }
    : { id, name: `${team.abbr} Custom`, offensePlayIds: [...base.offensePlayIds], defensePlayIds: [...base.defensePlayIds] };
  const key = side === 'offense' ? 'offensePlayIds' : 'defensePlayIds';
  const has = pb[key].includes(playId);
  if (has && pb[key].length <= 1) return refused(league, `A playbook needs at least one ${side === 'offense' ? 'offensive' : 'defensive'} play`);
  const reg = playbookRegistry(league);
  if (has && isScrimmageId(reg, side, playId) && !pb[key].some((id) => id !== playId && isScrimmageId(reg, side, id))) {
    return refused(league, `${play.name} is your last ${side === 'offense' ? 'offensive' : 'defensive'} scrimmage play`);
  }
  pb[key] = has ? pb[key].filter((p) => p !== playId) : [...pb[key], playId];
  const next: League = {
    ...league,
    customPlaybooks: [...league.customPlaybooks.filter((p) => p.id !== id), pb],
    teams: { ...league.teams, [teamId]: { ...team, playbookId: id } },
  };
  return done(next, `${has ? 'Removed' : 'Added'} ${play.name} ${has ? 'from' : 'to'} ${pb.name}`);
};

/** Bundled playbooks (for choosing a base). */
export const bundledPlaybooks = (): Playbook[] => Object.values(loadPlaybookData().playbooks);

/** Sets the team's playbook to a bundled one or its custom one (kept in the League either way). */
export const choosePlaybook = (league: League, teamId: TeamId, playbookId: string): ActionResult => {
  const team = league.teams[teamId];
  if (!team) return refused(league, 'Unknown team');
  const pb = loadPlaybookData().playbooks[playbookId] ?? league.customPlaybooks.find((p) => p.id === playbookId && p.id === customPlaybookId(teamId));
  if (!pb) return refused(league, `Unknown playbook ${playbookId}`);
  if (team.playbookId === pb.id) return refused(league, `${pb.name} is already in use`);
  return done({ ...league, teams: { ...league.teams, [teamId]: { ...team, playbookId: pb.id } } }, `Now running the ${pb.name} playbook`);
};
