/**
 * Manual in-game substitutions (the model behind the pause menu's SUBSTITUTIONS screen): the formation roles the
 * user's playbooks field, who the depth chart would start there, the healthy players who can be sent in (the
 * position first, then the lineup fallbacks), and the row labels with each player's remaining energy. Sending a
 * player in is GameCommand 'substitute' (through GameSession.substitute); the override holds for the rest of
 * the game unless he is hurt, or until the role is sent back to AUTO (playerId null). Pure.
 */
import type { PlayerId } from '@/core/ids';
import { FALLBACK_POSITIONS, inferPositionFromRole } from '@/game/lineups';
import type { GameSetup, GameState, TeamSide } from '@/game/types';
import type { PlaybookRegistry } from '@/playbook/loader';
import type { GameSession } from './session-types';
import { isSpecialPlay } from '@/playbook/special-teams';
import { shortName, type Player, type Position } from '@/players/types';
import type { FormationSlot } from '@/playbook/types';

export interface SubRole {
  role: string;
  position: Position;
  unit: 'offense' | 'defense';
}

const ROLE_ORDER = ['QB', 'RB', 'FB', 'WR1', 'WR2', 'WR3', 'WR4', 'TE1', 'TE2', 'LT', 'LG', 'C', 'RG', 'RT',
  'DE1', 'DT1', 'DT2', 'DE2', 'NT', 'OLB1', 'MLB', 'MLB2', 'OLB2', 'CB1', 'CB2', 'CB3', 'NCB', 'FS', 'SS'];

const rank = (role: string): number => {
  const i = ROLE_ORDER.indexOf(role);
  return i < 0 ? ROLE_ORDER.length : i;
};

/** Every scrimmage formation role `side` fields (offense first, in lineup order), with its preferred position. */
export const substitutionRoles = (setup: GameSetup, side: TeamSide, registry: PlaybookRegistry): SubRole[] => {
  const seen = new Map<string, SubRole>();
  const t = setup[side];
  const add = (unit: SubRole['unit'], role: string, position: Position | null): void => {
    const key = `${unit}:${role}`;
    if (position && !seen.has(key)) seen.set(key, { role, position, unit });
  };
  // Slots from the formation registry; a play whose formation is not registered falls back to its assignment
  // roles with the position the lineup code would infer (the same fallback selectLineup uses).
  const addPlay = (unit: SubRole['unit'], slots: readonly FormationSlot[] | undefined, assignments: Readonly<Record<string, unknown>>): void => {
    if (slots) for (const s of slots) add(unit, s.role, s.position);
    else for (const role of Object.keys(assignments)) add(unit, role, inferPositionFromRole(role));
  };
  for (const p of t.offensePlays) if (isSpecialPlay(p) === 'none') addPlay('offense', registry.offensiveFormations[p.formation]?.slots, p.assignments);
  for (const p of t.defensePlays) {
    if (p.tags.some((tag) => tag === 'kickReturn' || tag === 'puntReturn' || tag === 'fgBlock')) continue;
    addPlay('defense', registry.defensiveFormations[p.formation]?.slots, p.assignments);
  }
  const list = [...seen.values()];
  return list.sort((a, b) => (a.unit === b.unit ? rank(a.role) - rank(b.role) || a.role.localeCompare(b.role) : a.unit === 'offense' ? -1 : 1));
};

const injuredIds = (state: Pick<GameState, 'injuries'>): Set<PlayerId> => new Set(state.injuries.map((i) => i.playerId));

/** Healthy roster players who can play `position`: that position by overall, then the lineup fallbacks. */
export const substitutionCandidates = (setup: GameSetup, side: TeamSide, position: Position, state: Pick<GameState, 'injuries'>): Player[] => {
  const t = setup[side];
  const hurt = injuredIds(state);
  const roster = t.team.rosterIds.map((id) => t.players[id]).filter((p): p is Player => p !== undefined && p.injury === null && !p.retired && !hurt.has(p.id));
  const out: Player[] = [];
  for (const pos of [position, ...(FALLBACK_POSITIONS[position] ?? [])]) {
    for (const p of roster.filter((r) => r.position === pos).sort((a, b) => b.overall - a.overall)) if (!out.includes(p)) out.push(p);
  }
  return out;
};

/** Which slot of its position a role is (WR1 -> 0, WR2 -> 1, CB3 -> 2, MLB2 -> 1; no trailing digit -> 0). */
export const roleSlotIndex = (role: string): number => {
  const m = /(\d+)$/.exec(role);
  return m ? Math.max(0, Number(m[1]) - 1) : 0;
};

/**
 * Who AUTO fields at a role: the `slot`-th healthy player on the depth chart at `position` (WR2 -> the second
 * receiver), skipping players the user has sent in elsewhere (`exclude`), since overrides claim their men first.
 */
export const depthStarter = (
  setup: GameSetup, side: TeamSide, position: Position, state: Pick<GameState, 'injuries'>, slot = 0, exclude: ReadonlySet<PlayerId> = new Set(),
): Player | null => {
  const t = setup[side];
  const hurt = injuredIds(state);
  const depth = (t.team.depthChart[position] ?? []).map((id) => t.players[id])
    .filter((p): p is Player => p !== undefined && p.injury === null && !hurt.has(p.id) && !exclude.has(p.id));
  const rest = substitutionCandidates(setup, side, position, state).filter((p) => !exclude.has(p.id) && !depth.includes(p));
  const order = [...depth, ...rest];
  return order[slot] ?? order[order.length - 1] ?? null;
};

/** "J. DOE WR 81 · 74%" (energy left from in-game fatigue). */
export const playerSubLabel = (p: Player, fatigue: Readonly<Record<PlayerId, number>>): string =>
  `${shortName(p).toUpperCase()} ${p.position} ${p.overall} · ${Math.round((1 - (fatigue[p.id] ?? 0)) * 100)}%`;

/** The cycle stop that hands a role back to the depth chart / fatigue rotation. */
export const AUTO_SUB = 'AUTO';

/** Sends `playerId` in at `role` for the user side, or (null) returns the role to AUTO; false when refused. */
export const sendSubstitution = (session: Pick<GameSession, 'substitute'>, role: string, playerId: PlayerId | null): boolean =>
  session.substitute ? session.substitute(role, playerId) : false;
